import { type ChildProcess, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  formatServiceErrorDescriptor,
  SERVICE_ERROR_MARKER,
  type StructuredProcessErrorCode,
  type StructuredProcessErrorDetail,
  type StructuredProcessServiceErrorDescriptor,
} from './service-error-messages'
import { isPathContained } from './workspace'

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_TIMEOUT_MS = 15 * 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024
const MAX_ARGUMENT_COUNT = 256
const MAX_ARGUMENT_BYTES = 64 * 1024
const MAX_TOTAL_ARGUMENT_BYTES = 256 * 1024
const FORCE_KILL_DELAY_MS = 500

const INHERITED_ENVIRONMENT_NAMES = new Set([
  'COMSPEC',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TERM',
  'TZ',
  'WINDIR',
])
const SENSITIVE_ENVIRONMENT_NAME = /(?:KEY|TOKEN|SECRET|HOME|SSH|AWS)/i

export interface ExecutionWorkspaceProvider {
  getWorkspace(): { path: string } | null
}

export interface StructuredProcessRequest {
  argv: string[]
  cwd?: string
  timeoutMs?: number
}

export interface StructuredProcessOutputEvent {
  stream: 'stdout' | 'stderr'
  chunk: string
}

export interface StructuredProcessRunOptions {
  signal?: AbortSignal
  /** Optional bounded UTF-8 input written once before stdin is closed. */
  stdin?: string
  onOutput?: (event: StructuredProcessOutputEvent) => void
}

export interface StructuredProcessResult {
  argv: string[]
  cwd: string
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  totalOutputBytes: number
  outputTruncated: boolean
  timedOut: boolean
  cancelled: boolean
  durationMs: number
  isolation: 'structured-process'
  network: 'host'
  spawnError?: string
}

export interface StructuredProcessPreview {
  argv: string[]
  cwd: string
  timeoutMs: number
  isolation: 'structured-process'
  network: 'host'
}

export interface StructuredProcessRunnerOptions {
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
  maxOutputBytes?: number
  maxInputBytes?: number
  tempDirectory?: string
  /** Delay between a graceful tree termination and the forced termination fallback. */
  forceKillDelayMs?: number
  /** Environment source sanitized before executable discovery and process launch. */
  environmentSource?: NodeJS.ProcessEnv
}

export class StructuredProcessError extends Error {
  readonly code: StructuredProcessErrorCode
  readonly descriptor: StructuredProcessServiceErrorDescriptor
  readonly [SERVICE_ERROR_MARKER] = true as const

  constructor(detail: StructuredProcessErrorDetail, options?: ErrorOptions)
  constructor(code: StructuredProcessErrorCode, message: string, options?: ErrorOptions)
  constructor(
    detailOrCode: StructuredProcessErrorDetail | StructuredProcessErrorCode,
    messageOrOptions?: string | ErrorOptions,
    legacyOptions?: ErrorOptions,
  ) {
    const descriptor = (
      typeof detailOrCode === 'string'
        ? { service: 'execution', code: detailOrCode }
        : { service: 'execution', ...detailOrCode }
    ) as StructuredProcessServiceErrorDescriptor
    const message =
      typeof messageOrOptions === 'string'
        ? messageOrOptions
        : formatServiceErrorDescriptor('ko', descriptor)
    const options = typeof messageOrOptions === 'string' ? legacyOptions : messageOrOptions
    super(message, options)
    this.name = 'StructuredProcessError'
    this.code = descriptor.code
    this.descriptor = descriptor
  }
}

