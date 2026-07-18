import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import {
  formatServiceErrorDescriptor,
  type MutationErrorCode,
  type MutationErrorDetail,
  type MutationServiceErrorDescriptor,
  SERVICE_ERROR_MARKER,
} from './service-error-messages'
import { isPathContained } from './workspace'

const JOURNAL_VERSION = 1
const DEFAULT_MAX_FILES = 50
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_HUNKS_PER_FILE = 100
const MAX_PATH_BYTES = 4_096
const MAX_SUMMARY_CHARACTERS = 2_000
const MAX_PREPARED_ACTIONS = 20
const JOURNAL_OVERHEAD_BYTES = 1024 * 1024
const JOURNAL_TEXT_EXPANSION_FACTOR = 2
const DIFF_CONTEXT_LINES = 3
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

export interface MutationWorkspaceProvider {
  getWorkspace(): { path: string } | null
}

export interface MutationChange {
  path: string
  baseSha256: string | null
  newContent: string | null
}

export interface MutationProposal {
  summary: string
  changes: MutationChange[]
}

export interface MutationPatchHunk {
  oldText: string
  newText: string
}

export interface MutationPatchChange {
  path: string
  baseSha256: string
  hunks: MutationPatchHunk[]
}

export interface MutationPatchProposal {
  summary: string
  patches: MutationPatchChange[]
}

export type MutationKind = 'create' | 'update' | 'delete'

export interface PreparedMutationChange {
  path: string
  kind: MutationKind
  diff: string
  additions: number
  deletions: number
  beforeHash: string | null
  afterHash: string | null
  previousMode: number | null
  nextMode: number | null
}

export interface PreparedMutation {
  actionHash: string
  summary: string
  diff: string
  changes: PreparedMutationChange[]
  preparedAt: string
}

export interface MutationOperationOptions {
  signal?: AbortSignal
}

export interface MutationUndoOptions extends MutationOperationOptions {
  expectedActionHash?: string
  expectedJournalId?: string
}

export interface AppliedMutation {
  actionHash: string
  journalId: string
  changedPaths: string[]
  undoAvailable: boolean
}

export interface UndoMutationResult {
  actionHash: string
  journalId: string
  restoredPaths: string[]
}

export interface MutationUndoStatus {
  available: boolean
  actionHash: string | null
  journalId: string | null
  summary: string | null
  paths: string[]
}

export interface MutationRecoveryResult {
  actionHashes: string[]
  restoredPaths: string[]
}

export interface MutationServiceOptions {
  journalDirectory?: string
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  maxHunksPerFile?: number
}

export type { MutationErrorCode } from './service-error-messages'

export interface MutationErrorDetails {
  path?: string
  parentPath?: string
  currentSha256?: string | null
  expectedSha256?: string | null
}

type MutationErrorOptions = ErrorOptions & { details?: MutationErrorDetails }

export class MutationError extends Error {
  readonly code: MutationErrorCode
  readonly details?: MutationErrorDetails
  readonly descriptor: MutationServiceErrorDescriptor
  readonly [SERVICE_ERROR_MARKER] = true as const

  constructor(detail: MutationErrorDetail, options?: MutationErrorOptions)
  constructor(code: MutationErrorCode, message: string, options?: MutationErrorOptions)
  constructor(
    detailOrCode: MutationErrorDetail | MutationErrorCode,
    messageOrOptions?: string | MutationErrorOptions,
    legacyOptions?: MutationErrorOptions,
  ) {
    const options = typeof messageOrOptions === 'string' ? legacyOptions : messageOrOptions
    const descriptor = (
      typeof detailOrCode === 'string'
        ? { service: 'mutation', code: detailOrCode, ...options?.details }
        : { service: 'mutation', ...detailOrCode, ...options?.details }
    ) as MutationServiceErrorDescriptor
    const message =
      typeof messageOrOptions === 'string'
        ? messageOrOptions
        : formatServiceErrorDescriptor('ko', descriptor)
    super(message, options)
    this.name = 'MutationError'
    this.code = descriptor.code
    this.descriptor = descriptor
    const detailFields =
      options?.details ?? (typeof detailOrCode === 'string' ? undefined : detailOrCode)
    this.details =
      detailFields &&
      (detailFields.path !== undefined ||
        detailFields.parentPath !== undefined ||
        detailFields.currentSha256 !== undefined ||
        detailFields.expectedSha256 !== undefined)
        ? {
            ...(detailFields.path !== undefined ? { path: detailFields.path } : {}),
            ...(detailFields.parentPath !== undefined
              ? { parentPath: detailFields.parentPath }
              : {}),
            ...(detailFields.currentSha256 !== undefined
              ? { currentSha256: detailFields.currentSha256 }
              : {}),
            ...(detailFields.expectedSha256 !== undefined
              ? { expectedSha256: detailFields.expectedSha256 }
              : {}),
          }
        : undefined
  }
}

interface InspectedFile {
  displayPath: string
  targetPath: string
  parentPath: string
  content: string | null
  contentBytes: Buffer | null
  sha256: string | null
  mode: number | null
}

interface InternalPreparedChange extends PreparedMutationChange {
  targetPath: string
  parentPath: string
  previousContent: string | null
  newContent: string | null
}

interface InternalPreparedMutation {
  root: string
  actionHash: string
  summary: string
  diff: string
  changes: InternalPreparedChange[]
  preparedAt: string
}

interface CommitPlan {
  displayPath: string
  targetPath: string
  parentPath: string
  expectedHash: string | null
  expectedMode: number | null
  newContent: string | null
  newMode: number | null
}

interface StagedCommitPlan extends CommitPlan {
  temporaryPath: string | null
}

interface AppliedCommit {
  plan: StagedCommitPlan
  backupPath: string | null
  installed: boolean
}

interface MutationJournalChange {
  path: string
  beforeHash: string | null
  afterHash: string | null
  beforeContent: string | null
  beforeMode: number | null
  afterMode: number | null
}

interface MutationJournal {
  version: typeof JOURNAL_VERSION
  status: 'applied'
  id: string
  root: string
  actionHash: string
  summary: string
  createdAt: string
  changes: MutationJournalChange[]
}

