import { type ChildProcess, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createSanitizedProcessEnvironment } from './execution'
import {
  formatServiceErrorDescriptor,
  type GitOperation,
  type GitServiceErrorCode,
  type GitServiceErrorDescriptor,
  type GitServiceErrorDetail,
  SERVICE_ERROR_MARKER,
} from './service-error-messages'
import {
  containsLikelyWorkspaceSecret,
  isPathContained,
  isSensitiveWorkspacePath,
} from './workspace'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024
const METADATA_OUTPUT_LIMIT_BYTES = 256 * 1024
const STDERR_LIMIT_BYTES = 64 * 1024
const FORCE_KILL_DELAY_MS = 500
const DEFAULT_MAX_DIFF_PATHS = 512
const DEFAULT_MAX_PATHSPEC_BYTES = 128 * 1024
const UNSAFE_REPOSITORY_CONFIG_PATTERN =
  '^filter\\..*\\.(clean|smudge|process|required)$|^diff\\..*\\.(command|textconv)$'

export interface GitWorkspaceProvider {
  getWorkspace(): { path: string } | null
  isSensitivePath?(path: string): boolean
  containsSensitiveContent?(content: string): boolean
}

export interface GitServiceOptions {
  timeoutMs?: number
  maxDiffBytes?: number
  maxDiffPaths?: number
  maxPathspecBytes?: number
  tempDirectory?: string
  gitExecutable?: string
}

export interface GitStatusEntry {
  index: string
  worktree: string
  path: string
  originalPath?: string
}

export interface GitRepositoryStatus {
  repositoryRoot: string
  head: string | null
  branch: string | null
  detached: boolean
  entries: GitStatusEntry[]
  porcelainBytes: number
  porcelainTruncated: boolean
}

export interface GitDiffOptions {
  path?: string
  maxBytes?: number
  signal?: AbortSignal
}

export interface GitDiffSection {
  content: string
  totalBytes: number
  capturedBytes: number
  truncated: boolean
}

export interface GitDiffResult {
  path: string | null
  staged: GitDiffSection
  unstaged: GitDiffSection
}

export class GitServiceError extends Error {
  readonly code: GitServiceErrorCode
  readonly descriptor: GitServiceErrorDescriptor
  readonly [SERVICE_ERROR_MARKER] = true as const

  constructor(detail: GitServiceErrorDetail, options?: ErrorOptions)
  constructor(code: GitServiceErrorCode, message: string, options?: ErrorOptions)
  constructor(
    detailOrCode: GitServiceErrorDetail | GitServiceErrorCode,
    messageOrOptions?: string | ErrorOptions,
    legacyOptions?: ErrorOptions,
  ) {
    const descriptor = (
      typeof detailOrCode === 'string'
        ? { service: 'git', code: detailOrCode }
        : { service: 'git', ...detailOrCode }
    ) as GitServiceErrorDescriptor
    const message =
      typeof messageOrOptions === 'string'
        ? messageOrOptions
        : formatServiceErrorDescriptor('ko', descriptor)
    const options = typeof messageOrOptions === 'string' ? legacyOptions : messageOrOptions
    super(message, options)
    this.name = 'GitServiceError'
    this.code = descriptor.code
    this.descriptor = descriptor
  }
}

export type { GitServiceErrorCode } from './service-error-messages'