export type { StructuredProcessErrorCode } from './service-error-messages'

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`)
  }
  return value
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function validateArgv(argv: string[]): string[] {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > MAX_ARGUMENT_COUNT) {
    throw new StructuredProcessError({
      code: 'INVALID_ARGUMENTS',
      identifier: 'argv-count',
      minimum: 1,
      maximum: MAX_ARGUMENT_COUNT,
    })
  }

  let totalBytes = 0
  const validated = argv.map((argument, index) => {
    if (typeof argument !== 'string' || argument.includes('\0')) {
      throw new StructuredProcessError({
        code: 'INVALID_ARGUMENTS',
        identifier: 'argv-entry',
        index,
      })
    }
    const bytes = Buffer.byteLength(argument)
    if (bytes > MAX_ARGUMENT_BYTES) {
      throw new StructuredProcessError({
        code: 'INVALID_ARGUMENTS',
        identifier: 'argv-entry-too-large',
        index,
        maximumBytes: MAX_ARGUMENT_BYTES,
      })
    }
    totalBytes += bytes
    return argument
  })

  if (validated[0].length === 0 || totalBytes > MAX_TOTAL_ARGUMENT_BYTES) {
    throw new StructuredProcessError({
      code: 'INVALID_ARGUMENTS',
      identifier: 'argv-total',
      maximumBytes: MAX_TOTAL_ARGUMENT_BYTES,
    })
  }
  return validated
}

async function canonicalExecutable(candidate: string): Promise<string | null> {
  try {
    const canonicalPath = await realpath(candidate)
    if (!(await stat(canonicalPath)).isFile()) return null
    if (process.platform !== 'win32') await access(canonicalPath, constants.X_OK)
    return canonicalPath
  } catch {
    return null
  }
}

async function resolveExecutablePath(
  requested: string,
  cwd: string,
  source: NodeJS.ProcessEnv,
): Promise<string> {
  const containsSeparator = requested.includes('/') || requested.includes('\\')
  if (isAbsolute(requested) || containsSeparator) {
    const resolved = await canonicalExecutable(
      isAbsolute(requested) ? requested : resolve(cwd, requested),
    )
    if (resolved) return resolved
    throw new StructuredProcessError({
      code: 'INVALID_ARGUMENTS',
      identifier: 'executable-path-not-found',
      executable: requested,
    })
  }

  const pathEntries = (source.PATH ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && isAbsolute(entry))
  const extensions =
    process.platform === 'win32' && !extname(requested)
      ? (source.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((extension) => extension.trim())
          .filter(Boolean)
      : ['']
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const resolved = await canonicalExecutable(join(directory, `${requested}${extension}`))
      if (resolved) return resolved
    }
  }
  throw new StructuredProcessError({
    code: 'INVALID_ARGUMENTS',
    identifier: 'executable-not-on-path',
    executable: requested,
  })
}

/**
 * Only non-secret process-locale and executable-discovery values cross the boundary. The caller's
 * HOME and credential-related variables are deliberately ignored; the runner supplies fresh
 * per-run directories below.
 */
export function createSanitizedProcessEnvironment(
  temporaryHome: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      INHERITED_ENVIRONMENT_NAMES.has(name.toUpperCase()) &&
      !SENSITIVE_ENVIRONMENT_NAME.test(name)
    ) {
      environment[name] = value
    }
  }

  environment.HOME = temporaryHome
  environment.USERPROFILE = temporaryHome
  environment.XDG_CACHE_HOME = join(temporaryHome, '.cache')
  environment.XDG_CONFIG_HOME = join(temporaryHome, '.config')
  environment.TMPDIR = temporaryHome
  environment.TMP = temporaryHome
  environment.TEMP = temporaryHome
  return environment
}

function emitOutput(
  listener: StructuredProcessRunOptions['onOutput'],
  stream: 'stdout' | 'stderr',
  bytes: Buffer,
): void {
  if (!listener || bytes.length === 0) return
  try {
    listener({ stream, chunk: bytes.toString('utf8') })
  } catch {
    // A renderer/listener failure must not interfere with process lifecycle management.
  }
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
  } catch (error) {
    if (!isNodeError(error, 'ESRCH') && child.exitCode === null) {
      try {
        child.kill(signal)
      } catch {
        // The process may have exited between the state check and the signal.
      }
    }
  }
}

/**
 * Executes an argv array without a shell in the selected workspace. This is intentionally named
 * "structured-process": it constrains argument parsing, cwd and inherited environment, but it is
 * not an operating-system sandbox and retains host network access.
 */
export class StructuredProcessRunner {
  private readonly defaultTimeoutMs: number
  private readonly maxTimeoutMs: number
  private readonly maxOutputBytes: number
  private readonly maxInputBytes: number
  private readonly tempDirectory: string
  private readonly forceKillDelayMs: number
  private readonly environmentSource: NodeJS.ProcessEnv

  constructor(
    private readonly workspace: ExecutionWorkspaceProvider,
    options: StructuredProcessRunnerOptions = {},
  ) {
    this.maxTimeoutMs = positiveInteger(
      options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
      'maxTimeoutMs',
    )
    this.defaultTimeoutMs = positiveInteger(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      'defaultTimeoutMs',
    )
    if (this.defaultTimeoutMs > this.maxTimeoutMs) {
      throw new RangeError('defaultTimeoutMs cannot exceed maxTimeoutMs.')
    }
    this.maxOutputBytes = positiveInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      'maxOutputBytes',
    )
    this.maxInputBytes = positiveInteger(
      options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
      'maxInputBytes',
    )
    this.tempDirectory = options.tempDirectory ?? tmpdir()
    this.forceKillDelayMs = positiveInteger(
      options.forceKillDelayMs ?? FORCE_KILL_DELAY_MS,
      'forceKillDelayMs',
    )
    this.environmentSource = { ...(options.environmentSource ?? process.env) }
  }

  async preview(request: StructuredProcessRequest): Promise<StructuredProcessPreview> {
    const argv = validateArgv(request.argv)
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.maxTimeoutMs) {
      throw new StructuredProcessError({
        code: 'INVALID_ARGUMENTS',
        identifier: 'timeout',
        minimum: 1,
        maximum: this.maxTimeoutMs,
      })
    }
    const { root, cwd } = await this.resolveWorkingDirectory(request.cwd)
    if (!isPathContained(root, cwd)) {
      throw new StructuredProcessError({
        code: 'OUTSIDE_WORKSPACE',
        path: request.cwd,
      })
    }
    const executablePath = await resolveExecutablePath(argv[0], cwd, this.environmentSource)
    return {
      argv: [executablePath, ...argv.slice(1)],
      cwd,
      timeoutMs,
      isolation: 'structured-process',
      network: 'host',
    }
  }

  async run(
    request: StructuredProcessRequest,
    options: StructuredProcessRunOptions = {},
  ): Promise<StructuredProcessResult> {
    const stdin = this.validateStdin(options.stdin)
    const { argv, cwd, timeoutMs } = await this.preview(request)

    await mkdir(this.tempDirectory, { recursive: true, mode: 0o700 })
    const temporaryHome = await mkdtemp(join(this.tempDirectory, 'code-assistant-process-'))
    const environment = createSanitizedProcessEnvironment(temporaryHome, this.environmentSource)
    const startedAt = performance.now()

    try {
      if (options.signal?.aborted) {
        return this.createEarlyCancellationResult(argv, cwd, startedAt)
      }

      return await new Promise<StructuredProcessResult>((complete) => {
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let capturedBytes = 0
        let totalOutputBytes = 0
        let outputTruncated = false
        let timedOut = false
        let cancelled = false
        let spawnError: string | undefined
        let settled = false
        let forceKillTimer: NodeJS.Timeout | undefined

        const child = spawn(argv[0], argv.slice(1), {
          cwd,
          detached: process.platform !== 'win32',
          env: environment,
          shell: false,
          stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })

        const acceptOutput = (stream: 'stdout' | 'stderr', value: Buffer | string): void => {
          const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
          totalOutputBytes += bytes.length
          const remaining = Math.max(0, this.maxOutputBytes - capturedBytes)
          const accepted = bytes.subarray(0, remaining)
          if (accepted.length < bytes.length) outputTruncated = true
          if (accepted.length === 0) return
          capturedBytes += accepted.length
          ;(stream === 'stdout' ? stdout : stderr).push(accepted)
          emitOutput(options.onOutput, stream, accepted)
        }

        child.stdout?.on('data', (chunk: Buffer | string) => acceptOutput('stdout', chunk))
        child.stderr?.on('data', (chunk: Buffer | string) => acceptOutput('stderr', chunk))
        if (stdin !== undefined && child.stdin) {
          // A process may exit before consuming all input. EPIPE is a process outcome, not an
          // unhandled host error; close still reports the authoritative exit status below.
          child.stdin.on('error', () => undefined)
          child.stdin.end(stdin, 'utf8')
        }

        const forceTerminateSoon = (): void => {
          signalProcessTree(child, 'SIGTERM')
          forceKillTimer = setTimeout(
            () => signalProcessTree(child, 'SIGKILL'),
            this.forceKillDelayMs,
          )
          forceKillTimer.unref()
        }

        const timeout = setTimeout(() => {
          timedOut = true
          forceTerminateSoon()
        }, timeoutMs)
        timeout.unref()

        const onAbort = (): void => {
          cancelled = true
          forceTerminateSoon()
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })

        child.once('error', (error) => {
          spawnError = error.message
        })

        child.once('close', (exitCode, terminationSignal) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          if (forceKillTimer) {
            clearTimeout(forceKillTimer)
            if (timedOut || cancelled) signalProcessTree(child, 'SIGKILL', true)
          }
          options.signal?.removeEventListener('abort', onAbort)
          complete({
            argv: [...argv],
            cwd,
            exitCode,
            signal: terminationSignal,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            totalOutputBytes,
            outputTruncated,
            timedOut,
            cancelled,
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            isolation: 'structured-process',
            network: 'host',
            ...(spawnError ? { spawnError } : {}),
          })
        })
      })
    } finally {
      await rm(temporaryHome, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async resolveWorkingDirectory(
    requested?: string,
  ): Promise<{ root: string; cwd: string }> {
    const summary = this.workspace.getWorkspace()
    if (!summary) {
      throw new StructuredProcessError({ code: 'NO_WORKSPACE' })
    }
    if (requested?.includes('\0')) {
      throw new StructuredProcessError({ code: 'INVALID_CWD', identifier: 'nul' })
    }

    const root = await realpath(summary.path)
    const lexicalCwd = requested
      ? isAbsolute(requested)
        ? resolve(requested)
        : resolve(root, requested)
      : root
    let cwd: string
    try {
      cwd = await realpath(lexicalCwd)
    } catch (error) {
      throw new StructuredProcessError(
        { code: 'INVALID_CWD', identifier: 'not-found', path: requested },
        { cause: error },
      )
    }
    if (!isPathContained(root, cwd)) {
      throw new StructuredProcessError({ code: 'OUTSIDE_WORKSPACE', path: requested })
    }
    if (!(await stat(cwd)).isDirectory()) {
      throw new StructuredProcessError({
        code: 'INVALID_CWD',
        identifier: 'not-directory',
        path: requested,
      })
    }
    return { root, cwd }
  }

  private validateStdin(value: string | undefined): string | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'string') {
      throw new StructuredProcessError({ code: 'INVALID_STDIN', identifier: 'type' })
    }
    const bytes = Buffer.byteLength(value)
    if (bytes > this.maxInputBytes) {
      throw new StructuredProcessError({
        code: 'INVALID_STDIN',
        identifier: 'too-large',
        maximumBytes: this.maxInputBytes,
      })
    }
    return value
  }

  private createEarlyCancellationResult(
    argv: string[],
    cwd: string,
    startedAt: number,
  ): StructuredProcessResult {
    return {
      argv: [...argv],
      cwd,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      totalOutputBytes: 0,
      outputTruncated: false,
      timedOut: false,
      cancelled: true,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      isolation: 'structured-process',
      network: 'host',
    }
  }
}
