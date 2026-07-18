import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'

const MCP_CONFIG_VERSION = 1 as const
const MCP_PROTOCOL_VERSION = '2025-11-25'
const SUPPORTED_PROTOCOL_VERSIONS = new Set([MCP_PROTOCOL_VERSION, '2025-06-18', '2025-03-26'])

const DEFAULTS = {
  userConfigFileName: 'mcp.json',
  workspaceConfigFileName: '.mcp.json',
  maximumConfigBytes: 256 * 1024,
  maximumServers: 8,
  maximumToolsPerServer: 64,
  maximumTotalTools: 128,
  maximumSchemaBytes: 64 * 1024,
  maximumArgumentsBytes: 128 * 1024,
  maximumResultBytes: 1024 * 1024,
  maximumMessageBytes: 1024 * 1024 + 64 * 1024,
  maximumPendingRequestsPerServer: 16,
  maximumListPages: 16,
  startupTimeoutMs: 10_000,
  callTimeoutMs: 30_000,
  shutdownGraceMs: 250,
} as const

const serverIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
const safeTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), 'NUL bytes are not allowed.')
const argumentSchema = z
  .string()
  .max(8192)
  .refine((value) => !value.includes('\0'), 'NUL bytes are not allowed.')
const environmentKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
const environmentValueSchema = z
  .string()
  .max(32_768)
  .refine((value) => !value.includes('\0'), 'NUL bytes are not allowed.')
const serverConfigSchema = z
  .object({
    id: serverIdSchema,
    name: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().default(false),
    command: safeTextSchema,
    args: z.array(argumentSchema).max(64).default([]),
    cwd: safeTextSchema.optional(),
    env: z
      .record(environmentKeySchema, environmentValueSchema)
      .refine((value) => Object.keys(value).length <= 64, 'Too many environment entries.')
      .default({}),
  })
  .strict()

type ParsedServerConfig = z.infer<typeof serverConfigSchema>

const jsonObjectSchema = z.record(z.string(), z.json())
const toolAnnotationsSchema = z
  .object({
    title: z.string().max(512).optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .strip()
const toolSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    title: z.string().trim().min(1).max(512).optional(),
    description: z.string().max(8192).optional(),
    inputSchema: jsonObjectSchema,
    outputSchema: jsonObjectSchema.optional(),
    annotations: toolAnnotationsSchema.optional(),
  })
  .strip()
const initializeResultSchema = z
  .object({
    protocolVersion: z.string().min(1).max(64),
    capabilities: z
      .object({
        tools: z.object({ listChanged: z.boolean().optional() }).passthrough().optional(),
      })
      .passthrough(),
    serverInfo: z
      .object({
        name: z.string().trim().min(1).max(256),
        title: z.string().trim().min(1).max(512).optional(),
        version: z.string().trim().min(1).max(128),
      })
      .strip(),
  })
  .strip()

type McpToolWireDescriptor = z.infer<typeof toolSchema>

export type McpConfigurationSource = 'user' | 'workspace'
export type McpToolCapability = 'process' | 'write' | 'network'
export type McpToolRisk = 'approval-required'
export type McpJsonValue =
  | string
  | number
  | boolean
  | null
  | McpJsonValue[]
  | { [key: string]: McpJsonValue }

export interface McpServerSummary {
  id: string
  name: string
  source: McpConfigurationSource
  enabled: boolean
  command: string
  args: string[]
  cwd: string | null
  environmentKeys: string[]
  environment: Record<string, string>
  revision: string
}

export interface McpConfigFileSnapshot {
  path: string
  revision: string
  servers: McpServerSummary[]
}

export interface McpConfigurationSnapshot {
  revision: string
  user: McpConfigFileSnapshot
  workspace: McpConfigFileSnapshot | null
  workspaceTrusted: boolean
}

export interface McpWorkspaceExecutionApproval {
  actionHash: string
  configurationRevision: string
  path: string
  servers: McpServerSummary[]
}

export interface McpApprovalGrant {
  approved: boolean
  actionHash: string
}

export interface McpDiscoveredTool {
  /** A deterministic, ToolRegistry-compatible alias. The original MCP name remains `name`. */
  registryName: string
  serverId: string
  serverName: string
  name: string
  title: string | null
  description: string
  inputSchema: Record<string, McpJsonValue>
  outputSchema: Record<string, McpJsonValue> | null
  revision: string
  origin: 'mcp'
  metadataTrusted: false
  capability: McpToolCapability[]
  risk: McpToolRisk
  /** Server annotations are untrusted display hints and never relax host policy. */
  annotations: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

export interface McpDiscoveredServer {
  id: string
  name: string
  title: string | null
  version: string
  source: McpConfigurationSource
  protocolVersion: string
  toolCount: number
}

export interface McpDiscoveryError {
  serverId: string
  source: McpConfigurationSource
  code: McpServiceErrorCode
  message: string
}

export interface McpDiscoveryResult {
  configurationRevision: string
  servers: McpDiscoveredServer[]
  tools: McpDiscoveredTool[]
  errors: McpDiscoveryError[]
  workspaceApprovalRequired: McpWorkspaceExecutionApproval | null
}

export interface McpCallInput {
  serverId: string
  toolName: string
  revision: string
  arguments: Record<string, McpJsonValue>
}

export interface McpToolExecutionApproval {
  actionHash: string
  serverId: string
  serverName: string
  toolName: string
  title: string | null
  revision: string
  arguments: Record<string, McpJsonValue>
  origin: 'mcp'
  capability: McpToolCapability[]
  risk: McpToolRisk
}

export interface McpToolExecutionResult {
  serverId: string
  toolName: string
  revision: string
  actionHash: string
  isError: boolean
  untrustedContent: true
  result: Record<string, McpJsonValue>
}

export interface McpInspectOptions {
  workspacePath?: string
  workspaceTrusted?: boolean
}

export interface McpDiscoverOptions extends McpInspectOptions {
  signal?: AbortSignal
  /** Required on every discovery that would execute workspace-owned server configuration. */
  authorizeWorkspace?: (
    request: McpWorkspaceExecutionApproval,
  ) => Promise<McpApprovalGrant> | McpApprovalGrant
}

export interface McpCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** All MCP calls require an exact, action-hash-bound grant. */
  authorize?: (request: McpToolExecutionApproval) => Promise<McpApprovalGrant> | McpApprovalGrant
}

