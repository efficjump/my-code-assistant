import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isPathContained,
  type WorkspaceError,
  WorkspaceService,
} from '../src/main/services/workspace'

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('isPathContained', () => {
  const workspaceRoot = resolve('/tmp', 'code-assistant-workspace')

  it('accepts the canonical root itself', () => {
    expect(isPathContained(workspaceRoot, workspaceRoot)).toBe(true)
  })

  it('accepts nested canonical paths', () => {
    expect(isPathContained(workspaceRoot, resolve(workspaceRoot, 'src', 'main.ts'))).toBe(true)
  })

  it('rejects a sibling with the same string prefix', () => {
    expect(isPathContained(workspaceRoot, `${workspaceRoot}-backup/file.ts`)).toBe(false)
  })

  it('rejects parent traversal after path normalization', () => {
    const escapedPath = resolve(workspaceRoot, '..', 'outside', 'secret.txt')
    expect(isPathContained(workspaceRoot, escapedPath)).toBe(false)
  })

  it('rejects a canonical symlink target outside the root', () => {
    const resolvedSymlinkTarget = resolve('/tmp', 'external-project', 'credentials.json')
    expect(isPathContained(workspaceRoot, resolvedSymlinkTarget)).toBe(false)
  })
})

describe('WorkspaceService security boundary', () => {
  it('rejects symlinks that resolve outside the selected workspace', async () => {
    const workspaceRoot = await temporaryDirectory('code-assistant-workspace-')
    const externalRoot = await temporaryDirectory('code-assistant-external-')
    await writeFile(join(externalRoot, 'outside.txt'), 'private')
    await symlink(join(externalRoot, 'outside.txt'), join(workspaceRoot, 'escape.txt'))

    const workspace = new WorkspaceService()
    await workspace.openWorkspace(workspaceRoot, false)

    await expect(workspace.readFile('escape.txt')).rejects.toMatchObject({
      code: 'OUTSIDE_WORKSPACE',
    } satisfies Partial<WorkspaceError>)
  })

  it('supports searching a specifically selected file', async () => {
    const workspaceRoot = await temporaryDirectory('code-assistant-workspace-')
    await mkdir(join(workspaceRoot, 'src'))
    await writeFile(join(workspaceRoot, 'src', 'index.ts'), 'const answer = 42\n')

    const workspace = new WorkspaceService()
    await workspace.openWorkspace(workspaceRoot, false)

    await expect(workspace.searchText('answer', { path: 'src/index.ts' })).resolves.toEqual([
      { path: 'src/index.ts', line: 1, column: 7, preview: 'const answer = 42' },
    ])
  })

  it('skips generated release trees during workspace traversal', async () => {
    const workspaceRoot = await temporaryDirectory('code-assistant-workspace-')
    await mkdir(join(workspaceRoot, 'release', 'Product.app', 'Contents'), { recursive: true })
    await mkdir(join(workspaceRoot, 'src'))
    await writeFile(
      join(workspaceRoot, 'release', 'Product.app', 'Contents', 'app.asar'),
      'archive',
    )
    await writeFile(join(workspaceRoot, 'src', 'index.ts'), 'export const ready = true\n')

    const workspace = new WorkspaceService()
    await workspace.openWorkspace(workspaceRoot, false)

    await expect(workspace.listFiles()).resolves.toEqual(['src/index.ts'])
    await expect(workspace.listTree()).resolves.toEqual([
      {
        name: 'src',
        path: 'src',
        kind: 'directory',
        hasChildren: true,
        children: [{ name: 'index.ts', path: 'src/index.ts', kind: 'file' }],
      },
    ])
  })

  it('loads deep source trees one directory at a time and distinguishes empty directories', async () => {
    const workspaceRoot = await temporaryDirectory('code-assistant-workspace-')
    await mkdir(join(workspaceRoot, 'backend', 'src', 'main', 'java', 'com', 'example'), {
      recursive: true,
    })
    await mkdir(join(workspaceRoot, 'empty'))
    await writeFile(
      join(workspaceRoot, 'backend', 'src', 'main', 'java', 'com', 'example', 'App.java'),
      'final class App {}\n',
    )

    const workspace = new WorkspaceService()
    await workspace.openWorkspace(workspaceRoot, false)

    const rootPage = await workspace.listWorkspace({ path: null, cursor: null })
    expect(rootPage).toMatchObject({ complete: true, nextCursor: null })
    expect(rootPage.entries).toEqual([
      { name: 'backend', path: 'backend', kind: 'directory', hasChildren: true },
      { name: 'empty', path: 'empty', kind: 'directory', hasChildren: false },
    ])

    const expectedDirectories = [
      ['backend', 'src'],
      ['backend/src', 'main'],
      ['backend/src/main', 'java'],
      ['backend/src/main/java', 'com'],
      ['backend/src/main/java/com', 'example'],
    ] as const
    for (const [path, childName] of expectedDirectories) {
      await expect(workspace.listWorkspace({ path, cursor: null })).resolves.toEqual({
        entries: [
          {
            name: childName,
            path: `${path}/${childName}`,
            kind: 'directory',
            hasChildren: true,
          },
        ],
        complete: true,
        nextCursor: null,
      })
    }
    await expect(
      workspace.listWorkspace({ path: 'backend/src/main/java/com/example', cursor: null }),
    ).resolves.toEqual({
      entries: [
        {
          name: 'App.java',
          path: 'backend/src/main/java/com/example/App.java',
          kind: 'file',
        },
      ],
      complete: true,
      nextCursor: null,
    })
  })

  it('continues deterministic directory pages without omissions or duplicates', async () => {
    const workspaceRoot = await temporaryDirectory('code-assistant-workspace-')
    await mkdir(join(workspaceRoot, 'src'))
    await writeFile(join(workspaceRoot, 'src', 'index.ts'), 'export {}\n')
    await writeFile(join(workspaceRoot, 'alpha.ts'), 'export {}\n')
    await writeFile(join(workspaceRoot, 'beta.ts'), 'export {}\n')
    await writeFile(join(workspaceRoot, 'gamma.ts'), 'export {}\n')
    await mkdir(join(workspaceRoot, 'node_modules'))
    await writeFile(join(workspaceRoot, 'node_modules', 'hidden.js'), 'module.exports = {}\n')
    await writeFile(join(workspaceRoot, '.env'), 'EXAMPLE=value\n')

    const workspace = new WorkspaceService({ limits: { treeEntries: 2 } })
    await workspace.openWorkspace(workspaceRoot, false)

    const paths: string[] = []
    let cursor: string | null = null
    let firstContinuation: string | null = null
    let pageCount = 0
    do {
      const page = await workspace.listWorkspace({ path: null, cursor })
      paths.push(...page.entries.map((entry) => entry.path))
      pageCount += 1
      if (page.complete) {
        expect(page.nextCursor).toBeNull()
        break
      }
      expect(page.nextCursor).toEqual(expect.any(String))
      cursor = page.nextCursor
      firstContinuation ??= page.nextCursor
      if (pageCount === 1) await rm(join(workspaceRoot, 'alpha.ts'))
    } while (pageCount < 10)

    expect(pageCount).toBe(2)
    expect(paths).toEqual(['src', 'alpha.ts', 'beta.ts', 'gamma.ts'])
    expect(new Set(paths).size).toBe(paths.length)

    expect(firstContinuation).not.toBeNull()
    const continuation = firstContinuation as string
    await expect(
      workspace.listWorkspace({ path: 'src', cursor: continuation }),
    ).rejects.toBeInstanceOf(RangeError)
    const tampered = `${continuation.slice(0, -1)}${continuation.endsWith('A') ? 'B' : 'A'}`
    await expect(workspace.listWorkspace({ path: null, cursor: tampered })).rejects.toBeInstanceOf(
      RangeError,
    )
  })

  it('lists internal directory aliases independently without global seen-directory gaps', async () => {
    const workspaceRoot = await temporaryDirectory('code-assistant-workspace-')
    await mkdir(join(workspaceRoot, 'source'))
    await writeFile(join(workspaceRoot, 'source', 'index.ts'), 'export const alias = true\n')
    await symlink(join(workspaceRoot, 'source'), join(workspaceRoot, 'alias'))

    const workspace = new WorkspaceService()
    await workspace.openWorkspace(workspaceRoot, false)

    await expect(workspace.listWorkspace({ path: null, cursor: null })).resolves.toEqual({
      entries: [
        { name: 'alias', path: 'alias', kind: 'directory', hasChildren: true },
        { name: 'source', path: 'source', kind: 'directory', hasChildren: true },
      ],
      complete: true,
      nextCursor: null,
    })
    await expect(workspace.listWorkspace({ path: 'alias', cursor: null })).resolves.toEqual({
      entries: [{ name: 'index.ts', path: 'alias/index.ts', kind: 'file' }],
      complete: true,
      nextCursor: null,
    })
  })

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'propagates unreadable directory errors instead of presenting them as empty',
    async () => {
      const workspaceRoot = await temporaryDirectory('code-assistant-workspace-')
      const lockedDirectory = join(workspaceRoot, 'locked')
      await mkdir(lockedDirectory)
      await writeFile(join(lockedDirectory, 'source.ts'), 'export {}\n')

      const workspace = new WorkspaceService()
      await workspace.openWorkspace(workspaceRoot, false)
      await chmod(lockedDirectory, 0o000)
      try {
        await expect(workspace.listWorkspace({ path: null, cursor: null })).rejects.toMatchObject({
          code: expect.stringMatching(/^(?:EACCES|EPERM)$/),
        })
      } finally {
        await chmod(lockedDirectory, 0o700)
      }
    },
  )

  it('truncates text at a valid UTF-8 boundary', async () => {
    const workspaceRoot = await temporaryDirectory('code-assistant-workspace-')
    await writeFile(join(workspaceRoot, 'unicode.txt'), `${'a'.repeat(9)}가`)

    const workspace = new WorkspaceService({ limits: { readBytes: 10 } })
    await workspace.openWorkspace(workspaceRoot, false)
    const preview = await workspace.readFile('unicode.txt')

    expect(preview.truncated).toBe(true)
    expect(preview.content).toBe('a'.repeat(9))
    expect(preview.sha256).toBeNull()
  })

  it('blocks sensitive roots, direct metadata reads, and likely credentials', async () => {
    const parent = await temporaryDirectory('code-assistant-workspace-')
    const sensitiveRoot = join(parent, '.ssh')
    await mkdir(sensitiveRoot)
    const sensitiveWorkspace = new WorkspaceService()
    await expect(sensitiveWorkspace.openWorkspace(sensitiveRoot, false)).rejects.toMatchObject({
      code: 'SENSITIVE_FILE',
    })

    const workspaceRoot = join(parent, 'project')
    await mkdir(join(workspaceRoot, '.git'), { recursive: true })
    await writeFile(join(workspaceRoot, '.git', 'config'), 'repository config')
    await writeFile(
      join(workspaceRoot, 'config.json'),
      `{"api_key":"${['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')}"}`,
    )
    const workspace = new WorkspaceService()
    await workspace.openWorkspace(workspaceRoot, false)

    await expect(workspace.readFile('.git/config')).rejects.toMatchObject({
      code: 'SENSITIVE_FILE',
    })
    await expect(workspace.readFile('config.json')).rejects.toMatchObject({
      code: 'SENSITIVE_FILE',
    })
  })
})