interface GitCommandResult {
  exitCode: number | null
  signal: string | null
  stdout: Buffer
  stderr: Buffer
  stdoutBytes: number
  stdoutTruncated: boolean
  timedOut: boolean
  cancelled: boolean
  spawnError?: Error
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`)
  }
  return value
}

function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  includeExitedProcessGroup = false,
): void {
  if (!child.pid || (!includeExitedProcessGroup && child.exitCode !== null)) return
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
    if (!systemRoot || !isAbsolute(systemRoot)) {
      child.kill(signal)
      return
    }
    const systemDirectory = join(systemRoot, 'System32')
    const arguments_ = ['/pid', String(child.pid), '/t']
    if (signal === 'SIGKILL') arguments_.push('/f')
    const killer = spawn(join(systemDirectory, 'taskkill.exe'), arguments_, {
      env: {
        PATH: systemDirectory,
        SystemRoot: systemRoot,
        SYSTEMROOT: systemRoot,
        WINDIR: systemRoot,
      },
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.unref()
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    if (child.exitCode === null) {
      try {
        child.kill(signal)
      } catch {
        // The command may have exited concurrently.
      }
    }
  }
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  capturedBytes: number,
  limit: number,
): number {
  const accepted = chunk.subarray(0, Math.max(0, limit - capturedBytes))
  if (accepted.length > 0) chunks.push(accepted)
  return accepted.length
}

function portablePath(path: string): string {
  return path.split(sep).join('/')
}

function parsePorcelainStatus(output: Buffer): GitStatusEntry[] {
  const records = output.toString('utf8').split('\0')
  const entries: GitStatusEntry[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    if (record.length < 3 || record[2] !== ' ') continue
    const indexStatus = record[0]
    const worktreeStatus = record[1]
    const entry: GitStatusEntry = {
      index: indexStatus,
      worktree: worktreeStatus,
      path: record.slice(3),
    }
    if (
      index + 1 < records.length &&
      (indexStatus === 'R' ||
        indexStatus === 'C' ||
        worktreeStatus === 'R' ||
        worktreeStatus === 'C')
    ) {
      entry.originalPath = records[index + 1]
      index += 1
    }
    entries.push(entry)
  }
  return entries
}

function diffSection(result: GitCommandResult): GitDiffSection {
  return {
    content: result.stdout.toString('utf8'),
    totalBytes: result.stdoutBytes,
    capturedBytes: result.stdout.length,
    truncated: result.stdoutTruncated,
  }
}

function emptyDiffSection(): GitDiffSection {
  return { content: '', totalBytes: 0, capturedBytes: 0, truncated: false }
}

/** Read-only Git inspection with fixed argv construction and isolated global/system configuration. */
export class GitService {
  private readonly timeoutMs: number
  private readonly maxDiffBytes: number
  private readonly maxDiffPaths: number
  private readonly maxPathspecBytes: number
  private readonly tempDirectory: string
  private readonly configuredGitExecutable: string | null

  constructor(
    private readonly workspace: GitWorkspaceProvider,
    options: GitServiceOptions = {},
  ) {
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs')
    this.maxDiffBytes = positiveInteger(
      options.maxDiffBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
      'maxDiffBytes',
    )
    this.maxDiffPaths = positiveInteger(
      options.maxDiffPaths ?? DEFAULT_MAX_DIFF_PATHS,
      'maxDiffPaths',
    )
    this.maxPathspecBytes = positiveInteger(
      options.maxPathspecBytes ?? DEFAULT_MAX_PATHSPEC_BYTES,
      'maxPathspecBytes',
    )
    this.tempDirectory = options.tempDirectory ?? tmpdir()
    if (
      options.gitExecutable !== undefined &&
      (!isAbsolute(options.gitExecutable) || options.gitExecutable.includes('\0'))
    ) {
      throw new RangeError('gitExecutable must be an absolute path without NUL characters.')
    }
    this.configuredGitExecutable = options.gitExecutable ?? null
  }

  async getStatus(signal?: AbortSignal): Promise<GitRepositoryStatus> {
    const root = await this.requireWorkspaceRoot()
    const repositoryRoot = await this.resolveRepositoryRoot(root, signal)
    await this.assertSafeRepositoryConfiguration(root, signal)
    const [headResult, branchResult, statusResult] = await Promise.all([
      this.runGit(root, ['rev-parse', '--verify', 'HEAD'], METADATA_OUTPUT_LIMIT_BYTES, signal),
      this.runGit(
        root,
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        METADATA_OUTPUT_LIMIT_BYTES,
        signal,
      ),
      this.runGit(
        root,
        [
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--ignore-submodules=all',
          '--',
          '.',
        ],
        METADATA_OUTPUT_LIMIT_BYTES,
        signal,
      ),
    ])

    const head = headResult.exitCode === 0 ? headResult.stdout.toString('utf8').trim() : null
    const branch = branchResult.exitCode === 0 ? branchResult.stdout.toString('utf8').trim() : null
    this.assertSuccessful(statusResult, 'status')
    if (headResult.exitCode !== 0 && headResult.exitCode !== 128) {
      this.assertSuccessful(headResult, 'repository-head')
    }
    if (branchResult.exitCode !== 0 && branchResult.exitCode !== 1) {
      this.assertSuccessful(branchResult, 'repository-branch')
    }

    return {
      repositoryRoot,
      head: head || null,
      branch: branch || null,
      detached: Boolean(head) && !branch,
      entries: this.safeStatusEntries(parsePorcelainStatus(statusResult.stdout)),
      porcelainBytes: statusResult.stdoutBytes,
      porcelainTruncated: statusResult.stdoutTruncated,
    }
  }

  async getDiff(options: GitDiffOptions = {}): Promise<GitDiffResult> {
    const root = await this.requireWorkspaceRoot()
    await this.resolveRepositoryRoot(root, options.signal)
    await this.assertSafeRepositoryConfiguration(root, options.signal)
    const path = this.validateOptionalPath(root, options.path)
    if (path && this.isSensitivePath(path)) {
      throw new GitServiceError({ code: 'SENSITIVE_PATH', path })
    }
    const requestedLimit = options.maxBytes ?? this.maxDiffBytes
    const outputLimit = Math.min(positiveInteger(requestedLimit, 'maxBytes'), this.maxDiffBytes)
    const statusPathspec = path === null ? '.' : `:(literal)${path}`
    const statusResult = await this.runGit(
      root,
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=all',
        '--',
        statusPathspec,
      ],
      METADATA_OUTPUT_LIMIT_BYTES,
      options.signal,
    )
    this.assertSuccessful(statusResult, 'safe-diff-paths')
    if (statusResult.stdoutTruncated) {
      throw new GitServiceError({
        code: 'GIT_FAILED',
        identifier: 'changed-path-list-too-large',
      })
    }
    const pathspecs = this.diffPathspecs(
      this.safeStatusEntries(parsePorcelainStatus(statusResult.stdout)),
    )
    if (pathspecs.length === 0) {
      return { path, staged: emptyDiffSection(), unstaged: emptyDiffSection() }
    }
    const commonArguments = [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
    ]

    const [stagedResult, unstagedResult] = await Promise.all([
      this.runGit(
        root,
        [...commonArguments, '--cached', '--', ...pathspecs],
        outputLimit,
        options.signal,
      ),
      this.runGit(root, [...commonArguments, '--', ...pathspecs], outputLimit, options.signal),
    ])
    this.assertSuccessful(stagedResult, 'staged-diff')
    this.assertSuccessful(unstagedResult, 'unstaged-diff')
    const staged = diffSection(stagedResult)
    const unstaged = diffSection(unstagedResult)
    this.assertSafeDiffContent(staged.content, path ?? undefined)
    this.assertSafeDiffContent(unstaged.content, path ?? undefined)
    return {
      path,
      staged,
      unstaged,
    }
  }

  private isSensitivePath(path: string): boolean {
    return this.workspace.isSensitivePath?.(path) ?? isSensitiveWorkspacePath(path)
  }

  private containsSensitiveContent(content: string): boolean {
    return (
      this.workspace.containsSensitiveContent?.(content) ?? containsLikelyWorkspaceSecret(content)
    )
  }

  private safeStatusEntries(entries: readonly GitStatusEntry[]): GitStatusEntry[] {
    return entries.filter(
      (entry) =>
        !this.isSensitivePath(entry.path) &&
        (!entry.originalPath || !this.isSensitivePath(entry.originalPath)),
    )
  }

  private diffPathspecs(entries: readonly GitStatusEntry[]): string[] {
    const paths = new Set<string>()
    let totalBytes = 0
    for (const entry of entries) {
      if (entry.index === '?' && entry.worktree === '?') continue
      for (const path of [entry.path, entry.originalPath]) {
        if (!path || paths.has(path)) continue
        if (
          !path ||
          path.includes('\0') ||
          isAbsolute(path) ||
          path === '..' ||
          path.startsWith('../')
        ) {
          throw new GitServiceError({ code: 'INVALID_PATH', identifier: 'reported', path })
        }
        const bytes = Buffer.byteLength(path)
        if (paths.size >= this.maxDiffPaths || totalBytes + bytes > this.maxPathspecBytes) {
          throw new GitServiceError({
            code: 'GIT_FAILED',
            identifier: 'too-many-changed-paths',
            maximumPaths: this.maxDiffPaths,
            maximumPathspecBytes: this.maxPathspecBytes,
          })
        }
        paths.add(path)
        totalBytes += bytes
      }
    }
    return [...paths].map((path) => `:(literal)${path}`)
  }

  private assertSafeDiffContent(content: string, path?: string): void {
    if (this.containsSensitiveContent(content)) {
      throw new GitServiceError({ code: 'SENSITIVE_CONTENT', path })
    }
  }

  private async requireWorkspaceRoot(): Promise<string> {
    const summary = this.workspace.getWorkspace()
    if (!summary) {
      throw new GitServiceError({ code: 'NO_WORKSPACE' })
    }
    return realpath(summary.path)
  }

  private async resolveRepositoryRoot(root: string, signal?: AbortSignal): Promise<string> {
    const result = await this.runGit(
      root,
      ['rev-parse', '--show-toplevel'],
      METADATA_OUTPUT_LIMIT_BYTES,
      signal,
    )
    if (result.cancelled || result.timedOut || result.spawnError) {
      this.assertSuccessful(result, 'repository-root')
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString('utf8')
      const externalDetail = stderr.trim() ? stderr : undefined
      throw new GitServiceError(
        { code: 'NOT_A_REPOSITORY', identifier: 'workspace', externalDetail },
        externalDetail ? { cause: new Error(externalDetail) } : undefined,
      )
    }
    const reportedRoot = result.stdout.toString('utf8').trim()
    let repositoryRoot: string
    try {
      repositoryRoot = await realpath(reportedRoot)
    } catch (error) {
      throw new GitServiceError(
        { code: 'NOT_A_REPOSITORY', identifier: 'invalid-root', path: reportedRoot },
        { cause: error },
      )
    }
    if (!isPathContained(repositoryRoot, root) && !isPathContained(root, repositoryRoot)) {
      throw new GitServiceError({
        code: 'NOT_A_REPOSITORY',
        identifier: 'unrelated-root',
        path: repositoryRoot,
      })
    }
    return repositoryRoot
  }

  private async assertSafeRepositoryConfiguration(
    root: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.runGit(
      root,
      ['config', '--includes', '--name-only', '--get-regexp', UNSAFE_REPOSITORY_CONFIG_PATTERN],
      METADATA_OUTPUT_LIMIT_BYTES,
      signal,
    )
    if (result.exitCode === 1 && !result.cancelled && !result.timedOut && !result.spawnError) return
    this.assertSuccessful(result, 'repository-process-filters')
    if (result.stdout.length > 0) {
      throw new GitServiceError({ code: 'UNSAFE_REPOSITORY' })
    }
  }

  private validateOptionalPath(root: string, requested?: string): string | null {
    if (requested === undefined) return null
    if (!requested || requested.includes('\0') || isAbsolute(requested)) {
      throw new GitServiceError({ code: 'INVALID_PATH', identifier: 'requested', path: requested })
    }
    const candidate = resolve(root, requested)
    if (!isPathContained(root, candidate)) {
      throw new GitServiceError({ code: 'INVALID_PATH', identifier: 'outside', path: requested })
    }
    const normalized = portablePath(relative(root, candidate))
    if (!normalized || normalized === '.' || normalized.startsWith('../')) {
      throw new GitServiceError({
        code: 'INVALID_PATH',
        identifier: 'workspace-root',
        path: requested,
      })
    }
    return normalized
  }

  private async runGit(
    cwd: string,
    operationArguments: readonly string[],
    stdoutLimit: number,
    signal?: AbortSignal,
  ): Promise<GitCommandResult> {
    if (signal?.aborted) {
      throw new GitServiceError({ code: 'CANCELLED' })
    }
    const gitExecutable = await this.resolveGitExecutable(cwd)
    await mkdir(this.tempDirectory, { recursive: true, mode: 0o700 })
    const temporaryHome = await mkdtemp(join(this.tempDirectory, 'code-assistant-git-'))
    const environment = createSanitizedProcessEnvironment(temporaryHome)
    environment.GIT_CONFIG_NOSYSTEM = '1'
    environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
    environment.GIT_ATTR_NOSYSTEM = '1'
    environment.GIT_TERMINAL_PROMPT = '0'
    environment.GCM_INTERACTIVE = 'Never'
    environment.GIT_OPTIONAL_LOCKS = '0'
    environment.GIT_NO_LAZY_FETCH = '1'
    environment.GIT_PAGER = 'cat'
    environment.PAGER = 'cat'

    const disabledHooksPath = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const argv = [
      '--no-pager',
      '-c',
      'color.ui=false',
      '-c',
      'core.quotepath=false',
      '-c',
      'core.pager=cat',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'protocol.allow=never',
      '-c',
      `core.hooksPath=${disabledHooksPath}`,
      '-c',
      'diff.external=',
      '-c',
      'status.relativePaths=true',
      '-C',
      cwd,
      ...operationArguments,
    ]

    try {
      return await new Promise<GitCommandResult>((complete) => {
        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        let stdoutCaptured = 0
        let stderrCaptured = 0
        let stdoutBytes = 0
        let timedOut = false
        let cancelled = false
        let forceKillTimer: NodeJS.Timeout | undefined
        let spawnError: Error | undefined

        const child = spawn(gitExecutable, argv, {
          cwd,
          detached: process.platform !== 'win32',
          env: environment,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        child.stdout?.on('data', (value: Buffer | string) => {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
          stdoutBytes += chunk.length
          stdoutCaptured += appendBounded(stdoutChunks, chunk, stdoutCaptured, stdoutLimit)
        })
        child.stderr?.on('data', (value: Buffer | string) => {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
          stderrCaptured += appendBounded(stderrChunks, chunk, stderrCaptured, STDERR_LIMIT_BYTES)
        })
        child.once('error', (error) => {
          spawnError = error
        })

        const terminate = (): void => {
          signalProcessTree(child, 'SIGTERM')
          forceKillTimer = setTimeout(
            () => signalProcessTree(child, 'SIGKILL'),
            FORCE_KILL_DELAY_MS,
          )
          forceKillTimer.unref()
        }
        const timeout = setTimeout(() => {
          timedOut = true
          terminate()
        }, this.timeoutMs)
        timeout.unref()
        const onAbort = (): void => {
          cancelled = true
          terminate()
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        child.once('close', (exitCode, terminationSignal) => {
          clearTimeout(timeout)
          if (forceKillTimer) {
            clearTimeout(forceKillTimer)
            if (timedOut || cancelled) signalProcessTree(child, 'SIGKILL', true)
          }
          signal?.removeEventListener('abort', onAbort)
          complete({
            exitCode,
            signal: terminationSignal,
            stdout: Buffer.concat(stdoutChunks),
            stderr: Buffer.concat(stderrChunks),
            stdoutBytes,
            stdoutTruncated: stdoutBytes > stdoutCaptured,
            timedOut,
            cancelled,
            ...(spawnError ? { spawnError } : {}),
          })
        })
      })
    } finally {
      await rm(temporaryHome, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async resolveGitExecutable(workspaceRoot: string): Promise<string> {
    const executableName = process.platform === 'win32' ? 'git.exe' : 'git'
    const candidates = this.configuredGitExecutable
      ? [this.configuredGitExecutable]
      : (process.env.PATH ?? '')
          .split(delimiter)
          .map((directory) => directory.replace(/^"|"$/g, ''))
          .filter((directory) => isAbsolute(directory))
          .map((directory) => join(directory, executableName))

    for (const candidate of candidates) {
      try {
        const canonical = await realpath(candidate)
        if (isPathContained(workspaceRoot, canonical)) continue
        await access(canonical, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        return canonical
      } catch {
        // Continue to the next absolute PATH entry.
      }
    }
    throw new GitServiceError({
      code: 'GIT_NOT_FOUND',
      executable: this.configuredGitExecutable ?? executableName,
    })
  }

  private assertSuccessful(result: GitCommandResult, operation: GitOperation): void {
    if (result.cancelled) {
      throw new GitServiceError({ code: 'CANCELLED' })
    }
    if (result.timedOut) {
      throw new GitServiceError({ code: 'GIT_TIMEOUT', operation })
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString('utf8')
      const externalDetail = result.spawnError?.message ?? (stderr.trim() ? stderr : undefined)
      throw new GitServiceError(
        {
          code: 'GIT_FAILED',
          identifier: 'command',
          operation,
          externalDetail,
          exitCode: result.exitCode,
        },
        result.spawnError ? { cause: result.spawnError } : undefined,
      )
    }
  }
}