export interface McpServiceOptions {
  userDataPath: string
  userConfigFileName?: string
  workspaceConfigFileName?: string
  maximumConfigBytes?: number
  maximumServers?: number
  maximumToolsPerServer?: number
  maximumTotalTools?: number
  maximumSchemaBytes?: number
  maximumArgumentsBytes?: number
  maximumResultBytes?: number
  maximumMessageBytes?: number
  maximumPendingRequestsPerServer?: number
  maximumListPages?: number
  startupTimeoutMs?: number
  callTimeoutMs?: number
  shutdownGraceMs?: number
}

export type McpServiceErrorCode =
  | 'INVALID_CONFIG'
  | 'CONFIG_TOO_LARGE'
  | 'SERVER_LIMIT_EXCEEDED'
  | 'WORKSPACE_NOT_TRUSTED'
  | 'WORKSPACE_APPROVAL_REQUIRED'
  | 'SPAWN_FAILED'
  | 'STARTUP_TIMEOUT'
  | 'PROTOCOL_ERROR'
  | 'TOOL_LIMIT_EXCEEDED'
  | 'SCHEMA_TOO_LARGE'
  | 'SERVER_NOT_FOUND'
  | 'TOOL_NOT_FOUND'
  | 'REVISION_MISMATCH'
  | 'POLICY_APPROVAL_REQUIRED'
  | 'POLICY_DENIED'
  | 'ARGUMENTS_TOO_LARGE'
  | 'CALL_TIMEOUT'
  | 'ABORTED'
  | 'RESULT_TOO_LARGE'
  | 'CLOSED'

export class McpServiceError extends Error {
  readonly code: McpServiceErrorCode

  constructor(code: McpServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'McpServiceError'
    this.code = code
  }
}

interface NormalizedOptions extends Required<McpServiceOptions> {}

interface LoadedConfigFile {
  path: string
  revision: string
  missing: boolean
  servers: Array<ParsedServerConfig & { source: McpConfigurationSource; revision: string }>
}

interface LoadedConfiguration {
  revision: string
  user: LoadedConfigFile
  workspace: LoadedConfigFile | null
  workspacePath: string | null
  workspaceTrusted: boolean
}

interface SessionRecord {
  session: StdioMcpSession
  server: McpDiscoveredServer
  tools: Map<string, McpDiscoveredTool>
}

interface JsonRpcRequestOptions {
  signal?: AbortSignal
  timeoutMs: number
  timeoutCode: 'STARTUP_TIMEOUT' | 'CALL_TIMEOUT'
}

interface PendingRequest {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  signal?: AbortSignal
  abortHandler?: () => void
}

interface StdioMcpSessionOptions {
  child: ChildProcessWithoutNullStreams
  maximumMessageBytes: number
  maximumPendingRequests: number
  shutdownGraceMs: number
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new McpServiceError('INVALID_CONFIG', 'MCP service limits must be positive integers.')
  }
  return value
}

function normalizedOptions(options: McpServiceOptions): NormalizedOptions {
  if (!isAbsolute(options.userDataPath)) {
    throw new McpServiceError('INVALID_CONFIG', 'userDataPath must be an absolute path.')
  }
  const userConfigFileName = options.userConfigFileName ?? DEFAULTS.userConfigFileName
  const workspaceConfigFileName =
    options.workspaceConfigFileName ?? DEFAULTS.workspaceConfigFileName
  for (const fileName of [userConfigFileName, workspaceConfigFileName]) {
    if (!fileName || fileName !== fileName.trim() || dirname(fileName) !== '.') {
      throw new McpServiceError('INVALID_CONFIG', 'MCP config file names must be plain file names.')
    }
  }
  return {
    ...options,
    userDataPath: resolve(options.userDataPath),
    userConfigFileName,
    workspaceConfigFileName,
    maximumConfigBytes: positiveInteger(
      options.maximumConfigBytes,
      DEFAULTS.maximumConfigBytes,
      16 * 1024 * 1024,
    ),
    maximumServers: positiveInteger(options.maximumServers, DEFAULTS.maximumServers, 64),
    maximumToolsPerServer: positiveInteger(
      options.maximumToolsPerServer,
      DEFAULTS.maximumToolsPerServer,
      512,
    ),
    maximumTotalTools: positiveInteger(options.maximumTotalTools, DEFAULTS.maximumTotalTools, 2048),
    maximumSchemaBytes: positiveInteger(
      options.maximumSchemaBytes,
      DEFAULTS.maximumSchemaBytes,
      4 * 1024 * 1024,
    ),
    maximumArgumentsBytes: positiveInteger(
      options.maximumArgumentsBytes,
      DEFAULTS.maximumArgumentsBytes,
      4 * 1024 * 1024,
    ),
    maximumResultBytes: positiveInteger(
      options.maximumResultBytes,
      DEFAULTS.maximumResultBytes,
      16 * 1024 * 1024,
    ),
    maximumMessageBytes: positiveInteger(
      options.maximumMessageBytes,
      DEFAULTS.maximumMessageBytes,
      32 * 1024 * 1024,
    ),
    maximumPendingRequestsPerServer: positiveInteger(
      options.maximumPendingRequestsPerServer,
      DEFAULTS.maximumPendingRequestsPerServer,
      128,
    ),
    maximumListPages: positiveInteger(options.maximumListPages, DEFAULTS.maximumListPages, 128),
    startupTimeoutMs: positiveInteger(
      options.startupTimeoutMs,
      DEFAULTS.startupTimeoutMs,
      5 * 60_000,
    ),
    callTimeoutMs: positiveInteger(options.callTimeoutMs, DEFAULTS.callTimeoutMs, 30 * 60_000),
    shutdownGraceMs: positiveInteger(options.shutdownGraceMs, DEFAULTS.shutdownGraceMs, 10_000),
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  const normalize = (entry: unknown): unknown => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry
    if (Array.isArray(entry)) return entry.map(normalize)
    if (typeof entry === 'object') {
      if (seen.has(entry)) {
        throw new McpServiceError('INVALID_CONFIG', 'Cyclic JSON values are not supported.')
      }
      seen.add(entry)
      const object = entry as Record<string, unknown>
      const normalized: Record<string, unknown> = {}
      for (const key of Object.keys(object).sort()) normalized[key] = normalize(object[key])
      seen.delete(entry)
      return normalized
    }
    throw new McpServiceError('INVALID_CONFIG', 'Only finite JSON values are supported.')
  }
  return JSON.stringify(normalize(value))
}

function hashesEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function errorMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return 'Unknown MCP server failure.'
  return stripControlCharacters(cause.message).slice(0, 1000)
}

function asServiceError(
  cause: unknown,
  fallbackCode: McpServiceErrorCode,
  fallbackMessage: string,
): McpServiceError {
  if (cause instanceof McpServiceError) return cause
  return new McpServiceError(fallbackCode, fallbackMessage, { cause })
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new McpServiceError('ABORTED', 'MCP operation was cancelled.', {
      cause: signal.reason,
    })
  }
}

async function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  assertNotAborted(signal)
  if (!signal) return operation
  return new Promise<T>((resolveOperation, rejectOperation) => {
    let settled = false
    const settle = (error: Error | null, value?: T) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abortHandler)
      if (error) rejectOperation(error)
      else resolveOperation(value as T)
    }
    const abortHandler = () => {
      settle(
        new McpServiceError('ABORTED', 'MCP operation was cancelled.', {
          cause: signal.reason,
        }),
      )
    }
    signal.addEventListener('abort', abortHandler, { once: true })
    if (signal.aborted) abortHandler()
    operation.then(
      (value) => settle(null, value),
      (cause) => settle(cause instanceof Error ? cause : new Error(String(cause))),
    )
  })
}

function remainingTimeout(deadline: number, code: 'STARTUP_TIMEOUT' | 'CALL_TIMEOUT'): number {
  const remaining = deadline - Date.now()
  if (remaining < 1) {
    throw new McpServiceError(
      code,
      code === 'STARTUP_TIMEOUT' ? 'MCP server startup timed out.' : 'MCP tool call timed out.',
    )
  }
  return remaining
}

function parseApprovalGrant(value: unknown): McpApprovalGrant {
  const parsed = z
    .object({
      approved: z.boolean(),
      actionHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .safeParse(value)
  if (!parsed.success) {
    throw new McpServiceError('POLICY_DENIED', 'The host returned an invalid MCP approval grant.')
  }
  return parsed.data
}

function ensureContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function sanitizeDescription(value: string | undefined): string {
  const sanitized = (value ?? '')
    .replace(/[^\S\r\n]+/g, ' ')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code === 0x0a || code === 0x0d || code >= 0x20
    })
    .join('')
    .trim()
    .slice(0, 4000)
  return sanitized || 'MCP tool'
}

function stripControlCharacters(value: string): string {
  return value
    .split('')
    .filter((character) => character.charCodeAt(0) >= 0x20)
    .join('')
}

function registryName(serverId: string, toolName: string, revisionSeed: string): string {
  const server = serverId.replace(/[^A-Za-z0-9_]+/g, '_').slice(0, 18)
  const tool = toolName
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+/, '')
    .slice(0, 25)
  const digest = sha256(revisionSeed).slice(0, 12)
  return `mcp_${server || 'server'}_${tool || 'tool'}_${digest}`.slice(0, 64)
}

function blockedEnvironmentKey(key: string): boolean {
  const upper = key.toUpperCase()
  return (
    upper === 'PATH' ||
    upper === 'HOME' ||
    upper === 'USERPROFILE' ||
    upper === 'TMPDIR' ||
    upper === 'TMP' ||
    upper === 'TEMP' ||
    upper === 'SYSTEMROOT' ||
    upper === 'WINDIR' ||
    upper === 'COMSPEC' ||
    upper === 'PATHEXT' ||
    upper === 'NODE_OPTIONS' ||
    upper === 'NODE_PATH' ||
    upper === 'ELECTRON_RUN_AS_NODE' ||
    upper === 'BASH_ENV' ||
    upper === 'ENV' ||
    upper === 'PROMPT_COMMAND' ||
    upper === 'ZDOTDIR' ||
    upper === 'SSLKEYLOGFILE' ||
    upper === 'LD_PRELOAD' ||
    upper.startsWith('DYLD_')
  )
}

function sanitizedPath(value: string | undefined): string | undefined {
  if (!value) return undefined
  const entries = value
    .split(delimiter)
    .filter((entry) => entry.length > 0 && isAbsolute(entry) && !entry.includes('\0'))
  return entries.length > 0 ? [...new Set(entries)].join(delimiter) : undefined
}

function minimalParentEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  const path = sanitizedPath(process.env.PATH)
  if (path) environment.PATH = path

  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    const value = process.env[key]
    if (value && !value.includes('\0')) environment[key] = value
  }
  for (const key of ['LANG', 'LC_ALL']) {
    const value = process.env[key]
    if (value && value.length <= 256 && !value.includes('\0')) environment[key] = value
  }
  return environment
}

async function readBoundedConfig(
  path: string,
  maximumBytes: number,
): Promise<{ bytes: Buffer; missing: boolean }> {
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(path)
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
      return { bytes: Buffer.from('{"version":1,"servers":[]}'), missing: true }
    }
    throw new McpServiceError('INVALID_CONFIG', `Unable to inspect MCP config: ${path}`, {
      cause,
    })
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new McpServiceError('INVALID_CONFIG', `MCP config must be a regular file: ${path}`)
  }
  if (before.size > maximumBytes) {
    throw new McpServiceError('CONFIG_TOO_LARGE', `MCP config exceeds the byte limit: ${path}`)
  }

  const handle = await open(path, 'r')
  try {
    const after = await handle.stat()
    if (
      !after.isFile() ||
      after.size > maximumBytes ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new McpServiceError('INVALID_CONFIG', `MCP config changed while reading: ${path}`)
    }
    const bytes = await handle.readFile()
    if (bytes.byteLength > maximumBytes) {
      throw new McpServiceError('CONFIG_TOO_LARGE', `MCP config exceeds the byte limit: ${path}`)
    }
    return { bytes, missing: false }
  } finally {
    await handle.close()
  }
}

class StdioMcpSession {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly maximumMessageBytes: number
  private readonly maximumPendingRequests: number
  private readonly shutdownGraceMs: number
  private readonly pending = new Map<string, PendingRequest>()
  private nextRequestId = 1
  private stdoutBuffer = Buffer.alloc(0)
  private closing = false
  private closed = false
  private closePromise: Promise<void> | undefined
  private exitResolve!: () => void
  private readonly exitPromise: Promise<void>
  toolsInvalidated = false

