import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  InstructionService,
  type InstructionServiceOptions,
} from '../src/main/services/instructions'
import { TrustStore } from '../src/main/services/trust'
import { WorkspaceService } from '../src/main/services/workspace'

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

const extendedSources: NonNullable<InstructionServiceOptions['sourceGroups']> = [
  {
    candidates: [
      { fileName: 'AGENTS.override.md', kind: 'agents-override' },
      { fileName: 'AGENTS.md', kind: 'agents' },
    ],
  },
  { candidates: [{ fileName: 'PROJECT.md', kind: 'project' }] },
]

async function setup(
  root: string,
  userData: string,
  trusted: boolean,
  options: InstructionServiceOptions = {},
) {
  const workspace = new WorkspaceService()
  await workspace.openWorkspace(root, false)
  const trust = new TrustStore({ userDataPath: userData })
  if (trusted) await trust.setWorkspaceTrust(root, true)
  return { workspace, instructions: new InstructionService(workspace, trust, options) }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('InstructionService', () => {
  it('does not inspect repository instructions before workspace trust', async () => {
    const root = await temporaryDirectory('code-assistant-instructions-')
    const userData = await temporaryDirectory('code-assistant-instructions-data-')
    await writeFile(join(root, 'AGENTS.md'), 'Untrusted instruction')
    const { instructions } = await setup(root, userData, false)

    await expect(instructions.load(['src/index.ts'])).resolves.toMatchObject({
      trusted: false,
      layers: [],
      totalBytes: 0,
    })
  })

  it('applies override precedence and deterministic root-to-context nesting with provenance', async () => {
    const root = await temporaryDirectory('code-assistant-instructions-')
    const userData = await temporaryDirectory('code-assistant-instructions-data-')
    await mkdir(join(root, 'src', 'feature'), { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), 'ignored root base')
    await writeFile(join(root, 'AGENTS.override.md'), 'root override')
    await writeFile(join(root, 'PROJECT.md'), 'root project')
    await writeFile(join(root, 'src', 'AGENTS.md'), 'src agents')
    await writeFile(join(root, 'src', 'feature', 'PROJECT.md'), 'feature project')
    await writeFile(join(root, 'src', 'feature', 'a.ts'), 'export const a = true')
    await writeFile(join(root, 'src', 'feature', 'b.ts'), 'export const b = true')
    const { instructions } = await setup(root, userData, true, { sourceGroups: extendedSources })

    const bundle = await instructions.load(['src/feature/b.ts', 'src/feature/a.ts'])
    expect(bundle.trusted).toBe(true)
    expect(
      bundle.layers.map(({ path, kind, content, precedence }) => ({
        path,
        kind,
        content,
        precedence,
      })),
    ).toEqual([
      {
        path: 'AGENTS.override.md',
        kind: 'agents-override',
        content: 'root override',
        precedence: 0,
      },
      { path: 'PROJECT.md', kind: 'project', content: 'root project', precedence: 1 },
      { path: 'src/AGENTS.md', kind: 'agents', content: 'src agents', precedence: 2 },
      {
        path: 'src/feature/PROJECT.md',
        kind: 'project',
        content: 'feature project',
        precedence: 3,
      },
    ])
    expect(bundle.layers.every(({ status }) => status === 'loaded')).toBe(true)
  })

  it('reports malformed, sensitive, and oversized sources without aborting other layers', async () => {
    const root = await temporaryDirectory('code-assistant-instructions-')
    const userData = await temporaryDirectory('code-assistant-instructions-data-')
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'AGENTS.override.md'), '   \n')
    await writeFile(join(root, 'PROJECT.md'), 'api_key = "provider-test-credential"')
    await writeFile(join(root, 'src', 'AGENTS.md'), 'x'.repeat(100))
    await writeFile(join(root, 'src', 'file.ts'), 'export {}')
    const { workspace } = await setup(root, userData, true)
    const trust = new TrustStore({ userDataPath: userData })
    const instructions = new InstructionService(workspace, trust, {
      perFileBytes: 64,
      sourceGroups: extendedSources,
    })

    const bundle = await instructions.load(['src/file.ts'])
    expect(bundle.layers.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: 'AGENTS.override.md', status: 'malformed' },
      { path: 'PROJECT.md', status: 'sensitive' },
      { path: 'src/AGENTS.md', status: 'oversized' },
    ])
    expect(bundle.totalBytes).toBe(0)
  })
})
