import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandService } from '../src/main/services/commands'
import { WorkspaceService } from '../src/main/services/workspace'
import { expandSlashCommandInputSchema } from '../src/shared/contracts'

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix = 'code-assistant-commands-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function createService(root: string): Promise<CommandService> {
  const workspace = new WorkspaceService()
  await workspace.openWorkspace(root, false)
  return new CommandService(workspace)
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('CommandService discovery', () => {
  it('discovers nested command files with validated frontmatter and stable descriptors', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'team', 'prompts'), { recursive: true })
    await writeFile(
      join(root, 'team', 'prompts', 'review.command.md'),
      [
        '---',
        'name: Review-Code',
        'description: "Review the selected code"',
        "argument-hint: '<path> [focus]'",
        'owner: ignored-extension-field',
        '---',
        'Review $1 with a focus on $FOCUS.',
      ].join('\n'),
    )
    await writeFile(join(root, 'explain.command.md'), 'Explain $ARGUMENTS clearly.')
    await writeFile(join(root, 'notes.md'), 'not a command')

    const commands = await createService(root)
    const first = await commands.listSlashCommands()
    const second = await commands.listSlashCommands()

    expect(first).toHaveLength(2)
    expect(first).toEqual(second)
    expect(first).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'prompts:review-code',
          description: 'Review the selected code',
          argumentHint: '<path> [focus]',
          path: 'team/prompts/review.command.md',
          source: 'workspace',
        }),
        expect.objectContaining({
          name: 'prompts:explain',
          description: '',
          argumentHint: null,
          path: 'explain.command.md',
          source: 'workspace',
        }),
      ]),
    )
    expect(first.every(({ id }) => /^workspace-command:[\w-]{43}$/.test(id))).toBe(true)
  })

  it('parses frontmatter after a UTF-8 byte-order mark', async () => {
    const root = await temporaryDirectory()
    await writeFile(
      join(root, 'bom.command.md'),
      '\uFEFF---\nname: bom-prompt\ndescription: BOM-safe metadata\n---\nRun $1.',
    )

    const commands = await createService(root)
    await expect(commands.listSlashCommands()).resolves.toEqual([
      expect.objectContaining({
        name: 'prompts:bom-prompt',
        description: 'BOM-safe metadata',
      }),
    ])
  })

  it('skips oversized, malformed, invalidly named, and duplicate commands deterministically', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'a'))
    await mkdir(join(root, 'z'))
    await writeFile(
      join(root, 'a', 'first.command.md'),
      '---\nname: duplicate\ndescription: first\n---\nfirst template',
    )
    await writeFile(
      join(root, 'z', 'second.command.md'),
      '---\nname: DUPLICATE\ndescription: second\n---\nsecond template',
    )
    await writeFile(join(root, 'invalid.command.md'), '---\nname: ../escape\n---\ninvalid')
    await writeFile(join(root, 'malformed.command.md'), '---\nname: malformed\nno closing marker')
    await writeFile(join(root, 'large.command.md'), 'x'.repeat(64 * 1024 + 1))

    const commands = await createService(root)
    const descriptors = await commands.listSlashCommands()

    expect(descriptors).toHaveLength(1)
    expect(descriptors[0]).toMatchObject({
      name: 'prompts:duplicate',
      path: 'a/first.command.md',
      description: 'first',
    })
  })

  it('ignores command paths that resolve outside the workspace', async () => {
    const root = await temporaryDirectory()
    const external = await temporaryDirectory('code-assistant-command-external-')
    await writeFile(join(external, 'external.command.md'), 'external template')
    await symlink(join(external, 'external.command.md'), join(root, 'escape.command.md'))

    const commands = await createService(root)
    await expect(commands.listSlashCommands()).resolves.toEqual([])
  })

  it('caps discovery at one hundred command files', async () => {
    const root = await temporaryDirectory()
    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        writeFile(
          join(root, `command-${String(index).padStart(3, '0')}.command.md`),
          `prompt ${index}`,
        ),
      ),
    )

    const commands = await createService(root)
    await expect(commands.listSlashCommands()).resolves.toHaveLength(100)
  })
})