  constructor(options: StdioMcpSessionOptions) {
    this.child = options.child
    this.maximumMessageBytes = options.maximumMessageBytes
    this.maximumPendingRequests = options.maximumPendingRequests
    this.shutdownGraceMs = options.shutdownGraceMs
    this.exitPromise = new Promise((resolveExit) => {
      this.exitResolve = resolveExit
    })

    this.child.stdout.on('data', (chunk: Buffer) => this.consumeStdout(chunk))
    this.child.stderr.on('data', () => undefined)
    this.child.on('error', (cause) => {
      this.fail(new McpServiceError('SPAWN_FAILED', 'MCP server process failed.', { cause }))
    })
    this.child.on('exit', () => {
      this.closed = true
      this.exitResolve()
      if (!this.closing) {
        this.fail(new McpServiceError('CLOSED', 'MCP server process exited unexpectedly.'))
      } else {
        this.rejectPending(new McpServiceError('CLOSED', 'MCP server process was closed.'))
      }
    })
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    options: JsonRpcRequestOptions,
  ): Promise<unknown> {
    if (this.closed || this.closing) {
      throw new McpServiceError('CLOSED', 'MCP server is not available.')
    }
    assertNotAborted(options.signal)
    if (this.pending.size >= this.maximumPendingRequests) {
      throw new McpServiceError('PROTOCOL_ERROR', 'Too many pending MCP requests.')
    }

    const id = this.nextRequestId++
    const key = String(id)
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      let settled = false
      const settle = (error: Error | null, result?: unknown) => {
        if (settled) return
        settled = true
        const active = this.pending.get(key)
        if (active) {
          clearTimeout(active.timeout)
          if (active.signal && active.abortHandler) {
            active.signal.removeEventListener('abort', active.abortHandler)
          }
          this.pending.delete(key)
        }
        if (error) rejectRequest(error)
        else resolveRequest(result)
      }

      const timeout = setTimeout(() => {
        void this.notify('notifications/cancelled', {
          requestId: id,
          reason: 'Host request timeout',
        }).catch(() => undefined)
        settle(
          new McpServiceError(
            options.timeoutCode,
            options.timeoutCode === 'STARTUP_TIMEOUT'
              ? 'MCP server startup timed out.'
              : 'MCP tool call timed out.',
          ),
        )
        void this.close()
      }, options.timeoutMs)
      timeout.unref?.()

      const abortHandler = options.signal
        ? () => {
            void this.notify('notifications/cancelled', {
              requestId: id,
              reason: 'Host operation cancelled',
            }).catch(() => undefined)
            settle(
              new McpServiceError('ABORTED', 'MCP operation was cancelled.', {
                cause: options.signal?.reason,
              }),
            )
            void this.close()
          }
        : undefined
      this.pending.set(key, {
        method,
        resolve: (result) => settle(null, result),
        reject: (error) => settle(error),
        timeout,
        ...(options.signal && abortHandler ? { signal: options.signal, abortHandler } : {}),
      })
      if (options.signal && abortHandler) {
        options.signal.addEventListener('abort', abortHandler, { once: true })
        if (options.signal.aborted) abortHandler()
      }

      this.write({ jsonrpc: '2.0', id, method, params }).catch((cause) => {
        settle(asServiceError(cause, 'PROTOCOL_ERROR', `Unable to send MCP request: ${method}`))
        void this.close()
      })
    })
  }

  notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.closed || this.closing) return Promise.resolve()
    return this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = this.performClose()
    return this.closePromise
  }

  private async performClose(): Promise<void> {
    this.rejectPending(new McpServiceError('CLOSED', 'MCP server process was closed.'))
    if (this.closed) return
    this.child.stdin.end()

    const exitedGracefully = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<false>((resolveTimeout) => {
        const timer = setTimeout(() => resolveTimeout(false), this.shutdownGraceMs)
        timer.unref?.()
      }),
    ])
    if (exitedGracefully || this.closed) return

    await terminateProcessTree(this.child, 'SIGTERM')
    const exitedAfterTerminate = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<false>((resolveTimeout) => {
        const timer = setTimeout(() => resolveTimeout(false), this.shutdownGraceMs)
        timer.unref?.()
      }),
    ])
    if (!exitedAfterTerminate && !this.closed) await terminateProcessTree(this.child, 'SIGKILL')
  }

  private async write(message: Record<string, unknown>): Promise<void> {
    const serialized = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(serialized) > this.maximumMessageBytes) {
      throw new McpServiceError('PROTOCOL_ERROR', 'Outgoing MCP message exceeds the byte limit.')
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      this.child.stdin.write(serialized, 'utf8', (cause) => {
        if (cause) rejectWrite(cause)
        else resolveWrite()
      })
    })
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.closed || this.closing) return
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])
    let newline = this.stdoutBuffer.indexOf(0x0a)
    while (newline >= 0) {
      const line = this.stdoutBuffer.subarray(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1)
      if (line.byteLength > this.maximumMessageBytes) {
        this.fail(new McpServiceError('PROTOCOL_ERROR', 'Incoming MCP message is too large.'))
        return
      }
      if (line.byteLength > 0) this.consumeLine(line)
      newline = this.stdoutBuffer.indexOf(0x0a)
    }
    if (this.stdoutBuffer.byteLength > this.maximumMessageBytes) {
      this.fail(new McpServiceError('PROTOCOL_ERROR', 'Incoming MCP message is too large.'))
    }
  }

  private consumeLine(line: Buffer): void {
    let message: unknown
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(line)
      message = JSON.parse(decoded.replace(/\r$/, ''))
    } catch (cause) {
      this.fail(
        new McpServiceError('PROTOCOL_ERROR', 'MCP server emitted invalid JSON.', { cause }),
      )
      return
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.fail(new McpServiceError('PROTOCOL_ERROR', 'MCP server emitted an invalid message.'))
      return
    }
    const object = message as Record<string, unknown>
    if (object.jsonrpc !== '2.0') {
      this.fail(
        new McpServiceError('PROTOCOL_ERROR', 'MCP server used an invalid JSON-RPC version.'),
      )
      return
    }

    if ('id' in object && ('result' in object || 'error' in object) && !('method' in object)) {
      const request = this.pending.get(String(object.id))
      if (!request) return
      if ('error' in object) {
        const rpcError = object.error
        const messageText =
          rpcError && typeof rpcError === 'object' && 'message' in rpcError
            ? String((rpcError as { message: unknown }).message).slice(0, 1000)
            : `MCP request failed: ${request.method}`
        request.reject(new McpServiceError('PROTOCOL_ERROR', messageText))
      } else {
        request.resolve(object.result)
      }
      return
    }

    if (typeof object.method === 'string') {
      if (object.method === 'notifications/tools/list_changed') this.toolsInvalidated = true
      if ('id' in object) {
        const response =
          object.method === 'ping'
            ? { jsonrpc: '2.0', id: object.id, result: {} }
            : {
                jsonrpc: '2.0',
                id: object.id,
                error: { code: -32601, message: 'Client method not supported' },
              }
        void this.write(response).catch(() => this.close())
      }
      return
    }
    this.fail(new McpServiceError('PROTOCOL_ERROR', 'MCP server emitted an invalid message.'))
  }

  private fail(error: McpServiceError): void {
    this.rejectPending(error)
    void this.close()
  }

  private rejectPending(error: McpServiceError): void {
    for (const request of [...this.pending.values()]) request.reject(error)
  }
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: 'SIGTERM' | 'SIGKILL',
): Promise<void> {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
    if (!systemRoot || !isAbsolute(systemRoot)) {
      child.kill(signal)
      return
    }
    const systemDirectory = join(systemRoot, 'System32')
    await new Promise<void>((resolveTermination) => {
      const terminator = spawn(
        join(systemDirectory, 'taskkill.exe'),
        ['/pid', String(child.pid), '/T', '/F'],
        {
          env: {
            PATH: systemDirectory,
            SystemRoot: systemRoot,
            SYSTEMROOT: systemRoot,
            WINDIR: systemRoot,
          },
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        },
      )
      terminator.once('error', () => {
        child.kill(signal)
        resolveTermination()
      })
      terminator.once('exit', () => resolveTermination())
    })
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

/**
 * Optional MCP stdio host. Configuration inspection never launches processes. Workspace-owned
 * configuration additionally needs workspace trust and an exact revision-bound authorization.
 */
export class McpService {
  private readonly options: NormalizedOptions
  private readonly sessions = new Map<string, SessionRecord>()
  private operationTail: Promise<void> = Promise.resolve()

  constructor(options: McpServiceOptions) {
    this.options = normalizedOptions(options)
  }

  get userConfigPath(): string {
    return join(this.options.userDataPath, this.options.userConfigFileName)
  }

  get workspaceConfigFileName(): string {
    return this.options.workspaceConfigFileName
  }

  async saveUserConfiguration(input: unknown): Promise<McpConfigurationSnapshot> {
    const parsed = this.parseConfig(input, this.userConfigPath, 'user')
    const serialized = `${JSON.stringify(parsed, null, 2)}\n`
    if (Buffer.byteLength(serialized) > this.options.maximumConfigBytes) {
      throw new McpServiceError('CONFIG_TOO_LARGE', 'MCP configuration exceeds the byte limit.')
    }
    await mkdir(this.options.userDataPath, { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.userConfigPath}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporaryPath, 'wx', 0o600)
      try {
        await handle.writeFile(serialized, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporaryPath, this.userConfigPath)
      await chmod(this.userConfigPath, 0o600)
    } catch (cause) {
      await unlink(temporaryPath).catch(() => undefined)
      throw cause
    }
    return this.inspect()
  }

  async inspect(options: McpInspectOptions = {}): Promise<McpConfigurationSnapshot> {
    const configuration = await this.loadConfiguration(options)
    return this.toSnapshot(configuration)
  }

  async discover(options: McpDiscoverOptions = {}): Promise<McpDiscoveryResult> {
    return this.serialize(async () => {
      assertNotAborted(options.signal)
      await this.closeSessions()
      const configuration = await this.loadConfiguration(options)
      const snapshot = this.toSnapshot(configuration)
      const enabledUserServers = configuration.user.servers.filter((server) => server.enabled)
      const enabledWorkspaceServers =
        configuration.workspace?.servers.filter((server) => server.enabled) ?? []
      let workspaceApprovalRequired: McpWorkspaceExecutionApproval | null = null
      let approvedWorkspaceServers: typeof enabledWorkspaceServers = []

      if (enabledWorkspaceServers.length > 0 && configuration.workspace) {
        const approval = this.workspaceApproval(snapshot, configuration.workspace)
        if (!configuration.workspaceTrusted) {
          workspaceApprovalRequired = approval
        } else if (!options.authorizeWorkspace) {
          workspaceApprovalRequired = approval
        } else {
          const expectedActionHash = approval.actionHash
          const grant = parseApprovalGrant(
            await awaitWithAbort(
              Promise.resolve(options.authorizeWorkspace(approval)),
              options.signal,
            ),
          )
          assertNotAborted(options.signal)
          if (grant.approved && hashesEqual(grant.actionHash, expectedActionHash)) {
            approvedWorkspaceServers = enabledWorkspaceServers
          } else {
            workspaceApprovalRequired = approval
          }
        }
      }

      const selectedServers = [...enabledUserServers, ...approvedWorkspaceServers]
      if (selectedServers.length > this.options.maximumServers) {
        throw new McpServiceError(
          'SERVER_LIMIT_EXCEEDED',
          `Enabled MCP servers exceed the ${this.options.maximumServers} server limit.`,
        )
      }
      const duplicateIds = selectedServers
        .map((server) => server.id)
        .filter((id, index, values) => values.indexOf(id) !== index)
      if (duplicateIds.length > 0) {
        throw new McpServiceError(
          'INVALID_CONFIG',
          `MCP server ids must be unique across user and workspace configuration: ${duplicateIds[0]}`,
        )
      }

      const errors: McpDiscoveryError[] = []
      const records: SessionRecord[] = []
      await Promise.all(
        selectedServers.map(async (server) => {
          try {
            const record = await this.startServer(
              server,
              configuration.workspacePath,
              options.signal,
            )
            records.push(record)
          } catch (cause) {
            const error = asServiceError(cause, 'SPAWN_FAILED', 'Unable to start MCP server.')
            errors.push({
              serverId: server.id,
              source: server.source,
              code: error.code,
              message: errorMessage(error),
            })
          }
        }),
      )
      if (options.signal?.aborted) {
        await Promise.all(records.map((record) => record.session.close()))
      }
      assertNotAborted(options.signal)

      const toolCount = records.reduce((count, record) => count + record.tools.size, 0)
      if (toolCount > this.options.maximumTotalTools) {
        await Promise.all(records.map((record) => record.session.close()))
        throw new McpServiceError(
          'TOOL_LIMIT_EXCEEDED',
          `Discovered MCP tools exceed the ${this.options.maximumTotalTools} tool limit.`,
        )
      }
      for (const record of records) this.sessions.set(record.server.id, record)

      return {
        configurationRevision: configuration.revision,
        servers: records.map((record) => record.server).sort((a, b) => a.id.localeCompare(b.id)),
        tools: records
          .flatMap((record) => [...record.tools.values()])
          .sort((a, b) => a.registryName.localeCompare(b.registryName)),
        errors: errors.sort((a, b) => a.serverId.localeCompare(b.serverId)),
        workspaceApprovalRequired,
      }
    })
  }

  async callTool(
    input: McpCallInput,
    options: McpCallOptions = {},
  ): Promise<McpToolExecutionResult> {
    assertNotAborted(options.signal)
    const call = z
      .object({
        serverId: serverIdSchema,
        toolName: z.string().trim().min(1).max(128),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        arguments: jsonObjectSchema,
      })
      .strict()
      .parse(input)
    const record = this.sessions.get(call.serverId)
    if (!record) {
      throw new McpServiceError('SERVER_NOT_FOUND', `MCP server is not active: ${call.serverId}`)
    }
    if (record.session.toolsInvalidated) {
      throw new McpServiceError(
        'REVISION_MISMATCH',
        'The MCP server changed its tool list. Rediscover tools before calling it.',
      )
    }
    const tool = record.tools.get(call.toolName)
    if (!tool) {
      throw new McpServiceError('TOOL_NOT_FOUND', `MCP tool was not discovered: ${call.toolName}`)
    }
    if (!hashesEqual(call.revision, tool.revision)) {
      throw new McpServiceError(
        'REVISION_MISMATCH',
        'The MCP tool metadata changed. Rediscover it before calling.',
      )
    }
    const serializedArguments = stableStringify(call.arguments)
    if (Buffer.byteLength(serializedArguments) > this.options.maximumArgumentsBytes) {
      throw new McpServiceError('ARGUMENTS_TOO_LARGE', 'MCP tool arguments exceed the byte limit.')
    }
    const boundArguments = JSON.parse(serializedArguments) as Record<string, McpJsonValue>

    const actionHash = sha256(
      stableStringify({
        kind: 'mcp-tool-call',
        serverId: call.serverId,
        toolName: call.toolName,
        revision: call.revision,
        arguments: boundArguments,
      }),
    )
    const approval: McpToolExecutionApproval = {
      actionHash,
      serverId: record.server.id,
      serverName: record.server.name,
      toolName: tool.name,
      title: tool.title,
      revision: tool.revision,
      arguments: JSON.parse(serializedArguments) as Record<string, McpJsonValue>,
      origin: 'mcp',
      capability: [...tool.capability],
      risk: tool.risk,
    }
    if (!options.authorize) {
      throw new McpServiceError(
        'POLICY_APPROVAL_REQUIRED',
        'MCP tool calls require an explicit host approval callback.',
      )
    }
    const grant = parseApprovalGrant(
      await awaitWithAbort(Promise.resolve(options.authorize(approval)), options.signal),
    )
    assertNotAborted(options.signal)
    if (!grant.approved || !hashesEqual(grant.actionHash, actionHash)) {
      throw new McpServiceError('POLICY_DENIED', 'MCP tool call was not approved for this action.')
    }

    const currentRecord = this.sessions.get(call.serverId)
    const currentTool = currentRecord?.tools.get(call.toolName)
    if (
      currentRecord !== record ||
      record.session.toolsInvalidated ||
      !currentTool ||
      !hashesEqual(currentTool.revision, call.revision)
    ) {
      throw new McpServiceError(
        'REVISION_MISMATCH',
        'MCP tool metadata changed while awaiting approval.',
      )
    }

    let rawResult: unknown
    try {
      rawResult = await record.session.request(
        'tools/call',
        { name: call.toolName, arguments: boundArguments },
        {
          timeoutMs: positiveInteger(
            options.timeoutMs,
            this.options.callTimeoutMs,
            this.options.callTimeoutMs,
          ),
          timeoutCode: 'CALL_TIMEOUT',
          ...(options.signal ? { signal: options.signal } : {}),
        },
      )
    } catch (cause) {
      if (cause instanceof McpServiceError) {
        if (cause.code === 'ABORTED' || cause.code === 'CALL_TIMEOUT' || cause.code === 'CLOSED') {
          await record.session.close()
          if (this.sessions.get(call.serverId) === record) this.sessions.delete(call.serverId)
        }
        throw cause
      }
      throw new McpServiceError('PROTOCOL_ERROR', 'MCP tool call failed.', { cause })
    }
    const result = jsonObjectSchema.safeParse(rawResult)
    if (!result.success) {
      await record.session.close()
      this.sessions.delete(call.serverId)
      throw new McpServiceError('PROTOCOL_ERROR', 'MCP tool returned an invalid result object.')
    }
    const resultBytes = Buffer.byteLength(stableStringify(result.data))
    if (resultBytes > this.options.maximumResultBytes) {
      await record.session.close()
      this.sessions.delete(call.serverId)
      throw new McpServiceError('RESULT_TOO_LARGE', 'MCP tool result exceeds the byte limit.')
    }
    return {
      serverId: call.serverId,
      toolName: call.toolName,
      revision: call.revision,
      actionHash,
      isError: result.data.isError === true,
      untrustedContent: true,
      result: result.data,
    }
  }

  async close(): Promise<void> {
    await this.serialize(() => this.closeSessions())
  }

  activeServerCount(): number {
    return this.sessions.size
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail
    let release!: () => void
    this.operationTail = new Promise<void>((resolveOperation) => {
      release = resolveOperation
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async closeSessions(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map((record) => record.session.close()))
  }

  private async loadConfiguration(options: McpInspectOptions): Promise<LoadedConfiguration> {
    const workspaceTrusted = options.workspaceTrusted === true
    const workspacePath = options.workspacePath ? resolve(options.workspacePath) : null
    if (options.workspacePath && !isAbsolute(options.workspacePath)) {
      throw new McpServiceError('INVALID_CONFIG', 'workspacePath must be absolute.')
    }
    const user = await this.loadConfigFile(this.userConfigPath, 'user')
    const loadedWorkspace = workspacePath
      ? await this.loadConfigFile(
          join(workspacePath, this.options.workspaceConfigFileName),
          'workspace',
        )
      : null
    const workspace = loadedWorkspace?.missing ? null : loadedWorkspace
    return {
      revision: sha256(
        stableStringify({
          user: user.revision,
          workspace: workspace?.revision ?? null,
          workspacePath,
          workspaceTrusted,
        }),
      ),
      user,
      workspace,
      workspacePath,
      workspaceTrusted,
    }
  }

  private async loadConfigFile(
    path: string,
    source: McpConfigurationSource,
  ): Promise<LoadedConfigFile> {
    const loaded = await readBoundedConfig(path, this.options.maximumConfigBytes)
    let json: unknown
    try {
      json = JSON.parse(loaded.bytes.toString('utf8'))
    } catch (cause) {
      throw new McpServiceError('INVALID_CONFIG', `MCP config is not valid JSON: ${path}`, {
        cause,
      })
    }
    const parsed = this.parseConfig(json, path, source)
    const fileRevision = loaded.missing ? sha256('missing') : sha256(loaded.bytes)
    return {
      path,
      revision: fileRevision,
      missing: loaded.missing,
      servers: parsed.servers.map((server) => ({
        ...server,
        source,
        revision: sha256(stableStringify({ source, fileRevision, server })),
      })),
    }
  }

  private parseConfig(
    input: unknown,
    path: string,
    source: McpConfigurationSource,
  ): { version: 1; servers: ParsedServerConfig[] } {
    const schema = z
      .object({
        version: z.literal(MCP_CONFIG_VERSION),
        servers: z.array(serverConfigSchema).max(this.options.maximumServers),
      })
      .strict()
      .superRefine((value, context) => {
        const ids = new Set<string>()
        for (const [index, server] of value.servers.entries()) {
          if (ids.has(server.id)) {
            context.addIssue({
              code: 'custom',
              path: ['servers', index, 'id'],
              message: 'Duplicate server id.',
            })
          }
          ids.add(server.id)
          for (const key of Object.keys(server.env)) {
            if (blockedEnvironmentKey(key)) {
              context.addIssue({
                code: 'custom',
                path: ['servers', index, 'env', key],
                message: 'This environment key may alter process loading and is not allowed.',
              })
            }
          }
          if (source === 'user' && server.cwd && !isAbsolute(server.cwd)) {
            context.addIssue({
              code: 'custom',
              path: ['servers', index, 'cwd'],
              message: 'User MCP server cwd must be absolute.',
            })
          }
        }
      })
    const parsed = schema.safeParse(input)
    if (!parsed.success) {
      throw new McpServiceError(
        'INVALID_CONFIG',
        `MCP config is invalid: ${path} (${z.prettifyError(parsed.error).slice(0, 2000)})`,
      )
    }
    return parsed.data
  }

  private toSnapshot(configuration: LoadedConfiguration): McpConfigurationSnapshot {
    const snapshot = (file: LoadedConfigFile): McpConfigFileSnapshot => ({
      path: file.path,
      revision: file.revision,
      servers: file.servers.map((server) => ({
        id: server.id,
        name: server.name ?? server.id,
        source: server.source,
        enabled: server.enabled,
        command: server.command,
        args: [...server.args],
        cwd: server.cwd ?? null,
        environmentKeys: Object.keys(server.env).sort(),
        environment: Object.fromEntries(
          Object.entries(server.env).sort(([left], [right]) => left.localeCompare(right)),
        ),
        revision: server.revision,
      })),
    })
    return {
      revision: configuration.revision,
      user: snapshot(configuration.user),
      workspace: configuration.workspace ? snapshot(configuration.workspace) : null,
      workspaceTrusted: configuration.workspaceTrusted,
    }
  }

  private workspaceApproval(
    snapshot: McpConfigurationSnapshot,
    workspace: LoadedConfigFile,
  ): McpWorkspaceExecutionApproval {
    const enabledServers = snapshot.workspace?.servers.filter((server) => server.enabled) ?? []
    return {
      actionHash: sha256(
        stableStringify({
          kind: 'workspace-mcp-config',
          configurationRevision: snapshot.revision,
          workspaceRevision: workspace.revision,
          servers: enabledServers.map((server) => server.revision),
        }),
      ),
      configurationRevision: snapshot.revision,
      path: workspace.path,
      servers: enabledServers,
    }
  }

  private async startServer(
    config: LoadedConfigFile['servers'][number],
    workspacePath: string | null,
    signal?: AbortSignal,
  ): Promise<SessionRecord> {
    assertNotAborted(signal)
    const startupDeadline = Date.now() + this.options.startupTimeoutMs
    const home = join(this.options.userDataPath, 'mcp-runtime', config.id, 'home')
    const temporary = join(this.options.userDataPath, 'mcp-runtime', config.id, 'tmp')
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(temporary, { recursive: true, mode: 0o700 }),
    ])
    const cwd = await this.resolveServerCwd(config, workspacePath, home)
    const env: NodeJS.ProcessEnv = {
      ...minimalParentEnvironment(),
      HOME: home,
      USERPROFILE: home,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      ...config.env,
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(config.command, config.args, {
        cwd,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (cause) {
      throw new McpServiceError('SPAWN_FAILED', `Unable to spawn MCP server: ${config.id}`, {
        cause,
      })
    }
    const session = new StdioMcpSession({
      child,
      maximumMessageBytes: this.options.maximumMessageBytes,
      maximumPendingRequests: this.options.maximumPendingRequestsPerServer,
      shutdownGraceMs: this.options.shutdownGraceMs,
    })
    try {
      const initialized = initializeResultSchema.parse(
        await session.request(
          'initialize',
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'my-code-assistant', version: '0.1.0' },
          },
          {
            timeoutMs: remainingTimeout(startupDeadline, 'STARTUP_TIMEOUT'),
            timeoutCode: 'STARTUP_TIMEOUT',
            ...(signal ? { signal } : {}),
          },
        ),
      )
      if (!SUPPORTED_PROTOCOL_VERSIONS.has(initialized.protocolVersion)) {
        throw new McpServiceError(
          'PROTOCOL_ERROR',
          `MCP server negotiated an unsupported protocol version: ${initialized.protocolVersion}`,
        )
      }
      await session.notify('notifications/initialized')
      const tools = initialized.capabilities.tools
        ? await this.listTools(session, config, initialized.serverInfo, startupDeadline, signal)
        : new Map<string, McpDiscoveredTool>()
      const server: McpDiscoveredServer = {
        id: config.id,
        name: config.name ?? config.id,
        title: initialized.serverInfo.title ?? null,
        version: initialized.serverInfo.version,
        source: config.source,
        protocolVersion: initialized.protocolVersion,
        toolCount: tools.size,
      }
      return { session, server, tools }
    } catch (cause) {
      await session.close()
      if (cause instanceof z.ZodError) {
        throw new McpServiceError(
          'PROTOCOL_ERROR',
          'MCP server returned invalid initialization or tool metadata.',
          { cause },
        )
      }
      throw cause
    }
  }

  private async resolveServerCwd(
    config: LoadedConfigFile['servers'][number],
    workspacePath: string | null,
    fallback: string,
  ): Promise<string> {
    if (!config.cwd)
      return config.source === 'workspace' && workspacePath ? workspacePath : fallback
    if (config.source === 'user') return config.cwd
    if (!workspacePath) {
      throw new McpServiceError('INVALID_CONFIG', 'Workspace MCP server has no workspace path.')
    }
    const workspaceReal = await realpath(workspacePath)
    const candidate = isAbsolute(config.cwd) ? config.cwd : resolve(workspaceReal, config.cwd)
    let candidateReal: string
    try {
      candidateReal = await realpath(candidate)
    } catch (cause) {
      throw new McpServiceError('INVALID_CONFIG', 'Workspace MCP cwd does not exist.', { cause })
    }
    if (!ensureContained(workspaceReal, candidateReal)) {
      throw new McpServiceError('INVALID_CONFIG', 'Workspace MCP cwd must stay in the workspace.')
    }
    return candidateReal
  }

  private async listTools(
    session: StdioMcpSession,
    config: LoadedConfigFile['servers'][number],
    serverInfo: z.infer<typeof initializeResultSchema>['serverInfo'],
    startupDeadline: number,
    signal?: AbortSignal,
  ): Promise<Map<string, McpDiscoveredTool>> {
    const tools = new Map<string, McpDiscoveredTool>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < this.options.maximumListPages; page += 1) {
      const raw = await session.request('tools/list', cursor ? { cursor } : {}, {
        timeoutMs: remainingTimeout(startupDeadline, 'STARTUP_TIMEOUT'),
        timeoutCode: 'STARTUP_TIMEOUT',
        ...(signal ? { signal } : {}),
      })
      const result = z
        .object({
          tools: z.array(toolSchema),
          nextCursor: z.string().max(4096).optional(),
        })
        .strip()
        .parse(raw)
      for (const metadata of result.tools) {
        if (tools.has(metadata.name)) {
          throw new McpServiceError(
            'PROTOCOL_ERROR',
            `MCP server returned duplicate tool metadata: ${metadata.name}`,
          )
        }
        if (tools.size >= this.options.maximumToolsPerServer) {
          throw new McpServiceError(
            'TOOL_LIMIT_EXCEEDED',
            `MCP server exceeds the ${this.options.maximumToolsPerServer} tool limit.`,
          )
        }
        tools.set(metadata.name, this.toDiscoveredTool(config, serverInfo, metadata))
      }
      cursor = result.nextCursor
      if (!cursor) return tools
      if (cursors.has(cursor)) {
        throw new McpServiceError('PROTOCOL_ERROR', 'MCP tool pagination cursor repeated.')
      }
      cursors.add(cursor)
    }
    throw new McpServiceError('TOOL_LIMIT_EXCEEDED', 'MCP tool pagination exceeds the page limit.')
  }

  private toDiscoveredTool(
    config: LoadedConfigFile['servers'][number],
    serverInfo: z.infer<typeof initializeResultSchema>['serverInfo'],
    metadata: McpToolWireDescriptor,
  ): McpDiscoveredTool {
    const schemaBytes = Buffer.byteLength(
      stableStringify({
        inputSchema: metadata.inputSchema,
        outputSchema: metadata.outputSchema ?? null,
      }),
    )
    if (schemaBytes > this.options.maximumSchemaBytes) {
      throw new McpServiceError(
        'SCHEMA_TOO_LARGE',
        `MCP tool schema exceeds the ${this.options.maximumSchemaBytes} byte limit.`,
      )
    }
    const revisionSeed = stableStringify({
      serverRevision: config.revision,
      name: metadata.name,
      title: metadata.title ?? null,
      description: metadata.description ?? null,
      inputSchema: metadata.inputSchema,
      outputSchema: metadata.outputSchema ?? null,
      annotations: metadata.annotations ?? null,
      hostPolicy: {
        capability: ['process', 'write', 'network'],
        risk: 'approval-required',
      },
    })
    const revision = sha256(revisionSeed)
    return {
      registryName: registryName(config.id, metadata.name, revisionSeed),
      serverId: config.id,
      serverName: config.name ?? serverInfo.title ?? serverInfo.name,
      name: metadata.name,
      title: metadata.title ?? metadata.annotations?.title ?? null,
      description: sanitizeDescription(metadata.description),
      inputSchema: metadata.inputSchema,
      outputSchema: metadata.outputSchema ?? null,
      revision,
      origin: 'mcp',
      metadataTrusted: false,
      capability: ['process', 'write', 'network'],
      risk: 'approval-required',
      annotations: {
        ...(metadata.annotations?.readOnlyHint === undefined
          ? {}
          : { readOnlyHint: metadata.annotations.readOnlyHint }),
        ...(metadata.annotations?.destructiveHint === undefined
          ? {}
          : { destructiveHint: metadata.annotations.destructiveHint }),
        ...(metadata.annotations?.idempotentHint === undefined
          ? {}
          : { idempotentHint: metadata.annotations.idempotentHint }),
        ...(metadata.annotations?.openWorldHint === undefined
          ? {}
          : { openWorldHint: metadata.annotations.openWorldHint }),
      },
    }
  }
}
