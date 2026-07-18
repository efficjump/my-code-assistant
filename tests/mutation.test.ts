import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type MutationError,
  MutationService,
  type MutationServiceOptions,
} from '../src/main/services/mutation'

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function workspaceProvider(path: string): { getWorkspace(): { path: string } } {
  return { getWorkspace: () => ({ path }) }
}

async function writePendingJournal(input: {
  journals: string
  workspace: string
  actionHash: string
  path: string
  beforeContent: string
  afterContent: string
  beforeMode: number | null
  afterMode: number | null
}): Promise<string> {
  const root = await realpath(input.workspace)
  const directory = join(input.journals, hash(root).slice(0, 32))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(directory, 0o700)
  const journalPath = join(directory, '0000000000001-recovery.pending.v1.json')
  await writeFile(
    journalPath,
    `${JSON.stringify({
      version: 1,
      status: 'applied',
      id: 'recovery-test',
      root,
      actionHash: input.actionHash,
      summary: 'Recover an interrupted mutation',
      createdAt: new Date().toISOString(),
      changes: [
        {
          path: input.path,
          beforeHash: hash(input.beforeContent),
          afterHash: hash(input.afterContent),
          beforeContent: input.beforeContent,
          beforeMode: input.beforeMode,
          afterMode: input.afterMode,
        },
      ],
    })}\n`,
    { mode: 0o600 },
  )
  if (process.platform !== 'win32') await chmod(journalPath, 0o600)
  return journalPath
}

class FailingMutationService extends MutationService {
  constructor(
    path: string,
    options: MutationServiceOptions,
    private readonly failureIndex: number,
  ) {
    super(workspaceProvider(path), options)
  }

  protected override async beforeCommitChange(index: number): Promise<void> {
    if (index === this.failureIndex) throw new Error('injected commit failure')
  }
}

class FailingRollbackMutationService extends FailingMutationService {
  protected override async beforeRollbackChange(): Promise<void> {
    throw new Error('injected rollback failure')
  }
}

class ExternallyChangedRollbackMutationService extends MutationService {
  constructor(
    private readonly workspacePath: string,
    options: MutationServiceOptions,
  ) {
    super(workspaceProvider(workspacePath), options)
  }

