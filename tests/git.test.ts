import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService, type GitServiceError } from '../src/main/services/git'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function git(root: string, ...arguments_: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...arguments_], {
    encoding: 'utf8',
  })
  return stdout.trim()
}

async function repository(): Promise<string> {
  const root = await temporaryDirectory('code-assistant-git-')
  await git(root, 'init', '--quiet')
  await writeFile(join(root, 'tracked.txt'), 'initial\n')
  await writeFile(join(root, 'staged.txt'), 'before\n')
  await git(root, 'add', '--', 'tracked.txt', 'staged.txt')
  await git(
    root,
    '-c',
    'user.name=Code Assistant Test',
    '-c',
    'user.email=code-assistant@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'initial',
  )
  return root
}

function workspaceProvider(path: string): { getWorkspace(): { path: string } } {
  return { getWorkspace: () => ({ path }) }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('GitService', () => {
  it('returns repository identity and parsed porcelain status', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), 'changed in worktree\n')
    await writeFile(join(root, 'staged.txt'), 'changed in index\n')
    await git(root, 'add', '--', 'staged.txt')
    await writeFile(join(root, 'untracked file.txt'), 'new\n')
    const service = new GitService(workspaceProvider(root))

    const status = await service.getStatus()

    expect(status.repositoryRoot).toBe(await realpath(root))
    expect(status.head).toBe(await git(root, 'rev-parse', 'HEAD'))
    expect(status.branch).toBe(await git(root, 'branch', '--show-current'))
    expect(status.detached).toBe(false)
    expect(status.porcelainTruncated).toBe(false)
    expect(status.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'tracked.txt', index: ' ', worktree: 'M' }),
        expect.objectContaining({ path: 'staged.txt', index: 'M', worktree: ' ' }),
        expect.objectContaining({ path: 'untracked file.txt', index: '?', worktree: '?' }),
      ]),
    )
  })

  it('preserves both paths for a staged rename record', async () => {
    const root = await repository()
    await git(root, 'mv', 'tracked.txt', 'renamed file.txt')
    const service = new GitService(workspaceProvider(root))

    const status = await service.getStatus()

    expect(status.entries).toContainEqual({
      index: 'R',
      worktree: ' ',
      path: 'renamed file.txt',
      originalPath: 'tracked.txt',
    })
  })

  it('returns independently bounded staged and unstaged diffs', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), `unstaged-${'x'.repeat(300)}\n`)
    await writeFile(join(root, 'staged.txt'), `staged-${'y'.repeat(300)}\n`)
    await git(root, 'add', '--', 'staged.txt')
    const service = new GitService(workspaceProvider(root), { maxDiffBytes: 128 })

    const diff = await service.getDiff()

    expect(diff.staged.content).toContain('staged.txt')
    expect(diff.unstaged.content).toContain('tracked.txt')
    expect(diff.staged.capturedBytes).toBe(128)
    expect(diff.unstaged.capturedBytes).toBe(128)
    expect(diff.staged.totalBytes).toBeGreaterThan(diff.staged.capturedBytes)
    expect(diff.unstaged.totalBytes).toBeGreaterThan(diff.unstaged.capturedBytes)
    expect(diff.staged.truncated).toBe(true)
    expect(diff.unstaged.truncated).toBe(true)
  })

  it('supports a literal optional path without including another file', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.txt'), 'tracked changed\n')
    await writeFile(join(root, 'staged.txt'), 'staged changed\n')
    const service = new GitService(workspaceProvider(root))

    const diff = await service.getDiff({ path: 'tracked.txt' })

    expect(diff.path).toBe('tracked.txt')
    expect(diff.unstaged.content).toContain('tracked.txt')
    expect(diff.unstaged.content).not.toContain('staged.txt')
    expect(diff.staged.content).toBe('')
  })

  it('omits sensitive paths and blocks credential-like content in normal files', async () => {
    const root = await repository()
    await writeFile(join(root, '.env'), 'API_KEY=initial-placeholder\n')
    await git(root, 'add', '--', '.env')
    await git(
      root,
      '-c',
      'user.name=Code Assistant Test',
      '-c',
      'user.email=code-assistant@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'add env fixture',
    )
    await writeFile(
      join(root, '.env'),
      `API_KEY=${['sk', 'sensitive-value-that-must-never-leave'].join('-')}\n`,
    )
    await writeFile(join(root, 'tracked.txt'), 'safe change\n')
    const service = new GitService(workspaceProvider(root))

    const status = await service.getStatus()
    expect(status.entries.map((entry) => entry.path)).toContain('tracked.txt')
    expect(status.entries.map((entry) => entry.path)).not.toContain('.env')
    const diff = await service.getDiff()
    expect(diff.unstaged.content).toContain('safe change')
    expect(diff.unstaged.content).not.toContain('sensitive-value')
    await expect(service.getDiff({ path: '.env' })).rejects.toMatchObject({
      code: 'SENSITIVE_PATH',
    } satisfies Partial<GitServiceError>)

    await writeFile(
      join(root, 'tracked.txt'),
      `api_key = ${['sk', 'normal-path-secret-value-that-must-be-blocked'].join('-')}\n`,
    )
    await expect(service.getDiff({ path: 'tracked.txt' })).rejects.toMatchObject({
      code: 'SENSITIVE_CONTENT',
    } satisfies Partial<GitServiceError>)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects repository-defined clean filters without executing them',
    async () => {
      const root = await repository()
      const marker = join(root, 'clean-filter-ran')
      const filter = join(root, 'clean-filter.js')
      await writeFile(
        filter,
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\nprocess.stdin.pipe(process.stdout)\n`,
      )
      await chmod(filter, 0o700)
      await writeFile(join(root, '.gitattributes'), 'tracked.txt filter=untrusted\n')
      await git(root, 'config', '--local', 'filter.untrusted.clean', filter)
      await writeFile(join(root, 'tracked.txt'), 'changed\n')
      const service = new GitService(workspaceProvider(root))

      await expect(service.getStatus()).rejects.toMatchObject({
        code: 'UNSAFE_REPOSITORY',
      } satisfies Partial<GitServiceError>)
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'skips a PATH-shadowing Git executable inside the workspace',
    async () => {
      const root = await repository()
      const fakeBin = join(root, 'fake-bin')
      const fakeGit = join(fakeBin, 'git')
      const marker = join(root, 'fake-git-ran')
      await mkdir(fakeBin)
      await writeFile(
        fakeGit,
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`,
      )
      await chmod(fakeGit, 0o700)
      const originalPath = process.env.PATH
      process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ''}`
      try {
        const service = new GitService(workspaceProvider(root))
        await expect(service.getStatus()).resolves.toMatchObject({
          repositoryRoot: await realpath(root),
        })
      } finally {
        if (originalPath === undefined) delete process.env.PATH
        else process.env.PATH = originalPath
      }
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'does not execute a repository-configured external diff command',
    async () => {
      const root = await repository()
      const marker = join(root, 'external-diff-ran')
      const externalDiff = join(root, 'external-diff.js')
      await writeFile(
        externalDiff,
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`,
      )
      await chmod(externalDiff, 0o700)
      await git(root, 'config', '--local', 'diff.external', externalDiff)
      await writeFile(join(root, 'tracked.txt'), 'changed\n')
      const service = new GitService(workspaceProvider(root))

      const diff = await service.getDiff({ path: 'tracked.txt' })

      expect(diff.unstaged.content).toContain('tracked.txt')
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('rejects path traversal and non-repositories', async () => {
    const root = await repository()
    const service = new GitService(workspaceProvider(root))
    await expect(service.getDiff({ path: '../outside' })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    } satisfies Partial<GitServiceError>)

    const plainDirectory = await temporaryDirectory('code-assistant-not-git-')
    await expect(
      new GitService(workspaceProvider(plainDirectory)).getStatus(),
    ).rejects.toMatchObject({ code: 'NOT_A_REPOSITORY' } satisfies Partial<GitServiceError>)
  })
})
