import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile as readFsFile, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { StructuredProcessRunner, type StructuredProcessRunnerOptions } from './execution'
import type { TrustStore } from './trust'
import { WorkspaceError, type WorkspaceService } from './workspace'

const HOOK_TRUST_VERSION = 1 as const
const DEFAULT_TRUST_FILE_NAME = 'hook-trust.json'
const DEFAULT_CONFIG_BYTES = 256 * 1024
const DEFAULT_MAX_HOOKS = 100
const DEFAULT_MATCHER_CHARACTERS = 256
const DEFAULT_MATCH_VALUE_CHARACTERS = 256
const DEFAULT_COMMAND_CHARACTERS = 64 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_TIMEOUT_MS = 30_000
const DEFAULT_STDIN_BYTES = 256 * 1024
const DEFAULT_OUTPUT_BYTES = 128 * 1024
const DEFAULT_CONTEXT_CHARACTERS = 16 * 1024
const DEFAULT_TOTAL_CONTEXT_CHARACTERS = 64 * 1024
const MAX_DIAGNOSTIC_CHARACTERS = 2_000

export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
] as const

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number]
export type HookSource = string

export interface HookSourceConfig {
  path: string
  source: HookSource
}
export type HookJsonValue =
  | string
  | number
  | boolean
  | null
  | HookJsonValue[]
  | { [key: string]: HookJsonValue }

export interface HookCommandDescriptor {
  type: 'command'
  argv: string[]
  /** True only for an official command string normalized to an explicit system-shell argv. */
  shell: boolean
  command: string | null
  timeoutMs: number
  isolation: 'structured-process'
  network: 'host'
}

export interface HookDescriptor {
  id: string
  revision: string
  source: HookSource
  configPath: string
  event: HookEventName
  matcher: string
  groupIndex: number
  handlerIndex: number
  trusted: boolean
  handler: HookCommandDescriptor
}

export interface HookDiagnostic {
  configPath: string
  event: HookEventName | null
  message: string
}

export interface HookCatalog {
  workspacePath: string | null
  hooks: HookDescriptor[]
  diagnostics: HookDiagnostic[]
}

export interface HookTrustInput {
  id: string
  revision: string
  trusted: boolean
}

export interface HookDispatchInput {
  event: HookEventName
  sessionId: string
  runId?: string | null
  /** Value tested by the event matcher, normally a tool name, start source, or agent type. */
  matcherValue?: string | null
  payload?: { [key: string]: HookJsonValue }
}

export interface HookExecutionRecord {
  hookId: string
  revision: string
  status: 'completed' | 'blocked' | 'error'
  exitCode: number | null
  timedOut: boolean
  cancelled: boolean
  outputTruncated: boolean
  ignoredPermissionElevation: boolean
  reason: string | null
}

export interface HookDispatchResult {
  decision: 'continue' | 'block'
  reason: string | null
  additionalContext: string[]
  executions: HookExecutionRecord[]
  skippedUntrustedHookIds: string[]
}

export interface HookServiceOptions {
  userDataPath?: string
  trustFileName?: string
  now?: () => Date
  maximumConfigBytes?: number
  maximumHooks?: number
  maximumMatcherCharacters?: number
  maximumMatchValueCharacters?: number
  maximumCommandCharacters?: number
  defaultTimeoutMs?: number
  maximumTimeoutMs?: number
  maximumStdinBytes?: number
  maximumOutputBytes?: number
  maximumAdditionalContextCharacters?: number
  maximumTotalAdditionalContextCharacters?: number
  runner?: StructuredProcessRunner
  processRunnerOptions?: Pick<StructuredProcessRunnerOptions, 'forceKillDelayMs' | 'tempDirectory'>
  sources?: readonly HookSourceConfig[]
}

export type HookServiceErrorCode =
  | 'INVALID_INPUT'
  | 'HOOK_NOT_FOUND'
  | 'REVISION_MISMATCH'
  | 'WORKSPACE_CHANGED'
  | 'WORKSPACE_NOT_TRUSTED'
  | 'EXECUTION_CANCELLED'

export class HookServiceError extends Error {
  constructor(
    readonly code: HookServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'HookServiceError'
  }
}

interface TrustEntry {
  workspacePath: string
  revision: string
  configPath: string
  trustedAt: string
}

interface PersistedHookTrust {
  version: typeof HOOK_TRUST_VERSION
  hooks: Record<string, TrustEntry>
}

interface DiscoveredHook extends HookDescriptor {
  matcherExpression: RegExp | null
}

interface InternalCatalog {
  workspacePath: string | null
  hooks: DiscoveredHook[]
  diagnostics: HookDiagnostic[]
}