  protected override async beforeCommitChange(index: number): Promise<void> {
    if (index !== 1) return
    await writeFile(join(this.workspacePath, 'a.txt'), 'external edit after install\n')
    throw new Error('injected later commit failure')
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('MutationService', () => {
  it('prepares deterministic diffs, applies atomically, preserves modes, and journals undo', async () => {
    const workspace = await temporaryDirectory('code-assistant-mutation-')
    const journals = await temporaryDirectory('code-assistant-mutation-journal-')
    await writeFile(join(workspace, 'update.txt'), 'before update\n')
    await chmod(join(workspace, 'update.txt'), 0o640)
    await writeFile(join(workspace, 'delete.txt'), 'before delete\n')
    const service = new MutationService(workspaceProvider(workspace), {
      journalDirectory: journals,
    })
    const proposal = {
      summary: 'Apply a three-file change',
      changes: [
        {
          path: 'update.txt',
          baseSha256: hash('before update\n'),
          newContent: 'after update\n',
        },
        { path: 'created.txt', baseSha256: null, newContent: 'created\n' },
        {
          path: 'delete.txt',
          baseSha256: hash('before delete\n'),
          newContent: null,
        },
      ],
    }

    const firstPreparation = await service.prepare(proposal)
    const secondPreparation = await service.prepare(proposal)
    expect(secondPreparation.actionHash).toBe(firstPreparation.actionHash)
    expect(firstPreparation.changes.map((change) => change.path)).toEqual([
      'created.txt',
      'delete.txt',
      'update.txt',
    ])
    expect(firstPreparation.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'created.txt', kind: 'create', additions: 1 }),
        expect.objectContaining({ path: 'delete.txt', kind: 'delete', deletions: 1 }),
        expect.objectContaining({
          path: 'update.txt',
          kind: 'update',
          additions: 1,
          deletions: 1,
        }),
      ]),
    )
    expect(firstPreparation.diff).toContain('--- a/update.txt')
    expect(firstPreparation.diff).toContain('+++ b/update.txt')

    const applied = await service.apply(firstPreparation)
    expect(applied.changedPaths).toEqual(['created.txt', 'delete.txt', 'update.txt'])
    expect(applied.undoAvailable).toBe(true)
    await expect(readFile(join(workspace, 'update.txt'), 'utf8')).resolves.toBe('after update\n')
    await expect(readFile(join(workspace, 'created.txt'), 'utf8')).resolves.toBe('created\n')
    await expect(access(join(workspace, 'delete.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (process.platform !== 'win32') {
      expect((await stat(join(workspace, 'update.txt'))).mode & 0o777).toBe(0o640)
      expect((await stat(join(workspace, 'created.txt'))).mode & 0o777).toBe(0o600)
    }

    const workspaceJournalDirectory = join(journals, hash(await realpath(workspace)).slice(0, 32))
    const journalNames = await readdir(workspaceJournalDirectory)
    expect(journalNames).toHaveLength(1)
    const journalStats = await stat(join(workspaceJournalDirectory, journalNames[0]))
    if (process.platform !== 'win32') expect(journalStats.mode & 0o777).toBe(0o600)

    const restartedService = new MutationService(workspaceProvider(workspace), {
      journalDirectory: journals,
    })
    const undone = await restartedService.undoLast()
    expect(undone.restoredPaths).toEqual(['created.txt', 'delete.txt', 'update.txt'])
    await expect(readFile(join(workspace, 'update.txt'), 'utf8')).resolves.toBe('before update\n')
    await expect(readFile(join(workspace, 'delete.txt'), 'utf8')).resolves.toBe('before delete\n')
    await expect(access(join(workspace, 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (process.platform !== 'win32') {
      expect((await stat(join(workspace, 'update.txt'))).mode & 0o777).toBe(0o640)
    }
    expect(await readdir(workspaceJournalDirectory)).toEqual([
      expect.stringMatching(/\.undone\.v1\.json$/),
    ])
  })

  it('prepares hash-bound non-overlapping patches and applies their exact replacements', async () => {
    const workspace = await temporaryDirectory('code-assistant-mutation-patch-')
    const journals = await temporaryDirectory('code-assistant-mutation-patch-journal-')
    const before = [
      'export function add(left: number, right: number) {',
      '  return left + right',
      '}',
      '',
      'export const label = "draft"',
      '',
    ].join('\n')
    await writeFile(join(workspace, 'math.ts'), before)
    const service = new MutationService(workspaceProvider(workspace), {
      journalDirectory: journals,
    })

    const prepared = await service.preparePatch({
      summary: 'Patch the implementation and label',
      patches: [
        {
          path: 'math.ts',
          baseSha256: hash(before),
          hunks: [
            {
              oldText: '  return left + right',
              newText: '  return Number(left) + Number(right)',
            },
            {
              oldText: 'export const label = "draft"',
              newText: 'export const label = "ready"',
            },
          ],
        },
      ],
    })

    expect(prepared.changes).toEqual([
      expect.objectContaining({ path: 'math.ts', kind: 'update', additions: 4, deletions: 4 }),
    ])
    expect(prepared.diff).toContain('-  return left + right')
    expect(prepared.diff).toContain('+  return Number(left) + Number(right)')
    await service.apply(prepared.actionHash)
    await expect(readFile(join(workspace, 'math.ts'), 'utf8')).resolves.toBe(
      before
        .replace('  return left + right', '  return Number(left) + Number(right)')
        .replace('export const label = "draft"', 'export const label = "ready"'),
    )
  })

  it('rejects ambiguous, overlapping, missing, and stale patch anchors before preparation', async () => {
    const workspace = await temporaryDirectory('code-assistant-mutation-patch-conflict-')
    const journals = await temporaryDirectory('code-assistant-mutation-patch-conflict-journal-')
    const before = 'repeat\nrepeat\nunique block\n'
    await writeFile(join(workspace, 'value.txt'), before)
    const service = new MutationService(workspaceProvider(workspace), {
      journalDirectory: journals,
    })
    const proposal = (
      hunks: Array<{ oldText: string; newText: string }>,
      baseSha256 = hash(before),
    ) =>
      service.preparePatch({
        summary: 'Conflict test',
        patches: [{ path: 'value.txt', baseSha256, hunks }],
      })
    const currentDetails = {
      path: 'value.txt',
      currentSha256: hash(before),
      expectedSha256: hash(before),
    }

    await expect(proposal([{ oldText: 'repeat', newText: 'changed' }])).rejects.toMatchObject({
      code: 'PATCH_CONFLICT',
      details: currentDetails,
    } satisfies Partial<MutationError>)
    await expect(
      proposal([
        { oldText: 'unique block', newText: 'first' },
        { oldText: 'block', newText: 'second' },
      ]),
    ).rejects.toMatchObject({
      code: 'PATCH_CONFLICT',
      details: currentDetails,
    } satisfies Partial<MutationError>)
    await expect(
      proposal([{ oldText: 'missing anchor', newText: 'changed' }]),
    ).rejects.toMatchObject({
      code: 'PATCH_CONFLICT',
      details: currentDetails,
    } satisfies Partial<MutationError>)
    const staleHash = hash('stale\n')
    await expect(
      proposal([{ oldText: 'unique block', newText: 'changed' }], staleHash),
    ).rejects.toMatchObject({
      code: 'HASH_CONFLICT',
      details: { ...currentDetails, expectedSha256: staleHash },
    } satisfies Partial<MutationError>)
    await expect(
      service.preparePatch({
        summary: 'Missing patch target',
        patches: [
          {
            path: 'missing.txt',
            baseSha256: staleHash,
            hunks: [{ oldText: 'missing', newText: 'changed' }],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'PATCH_CONFLICT',
      details: {
        path: 'missing.txt',
        currentSha256: null,
        expectedSha256: staleHash,
      },
    } satisfies Partial<MutationError>)
  })

  it('detects a dirty preimage both during prepare and immediately before apply', async () => {
    const workspace = await temporaryDirectory('code-assistant-mutation-')
    const journals = await temporaryDirectory('code-assistant-mutation-journal-')
    await writeFile(join(workspace, 'file.txt'), 'one\n')
    const service = new MutationService(workspaceProvider(workspace), {
      journalDirectory: journals,
    })

    await expect(
      service.prepare({
        summary: 'Wrong base',
        changes: [{ path: 'file.txt', baseSha256: hash('other\n'), newContent: 'two\n' }],
      }),
    ).rejects.toMatchObject({
      code: 'HASH_CONFLICT',
      details: {
        path: 'file.txt',
        currentSha256: hash('one\n'),
        expectedSha256: hash('other\n'),
      },
    } satisfies Partial<MutationError>)

    const prepared = await service.prepare({
      summary: 'Correct base',
      changes: [{ path: 'file.txt', baseSha256: hash('one\n'), newContent: 'two\n' }],
    })
    await writeFile(join(workspace, 'file.txt'), 'dirty after approval\n')

    await expect(service.apply(prepared.actionHash)).rejects.toMatchObject({
      code: 'HASH_CONFLICT',
      details: {
        path: 'file.txt',
        currentSha256: hash('dirty after approval\n'),
        expectedSha256: hash('one\n'),
      },
    } satisfies Partial<MutationError>)
    await expect(readFile(join(workspace, 'file.txt'), 'utf8')).resolves.toBe(
      'dirty after approval\n',
    )
  })

  it('rejects final symlinks and parent symlink escapes', async () => {
    const workspace = await temporaryDirectory('code-assistant-mutation-')
    const outside = await temporaryDirectory('code-assistant-mutation-outside-')
    const journals = await temporaryDirectory('code-assistant-mutation-journal-')
    await writeFile(join(outside, 'external.txt'), 'outside\n')
    await symlink(join(outside, 'external.txt'), join(workspace, 'final-link.txt'))
    await symlink(outside, join(workspace, 'escaped-parent'))
    const service = new MutationService(workspaceProvider(workspace), {
      journalDirectory: journals,
    })

    await expect(
      service.prepare({
        summary: 'Reject final link',
        changes: [{ path: 'final-link.txt', baseSha256: null, newContent: 'changed\n' }],
      }),
    ).rejects.toMatchObject({ code: 'SYMLINK_REJECTED' } satisfies Partial<MutationError>)
    await expect(
      service.prepare({
        summary: 'Reject escaped parent',
        changes: [
          { path: 'escaped-parent/external.txt', baseSha256: hash('outside\n'), newContent: 'x\n' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' } satisfies Partial<MutationError>)
    await expect(readFile(join(outside, 'external.txt'), 'utf8')).resolves.toBe('outside\n')
  })

  it('rejects a create below a missing parent without creating directories during prepare', async () => {
    const workspace = await temporaryDirectory('code-assistant-mutation-missing-parent-')
    const journals = await temporaryDirectory('code-assistant-mutation-missing-parent-journal-')
    const service = new MutationService(workspaceProvider(workspace), {
      journalDirectory: journals,
    })

    await expect(
      service.prepare({
        summary: 'Reject create below a missing parent',
        changes: [{ path: 'missing/nested.txt', baseSha256: null, newContent: 'created\n' }],
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_PATH',
      descriptor: {
        service: 'mutation',
        code: 'INVALID_PATH',
        identifier: 'parent-missing',
        path: 'missing/nested.txt',
        parentPath: 'missing',
      },
      details: { path: 'missing/nested.txt', parentPath: 'missing' },
      message: expect.stringMatching(/run_command.*\/bin\/mkdir -p --.*missing/s),
    } satisfies Partial<MutationError>)
    await expect(access(join(workspace, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back every earlier file when a later atomic commit fails', async () => {
    const workspace = await temporaryDirectory('code-assistant-mutation-')
    const journals = await temporaryDirectory('code-assistant-mutation-journal-')
    await writeFile(join(workspace, 'a.txt'), 'a-before\n')
    await writeFile(join(workspace, 'b.txt'), 'b-before\n')
    const service = new FailingMutationService(workspace, { journalDirectory: journals }, 1)
    const prepared = await service.prepare({
      summary: 'Two-file update',
      changes: [
        { path: 'a.txt', baseSha256: hash('a-before\n'), newContent: 'a-after\n' },
        { path: 'b.txt', baseSha256: hash('b-before\n'), newContent: 'b-after\n' },
      ],
    })

    await expect(service.apply(prepared.actionHash)).rejects.toMatchObject({
      code: 'APPLY_FAILED',
    } satisfies Partial<MutationError>)
    await expect(readFile(join(workspace, 'a.txt'), 'utf8')).resolves.toBe('a-before\n')
    await expect(readFile(join(workspace, 'b.txt'), 'utf8')).resolves.toBe('b-before\n')
    expect(
      (await readdir(workspace)).filter((name) => name.startsWith('.code-assistant-')),
    ).toEqual([])
  })

  it('retains the write-ahead marker when rollback fails and recovers on restart', async () => {
    const workspace = await temporaryDirectory('code-assistant-mutation-')
    const journals = await temporaryDirectory('code-assistant-mutation-journal-')
    await writeFile(join(workspace, 'a.txt'), 'a-before\n')
    await writeFile(join(workspace, 'b.txt'), 'b-before\n')
    const service = new FailingRollbackMutationService(workspace, { journalDirectory: journals }, 1)
    const prepared = await service.prepare({
      summary: 'Require restart recovery',
      changes: [
        { path: 'a.txt', baseSha256: hash('a-before\n'), newContent: 'a-after\n' },
        { path: 'b.txt', baseSha256: hash('b-before\n'), newContent: 'b-after\n' },
      ],
    })

    await expect(service.apply(prepared)).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
    } satisfies Partial<MutationError>)
    await expect(readFile(join(workspace, 'a.txt'), 'utf8')).resolves.toBe('a-after\n')
    await expect(readFile(join(workspace, 'b.txt'), 'utf8')).resolves.toBe('b-before\n')
    const directory = join(journals, hash(await realpath(workspace)).slice(0, 32))
    expect(await readdir(directory)).toEqual([expect.stringMatching(/\.pending\.v1\.json$/)])

    const restartedService = new MutationService(workspaceProvider(workspace), {
      journalDirectory: journals,
    })
    await expect(restartedService.recoverPending()).resolves.toMatchObject({
      actionHashes: [prepared.actionHash],
      restoredPaths: ['a.txt', 'b.txt'],
    })
    await expect(readFile(join(workspace, 'a.txt'), 'utf8')).resolves.toBe('a-before\n')
    await expect(readFile(join(workspace, 'b.txt'), 'utf8')).resolves.toBe('b-before\n')
  })

  it('preserves an externally replaced postimage and retains recovery state during rollback', async () => {
    const workspace = await temporaryDirectory('code-assistant-mutation-')
    const journals = await temporaryDirectory('code-assistant-mutation-journal-')
    await writeFile(join(workspace, 'a.txt'), 'a-before\n')
    await writeFile(join(workspace, 'b.txt'), 'b-before\n')
    const service = new ExternallyChangedRollbackMutationService(workspace, {
      journalDirectory: journals,
    })
    const prepared = await service.prepare({
      summary: 'Do not overwrite an external edit during rollback',
      changes: [
        { path: 'a.txt', baseSha256: hash('a-before\n'), newContent: 'a-after\n' },
        { path: 'b.txt', baseSha256: hash('b-before\n'), newContent: 'b-after\n' },
      ],
    })

    await expect(service.apply(prepared.actionHash)).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
    } satisfies Partial<MutationError>)
    await expect(readFile(join(workspace, 'a.txt'), 'utf8')).resolves.toBe(
      'external edit after install\n',
    )
    await expect(readFile(join(workspace, 'b.txt'), 'utf8')).resolves.toBe('b-before\n')
    const directory = join(journals, hash(await realpath(workspace)).slice(0, 32))
    expect(await readdir(directory)).toEqual([expect.stringMatching(/\.pending\.v1\.json$/)])

    const restartedService = new MutationService(workspaceProvider(workspace), {
      journalDirectory: journals,
    })
    await expect(restartedService.recoverPending()).rejects.toMatchObject({
      code: 'HASH_CONFLICT',
      details: {
        path: 'a.txt',
        currentSha256: hash('external edit after install\n'),
        expectedSha256: hash('a-after\n'),
      },
    } satisfies Partial<MutationError>)
    await expect(readFile(join(workspace, 'a.txt'), 'utf8')).resolves.toBe(
      'external edit after install\n',
    )
    expect(await readdir(directory)).toEqual([expect.stringMatching(/\.pending\.v1\.json$/)])
  })

  it('recovers an applied postimage from a pending write-ahead journal', async () => {
    const workspace = await temporaryDirectory('code-assistant-mutation-')
    const journals = await temporaryDirectory('code-assistant-mutation-journal-')
    const beforeContent = 'before interrupted apply\n'
    const afterContent = 'after interrupted apply\n'
    const beforeMode = process.platform === 'win32' ? null : 0o640
    const afterMode = process.platform === 'win32' ? null : 0o600
    const actionHash = hash('interrupted mutation action')
    const targetPath = join(workspace, 'file.txt')
    await writeFile(targetPath, afterContent)
    if (afterMode !== null) await chmod(targetPath, afterMode)
    const pendingJournalPath = await writePendingJournal({
      journals,
      workspace,
      actionHash,
      path: 'file.txt',
      beforeContent,
      afterContent,
      beforeMode,
      afterMode,
    })

    const restartedService = new MutationService(workspaceProvider(workspace), {
      journalDirectory: journals,
    })
    await expect(restartedService.recoverPending()).resolves.toEqual({
      actionHashes: [actionHash],
      restoredPaths: ['file.txt'],
    })
    await expect(readFile(targetPath, 'utf8')).resolves.toBe(beforeContent)
    if (beforeMode !== null) expect((await stat(targetPath)).mode & 0o777).toBe(beforeMode)
    await expect(access(pendingJournalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(restartedService.getUndoStatus()).resolves.toEqual({
      available: false,
      actionHash: null,
      journalId: null,
      summary: null,
      paths: [],
    })
  })

  it('completes an interrupted undo from a mixed before/after image', async () => {
    const workspace = await temporaryDirectory('code-assistant-mutation-')
    const journals = await temporaryDirectory('code-assistant-mutation-journal-')
    await writeFile(join(workspace, 'a.txt'), 'a-before\n')
    await writeFile(join(workspace, 'b.txt'), 'b-before\n')
    const service = new MutationService(workspaceProvider(workspace), {
      journalDirectory: journals,
    })
    const prepared = await service.prepare({
      summary: 'Prepare an undo crash image',
      changes: [
        { path: 'a.txt', baseSha256: hash('a-before\n'), newContent: 'a-after\n' },
        { path: 'b.txt', baseSha256: hash('b-before\n'), newContent: 'b-after\n' },
      ],
    })
    const applied = await service.apply(prepared)
    const directory = join(journals, hash(await realpath(workspace)).slice(0, 32))
    const appliedJournalPath = join(directory, applied.journalId)
    const undoPendingPath = appliedJournalPath.replace(/\.v1\.json$/, '.undo-pending.v1.json')
    await rename(appliedJournalPath, undoPendingPath)
    await writeFile(join(workspace, 'a.txt'), 'a-before\n')

    const restartedService = new MutationService(workspaceProvider(workspace), {
      journalDirectory: journals,
    })
    await expect(restartedService.recoverPending()).resolves.toEqual({
      actionHashes: [prepared.actionHash],
      restoredPaths: ['a.txt', 'b.txt'],
    })
    await expect(readFile(join(workspace, 'a.txt'), 'utf8')).resolves.toBe('a-before\n')
    await expect(readFile(join(workspace, 'b.txt'), 'utf8')).resolves.toBe('b-before\n')
    expect(await readdir(directory)).toEqual([expect.stringMatching(/\.undone\.v1\.json$/)])
    await expect(restartedService.getUndoStatus()).resolves.toMatchObject({ available: false })
  })

  it('fails closed and preserves an unknown file image during pending recovery', async () => {
    const workspace = await temporaryDirectory('code-assistant-mutation-')
    const journals = await temporaryDirectory('code-assistant-mutation-journal-')
    const beforeContent = 'approved preimage\n'
    const afterContent = 'approved postimage\n'
    const unknownContent = 'user edit after the crash\n'
    const currentMode = process.platform === 'win32' ? null : 0o600
    const actionHash = hash('conflicting interrupted mutation')
    const targetPath = join(workspace, 'file.txt')
    await writeFile(targetPath, unknownContent)
    if (currentMode !== null) await chmod(targetPath, currentMode)
    const pendingJournalPath = await writePendingJournal({
      journals,
      workspace,
      actionHash,
      path: 'file.txt',
      beforeContent,
      afterContent,
      beforeMode: currentMode,
      afterMode: currentMode,
    })

    const restartedService = new MutationService(workspaceProvider(workspace), {
      journalDirectory: journals,
    })
    await expect(restartedService.recoverPending()).rejects.toMatchObject({
      code: 'HASH_CONFLICT',
      details: {
        path: 'file.txt',
        currentSha256: hash(unknownContent),
        expectedSha256: hash(afterContent),
      },
    } satisfies Partial<MutationError>)
    await expect(readFile(targetPath, 'utf8')).resolves.toBe(unknownContent)
    await expect(access(pendingJournalPath)).resolves.toBeUndefined()
  })

  it('refuses undo when a postimage hash no longer matches', async () => {
    const workspace = await temporaryDirectory('code-assistant-mutation-')
    const journals = await temporaryDirectory('code-assistant-mutation-journal-')
    await writeFile(join(workspace, 'file.txt'), 'before\n')
    const service = new MutationService(workspaceProvider(workspace), {
      journalDirectory: journals,
    })
    const prepared = await service.prepare({
      summary: 'Update file',
      changes: [{ path: 'file.txt', baseSha256: hash('before\n'), newContent: 'approved after\n' }],
    })
    await service.apply(prepared.actionHash)
    await writeFile(join(workspace, 'file.txt'), 'changed after apply\n')

    await expect(service.undoLast()).rejects.toMatchObject({
      code: 'UNDO_CONFLICT',
    } satisfies Partial<MutationError>)
    await expect(readFile(join(workspace, 'file.txt'), 'utf8')).resolves.toBe(
      'changed after apply\n',
    )
  })

  it('rejects duplicate paths, directories, NUL content, and oversized proposals', async () => {
    const workspace = await temporaryDirectory('code-assistant-mutation-')
    const journals = await temporaryDirectory('code-assistant-mutation-journal-')
    await writeFile(join(workspace, 'file.txt'), 'before\n')
    await mkdir(join(workspace, 'directory'))
    const service = new MutationService(workspaceProvider(workspace), {
      journalDirectory: journals,
      maxFileBytes: 16,
    })

    await expect(
      service.prepare({
        summary: 'Duplicates',
        changes: [
          { path: 'file.txt', baseSha256: hash('before\n'), newContent: 'first\n' },
          { path: './file.txt', baseSha256: hash('before\n'), newContent: 'second\n' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_PATH' } satisfies Partial<MutationError>)
    await expect(
      service.prepare({
        summary: 'Directory',
        changes: [{ path: 'directory', baseSha256: null, newContent: 'text\n' }],
      }),
    ).rejects.toMatchObject({ code: 'NOT_REGULAR_FILE' } satisfies Partial<MutationError>)
    await expect(
      service.prepare({
        summary: 'NUL',
        changes: [{ path: 'new.txt', baseSha256: null, newContent: 'bad\0content' }],
      }),
    ).rejects.toMatchObject({ code: 'BINARY_FILE' } satisfies Partial<MutationError>)
    await expect(
      service.prepare({
        summary: 'Too large',
        changes: [{ path: 'new.txt', baseSha256: null, newContent: 'x'.repeat(17) }],
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' } satisfies Partial<MutationError>)

    expect((await lstat(join(workspace, 'directory'))).isDirectory()).toBe(true)
  })
})
