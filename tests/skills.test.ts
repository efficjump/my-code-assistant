import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillsService, type SkillsServiceOptions } from '../src/main/services/skills'
import { WorkspaceService } from '../src/main/services/workspace'

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

const extendedSources: NonNullable<SkillsServiceOptions['sources']> = [
  { directory: '.agents/skills', source: 'agents' },
  { directory: '.extensions/skills', source: 'extensions' },
]

async function createService(
  root: string,
  options: SkillsServiceOptions = {},
): Promise<SkillsService> {
  const workspace = new WorkspaceService()
  await workspace.openWorkspace(root, false)
  return new SkillsService(workspace, options)
}

async function writeSkill(
  root: string,
  directory: string,
  name: string,
  description: string,
  body = 'Follow the repository workflow.',
  source: 'agents' | 'extensions' = 'agents',
  extraFrontmatter = '',
): Promise<string> {
  const skillDirectory = join(root, `.${source}`, 'skills', directory)
  await mkdir(skillDirectory, { recursive: true })
  const content = `---\nname: ${name}\ndescription: ${description}\n${extraFrontmatter}---\n${body}\n`
  await writeFile(join(skillDirectory, 'SKILL.md'), content)
  return content
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('SkillsService', () => {
  it('discovers only metadata, then revision-checks full content and listed resources', async () => {
    const root = await temporaryDirectory('code-assistant-skills-')
    const content = await writeSkill(root, 'review', 'review-code', 'Review changed code')
    const skillDirectory = join(root, '.agents', 'skills', 'review')
    await mkdir(join(skillDirectory, 'scripts'))
    await mkdir(join(skillDirectory, 'references'))
    await mkdir(join(skillDirectory, 'assets'))
    await writeFile(join(skillDirectory, 'scripts', 'check.sh'), 'echo checked')
    await writeFile(join(skillDirectory, 'references', 'policy.md'), 'Review policy')
    await writeFile(join(skillDirectory, 'assets', 'example.txt'), 'Example output')
    const skills = await createService(root)

    const [descriptor] = await skills.list()
    expect(descriptor).toMatchObject({
      name: 'review-code',
      description: 'Review changed code',
      path: '.agents/skills/review/SKILL.md',
      source: 'agents',
      scope: 'workspace',
      allowImplicitInvocation: true,
      resources: {
        scripts: ['.agents/skills/review/scripts/check.sh'],
        references: ['.agents/skills/review/references/policy.md'],
        assets: ['.agents/skills/review/assets/example.txt'],
      },
    })
    expect(descriptor.id).toMatch(/^workspace-skill:[\w-]{43}$/)
    expect(descriptor.revision).toBe(descriptor.contentHash)
    expect(descriptor).not.toHaveProperty('content')

    await expect(skills.read(descriptor.id, descriptor.revision)).resolves.toEqual({
      descriptor,
      content,
    })
    await expect(
      skills.readResource(
        descriptor.id,
        descriptor.revision,
        '.agents/skills/review/references/policy.md',
      ),
    ).resolves.toMatchObject({ content: 'Review policy' })
    await expect(
      skills.readResource(descriptor.id, descriptor.revision, '../../outside.txt'),
    ).rejects.toMatchObject({ code: 'INVALID_RESOURCE' })
  })

  it('rejects stale revisions after SKILL.md changes', async () => {
    const root = await temporaryDirectory('code-assistant-skills-')
    await writeSkill(root, 'review', 'review-code', 'Review code')
    const skills = await createService(root)
    const [descriptor] = await skills.list()

    await writeSkill(root, 'review', 'review-code', 'Review code', 'Updated instructions.')
    await expect(skills.read(descriptor.id, descriptor.revision)).rejects.toMatchObject({
      code: 'REVISION_MISMATCH',
    })
  })

  it('resolves duplicate names by lexical path and ignores symlinks escaping the workspace', async () => {
    const root = await temporaryDirectory('code-assistant-skills-')
    const external = await temporaryDirectory('code-assistant-skills-external-')
    await writeSkill(root, 'a-first', 'duplicate', 'First descriptor')
    await writeSkill(root, 'z-last', 'duplicate', 'Last descriptor')
    await writeSkill(external, 'outside', 'outside-skill', 'Must remain outside')
    await symlink(
      join(external, '.agents', 'skills', 'outside'),
      join(root, '.agents', 'skills', 'escaped'),
    )
    const skills = await createService(root)

    await expect(skills.list()).resolves.toEqual([
      expect.objectContaining({
        name: 'duplicate',
        description: 'First descriptor',
        path: '.agents/skills/a-first/SKILL.md',
      }),
    ])
  })

  it('discovers configured skill sources and honors explicit-only invocation metadata', async () => {
    const root = await temporaryDirectory('code-assistant-skills-')
    const content = await writeSkill(
      root,
      'release-checks',
      'release-check',
      'Validate a release candidate',
      'Run the documented release checks.',
      'extensions',
      'disable-model-invocation: true\n',
    )
    const skills = await createService(root, { sources: extendedSources })

    const [descriptor] = await skills.list()
    expect(descriptor).toMatchObject({
      name: 'release-check',
      path: '.extensions/skills/release-checks/SKILL.md',
      source: 'extensions',
      scope: 'workspace',
      allowImplicitInvocation: false,
    })
    await expect(skills.read(descriptor.id, descriptor.revision)).resolves.toEqual({
      descriptor,
      content,
    })
  })

  it('gives the default skill root deterministic precedence over configured duplicates', async () => {
    const root = await temporaryDirectory('code-assistant-skills-')
    await writeSkill(
      root,
      'shared',
      'shared-workflow',
      'Extension fallback',
      'Extension instructions.',
      'extensions',
    )
    await writeSkill(root, 'shared', 'shared-workflow', 'Agents primary', 'Agents instructions.')
    const skills = await createService(root, { sources: extendedSources })

    await expect(skills.list()).resolves.toEqual([
      expect.objectContaining({
        name: 'shared-workflow',
        description: 'Agents primary',
        source: 'agents',
        path: '.agents/skills/shared/SKILL.md',
      }),
    ])
  })

  it('rejects ambiguous or malformed implicit invocation controls', async () => {
    const root = await temporaryDirectory('code-assistant-skills-')
    await writeSkill(
      root,
      'ambiguous',
      'ambiguous-skill',
      'Must be skipped',
      'Instructions.',
      'extensions',
      'disable-model-invocation: true\nallow-implicit-invocation: true\n',
    )
    await writeSkill(
      root,
      'malformed',
      'malformed-skill',
      'Must also be skipped',
      'Instructions.',
      'agents',
      'allow-implicit-invocation: sometimes\n',
    )
    const skills = await createService(root, { sources: extendedSources })

    await expect(skills.list()).resolves.toEqual([])
  })
})