interface InterpretedHookOutput {
  blocked: boolean
  reason: string | null
  additionalContext: string[]
  ignoredPermissionElevation: boolean
  error: boolean
}

const trustEntrySchema = z
  .object({
    workspacePath: z.string().min(1).max(16_384),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    configPath: z.string().min(1).max(4_096),
    trustedAt: z.string().datetime(),
  })
  .strict()

const persistedHookTrustSchema = z
  .object({
    version: z.literal(HOOK_TRUST_VERSION),
    hooks: z.record(z.string().min(1).max(200), trustEntrySchema),
  })
  .strict()

const DEFAULT_SOURCE_FILES: readonly HookSourceConfig[] = [
  { path: '.assistant/hooks.json', source: 'assistant' },
]

const EVENT_NAMES = new Set<string>(HOOK_EVENT_NAMES)
const MATCHER_EVENTS = new Set<HookEventName>([
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
])
const SECRET_TEXT = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /Bearer\s+[^\s,;]+/gi,
] as const

function emptyTrust(): PersistedHookTrust {
  return { version: HOOK_TRUST_VERSION, hooks: {} }
}

function cloneTrust(source: PersistedHookTrust): PersistedHookTrust {
  return {
    version: source.version,
    hooks: Object.fromEntries(
      Object.entries(source.hooks).map(([id, entry]) => [id, { ...entry }]),
    ),
  }
}