describe('CommandService expansion', () => {
  it('expands raw, quoted positional, and uppercase named arguments', async () => {
    const root = await temporaryDirectory()
    await writeFile(
      join(root, 'compose.command.md'),
      [
        'raw=<$ARGUMENTS>',
        'first=<$1>',
        'second=<$2>',
        'language=<$LANG>',
        'note=<$NOTE>',
        'missing=<$9>',
      ].join('\n'),
    )
    const commands = await createService(root)
    const [descriptor] = await commands.listSlashCommands()

    await expect(
      commands.expandSlashCommand({
        id: descriptor.id,
        revision: descriptor.revision,
        arguments: `alpha "two words" LANG=TypeScript NOTE='review carefully'`,
      }),
    ).resolves.toEqual({
      id: descriptor.id,
      prompt: [
        `raw=<alpha "two words" LANG=TypeScript NOTE='review carefully'>`,
        'first=<alpha>',
        'second=<two words>',
        'language=<TypeScript>',
        'note=<review carefully>',
        'missing=<>',
      ].join('\n'),
    })
  })

  it('treats double dollars as literal placeholders and rejects malformed quoting', async () => {
    const root = await temporaryDirectory()
    await writeFile(
      join(root, 'literal.command.md'),
      'Keep $$HOME, $$ARGUMENTS, and $$1; expand $1.',
    )
    const commands = await createService(root)
    const [descriptor] = await commands.listSlashCommands()

    await expect(
      commands.expandSlashCommand({
        id: descriptor.id,
        revision: descriptor.revision,
        arguments: 'value',
      }),
    ).resolves.toEqual({
      id: descriptor.id,
      prompt: 'Keep $HOME, $ARGUMENTS, and $1; expand value.',
    })
    await expect(
      commands.expandSlashCommand({
        id: descriptor.id,
        revision: descriptor.revision,
        arguments: '"unterminated',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  })

  it('does not recursively expand placeholders introduced by argument values', async () => {
    const root = await temporaryDirectory()
    await writeFile(
      join(root, 'single-pass.command.md'),
      'positional=<$1> named=<$VALUE> raw=<$ARGUMENTS>',
    )
    const commands = await createService(root)
    const [descriptor] = await commands.listSlashCommands()

    await expect(
      commands.expandSlashCommand({
        id: descriptor.id,
        revision: descriptor.revision,
        arguments: `'$$HOME' VALUE='$1 and $ARGUMENTS'`,
      }),
    ).resolves.toEqual({
      id: descriptor.id,
      prompt:
        "positional=<$$HOME> named=<$1 and $ARGUMENTS> raw=<'$$HOME' VALUE='$1 and $ARGUMENTS'>",
    })
  })

  it('only expands IDs discovered from the current workspace', async () => {
    const firstRoot = await temporaryDirectory()
    const secondRoot = await temporaryDirectory()
    await writeFile(join(firstRoot, 'safe.command.md'), 'safe template')
    await writeFile(join(secondRoot, 'safe.command.md'), 'other template')

    const firstCommands = await createService(firstRoot)
    const secondCommands = await createService(secondRoot)
    const [firstDescriptor] = await firstCommands.listSlashCommands()
    const [secondDescriptor] = await secondCommands.listSlashCommands()
    expect(firstDescriptor.id).not.toBe(secondDescriptor.id)

    await expect(
      secondCommands.expandSlashCommand({
        id: firstDescriptor.id,
        revision: firstDescriptor.revision,
        arguments: '',
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' })
    await expect(
      secondCommands.expandSlashCommand({
        id: 'workspace-command:../../arbitrary.command.md',
        revision: firstDescriptor.revision,
        arguments: '',
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' })

    expect(
      expandSlashCommandInputSchema.safeParse({
        id: secondDescriptor.id,
        arguments: '',
        path: '../../arbitrary.command.md',
      }).success,
    ).toBe(false)
  })

  it('requires the listed content revision before expanding a command', async () => {
    const root = await temporaryDirectory()
    const commandPath = join(root, 'changing.command.md')
    await writeFile(commandPath, 'Original $1')
    const commands = await createService(root)
    const [descriptor] = await commands.listSlashCommands()

    await writeFile(commandPath, 'Changed $1')
    await expect(
      commands.expandSlashCommand({
        id: descriptor.id,
        revision: descriptor.revision,
        arguments: 'value',
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_CHANGED' })
  })
})
