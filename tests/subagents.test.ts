import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeReadOnlyToolAllowlist,
  SubagentProfilesService,
  type SubagentProfilesServiceOptions,
} from '../src/main/services/subagents'
import { WorkspaceService } from '../src/main/services/workspace'

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function createService(
  root: string,
  isTrusted: () => boolean = () => true,
  options: SubagentProfilesServiceOptions = {},
): Promise<SubagentProfilesService> {
  const workspace = new WorkspaceService()
  await workspace.openWorkspace(root, false)
  return new SubagentProfilesService(
    workspace,
    {
      isTrusted: async () => isTrusted(),
    },
    options,
  )
}

const extendedSources: NonNullable<SubagentProfilesServiceOptions['sources']> = [
  {
    directory: '.agents/agents',
    extension: '.md',
    source: 'agents',
    format: 'markdown',
  },
  {
    directory: '.extensions-a/agents',
    extension: '.toml',
    source: 'extension-a',
    format: 'toml',
  },
  {
    directory: '.extensions-b/agents',
    extension: '.md',
    source: 'extension-b',
    format: 'markdown',
  },
]

async function writeProfile(root: string, path: string, content: string): Promise<void> {
  const filePath = join(root, path)
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(filePath, content)
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('SubagentProfilesService', () => {
  it('always exposes stable built-in read-only profiles without loading untrusted workspace files', async () => {
    const root = await temporaryDirectory('code-assistant-subagents-')
    await writeProfile(
      root,
      '.agents/agents/workspace.md',
      `---
name: workspace-agent
description: Must remain unavailable
---
Do workspace work.
`,
    )
    const profiles = await createService(root, () => false)

    const descriptors = await profiles.list()
    expect(descriptors.map((profile) => profile.name)).toEqual([
      'explorer',
      'general',
      'reviewer',
      'tester',
    ])
    expect(descriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'builtin-agent:explorer',
          source: 'builtin',
          scope: 'builtin',
          path: null,
          model: null,
          tools: [
            'list_files',
            'read_file',
            'search_text',
            'git_status',
            'git_diff',
            'list_skills',
            'read_skill',
          ],
        }),
      ]),
    )
    expect(descriptors[0].revision).toMatch(/^[a-f0-9]{64}$/)
    await expect(profiles.read(descriptors[0].id, descriptors[0].revision)).resolves.toMatchObject({
      descriptor: descriptors[0],
      developerInstructions: expect.stringContaining('without modifying files'),
    })
  })

  it('parses compatible Markdown and TOML profiles with bounded read-only capabilities', async () => {
    const root = await temporaryDirectory('code-assistant-subagents-')
    await writeProfile(
      root,
      '.agents/agents/architecture.md',
      `---
name: Architecture_Reader
description: Map architecture and ownership boundaries
model: "fast-model"
tools: [Read, Grep, Bash, git-status, Read]
skills:
  - review-code
  - invalid skill
---
Map the relevant code and report evidence only.
`,
    )
    await writeProfile(
      root,
      '.extensions-a/agents/docs.toml',
      `name = "docs-researcher"
description = "Inspect repository documentation"
developer_instructions = """
Read relevant documentation and return a concise evidence summary.
Do not edit files.
"""
tools = ["Glob", "Read", "run_command"]
skills = ["docs-check"]
`,
    )
    await writeProfile(
      root,
      '.extensions-b/agents/tests.md',
      `---
name: test-reader
description: Inspect test coverage
developer_instructions: |
  Read existing tests.
  Identify missing failure modes.
tools:
  - Glob
  - Grep
  - Write
---
This body is ignored when explicit instructions are present.
`,
    )
    const profiles = await createService(root, () => true, { sources: extendedSources })

    const descriptors = await profiles.list()
    expect(descriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'architecture_reader',
          source: 'agents',
          scope: 'workspace',
          model: 'fast-model',
          tools: ['read_file', 'search_text', 'git_status'],
          skills: ['review-code'],
          path: '.agents/agents/architecture.md',
        }),
        expect.objectContaining({
          name: 'docs-researcher',
          source: 'extension-a',
          tools: ['list_files', 'read_file'],
          skills: ['docs-check'],
          path: '.extensions-a/agents/docs.toml',
        }),
        expect.objectContaining({
          name: 'test-reader',
          source: 'extension-b',
          tools: ['list_files', 'search_text'],
          path: '.extensions-b/agents/tests.md',
        }),
      ]),
    )

    const documentationProfile = descriptors.find((profile) => profile.name === 'docs-researcher')
    if (!documentationProfile)
      throw new Error('Expected the documentation profile to be discovered.')
    await expect(
      profiles.read(documentationProfile.id, documentationProfile.revision),
    ).resolves.toMatchObject({
      descriptor: documentationProfile,
      developerInstructions:
        'Read relevant documentation and return a concise evidence summary.\nDo not edit files.',
    })
  })

  it('uses deterministic source and lexical precedence, including trusted built-in overrides', async () => {
    const root = await temporaryDirectory('code-assistant-subagents-')
    const markdown = (name: string, description: string) => `---
name: ${name}
description: ${description}
---
Read the requested area without edits.
`
    await writeProfile(
      root,
      '.extensions-b/agents/shared.md',
      markdown('shared', 'Markdown extension fallback'),
    )
    await writeProfile(
      root,
      '.extensions-a/agents/shared.toml',
      `name = "shared"
description = "TOML extension fallback"
developer_instructions = "Read without edits."
`,
    )
    await writeProfile(root, '.agents/agents/z-last.md', markdown('shared', 'Agents later'))
    await writeProfile(root, '.agents/agents/a-first.md', markdown('shared', 'Agents first'))
    await writeProfile(
      root,
      '.extensions-b/agents/reviewer.md',
      markdown('reviewer', 'Workspace reviewer'),
    )
    const profiles = await createService(root, () => true, { sources: extendedSources })

    const descriptors = await profiles.list()
    expect(descriptors.filter((profile) => profile.name === 'shared')).toEqual([
      expect.objectContaining({
        description: 'Agents first',
        path: '.agents/agents/a-first.md',
        source: 'agents',
      }),
    ])
    expect(descriptors.filter((profile) => profile.name === 'reviewer')).toEqual([
      expect.objectContaining({
        description: 'Workspace reviewer',
        source: 'extension-b',
        scope: 'workspace',
      }),
    ])
  })

  it('binds reads to content revisions and stops exposing custom profiles after trust revocation', async () => {
    const root = await temporaryDirectory('code-assistant-subagents-')
    const path = '.agents/agents/research.md'
    await writeProfile(
      root,
      path,
      `---
name: researcher
description: Inspect a bounded area
---
Read the source and report findings.
`,
    )
    let trusted = true
    const profiles = await createService(root, () => trusted)
    const descriptor = (await profiles.list()).find((profile) => profile.name === 'researcher')
    if (!descriptor) throw new Error('Expected the researcher profile to be discovered.')

    await writeProfile(
      root,
      path,
      `---
name: researcher
description: Inspect a bounded area
---
Updated instructions.
`,
    )
    await expect(profiles.read(descriptor.id, descriptor.revision)).rejects.toMatchObject({
      code: 'REVISION_MISMATCH',
    })

    const current = (await profiles.list()).find((profile) => profile.name === 'researcher')
    if (!current) throw new Error('Expected the updated researcher profile to be discovered.')
    trusted = false
    await expect(profiles.read(current.id, current.revision)).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
    })
  })

  it('skips malformed and escaping profiles instead of widening their capabilities', async () => {
    const root = await temporaryDirectory('code-assistant-subagents-')
    const external = await temporaryDirectory('code-assistant-subagents-external-')
    await writeProfile(
      external,
      'outside.md',
      `---
name: outside
description: Must remain outside
---
Read outside data.
`,
    )
    await mkdir(join(root, '.agents', 'agents'), { recursive: true })
    await symlink(join(external, 'outside.md'), join(root, '.agents', 'agents', 'escaped.md'))
    await writeProfile(
      root,
      '.extensions-a/agents/malformed.toml',
      `[agent]
name = "malformed"
description = "Unsupported table"
developer_instructions = "Do work."
`,
    )
    const profiles = await createService(root, () => true, { sources: extendedSources })

    expect((await profiles.list()).map((profile) => profile.name)).toEqual([
      'explorer',
      'general',
      'reviewer',
      'tester',
    ])
    expect(normalizeReadOnlyToolAllowlist(['Bash', 'Write', 'Agent'])).toEqual([])
    expect(normalizeReadOnlyToolAllowlist(['Grep', 'Read', 'grep', 'Git.Diff'])).toEqual([
      'read_file',
      'search_text',
      'git_diff',
    ])
  })
})