function normalizeHookSources(
  sources: readonly HookSourceConfig[] | undefined,
): readonly HookSourceConfig[] {
  const selected = sources ?? DEFAULT_SOURCE_FILES
  const seen = new Set<string>()
  return selected.map(({ path, source }) => {
    const normalizedPath = path.replace(/\/+$/, '')
    const normalizedSource = source.trim()
    if (
      !normalizedPath ||
      isAbsolute(normalizedPath) ||
      normalizedPath.includes('\\') ||
      normalizedPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      throw new RangeError('Hook source paths must be normalized workspace-relative paths.')
    }
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(normalizedSource)) {
      throw new RangeError('Hook source names must be stable lowercase identifiers.')
    }
    const identity = `${normalizedSource}\0${normalizedPath}`
    if (seen.has(identity)) throw new RangeError('Hook sources must be unique.')
    seen.add(identity)
    return Object.freeze({ path: normalizedPath, source: normalizedSource })
  })
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive integer.`)
  }
  return resolved
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedDiagnostic(message: string): string {
  const normalized = message.replace(/[\0\r]/g, ' ').trim()
  return normalized.slice(0, MAX_DIAGNOSTIC_CHARACTERS) || 'Invalid hook configuration.'
}

function diagnosticMessage(error: unknown): string {
  return boundedDiagnostic(error instanceof Error ? error.message : String(error))
}

function hookId(
  workspacePath: string,
  configPath: string,
  event: HookEventName,
  groupIndex: number,
  handlerIndex: number,
): string {
  return `workspace-hook:${createHash('sha256')
    .update('hook-id-v1\0')
    .update(workspacePath)
    .update('\0')
    .update(configPath)
    .update('\0')
    .update(event)
    .update('\0')
    .update(groupIndex.toString())
    .update('\0')
    .update(handlerIndex.toString())
    .digest('base64url')}`
}

function hookRevision(value: unknown): string {
  return createHash('sha256')
    .update('hook-revision-v1\0')
    .update(JSON.stringify(value))
    .digest('hex')
}

function systemShellArgv(command: string): string[] {
  if (process.platform !== 'win32') return ['/bin/sh', '-c', command]
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
  if (!systemRoot || !isAbsolute(systemRoot)) {
    throw new Error('Windows system shell cannot be resolved from an absolute SystemRoot.')
  }
  return [join(systemRoot, 'System32', 'cmd.exe'), '/d', '/s', '/c', command]
}

/**
 * Reject constructs with unbounded nested quantifiers, ambiguous quantified alternatives,
 * backreferences, and repeated wildcards. Matcher inputs are separately length-bounded.
 */
function compileBoundedMatcher(source: string, maximumCharacters: number): RegExp | null {
  if (source === '' || source === '*') return null
  if (source.length > maximumCharacters || source.includes('\0')) {
    throw new Error(`Matcher exceeds the ${maximumCharacters.toString()}-character limit.`)
  }
  if (/\\[1-9]/.test(source)) throw new Error('Matcher backreferences are not supported.')
  if (/\(\?(?:[=!<]|[a-zA-Z-]+>)/.test(source)) {
    throw new Error('Matcher lookaround and special assertion groups are not supported.')
  }
  if ((source.match(/\.(?:\*|\+)/g) ?? []).length > 1) {
    throw new Error('Matcher may contain at most one unbounded wildcard.')
  }

  const groups: Array<{ hasQuantifier: boolean; hasAlternation: boolean }> = []
  let inCharacterClass = false
  let escaped = false
  let previousWasQuantifier = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (escaped) {
      escaped = false
      previousWasQuantifier = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '[') {
      inCharacterClass = true
      previousWasQuantifier = false
      continue
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false
      previousWasQuantifier = false
      continue
    }
    if (inCharacterClass) continue
    if (character === '(') {
      groups.push({ hasQuantifier: false, hasAlternation: false })
      previousWasQuantifier = false
      continue
    }
    if (character === '|') {
      const current = groups.at(-1)
      if (current) current.hasAlternation = true
      previousWasQuantifier = false
      continue
    }
    if (character === ')') {
      const current = groups.pop()
      const next = source[index + 1]
      const groupIsQuantified = next === '*' || next === '+' || next === '?' || next === '{'
      if (current && groupIsQuantified && (current.hasQuantifier || current.hasAlternation)) {
        throw new Error('Matcher contains an unsafe quantified group.')
      }
      const parent = groups.at(-1)
      if (parent && current?.hasQuantifier) parent.hasQuantifier = true
      previousWasQuantifier = false
      continue
    }
    if (character === '?' && source[index - 1] === '(' && source[index + 1] === ':') {
      previousWasQuantifier = false
      continue
    }
    const quantifier =
      character === '*' ||
      character === '+' ||
      character === '?' ||
      (character === '{' && /^\{\d+(?:,\d*)?\}/.test(source.slice(index)))
    if (quantifier) {
      if (previousWasQuantifier) throw new Error('Matcher contains repeated quantifiers.')
      const current = groups.at(-1)
      if (current) current.hasQuantifier = true
      previousWasQuantifier = true
    } else {
      previousWasQuantifier = false
    }
  }
  if (escaped || inCharacterClass || groups.length > 0) {
    // RegExp would also reject these, but this produces a stable diagnostic.
    throw new Error('Matcher has an incomplete escape, character class, or group.')
  }
  try {
    return new RegExp(source)
  } catch (error) {
    throw new Error('Matcher is not a valid regular expression.', { cause: error })
  }
}

function deriveMatcherValue(input: HookDispatchInput): string {
  if (!MATCHER_EVENTS.has(input.event)) return ''
  if (typeof input.matcherValue === 'string') return input.matcherValue
  const payload = input.payload ?? {}
  const field =
    input.event === 'SessionStart'
      ? payload.source
      : input.event === 'SubagentStart' || input.event === 'SubagentStop'
        ? payload.agent_type
        : payload.tool_name
  return typeof field === 'string' ? field : ''
}

function matchesHook(hook: DiscoveredHook, value: string): boolean {
  return hook.matcherExpression?.test(value) ?? true
}

function redactText(source: string, workspacePath: string, maximum: number): string {
  let value = source.split(workspacePath).join('[workspace]')
  for (const pattern of SECRET_TEXT) value = value.replace(pattern, '[REDACTED]')
  return value.replace(/\0/g, '').trim().slice(0, maximum)
}

function outputRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function contextValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return []
}

function permissionBehavior(value: unknown): string | null {
  if (typeof value === 'string') return value.toLowerCase()
  const record = outputRecord(value)
  return typeof record?.behavior === 'string' ? record.behavior.toLowerCase() : null
}

export class HookService {
  private readonly maximumConfigBytes: number
  private readonly maximumHooks: number
  private readonly maximumMatcherCharacters: number
  private readonly maximumMatchValueCharacters: number
  private readonly maximumCommandCharacters: number
  private readonly defaultTimeoutMs: number
  private readonly maximumTimeoutMs: number
  private readonly maximumAdditionalContextCharacters: number
  private readonly maximumTotalAdditionalContextCharacters: number
  private readonly runner: StructuredProcessRunner
  private readonly sources: readonly HookSourceConfig[]
  private trustStatePromise: Promise<PersistedHookTrust> | undefined
  private trustMutationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly workspaceTrust: Pick<TrustStore, 'isTrusted'>,
    private readonly options: HookServiceOptions = {},
  ) {
    this.maximumConfigBytes = positiveInteger(
      options.maximumConfigBytes,
      DEFAULT_CONFIG_BYTES,
      'maximumConfigBytes',
    )
    this.maximumHooks = positiveInteger(options.maximumHooks, DEFAULT_MAX_HOOKS, 'maximumHooks')
    this.maximumMatcherCharacters = positiveInteger(
      options.maximumMatcherCharacters,
      DEFAULT_MATCHER_CHARACTERS,
      'maximumMatcherCharacters',
    )
    this.maximumMatchValueCharacters = positiveInteger(
      options.maximumMatchValueCharacters,
      DEFAULT_MATCH_VALUE_CHARACTERS,
      'maximumMatchValueCharacters',
    )
    this.maximumCommandCharacters = positiveInteger(
      options.maximumCommandCharacters,
      DEFAULT_COMMAND_CHARACTERS,
      'maximumCommandCharacters',
    )
    this.maximumTimeoutMs = positiveInteger(
      options.maximumTimeoutMs,
      DEFAULT_MAX_TIMEOUT_MS,
      'maximumTimeoutMs',
    )
    this.defaultTimeoutMs = positiveInteger(
      options.defaultTimeoutMs,
      DEFAULT_TIMEOUT_MS,
      'defaultTimeoutMs',
    )
    if (this.defaultTimeoutMs > this.maximumTimeoutMs) {
      throw new RangeError('defaultTimeoutMs cannot exceed maximumTimeoutMs.')
    }
    const maximumStdinBytes = positiveInteger(
      options.maximumStdinBytes,
      DEFAULT_STDIN_BYTES,
      'maximumStdinBytes',
    )
    const maximumOutputBytes = positiveInteger(
      options.maximumOutputBytes,
      DEFAULT_OUTPUT_BYTES,
      'maximumOutputBytes',
    )
    this.maximumAdditionalContextCharacters = positiveInteger(
      options.maximumAdditionalContextCharacters,
      DEFAULT_CONTEXT_CHARACTERS,
      'maximumAdditionalContextCharacters',
    )
    this.maximumTotalAdditionalContextCharacters = positiveInteger(
      options.maximumTotalAdditionalContextCharacters,
      DEFAULT_TOTAL_CONTEXT_CHARACTERS,
      'maximumTotalAdditionalContextCharacters',
    )
    if (this.maximumAdditionalContextCharacters > this.maximumTotalAdditionalContextCharacters) {
      throw new RangeError(
        'maximumAdditionalContextCharacters cannot exceed maximumTotalAdditionalContextCharacters.',
      )
    }
    if (
      options.trustFileName?.includes('/') ||
      options.trustFileName?.includes('\\') ||
      options.trustFileName === '.' ||
      options.trustFileName === '..'
    ) {
      throw new RangeError('trustFileName must be a file name without path separators.')
    }
    this.runner =
      options.runner ??
      new StructuredProcessRunner(this.workspace, {
        defaultTimeoutMs: this.defaultTimeoutMs,
        maxTimeoutMs: this.maximumTimeoutMs,
        maxInputBytes: maximumStdinBytes,
        maxOutputBytes: maximumOutputBytes,
        ...options.processRunnerOptions,
      })
    this.sources = normalizeHookSources(options.sources)
  }

  async inspect(): Promise<HookCatalog> {
    const discovered = await this.discoverDefinitions()
    if (!discovered.workspacePath) return discovered
    const trust = await this.loadTrust()
    return {
      workspacePath: discovered.workspacePath,
      hooks: discovered.hooks.map((hook) =>
        this.publicDescriptor(
          hook,
          this.entryTrustsHook(trust.hooks[hook.id], hook, discovered.workspacePath as string),
        ),
      ),
      diagnostics: discovered.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    }
  }

  async list(): Promise<HookDescriptor[]> {
    return (await this.inspect()).hooks
  }

  async setTrusted(input: HookTrustInput): Promise<HookDescriptor> {
    if (!input.id || input.id.length > 200 || !/^[a-f0-9]{64}$/.test(input.revision)) {
      throw new HookServiceError('INVALID_INPUT', 'A valid hook id and revision are required.')
    }
    const catalog = await this.inspect()
    if (!catalog.workspacePath) {
      throw new HookServiceError('WORKSPACE_NOT_TRUSTED', 'Open and trust a workspace first.')
    }
    const sameId = catalog.hooks.find((hook) => hook.id === input.id)
    if (!sameId) throw new HookServiceError('HOOK_NOT_FOUND', 'The hook was not found.')
    if (sameId.revision !== input.revision) {
      throw new HookServiceError(
        'REVISION_MISMATCH',
        'The hook changed after review. Refresh the hook list and review it again.',
      )
    }
    const workspacePath = catalog.workspacePath
    await this.mutateTrust((draft) => {
      if (input.trusted) {
        draft.hooks[input.id] = {
          workspacePath,
          revision: input.revision,
          configPath: sameId.configPath,
          trustedAt: (this.options.now ?? (() => new Date()))().toISOString(),
        }
      } else {
        delete draft.hooks[input.id]
      }
    })
    if (this.workspace.getWorkspace()?.path !== workspacePath) {
      throw new HookServiceError(
        'WORKSPACE_CHANGED',
        'The workspace changed while hook trust was being saved.',
      )
    }
    return { ...sameId, trusted: input.trusted, handler: this.cloneHandler(sameId.handler) }
  }

  reloadTrust(): void {
    this.trustStatePromise = undefined
  }

  async dispatch(
    input: HookDispatchInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<HookDispatchResult> {
    if (!EVENT_NAMES.has(input.event) || !input.sessionId || input.sessionId.length > 200) {
      throw new HookServiceError('INVALID_INPUT', 'A valid hook event and session id are required.')
    }
    const matcherValue = deriveMatcherValue(input)
    if (matcherValue.includes('\0') || matcherValue.length > this.maximumMatchValueCharacters) {
      throw new HookServiceError(
        'INVALID_INPUT',
        `Hook matcher input exceeds the ${this.maximumMatchValueCharacters.toString()}-character limit.`,
      )
    }

    const initial = await this.discoverDefinitions()
    if (!initial.workspacePath) return this.emptyDispatchResult()
    const workspacePath = initial.workspacePath
    const trust = await this.loadTrust()
    const eventHooks = initial.hooks.filter(
      (hook) => hook.event === input.event && matchesHook(hook, matcherValue),
    )
    const skippedUntrustedHookIds = eventHooks
      .filter((hook) => !this.entryTrustsHook(trust.hooks[hook.id], hook, workspacePath))
      .map((hook) => hook.id)
    const trustedHooks = eventHooks.filter((hook) =>
      this.entryTrustsHook(trust.hooks[hook.id], hook, workspacePath),
    )
    const stdin = this.serializeInput(input, workspacePath)
    const executions: HookExecutionRecord[] = []
    const reasons: string[] = []
    const additionalContext: string[] = []
    let totalContextCharacters = 0

    for (const snapshot of trustedHooks) {
      this.assertNotCancelled(options.signal)
      await this.assertWorkspaceSnapshot(workspacePath)
      const fresh = await this.discoverDefinitions()
      const current = fresh.hooks.find(
        (hook) => hook.id === snapshot.id && hook.revision === snapshot.revision,
      )
      const currentTrust = (await this.loadTrust()).hooks[snapshot.id]
      if (
        fresh.workspacePath !== workspacePath ||
        !current ||
        !this.entryTrustsHook(currentTrust, current, workspacePath)
      ) {
        skippedUntrustedHookIds.push(snapshot.id)
        continue
      }

      const result = await this.runner.run(
        {
          argv: current.handler.argv,
          cwd: workspacePath,
          timeoutMs: current.handler.timeoutMs,
        },
        { signal: options.signal, stdin },
      )
      if (result.cancelled && options.signal?.aborted) this.assertNotCancelled(options.signal)
      const interpreted = this.interpretResult(result, workspacePath)
      if (interpreted.reason) reasons.push(interpreted.reason)
      for (const context of interpreted.additionalContext) {
        if (totalContextCharacters >= this.maximumTotalAdditionalContextCharacters) break
        const remaining = this.maximumTotalAdditionalContextCharacters - totalContextCharacters
        const bounded = context.slice(
          0,
          Math.min(remaining, this.maximumAdditionalContextCharacters),
        )
        if (!bounded) continue
        additionalContext.push(bounded)
        totalContextCharacters += bounded.length
      }
      executions.push({
        hookId: current.id,
        revision: current.revision,
        status: interpreted.error ? 'error' : interpreted.blocked ? 'blocked' : 'completed',
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        outputTruncated: result.outputTruncated,
        ignoredPermissionElevation: interpreted.ignoredPermissionElevation,
        reason: interpreted.reason,
      })
    }

    return {
      decision: reasons.length > 0 ? 'block' : 'continue',
      reason: reasons.length > 0 ? reasons.join('\n').slice(0, 8_000) : null,
      additionalContext,
      executions,
      skippedUntrustedHookIds: [...new Set(skippedUntrustedHookIds)],
    }
  }

  private async discoverDefinitions(): Promise<InternalCatalog> {
    const selected = this.workspace.getWorkspace()
    if (!selected) return { workspacePath: null, hooks: [], diagnostics: [] }
    const workspacePath = selected.path
    if (!(await this.workspaceTrust.isTrusted(workspacePath))) {
      return { workspacePath: null, hooks: [], diagnostics: [] }
    }
    this.assertWorkspaceUnchanged(workspacePath)

    const hooks: DiscoveredHook[] = []
    const diagnostics: HookDiagnostic[] = []
    for (const source of this.sources) {
      let content: string
      try {
        content = (
          await this.workspace.readFile(source.path, {
            maxBytes: this.maximumConfigBytes,
            truncate: false,
          })
        ).content
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === 'PATH_NOT_FOUND') continue
        diagnostics.push({
          configPath: source.path,
          event: null,
          message: `Hook configuration could not be read safely: ${diagnosticMessage(error)}`,
        })
        continue
      }
      this.assertWorkspaceUnchanged(workspacePath)

      let root: unknown
      try {
        root = JSON.parse(content)
      } catch {
        diagnostics.push({
          configPath: source.path,
          event: null,
          message: 'Hook configuration is not valid JSON.',
        })
        continue
      }
      this.parseConfiguration(root, source.source, source.path, workspacePath, hooks, diagnostics)
      if (hooks.length >= this.maximumHooks) break
    }

    this.assertWorkspaceUnchanged(workspacePath)
    if (!(await this.workspaceTrust.isTrusted(workspacePath))) {
      return { workspacePath: null, hooks: [], diagnostics: [] }
    }
    return { workspacePath, hooks, diagnostics }
  }

  private parseConfiguration(
    root: unknown,
    source: HookSource,
    configPath: string,
    workspacePath: string,
    target: DiscoveredHook[],
    diagnostics: HookDiagnostic[],
  ): void {
    const rootRecord = outputRecord(root)
    const hookTable = outputRecord(rootRecord?.hooks)
    if (!rootRecord || !hookTable) {
      diagnostics.push({ configPath, event: null, message: 'Configuration has no hooks object.' })
      return
    }

    for (const event of HOOK_EVENT_NAMES) {
      const groupsValue = hookTable[event]
      if (groupsValue === undefined) continue
      if (!Array.isArray(groupsValue)) {
        diagnostics.push({ configPath, event, message: `${event} must be an array.` })
        continue
      }
      for (let groupIndex = 0; groupIndex < groupsValue.length; groupIndex += 1) {
        if (target.length >= this.maximumHooks) return
        const group = outputRecord(groupsValue[groupIndex])
        if (!group || !Array.isArray(group.hooks)) {
          diagnostics.push({
            configPath,
            event,
            message: `Matcher group ${groupIndex.toString()} has no hooks array.`,
          })
          continue
        }
        const matcher = group.matcher === undefined ? '' : group.matcher
        if (typeof matcher !== 'string') {
          diagnostics.push({
            configPath,
            event,
            message: `Matcher group ${groupIndex.toString()} has a non-string matcher.`,
          })
          continue
        }
        let matcherExpression: RegExp | null
        try {
          matcherExpression = compileBoundedMatcher(matcher, this.maximumMatcherCharacters)
        } catch (error) {
          diagnostics.push({ configPath, event, message: diagnosticMessage(error) })
          continue
        }

        for (let handlerIndex = 0; handlerIndex < group.hooks.length; handlerIndex += 1) {
          if (target.length >= this.maximumHooks) return
          try {
            const handler = this.normalizeHandler(group.hooks[handlerIndex])
            const id = hookId(workspacePath, configPath, event, groupIndex, handlerIndex)
            const revision = hookRevision({
              source,
              configPath,
              event,
              matcher,
              handler: {
                argv: handler.argv,
                shell: handler.shell,
                command: handler.command,
                timeoutMs: handler.timeoutMs,
              },
            })
            target.push({
              id,
              revision,
              source,
              configPath,
              event,
              matcher,
              groupIndex,
              handlerIndex,
              trusted: false,
              handler,
              matcherExpression,
            })
          } catch (error) {
            diagnostics.push({ configPath, event, message: diagnosticMessage(error) })
          }
        }
      }
    }
  }

  private normalizeHandler(value: unknown): HookCommandDescriptor {
    const handler = outputRecord(value)
    if (handler?.type !== 'command') {
      throw new Error('Only command hook handlers are supported.')
    }
    const hasArgv = handler.argv !== undefined
    const hasCommand = handler.command !== undefined || handler.commandWindows !== undefined
    if (hasArgv === hasCommand) {
      throw new Error('A command hook must define exactly one of argv or command.')
    }

    let argv: string[]
    let command: string | null = null
    let shell = false
    if (hasArgv) {
      if (
        !Array.isArray(handler.argv) ||
        handler.argv.length < 1 ||
        handler.argv.length > 256 ||
        !handler.argv.every(
          (argument) =>
            typeof argument === 'string' &&
            !argument.includes('\0') &&
            argument.length <= this.maximumCommandCharacters,
        )
      ) {
        throw new Error('Hook argv must be a bounded array of strings.')
      }
      argv = [...handler.argv]
    } else {
      const selectedCommand =
        process.platform === 'win32' && handler.commandWindows !== undefined
          ? handler.commandWindows
          : handler.command
      if (
        typeof selectedCommand !== 'string' ||
        !selectedCommand.trim() ||
        selectedCommand.includes('\0') ||
        selectedCommand.length > this.maximumCommandCharacters
      ) {
        throw new Error('Hook command must be a bounded non-empty string.')
      }
      if (handler.commandWindows !== undefined && typeof handler.commandWindows !== 'string') {
        throw new Error('commandWindows must be a string.')
      }
      command = selectedCommand
      argv = systemShellArgv(selectedCommand)
      shell = true
    }

    if (handler.timeout !== undefined && handler.timeoutMs !== undefined) {
      throw new Error('Use either timeout seconds or timeoutMs, not both.')
    }
    let timeoutMs = this.defaultTimeoutMs
    if (handler.timeoutMs !== undefined) {
      if (typeof handler.timeoutMs !== 'number') throw new Error('timeoutMs must be a number.')
      timeoutMs = handler.timeoutMs
    } else if (handler.timeout !== undefined) {
      if (typeof handler.timeout !== 'number') throw new Error('timeout must be a number.')
      timeoutMs = handler.timeout * 1_000
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.maximumTimeoutMs) {
      throw new Error(
        `Hook timeout must be between 1 and ${this.maximumTimeoutMs.toString()} milliseconds.`,
      )
    }
    return {
      type: 'command',
      argv,
      shell,
      command,
      timeoutMs,
      isolation: 'structured-process',
      network: 'host',
    }
  }

  private serializeInput(input: HookDispatchInput, workspacePath: string): string {
    try {
      return JSON.stringify({
        ...(input.payload ?? {}),
        session_id: input.sessionId,
        run_id: input.runId ?? null,
        cwd: workspacePath,
        hook_event_name: input.event,
      })
    } catch (error) {
      throw new HookServiceError('INVALID_INPUT', 'Hook input must be JSON serializable.', {
        cause: error,
      })
    }
  }

  private interpretResult(
    result: Awaited<ReturnType<StructuredProcessRunner['run']>>,
    workspacePath: string,
  ): InterpretedHookOutput {
    const stderr = redactText(result.stderr, workspacePath, 8_000)
    if (result.cancelled) {
      return {
        blocked: true,
        reason: stderr || 'Hook execution was cancelled.',
        additionalContext: [],
        ignoredPermissionElevation: false,
        error: true,
      }
    }
    if (result.timedOut) {
      return {
        blocked: true,
        reason: stderr || 'Hook execution timed out.',
        additionalContext: [],
        ignoredPermissionElevation: false,
        error: true,
      }
    }
    if (result.spawnError) {
      return {
        blocked: true,
        reason: redactText(result.spawnError, workspacePath, 8_000) || 'Hook could not start.',
        additionalContext: [],
        ignoredPermissionElevation: false,
        error: true,
      }
    }
    if (result.outputTruncated) {
      return {
        blocked: true,
        reason: 'Hook output exceeded the configured limit.',
        additionalContext: [],
        ignoredPermissionElevation: false,
        error: true,
      }
    }
    if (result.exitCode === 2) {
      return {
        blocked: true,
        reason: stderr || 'Blocked by a trusted hook.',
        additionalContext: [],
        ignoredPermissionElevation: false,
        error: false,
      }
    }
    if (result.exitCode !== 0) {
      return {
        blocked: true,
        reason: stderr || `Hook exited with status ${String(result.exitCode)}.`,
        additionalContext: [],
        ignoredPermissionElevation: false,
        error: true,
      }
    }

    const stdout = result.stdout.trim()
    if (!stdout) {
      return {
        blocked: false,
        reason: null,
        additionalContext: [],
        ignoredPermissionElevation: false,
        error: false,
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      return {
        blocked: true,
        reason: 'Trusted hook returned invalid JSON.',
        additionalContext: [],
        ignoredPermissionElevation: false,
        error: true,
      }
    }
    const output = outputRecord(parsed)
    if (!output) {
      return {
        blocked: true,
        reason: 'Trusted hook output must be a JSON object.',
        additionalContext: [],
        ignoredPermissionElevation: false,
        error: true,
      }
    }
    const specific = outputRecord(output.hookSpecificOutput)
    const topDecision = permissionBehavior(output.decision)
    const permissionDecision = permissionBehavior(specific?.permissionDecision)
    const nestedDecision = permissionBehavior(specific?.decision)
    const blocked =
      topDecision === 'block' ||
      topDecision === 'deny' ||
      permissionDecision === 'block' ||
      permissionDecision === 'deny' ||
      nestedDecision === 'block' ||
      nestedDecision === 'deny' ||
      output.continue === false
    const ignoredPermissionElevation = [topDecision, permissionDecision, nestedDecision].some(
      (decision) => decision === 'allow' || decision === 'approve' || decision === 'approved',
    )
    const rawReason =
      (typeof specific?.permissionDecisionReason === 'string'
        ? specific.permissionDecisionReason
        : null) ??
      (typeof specific?.reason === 'string' ? specific.reason : null) ??
      (typeof output.reason === 'string' ? output.reason : null) ??
      (typeof output.stopReason === 'string' ? output.stopReason : null)
    const additionalContext = [
      ...contextValues(output.additionalContext),
      ...contextValues(specific?.additionalContext),
    ].map((context) => redactText(context, workspacePath, this.maximumAdditionalContextCharacters))
    return {
      blocked,
      reason: blocked
        ? redactText(rawReason ?? 'Blocked by a trusted hook.', workspacePath, 8_000)
        : null,
      additionalContext: additionalContext.filter(Boolean),
      ignoredPermissionElevation,
      error: false,
    }
  }

  private async assertWorkspaceSnapshot(workspacePath: string): Promise<void> {
    this.assertWorkspaceUnchanged(workspacePath)
    if (!(await this.workspaceTrust.isTrusted(workspacePath))) {
      throw new HookServiceError(
        'WORKSPACE_NOT_TRUSTED',
        'Workspace trust was removed before hook execution.',
      )
    }
    this.assertWorkspaceUnchanged(workspacePath)
  }

  private assertWorkspaceUnchanged(workspacePath: string): void {
    if (this.workspace.getWorkspace()?.path !== workspacePath) {
      throw new HookServiceError(
        'WORKSPACE_CHANGED',
        'The workspace changed while hooks were being processed.',
      )
    }
  }

  private assertNotCancelled(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return
    throw new HookServiceError('EXECUTION_CANCELLED', 'Hook execution was cancelled.', {
      cause: signal.reason,
    })
  }

  private publicDescriptor(hook: HookDescriptor, trusted: boolean): HookDescriptor {
    return { ...hook, trusted, handler: this.cloneHandler(hook.handler) }
  }

  private cloneHandler(handler: HookCommandDescriptor): HookCommandDescriptor {
    return { ...handler, argv: [...handler.argv] }
  }

  private entryTrustsHook(
    entry: TrustEntry | undefined,
    hook: HookDescriptor,
    workspacePath: string,
  ): boolean {
    return Boolean(
      entry &&
        entry.workspacePath === workspacePath &&
        entry.configPath === hook.configPath &&
        entry.revision === hook.revision,
    )
  }

  private emptyDispatchResult(): HookDispatchResult {
    return {
      decision: 'continue',
      reason: null,
      additionalContext: [],
      executions: [],
      skippedUntrustedHookIds: [],
    }
  }

  private async userDataPath(): Promise<string> {
    if (this.options.userDataPath) return this.options.userDataPath
    const { app } = await import('electron')
    return app.getPath('userData')
  }

  private async trustPath(): Promise<string> {
    return join(await this.userDataPath(), this.options.trustFileName ?? DEFAULT_TRUST_FILE_NAME)
  }

  private loadTrust(): Promise<PersistedHookTrust> {
    this.trustStatePromise ??= this.readTrustFromDisk()
    return this.trustStatePromise
  }

  private async readTrustFromDisk(): Promise<PersistedHookTrust> {
    const path = await this.trustPath()
    let source: string
    try {
      source = await readFsFile(path, 'utf8')
      if (process.platform !== 'win32') {
        await chmod(await this.userDataPath(), 0o700)
        await chmod(path, 0o600)
      }
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return emptyTrust()
      throw error
    }
    try {
      return persistedHookTrustSchema.parse(JSON.parse(source))
    } catch {
      const quarantine = `${path}.corrupt-${Date.now().toString()}-${randomUUID()}`
      await rename(path, quarantine)
      if (process.platform !== 'win32') await chmod(quarantine, 0o600)
      return emptyTrust()
    }
  }

  private mutateTrust(mutation: (draft: PersistedHookTrust) => void): Promise<void> {
    const operation = this.trustMutationTail.then(async () => {
      const draft = cloneTrust(await this.loadTrust())
      mutation(draft)
      await this.writeTrustToDisk(draft)
      this.trustStatePromise = Promise.resolve(draft)
    })
    this.trustMutationTail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async writeTrustToDisk(state: PersistedHookTrust): Promise<void> {
    const directory = await this.userDataPath()
    const path = await this.trustPath()
    const temporary = `${path}.${randomUUID()}.tmp`
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(directory, 0o700)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, path)
      if (process.platform !== 'win32') await chmod(path, 0o600)
      const directoryHandle = await open(directory, 'r').catch(() => null)
      if (directoryHandle) {
        try {
          await directoryHandle.sync().catch(() => undefined)
        } finally {
          await directoryHandle.close()
        }
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isNodeError(error, 'ENOENT')) throw error
      })
    }
  }
}