interface JournalWithPath {
  journal: MutationJournal
  path: string
  directory: string
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`)
  }
  return value
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function portablePath(path: string): string {
  return path.split(sep).join('/')
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function containsPathControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if ((codePoint > 0 && codePoint < 32) || codePoint === 127) return true
  }
  return false
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function assertNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw new MutationError({ code: 'CANCELLED' })
}

function assertSha256(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new MutationError({ code: 'INVALID_PROPOSAL', identifier: 'sha256', field: name })
  }
}

function assertJournalSha256(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new MutationError('JOURNAL_INVALID', `${name} must be a lowercase SHA-256 hash.`)
  }
}

function decodeText(bytes: Buffer, displayPath: string): string {
  if (bytes.includes(0)) {
    throw new MutationError({
      code: 'BINARY_FILE',
      identifier: 'nul-content',
      path: displayPath,
    })
  }

  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192))
  let controlCharacters = 0
  for (const byte of sample) {
    const allowedWhitespace = byte === 9 || byte === 10 || byte === 12 || byte === 13
    if (!allowedWhitespace && (byte < 32 || byte === 127)) controlCharacters += 1
  }
  if (sample.length > 0 && controlCharacters / sample.length > 0.1) {
    throw new MutationError({
      code: 'BINARY_FILE',
      identifier: 'binary-content',
      path: displayPath,
    })
  }

  try {
    return UTF8_DECODER.decode(bytes)
  } catch (error) {
    throw new MutationError(
      { code: 'BINARY_FILE', identifier: 'invalid-utf8', path: displayPath },
      { cause: error },
    )
  }
}

function contentLines(content: string | null): string[] {
  if (content === null || content.length === 0) return []
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  return lines
}

function unifiedRangeStart(zeroBasedIndex: number, count: number): number {
  return count === 0 ? zeroBasedIndex : zeroBasedIndex + 1
}

function createHumanDiff(
  path: string,
  before: string | null,
  after: string | null,
): { diff: string; additions: number; deletions: number } {
  const oldLines = contentLines(before)
  const newLines = contentLines(after)
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const removed = oldLines.slice(prefix, oldLines.length - suffix)
  const added = newLines.slice(prefix, newLines.length - suffix)
  const oldContextStart = Math.max(0, prefix - DIFF_CONTEXT_LINES)
  const newContextStart = Math.max(0, prefix - DIFF_CONTEXT_LINES)
  const oldContextEnd = Math.min(oldLines.length, oldLines.length - suffix + DIFF_CONTEXT_LINES)
  const newContextEnd = Math.min(newLines.length, newLines.length - suffix + DIFF_CONTEXT_LINES)
  const oldCount = oldContextEnd - oldContextStart
  const newCount = newContextEnd - newContextStart
  const lines = [
    `--- ${before === null ? '/dev/null' : `a/${path}`}`,
    `+++ ${after === null ? '/dev/null' : `b/${path}`}`,
  ]

  if (removed.length > 0 || added.length > 0 || before !== after) {
    lines.push(
      `@@ -${unifiedRangeStart(oldContextStart, oldCount)},${oldCount} +${unifiedRangeStart(newContextStart, newCount)},${newCount} @@`,
    )
    for (const line of oldLines.slice(oldContextStart, prefix)) lines.push(` ${line}`)
    for (const line of removed) lines.push(`-${line}`)
    for (const line of added) lines.push(`+${line}`)
    for (const line of newLines.slice(newLines.length - suffix, newContextEnd)) {
      lines.push(` ${line}`)
    }
    if (before !== null && before.length > 0 && !before.endsWith('\n')) {
      lines.push('\\ No newline at end of file (before)')
    }
    if (after !== null && after.length > 0 && !after.endsWith('\n')) {
      lines.push('\\ No newline at end of file (after)')
    }
  }

  return { diff: lines.join('\n'), additions: added.length, deletions: removed.length }
}

function publicPreparedMutation(internal: InternalPreparedMutation): PreparedMutation {
  return {
    actionHash: internal.actionHash,
    summary: internal.summary,
    diff: internal.diff,
    changes: internal.changes.map((change) => ({
      path: change.path,
      kind: change.kind,
      diff: change.diff,
      additions: change.additions,
      deletions: change.deletions,
      beforeHash: change.beforeHash,
      afterHash: change.afterHash,
      previousMode: change.previousMode,
      nextMode: change.nextMode,
    })),
    preparedAt: internal.preparedAt,
  }
}

/**
 * Prepares content-addressed text changes, applies them with same-directory atomic replacement,
 * and keeps private versioned journals that can safely restore the last postimage.
 */
export class MutationService {
  private readonly journalDirectory: string
  private readonly maxFiles: number
  private readonly maxFileBytes: number
  private readonly maxTotalBytes: number
  private readonly maxHunksPerFile: number
  private readonly preparedActions = new Map<string, InternalPreparedMutation>()
  private lastJournalSequence = 0
  private operationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly workspace: MutationWorkspaceProvider,
    options: MutationServiceOptions = {},
  ) {
    this.journalDirectory =
      options.journalDirectory ?? join(tmpdir(), 'my-code-assistant-mutation-journals')
    this.maxFiles = positiveInteger(options.maxFiles ?? DEFAULT_MAX_FILES, 'maxFiles')
    this.maxFileBytes = positiveInteger(
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      'maxFileBytes',
    )
    this.maxTotalBytes = positiveInteger(
      options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      'maxTotalBytes',
    )
    this.maxHunksPerFile = positiveInteger(
      options.maxHunksPerFile ?? DEFAULT_MAX_HUNKS_PER_FILE,
      'maxHunksPerFile',
    )
  }

  prepare(
    proposal: MutationProposal,
    options: MutationOperationOptions = {},
  ): Promise<PreparedMutation> {
    return this.serializeOperation(() => this.prepareUnlocked(proposal, options))
  }

  preparePatch(
    proposal: MutationPatchProposal,
    options: MutationOperationOptions = {},
  ): Promise<PreparedMutation> {
    return this.serializeOperation(() => this.preparePatchUnlocked(proposal, options))
  }

  private async preparePatchUnlocked(
    proposal: MutationPatchProposal,
    options: MutationOperationOptions,
  ): Promise<PreparedMutation> {
    assertNotAborted(options.signal)
    const root = await this.requireWorkspaceRoot()
    await this.assertNoPendingJournals(root)
    const summary = this.validateSummary(proposal?.summary)
    if (
      !proposal ||
      !Array.isArray(proposal.patches) ||
      proposal.patches.length < 1 ||
      proposal.patches.length > this.maxFiles
    ) {
      throw new MutationError({
        code: 'INVALID_PROPOSAL',
        identifier: 'patch-file-count',
        minimum: 1,
        maximum: this.maxFiles,
      })
    }

    const seenPaths = new Set<string>()
    const changes: MutationChange[] = []
    let totalPatchBytes = 0
    for (let fileIndex = 0; fileIndex < proposal.patches.length; fileIndex += 1) {
      assertNotAborted(options.signal)
      const requested = proposal.patches[fileIndex]
      if (!requested || typeof requested !== 'object') {
        throw new MutationError({
          code: 'INVALID_PROPOSAL',
          identifier: 'patch-entry',
          index: fileIndex,
        })
      }
      const path = this.normalizeMutationPath(root, requested.path)
      if (seenPaths.has(path)) {
        throw new MutationError({ code: 'DUPLICATE_PATH', identifier: 'patch-duplicate', path })
      }
      seenPaths.add(path)
      assertSha256(requested.baseSha256, `patches[${fileIndex}].baseSha256`)
      if (
        !Array.isArray(requested.hunks) ||
        requested.hunks.length < 1 ||
        requested.hunks.length > this.maxHunksPerFile
      ) {
        throw new MutationError({
          code: 'INVALID_PROPOSAL',
          identifier: 'patch-hunk-count',
          index: fileIndex,
          minimum: 1,
          maximum: this.maxHunksPerFile,
        })
      }

      const current = await this.inspectFile(root, path, options.signal)
      if (current.content === null || current.sha256 === null) {
        throw new MutationError({
          code: 'PATCH_CONFLICT',
          identifier: 'patch-target-missing',
          path,
          currentSha256: null,
          expectedSha256: requested.baseSha256,
        })
      }
      if (requested.baseSha256 !== current.sha256) {
        throw new MutationError({
          code: 'HASH_CONFLICT',
          identifier: 'file-changed',
          path,
          currentSha256: current.sha256,
          expectedSha256: requested.baseSha256,
        })
      }

      const replacements: Array<{ start: number; end: number; newText: string }> = []
      for (let hunkIndex = 0; hunkIndex < requested.hunks.length; hunkIndex += 1) {
        const hunk = requested.hunks[hunkIndex]
        if (
          !hunk ||
          typeof hunk !== 'object' ||
          typeof hunk.oldText !== 'string' ||
          hunk.oldText.length === 0 ||
          typeof hunk.newText !== 'string'
        ) {
          throw new MutationError({
            code: 'INVALID_PROPOSAL',
            identifier: 'patch-hunk',
            index: fileIndex,
            hunkIndex,
          })
        }
        totalPatchBytes +=
          Buffer.byteLength(hunk.oldText, 'utf8') + Buffer.byteLength(hunk.newText, 'utf8')
        if (totalPatchBytes > this.maxTotalBytes) {
          throw new MutationError({
            code: 'FILE_TOO_LARGE',
            identifier: 'patch-total',
            maximumBytes: this.maxTotalBytes,
          })
        }
        const start = current.content.indexOf(hunk.oldText)
        if (start < 0) {
          throw new MutationError({
            code: 'PATCH_CONFLICT',
            identifier: 'patch-no-match',
            path,
            hunkIndex,
            currentSha256: current.sha256,
            expectedSha256: requested.baseSha256,
          })
        }
        if (current.content.indexOf(hunk.oldText, start + 1) >= 0) {
          throw new MutationError({
            code: 'PATCH_CONFLICT',
            identifier: 'patch-ambiguous',
            path,
            hunkIndex,
            currentSha256: current.sha256,
            expectedSha256: requested.baseSha256,
          })
        }
        replacements.push({ start, end: start + hunk.oldText.length, newText: hunk.newText })
      }

      replacements.sort((left, right) => left.start - right.start)
      for (let index = 1; index < replacements.length; index += 1) {
        if (replacements[index].start < replacements[index - 1].end) {
          throw new MutationError({
            code: 'PATCH_CONFLICT',
            identifier: 'patch-overlap',
            path,
            currentSha256: current.sha256,
            expectedSha256: requested.baseSha256,
          })
        }
      }
      let newContent = current.content
      for (const replacement of [...replacements].reverse()) {
        newContent =
          newContent.slice(0, replacement.start) +
          replacement.newText +
          newContent.slice(replacement.end)
      }
      changes.push({ path, baseSha256: requested.baseSha256, newContent })
    }

    return this.prepareUnlocked({ summary, changes }, options)
  }

  private async prepareUnlocked(
    proposal: MutationProposal,
    options: MutationOperationOptions,
  ): Promise<PreparedMutation> {
    assertNotAborted(options.signal)
    const root = await this.requireWorkspaceRoot()
    await this.assertNoPendingJournals(root)
    const summary = this.validateSummary(proposal?.summary)
    if (
      !proposal ||
      !Array.isArray(proposal.changes) ||
      proposal.changes.length < 1 ||
      proposal.changes.length > this.maxFiles
    ) {
      throw new MutationError({
        code: 'INVALID_PROPOSAL',
        identifier: 'change-count',
        minimum: 1,
        maximum: this.maxFiles,
      })
    }

    const seenPaths = new Set<string>()
    const changes: InternalPreparedChange[] = []
    let totalBytes = 0

    for (let index = 0; index < proposal.changes.length; index += 1) {
      assertNotAborted(options.signal)
      const requested = proposal.changes[index]
      if (!requested || typeof requested !== 'object') {
        throw new MutationError({
          code: 'INVALID_PROPOSAL',
          identifier: 'change-entry',
          index,
        })
      }
      const path = this.normalizeMutationPath(root, requested.path)
      if (seenPaths.has(path)) {
        throw new MutationError({ code: 'DUPLICATE_PATH', identifier: 'change-duplicate', path })
      }
      seenPaths.add(path)

      if (requested.baseSha256 !== null) {
        assertSha256(requested.baseSha256, `changes[${index}].baseSha256`)
      }
      if (requested.newContent !== null && typeof requested.newContent !== 'string') {
        throw new MutationError({
          code: 'INVALID_PROPOSAL',
          identifier: 'new-content',
          index,
        })
      }

      const current = await this.inspectFile(root, path, options.signal)
      if (requested.baseSha256 !== current.sha256) {
        throw new MutationError({
          code: 'HASH_CONFLICT',
          identifier:
            requested.baseSha256 === null && current.sha256 !== null
              ? 'create-conflict'
              : 'file-changed',
          path,
          currentSha256: current.sha256,
          expectedSha256: requested.baseSha256,
        })
      }

      let newBytes: Buffer | null = null
      let afterHash: string | null = null
      if (requested.newContent !== null) {
        newBytes = Buffer.from(requested.newContent, 'utf8')
        if (newBytes.length > this.maxFileBytes) {
          throw new MutationError({
            code: 'FILE_TOO_LARGE',
            identifier: 'file-content',
            path,
            maximumBytes: this.maxFileBytes,
          })
        }
        decodeText(newBytes, path)
        afterHash = sha256(newBytes)
      }
      totalBytes += (current.contentBytes?.length ?? 0) + (newBytes?.length ?? 0)
      if (totalBytes > this.maxTotalBytes) {
        throw new MutationError({
          code: 'FILE_TOO_LARGE',
          identifier: 'proposal-total',
          maximumBytes: this.maxTotalBytes,
        })
      }
      if (current.sha256 === null && requested.newContent === null) {
        throw new MutationError({
          code: 'INVALID_PROPOSAL',
          identifier: 'delete-missing',
          path,
        })
      }
      if (current.sha256 === afterHash) {
        throw new MutationError({ code: 'INVALID_PROPOSAL', identifier: 'unchanged', path })
      }

      const kind: MutationKind =
        current.sha256 === null ? 'create' : requested.newContent === null ? 'delete' : 'update'
      const humanDiff = createHumanDiff(path, current.content, requested.newContent)
      changes.push({
        path,
        kind,
        diff: humanDiff.diff,
        additions: humanDiff.additions,
        deletions: humanDiff.deletions,
        beforeHash: current.sha256,
        afterHash,
        previousMode: current.mode,
        nextMode:
          requested.newContent === null
            ? null
            : process.platform === 'win32'
              ? null
              : (current.mode ?? 0o600),
        targetPath: current.targetPath,
        parentPath: current.parentPath,
        previousContent: current.content,
        newContent: requested.newContent,
      })
    }

    changes.sort((left, right) => compareCodeUnits(left.path, right.path))
    const diff = changes.map((change) => change.diff).join('\n\n')
    const actionHash = this.computeActionHash(root, summary, changes)
    const internal: InternalPreparedMutation = {
      root,
      actionHash,
      summary,
      diff,
      changes,
      preparedAt: new Date().toISOString(),
    }
    this.preparedActions.delete(actionHash)
    this.preparedActions.set(actionHash, internal)
    while (this.preparedActions.size > MAX_PREPARED_ACTIONS) {
      const oldest = this.preparedActions.keys().next().value
      if (typeof oldest !== 'string') break
      this.preparedActions.delete(oldest)
    }
    return publicPreparedMutation(internal)
  }

  apply(
    reference: string | Pick<PreparedMutation, 'actionHash'>,
    options: MutationOperationOptions = {},
  ): Promise<AppliedMutation> {
    return this.serializeOperation(() => this.applyUnlocked(reference, options))
  }

  private async applyUnlocked(
    reference: string | Pick<PreparedMutation, 'actionHash'>,
    options: MutationOperationOptions,
  ): Promise<AppliedMutation> {
    assertNotAborted(options.signal)
    const actionHash = typeof reference === 'string' ? reference : reference?.actionHash
    if (typeof actionHash !== 'string') {
      throw new MutationError({ code: 'ACTION_NOT_FOUND', identifier: 'hash-required' })
    }
    const prepared = this.preparedActions.get(actionHash)
    if (!prepared) {
      throw new MutationError({
        code: 'ACTION_NOT_FOUND',
        identifier: 'prepared-action-missing',
      })
    }
    // Consume before the first await so one approval can never be replayed, even after failure.
    this.preparedActions.delete(actionHash)
    const root = await this.requireWorkspaceRoot()
    await this.assertNoPendingJournals(root)
    if (root !== prepared.root) {
      throw new MutationError({
        code: 'ACTION_NOT_FOUND',
        identifier: 'workspace-changed',
        actionHash,
      })
    }
    if (this.computeActionHash(root, prepared.summary, prepared.changes) !== actionHash) {
      this.preparedActions.delete(actionHash)
      throw new MutationError({
        code: 'ACTION_TAMPERED',
        identifier: 'integrity-check',
        actionHash,
      })
    }

    const plans: CommitPlan[] = []
    for (const change of prepared.changes) {
      assertNotAborted(options.signal)
      const current = await this.inspectFile(root, change.path, options.signal)
      this.assertPreimage(
        current,
        change.beforeHash,
        change.previousMode,
        change.path,
        'HASH_CONFLICT',
      )
      if (current.targetPath !== change.targetPath || current.parentPath !== change.parentPath) {
        throw new MutationError({
          code: 'HASH_CONFLICT',
          identifier: 'file-changed',
          path: change.path,
          currentSha256: current.sha256,
          expectedSha256: change.beforeHash,
        })
      }
      plans.push({
        displayPath: change.path,
        targetPath: current.targetPath,
        parentPath: current.parentPath,
        expectedHash: change.beforeHash,
        expectedMode: change.previousMode,
        newContent: change.newContent,
        newMode: change.nextMode,
      })
    }

    const journal = this.createJournal(prepared)
    const pendingJournalPath = await this.writeJournal(root, journal, true)
    let staged: StagedCommitPlan[] = []
    const applied: AppliedCommit[] = []
    try {
      staged = await this.stageCommitPlans(plans, options.signal)
      await this.commitPlans(root, staged, 'apply', applied, options.signal)
      assertNotAborted(options.signal)
      await this.verifyPostimages(
        root,
        prepared.changes.map((change) => ({
          path: change.path,
          hash: change.afterHash,
          mode: change.nextMode,
        })),
        'HASH_CONFLICT',
        options.signal,
      )
      const journalPath = await this.finalizePendingJournal(pendingJournalPath)
      await this.finalizeAppliedCommits(applied)
      return {
        actionHash,
        journalId: basename(journalPath),
        changedPaths: prepared.changes.map((change) => change.path),
        undoAvailable: true,
      }
    } catch (error) {
      const rollbackError = await this.rollbackAppliedCommits(root, applied)
      await this.cleanStagedTemps(staged)
      let journalCleanupError: Error | null = null
      if (!rollbackError) {
        try {
          await unlink(pendingJournalPath)
          await this.syncDirectory(dirname(pendingJournalPath)).catch(() => undefined)
        } catch (cleanupError) {
          journalCleanupError =
            cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
        }
      }
      if (rollbackError || journalCleanupError) {
        throw new MutationError(
          { code: 'RECOVERY_REQUIRED', identifier: 'apply', actionHash },
          {
            cause: new AggregateError(
              [error, rollbackError, journalCleanupError].filter(
                (failure): failure is Error => failure instanceof Error,
              ),
            ),
          },
        )
      }
      if (error instanceof MutationError) throw error
      throw new MutationError(
        { code: 'APPLY_FAILED', identifier: 'apply', actionHash },
        { cause: error },
      )
    }
  }

  undoLast(options: MutationUndoOptions = {}): Promise<UndoMutationResult> {
    return this.serializeOperation(() => this.undoLastUnlocked(options))
  }

  getUndoStatus(): Promise<MutationUndoStatus> {
    return this.serializeOperation(async () => {
      const root = await this.requireWorkspaceRoot()
      await this.assertNoPendingJournals(root)
      try {
        const located = await this.readLatestJournal(root)
        return {
          available: true,
          actionHash: located.journal.actionHash,
          journalId: basename(located.path),
          summary: located.journal.summary,
          paths: located.journal.changes.map((change) => change.path),
        }
      } catch (error) {
        if (error instanceof MutationError && error.code === 'NO_UNDO') {
          return {
            available: false,
            actionHash: null,
            journalId: null,
            summary: null,
            paths: [],
          }
        }
        throw error
      }
    })
  }

  recoverPending(): Promise<MutationRecoveryResult> {
    return this.serializeOperation(() => this.recoverPendingUnlocked())
  }

  private async undoLastUnlocked(options: MutationUndoOptions): Promise<UndoMutationResult> {
    assertNotAborted(options.signal)
    const root = await this.requireWorkspaceRoot()
    await this.assertNoPendingJournals(root)
    const located = await this.readLatestJournal(root)
    if (
      (options.expectedActionHash && options.expectedActionHash !== located.journal.actionHash) ||
      (options.expectedJournalId && options.expectedJournalId !== basename(located.path))
    ) {
      throw new MutationError({
        code: 'UNDO_CONFLICT',
        identifier: 'latest-action-changed',
        actionHash: located.journal.actionHash,
        journalId: basename(located.path),
      })
    }
    const plans: CommitPlan[] = []

    for (const change of located.journal.changes) {
      assertNotAborted(options.signal)
      const current = await this.inspectFile(root, change.path, options.signal)
      this.assertPreimage(current, change.afterHash, change.afterMode, change.path, 'UNDO_CONFLICT')
      plans.push({
        displayPath: change.path,
        targetPath: current.targetPath,
        parentPath: current.parentPath,
        expectedHash: change.afterHash,
        expectedMode: change.afterMode,
        newContent: change.beforeContent,
        newMode: change.beforeMode,
      })
    }

    const staged = await this.stageCommitPlans(plans, options.signal)
    const applied: AppliedCommit[] = []
    let undoPendingPath: string | null = null
    try {
      const pendingPath = located.path.replace(/\.v1\.json$/, '.undo-pending.v1.json')
      await rename(located.path, pendingPath)
      undoPendingPath = pendingPath
      await this.syncDirectory(located.directory)
      await this.commitPlans(root, staged, 'undo', applied, options.signal)
      assertNotAborted(options.signal)
      await this.verifyPostimages(
        root,
        located.journal.changes.map((change) => ({
          path: change.path,
          hash: change.beforeHash,
          mode: change.beforeMode,
        })),
        'UNDO_CONFLICT',
        options.signal,
      )
      const undonePath = undoPendingPath.replace(/\.undo-pending\.v1\.json$/, '.undone.v1.json')
      await rename(undoPendingPath, undonePath)
      undoPendingPath = null
      await this.syncDirectory(located.directory).catch(() => undefined)
      await this.finalizeAppliedCommits(applied)
      return {
        actionHash: located.journal.actionHash,
        journalId: basename(undonePath),
        restoredPaths: located.journal.changes.map((change) => change.path),
      }
    } catch (error) {
      let journalRollbackError: Error | null = null
      const rollbackError = await this.rollbackAppliedCommits(root, applied)
      await this.cleanStagedTemps(staged)
      if (undoPendingPath && !rollbackError) {
        try {
          await rename(undoPendingPath, located.path)
          undoPendingPath = null
          await this.syncDirectory(located.directory).catch(() => undefined)
        } catch (restoreError) {
          journalRollbackError =
            restoreError instanceof Error ? restoreError : new Error(String(restoreError))
        }
      }
      if (rollbackError || journalRollbackError) {
        throw new MutationError(
          {
            code: 'RECOVERY_REQUIRED',
            identifier: 'undo',
            actionHash: located.journal.actionHash,
            journalId: basename(located.path),
          },
          {
            cause: new AggregateError(
              [error, journalRollbackError, rollbackError].filter(
                (failure): failure is Error => failure instanceof Error,
              ),
            ),
          },
        )
      }
      if (error instanceof MutationError) throw error
      throw new MutationError(
        {
          code: 'APPLY_FAILED',
          identifier: 'undo',
          actionHash: located.journal.actionHash,
          journalId: basename(located.path),
        },
        { cause: error },
      )
    }
  }

  private async recoverPendingUnlocked(): Promise<MutationRecoveryResult> {
    const root = await this.requireWorkspaceRoot()
    const directory = this.journalDirectoryForRoot(root)
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return { actionHashes: [], restoredPaths: [] }
      throw error
    }
    const pendingNames = names
      .filter((name) => name.endsWith('.pending.v1.json') || name.endsWith('.undo-pending.v1.json'))
      .sort((left, right) => compareCodeUnits(right, left))
    const actionHashes: string[] = []
    const restoredPaths = new Set<string>()

    for (const name of pendingNames) {
      const located = await this.readJournalAt(root, join(directory, name), directory)
      const undoWasRequested = name.endsWith('.undo-pending.v1.json')
      const plans: CommitPlan[] = []
      for (const change of located.journal.changes) {
        const current = await this.inspectFile(root, change.path)
        const matchesBefore =
          current.sha256 === change.beforeHash && current.mode === change.beforeMode
        if (matchesBefore) continue
        const matchesAfter =
          current.sha256 === change.afterHash && current.mode === change.afterMode
        const missingDuringReplacement =
          current.sha256 === null && change.beforeHash !== null && change.afterHash !== null
        if (!matchesAfter && !missingDuringReplacement) {
          throw new MutationError({
            code: 'HASH_CONFLICT',
            identifier: 'recovery-image',
            path: change.path,
            currentSha256: current.sha256,
            expectedSha256: change.afterHash,
            actionHash: located.journal.actionHash,
            journalId: basename(located.path),
          })
        }
        plans.push({
          displayPath: change.path,
          targetPath: current.targetPath,
          parentPath: current.parentPath,
          expectedHash: current.sha256,
          expectedMode: current.mode,
          newContent: change.beforeContent,
          newMode: change.beforeMode,
        })
      }

      const staged = await this.stageCommitPlans(plans)
      const applied: AppliedCommit[] = []
      try {
        await this.commitPlans(root, staged, 'undo', applied)
        await this.verifyPostimages(
          root,
          located.journal.changes.map((change) => ({
            path: change.path,
            hash: change.beforeHash,
            mode: change.beforeMode,
          })),
          'UNDO_CONFLICT',
        )
      } catch (error) {
        const rollbackError = await this.rollbackAppliedCommits(root, applied)
        await this.cleanStagedTemps(staged)
        if (rollbackError) {
          throw new MutationError(
            {
              code: 'RECOVERY_REQUIRED',
              identifier: 'pending-recovery',
              actionHash: located.journal.actionHash,
              journalId: basename(located.path),
            },
            { cause: new AggregateError([error, rollbackError]) },
          )
        }
        throw error
      }
      await this.finalizeAppliedCommits(applied)
      if (undoWasRequested) {
        const undonePath = located.path.replace(/\.undo-pending\.v1\.json$/, '.undone.v1.json')
        await rename(located.path, undonePath)
      } else {
        await unlink(located.path)
      }
      await this.syncDirectory(located.directory)
      actionHashes.push(located.journal.actionHash)
      for (const change of located.journal.changes) restoredPaths.add(change.path)
    }

    return { actionHashes, restoredPaths: [...restoredPaths].sort(compareCodeUnits) }
  }

  private async assertNoPendingJournals(root: string): Promise<void> {
    const directory = this.journalDirectoryForRoot(root)
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    if (
      names.some(
        (name) => name.endsWith('.pending.v1.json') || name.endsWith('.undo-pending.v1.json'),
      )
    ) {
      throw new MutationError({ code: 'JOURNAL_INVALID', identifier: 'pending-recovery' })
    }
  }

  /** Testable seam immediately before each atomic file commit; production behavior is a no-op. */
  protected async beforeCommitChange(
    _index: number,
    _path: string,
    _phase: 'apply' | 'undo',
  ): Promise<void> {}

  /** Testable seam immediately before a committed file is rolled back; production is a no-op. */
  protected async beforeRollbackChange(_index: number, _path: string): Promise<void> {}

  private serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private validateSummary(value: unknown): string {
    if (typeof value !== 'string') {
      throw new MutationError({ code: 'INVALID_PROPOSAL', identifier: 'summary-required' })
    }
    const summary = value.trim()
    if (summary.length < 1 || summary.length > MAX_SUMMARY_CHARACTERS || summary.includes('\0')) {
      throw new MutationError({
        code: 'INVALID_PROPOSAL',
        identifier: 'summary-length',
        minimum: 1,
        maximum: MAX_SUMMARY_CHARACTERS,
      })
    }
    return summary
  }

  private async requireWorkspaceRoot(): Promise<string> {
    const summary = this.workspace.getWorkspace()
    if (!summary) {
      throw new MutationError({ code: 'NO_WORKSPACE' })
    }
    return realpath(summary.path)
  }

  private normalizeMutationPath(root: string, requested: unknown): string {
    if (
      typeof requested !== 'string' ||
      !requested ||
      requested.includes('\0') ||
      containsPathControlCharacter(requested) ||
      Buffer.byteLength(requested) > MAX_PATH_BYTES ||
      isAbsolute(requested)
    ) {
      throw new MutationError({
        code: 'INVALID_PATH',
        identifier:
          typeof requested === 'string' && Buffer.byteLength(requested) > MAX_PATH_BYTES
            ? 'path-length'
            : 'path-value',
        maximumBytes: MAX_PATH_BYTES,
      })
    }
    if (
      process.platform === 'win32' &&
      requested
        .replace(/\\/g, '/')
        .split('/')
        .some(
          (segment) =>
            !segment ||
            /[. ]$/.test(segment) ||
            segment.includes(':') ||
            WINDOWS_RESERVED_SEGMENT.test(segment),
        )
    ) {
      throw new MutationError({ code: 'INVALID_PATH', identifier: 'path-value' })
    }
    const candidate = resolve(root, requested)
    if (!isPathContained(root, candidate)) {
      throw new MutationError({
        code: 'INVALID_PATH',
        identifier: 'outside-workspace',
        path: requested,
      })
    }
    const normalized = portablePath(relative(root, candidate))
    if (!normalized || normalized === '.' || normalized.startsWith('../')) {
      throw new MutationError({
        code: 'INVALID_PATH',
        identifier: 'workspace-root',
        path: requested,
      })
    }
    if (normalized.split('/').some((segment) => segment.toLowerCase() === '.git')) {
      throw new MutationError({
        code: 'INVALID_PATH',
        identifier: 'git-metadata',
        path: normalized,
      })
    }
    return normalized
  }

  private async inspectFile(
    root: string,
    displayPath: string,
    signal?: AbortSignal,
  ): Promise<InspectedFile> {
    assertNotAborted(signal)
    const normalized = this.normalizeMutationPath(root, displayPath)
    const lexicalTarget = resolve(root, normalized)
    let parentPath: string
    try {
      parentPath = await realpath(dirname(lexicalTarget))
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        const missingParent = portablePath(relative(root, dirname(lexicalTarget)))
        throw new MutationError(
          {
            code: 'INVALID_PATH',
            identifier: 'parent-missing',
            path: normalized,
            parentPath: missingParent,
          },
          { cause: error },
        )
      }
      throw new MutationError(
        { code: 'INVALID_PATH', identifier: 'path-value', path: normalized },
        { cause: error },
      )
    }
    if (!isPathContained(root, parentPath) || !(await stat(parentPath)).isDirectory()) {
      throw new MutationError({
        code: 'INVALID_PATH',
        identifier: 'outside-workspace',
        path: normalized,
      })
    }
    const canonicalTargetPath = portablePath(
      relative(root, join(parentPath, basename(lexicalTarget))),
    )
    if (
      !canonicalTargetPath ||
      canonicalTargetPath.startsWith('../') ||
      canonicalTargetPath.split('/').some((segment) => segment.toLowerCase() === '.git')
    ) {
      throw new MutationError({
        code: 'INVALID_PATH',
        identifier: canonicalTargetPath.includes('.git') ? 'git-metadata' : 'path-value',
        path: canonicalTargetPath,
      })
    }

    const targetPath = join(parentPath, basename(lexicalTarget))
    let pathStats: Stats
    try {
      pathStats = await lstat(targetPath)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        return {
          displayPath: normalized,
          targetPath,
          parentPath,
          content: null,
          contentBytes: null,
          sha256: null,
          mode: null,
        }
      }
      throw error
    }
    if (pathStats.isSymbolicLink()) {
      throw new MutationError({ code: 'SYMLINK_REJECTED', path: normalized })
    }
    if (!pathStats.isFile()) {
      throw new MutationError({ code: 'NOT_REGULAR_FILE', path: normalized })
    }
    if (pathStats.size > this.maxFileBytes) {
      throw new MutationError({
        code: 'FILE_TOO_LARGE',
        identifier: 'file-content',
        path: normalized,
        maximumBytes: this.maxFileBytes,
      })
    }

    const handle = await open(targetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let bytes: Buffer
    try {
      const openedStats = await handle.stat()
      if (
        !openedStats.isFile() ||
        openedStats.dev !== pathStats.dev ||
        openedStats.ino !== pathStats.ino
      ) {
        throw new MutationError({
          code: 'HASH_CONFLICT',
          identifier: 'file-changed',
          path: normalized,
        })
      }
      bytes = await this.readLimited(handle, normalized, signal)
    } finally {
      await handle.close()
    }
    const content = decodeText(bytes, normalized)
    return {
      displayPath: normalized,
      targetPath,
      parentPath,
      content,
      contentBytes: bytes,
      sha256: sha256(bytes),
      mode: process.platform === 'win32' ? null : pathStats.mode & 0o777,
    }
  }

  private async readLimited(
    handle: FileHandle,
    displayPath: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const bytes = Buffer.alloc(this.maxFileBytes + 1)
    let offset = 0
    while (offset < bytes.length) {
      assertNotAborted(signal)
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset > this.maxFileBytes) {
      throw new MutationError({
        code: 'FILE_TOO_LARGE',
        identifier: 'file-content',
        path: displayPath,
        maximumBytes: this.maxFileBytes,
      })
    }
    return bytes.subarray(0, offset)
  }

  private computeActionHash(
    root: string,
    summary: string,
    changes: readonly PreparedMutationChange[],
  ): string {
    return sha256(
      JSON.stringify({
        version: JOURNAL_VERSION,
        root,
        summary,
        changes: changes.map((change) => ({
          path: change.path,
          kind: change.kind,
          diff: change.diff,
          additions: change.additions,
          deletions: change.deletions,
          beforeHash: change.beforeHash,
          afterHash: change.afterHash,
          previousMode: change.previousMode,
          nextMode: change.nextMode,
        })),
      }),
    )
  }

  private assertPreimage(
    current: InspectedFile,
    expectedHash: string | null,
    expectedMode: number | null,
    path: string,
    errorCode: 'HASH_CONFLICT' | 'UNDO_CONFLICT',
  ): void {
    if (current.sha256 !== expectedHash || current.mode !== expectedMode) {
      throw new MutationError({
        code: errorCode,
        identifier: 'file-changed',
        path,
        currentSha256: current.sha256,
        expectedSha256: expectedHash,
      })
    }
  }

  private async verifyPostimages(
    root: string,
    expected: readonly { path: string; hash: string | null; mode: number | null }[],
    errorCode: 'HASH_CONFLICT' | 'UNDO_CONFLICT',
    signal?: AbortSignal,
  ): Promise<void> {
    for (const image of expected) {
      assertNotAborted(signal)
      const current = await this.inspectFile(root, image.path, signal)
      this.assertPreimage(current, image.hash, image.mode, image.path, errorCode)
    }
  }

  private async stageCommitPlans(
    plans: readonly CommitPlan[],
    signal?: AbortSignal,
  ): Promise<StagedCommitPlan[]> {
    const staged: StagedCommitPlan[] = []
    try {
      for (const plan of plans) {
        assertNotAborted(signal)
        let temporaryPath: string | null = null
        if (plan.newContent !== null) {
          temporaryPath = join(plan.parentPath, `.code-assistant-${randomUUID()}.tmp`)
          const handle = await open(
            temporaryPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
            0o600,
          )
          try {
            await handle.writeFile(Buffer.from(plan.newContent, 'utf8'))
            await handle.chmod(plan.newMode ?? 0o600)
            await handle.sync()
          } finally {
            await handle.close()
          }
        }
        staged.push({ ...plan, temporaryPath })
      }
      return staged
    } catch (error) {
      await this.cleanStagedTemps(staged)
      throw error
    }
  }

  private async commitPlans(
    root: string,
    plans: StagedCommitPlan[],
    phase: 'apply' | 'undo',
    applied: AppliedCommit[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (let index = 0; index < plans.length; index += 1) {
      assertNotAborted(signal)
      const plan = plans[index]
      await this.beforeCommitChange(index, plan.displayPath, phase)
      const current = await this.inspectFile(root, plan.displayPath, signal)
      this.assertPreimage(
        current,
        plan.expectedHash,
        plan.expectedMode,
        plan.displayPath,
        phase === 'undo' ? 'UNDO_CONFLICT' : 'HASH_CONFLICT',
      )
      if (current.targetPath !== plan.targetPath || current.parentPath !== plan.parentPath) {
        throw new MutationError(
          phase === 'undo' ? 'UNDO_CONFLICT' : 'HASH_CONFLICT',
          `The resolved path changed before commit: ${plan.displayPath}`,
          {
            details: {
              path: plan.displayPath,
              currentSha256: current.sha256,
              expectedSha256: plan.expectedHash,
            },
          },
        )
      }

      const record: AppliedCommit = { plan, backupPath: null, installed: false }
      applied.push(record)
      if (current.sha256 !== null) {
        record.backupPath = join(plan.parentPath, `.code-assistant-${randomUUID()}.backup`)
        await rename(plan.targetPath, record.backupPath)
      }
      if (plan.temporaryPath) {
        await rename(plan.temporaryPath, plan.targetPath)
        plan.temporaryPath = null
        record.installed = true
      }
      await this.syncDirectory(plan.parentPath)
    }
  }

  private async rollbackAppliedCommits(
    root: string,
    applied: AppliedCommit[],
  ): Promise<Error | null> {
    const errors: Error[] = []
    const remaining: AppliedCommit[] = []
    const reversed = [...applied].reverse()
    for (let index = 0; index < reversed.length; index += 1) {
      const record = reversed[index]
      try {
        await this.beforeRollbackChange(index, record.plan.displayPath)
        if (record.installed) {
          const current = await this.inspectFile(root, record.plan.displayPath)
          this.assertPreimage(
            current,
            record.plan.newContent === null ? null : sha256(record.plan.newContent),
            record.plan.newMode,
            record.plan.displayPath,
            'HASH_CONFLICT',
          )
          await unlink(record.plan.targetPath).catch((error) => {
            if (!isNodeError(error, 'ENOENT')) throw error
          })
          record.installed = false
        }
        if (record.backupPath) {
          const current = await this.inspectFile(root, record.plan.displayPath)
          this.assertPreimage(current, null, null, record.plan.displayPath, 'HASH_CONFLICT')
          await rename(record.backupPath, record.plan.targetPath)
          record.backupPath = null
        }
        await this.syncDirectory(record.plan.parentPath)
      } catch (error) {
        remaining.push(record)
        errors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    applied.splice(0, applied.length, ...remaining.reverse())
    return errors.length > 0 ? new AggregateError(errors) : null
  }

  private async finalizeAppliedCommits(applied: AppliedCommit[]): Promise<void> {
    for (const record of applied) {
      if (record.backupPath) {
        await unlink(record.backupPath).catch(() => undefined)
        record.backupPath = null
      }
    }
    applied.splice(0)
  }

  private async cleanStagedTemps(staged: readonly StagedCommitPlan[]): Promise<void> {
    await Promise.all(
      staged.map(async (plan) => {
        if (!plan.temporaryPath) return
        await unlink(plan.temporaryPath).catch(() => undefined)
        plan.temporaryPath = null
      }),
    )
  }

  private createJournal(prepared: InternalPreparedMutation): MutationJournal {
    const timestamp = new Date().toISOString()
    return {
      version: JOURNAL_VERSION,
      status: 'applied',
      id: `${prepared.actionHash.slice(0, 16)}-${randomUUID()}`,
      root: prepared.root,
      actionHash: prepared.actionHash,
      summary: prepared.summary,
      createdAt: timestamp,
      changes: prepared.changes.map((change) => ({
        path: change.path,
        beforeHash: change.beforeHash,
        afterHash: change.afterHash,
        beforeContent: change.previousContent,
        beforeMode: change.previousMode,
        afterMode: change.nextMode,
      })),
    }
  }

  private journalDirectoryForRoot(root: string): string {
    return join(this.journalDirectory, sha256(root).slice(0, 32))
  }

  private async writeJournal(
    root: string,
    journal: MutationJournal,
    pending = false,
  ): Promise<string> {
    const directory = this.journalDirectoryForRoot(root)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const existingNames = await readdir(directory)
    const newestExistingSequence = existingNames.reduce((newest, name) => {
      const prefix = Number.parseInt(name.slice(0, 13), 10)
      return Number.isSafeInteger(prefix) ? Math.max(newest, prefix) : newest
    }, 0)
    this.lastJournalSequence = Math.max(
      Date.now(),
      this.lastJournalSequence + 1,
      newestExistingSequence + 1,
    )
    journal.id = `${this.lastJournalSequence.toString().padStart(13, '0')}-${journal.id}`
    const finalPath = join(directory, `${journal.id}${pending ? '.pending' : ''}.v1.json`)
    const temporaryPath = join(directory, `.${journal.id}.${randomUUID()}.tmp`)
    const encodedJournal = Buffer.from(`${JSON.stringify(journal)}\n`, 'utf8')
    if (encodedJournal.length > this.maximumJournalBytes()) {
      throw new MutationError({
        code: 'FILE_TOO_LARGE',
        identifier: 'journal-size',
        maximumBytes: this.maximumJournalBytes(),
        journalId: journal.id,
      })
    }
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      await handle.writeFile(encodedJournal)
      await handle.chmod(0o600)
      await handle.sync()
    } finally {
      await handle.close()
    }
    let moved = false
    try {
      await rename(temporaryPath, finalPath)
      moved = true
      await this.syncDirectory(directory)
      return finalPath
    } catch (error) {
      let cleanupError: unknown
      try {
        await unlink(moved ? finalPath : temporaryPath)
        await this.syncDirectory(directory)
      } catch (failure) {
        cleanupError = failure
      }
      if (cleanupError) throw new AggregateError([error, cleanupError])
      throw error
    }
  }

  private async finalizePendingJournal(pendingPath: string): Promise<string> {
    if (!pendingPath.endsWith('.pending.v1.json')) {
      throw new MutationError({ code: 'JOURNAL_INVALID', path: pendingPath })
    }
    const finalPath = pendingPath.replace(/\.pending\.v1\.json$/, '.v1.json')
    await rename(pendingPath, finalPath)
    await this.syncDirectory(dirname(finalPath)).catch(() => undefined)
    return finalPath
  }

  private async readLatestJournal(root: string): Promise<JournalWithPath> {
    const directory = this.journalDirectoryForRoot(root)
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw new MutationError({ code: 'NO_UNDO' })
      }
      throw error
    }

    const candidates = names
      .filter(
        (name) =>
          name.endsWith('.v1.json') &&
          !name.endsWith('.undone.v1.json') &&
          !name.endsWith('.pending.v1.json'),
      )
      .sort((left, right) => compareCodeUnits(right, left))
    if (candidates.length === 0) {
      throw new MutationError({ code: 'NO_UNDO' })
    }

    const path = join(directory, candidates[0])
    return this.readJournalAt(root, path, directory)
  }

  private async readJournalAt(
    root: string,
    path: string,
    directory = dirname(path),
  ): Promise<JournalWithPath> {
    const pathStats = await lstat(path)
    if (
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      (process.platform !== 'win32' && (pathStats.mode & 0o077) !== 0)
    ) {
      throw new MutationError({ code: 'JOURNAL_INVALID', path })
    }
    const maximumJournalBytes = this.maximumJournalBytes()
    if (pathStats.size > maximumJournalBytes) {
      throw new MutationError({
        code: 'JOURNAL_INVALID',
        path,
        maximumBytes: maximumJournalBytes,
      })
    }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let bytes: Buffer
    try {
      const buffer = Buffer.alloc(maximumJournalBytes + 1)
      let offset = 0
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (result.bytesRead === 0) break
        offset += result.bytesRead
      }
      if (offset > maximumJournalBytes) {
        throw new MutationError({
          code: 'JOURNAL_INVALID',
          path,
          maximumBytes: maximumJournalBytes,
        })
      }
      bytes = buffer.subarray(0, offset)
    } finally {
      await handle.close()
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(decodeText(bytes, basename(path)))
    } catch (error) {
      if (error instanceof MutationError) throw error
      throw new MutationError({ code: 'JOURNAL_INVALID', path }, { cause: error })
    }
    const journal = this.validateJournal(decoded, root)
    return { journal, path, directory }
  }

  private validateJournal(value: unknown, root: string): MutationJournal {
    if (!value || typeof value !== 'object') {
      throw new MutationError('JOURNAL_INVALID', 'The mutation journal must be an object.')
    }
    const candidate = value as Partial<MutationJournal>
    if (
      candidate.version !== JOURNAL_VERSION ||
      candidate.status !== 'applied' ||
      candidate.root !== root ||
      typeof candidate.id !== 'string' ||
      typeof candidate.summary !== 'string' ||
      typeof candidate.createdAt !== 'string' ||
      !Array.isArray(candidate.changes) ||
      candidate.changes.length < 1 ||
      candidate.changes.length > this.maxFiles
    ) {
      throw new MutationError('JOURNAL_INVALID', 'The mutation journal metadata is invalid.')
    }
    assertJournalSha256(candidate.actionHash, 'journal.actionHash')

    const seen = new Set<string>()
    let totalBytes = 0
    for (const [index, rawChange] of candidate.changes.entries()) {
      if (!rawChange || typeof rawChange !== 'object') {
        throw new MutationError('JOURNAL_INVALID', `journal.changes[${index}] is invalid.`)
      }
      const change = rawChange as Partial<MutationJournalChange>
      const path = this.normalizeMutationPath(root, change.path)
      if (path !== change.path || seen.has(path)) {
        throw new MutationError('JOURNAL_INVALID', 'The journal contains an invalid path list.')
      }
      seen.add(path)
      if (change.beforeHash !== null) {
        assertJournalSha256(change.beforeHash, 'journal.beforeHash')
      }
      if (change.afterHash !== null) assertJournalSha256(change.afterHash, 'journal.afterHash')
      if (change.beforeContent !== null && typeof change.beforeContent !== 'string') {
        throw new MutationError('JOURNAL_INVALID', 'The journal preimage must be text or null.')
      }
      if (
        (change.beforeHash === null) !== (change.beforeContent === null) ||
        (process.platform !== 'win32' &&
          ((change.beforeMode === null) !== (change.beforeContent === null) ||
            (change.afterHash === null) !== (change.afterMode === null)))
      ) {
        throw new MutationError('JOURNAL_INVALID', 'The journal image metadata is inconsistent.')
      }
      const beforeMode = change.beforeMode
      const afterMode = change.afterMode
      if (
        beforeMode !== null &&
        (typeof beforeMode !== 'number' ||
          !Number.isSafeInteger(beforeMode) ||
          beforeMode < 0 ||
          beforeMode > 0o777)
      ) {
        throw new MutationError('JOURNAL_INVALID', 'The journal preimage mode is invalid.')
      }
      if (
        afterMode !== null &&
        (typeof afterMode !== 'number' ||
          !Number.isSafeInteger(afterMode) ||
          afterMode < 0 ||
          afterMode > 0o777)
      ) {
        throw new MutationError('JOURNAL_INVALID', 'The journal postimage mode is invalid.')
      }
      if (change.beforeContent !== null) {
        const content = Buffer.from(change.beforeContent, 'utf8')
        decodeText(content, path)
        if (content.length > this.maxFileBytes || sha256(content) !== change.beforeHash) {
          throw new MutationError('JOURNAL_INVALID', 'A journal preimage failed validation.')
        }
        totalBytes += content.length
      }
      if (totalBytes > this.maxTotalBytes) {
        throw new MutationError('JOURNAL_INVALID', 'The journal preimages are oversized.')
      }
    }

    return candidate as MutationJournal
  }

  private async syncDirectory(directory: string): Promise<void> {
    let handle: FileHandle | undefined
    try {
      handle = await open(directory, constants.O_RDONLY)
      await handle.sync()
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        (!isNodeError(error, 'EACCES') &&
          !isNodeError(error, 'EINVAL') &&
          !isNodeError(error, 'EISDIR') &&
          !isNodeError(error, 'EPERM'))
      ) {
        throw error
      }
    } finally {
      await handle?.close()
    }
  }

  private maximumJournalBytes(): number {
    return this.maxTotalBytes * JOURNAL_TEXT_EXPANSION_FACTOR + JOURNAL_OVERHEAD_BYTES
  }
}
