import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

const SCHEMA_VERSION = 5
const DEFAULT_DATABASE_NAME = 'conversations.sqlite3'

const LIMITS = {
  id: 120,
  summary: 1_000,
  providerId: 120,
  modelId: 512,
  workspacePath: 4_096,
  messageContent: 2_000_000,
  contextPaths: 100,
  toolActivities: 200,
  toolName: 160,
  toolSummary: 4_000,
  error: 8_000,
  auditType: 160,
  auditSummary: 4_000,
  auditMetadata: 32_768,
  search: 500,
  list: 500,
  history: 500,
  goalObjective: 100_000,
  goalSummary: 16_000,
  goalPlanItems: 50,
  goalPlanItem: 4_000,
  goalPlanExplanation: 16_000,
  runTriggerProviderId: 160,
  runTriggerType: 160,
  runTriggerDedupeKey: 240,
  runPolicyId: 160,
  runOutcomeSummary: 16_000,
  subagentName: 160,
  subagentTask: 100_000,
  subagentList: 500,
} as const

export type ConversationStatus = 'active' | 'archived'
export type ConversationMessageRole = 'user' | 'assistant'
export type ConversationMessageStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'interrupted'
export type JournalRunStatus = 'running' | 'completed' | 'cancelled' | 'error' | 'interrupted'
export type TerminalRunStatus = Exclude<JournalRunStatus, 'running'>
export type RunIntent = 'answer' | 'plan' | 'act'
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'cleared'
export type GoalPlanItemStatus = 'pending' | 'in_progress' | 'completed'
export type SubagentRunStatus = JournalRunStatus
export type TerminalSubagentRunStatus = Exclude<SubagentRunStatus, 'running'>

export interface RunTriggerSnapshot {
  providerId: string
  type: string
  dedupeKey: string
}

export interface RunUsageSnapshot {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
}

export interface GoalPlanItem {
  step: string
  status: GoalPlanItemStatus
}

export interface GoalRecord {
  id: string
  /** Optional conversation that supplied the initial context. It does not own the goal. */
  originConversationId: string | null
  /** @deprecated Use originConversationId. This remains as a compatibility alias. */
  conversationId: string | null
  /** Canonical workspace binding captured independently from the origin conversation. */
  workspacePath: string | null
  objective: string
  status: GoalStatus
  revision: number
  planRevision: number
  progressSummary: string
  blockedSummary: string | null
  completionSummary: string | null
  tokenBudget: number | null
  usedTokens: number
  createdAt: number
  updatedAt: number
  completedAt: number | null
  clearedAt: number | null
}

export interface GoalPlanRevisionRecord {
  goalId: string
  revision: number
  goalRevision: number
  runId: string | null
  explanation: string
  items: GoalPlanItem[]
  createdAt: number
}

export interface GoalCheckpointRecord {
  id: number
  goalId: string
  goalRevision: number
  planRevision: number
  runId: string | null
  subagentRunId: string | null
  status: GoalStatus
  summary: string
  usedTokens: number
  createdAt: number
}

export interface SubagentRunRecord {
  id: string
  conversationId: string
  goalId: string | null
  originRunId: string | null
  parentSubagentRunId: string | null
  name: string
  task: string
  status: SubagentRunStatus
  resultSummary: string | null
  error: string | null
  startedAt: number
  finishedAt: number | null
}

export interface ToolActivitySummary {
  callId: string
  tool: string
  summary: string
  status: 'running' | 'completed' | 'error'
  startedAt: number | null
  completedAt: number | null
}

export interface ToolActivityInput {
  callId: string
  tool: string
  summary: string
  status: 'running' | 'completed' | 'error'
  startedAt?: number | null
  completedAt?: number | null
}

export interface ConversationRecord {
  id: string
  summary: string
  status: ConversationStatus
  providerId: string | null
  providerGeneration: number | null
  modelId: string | null
  workspacePath: string | null
  createdAt: number
  updatedAt: number
  archivedAt: number | null
  messageCount: number
  lastMessageAt: number | null
}

export interface ConversationMessageRecord {
  id: string
  conversationId: string
  role: ConversationMessageRole
  /** UI-visible text. Kept as an alias of displayContent for renderer compatibility. */
  content: string
  displayContent: string
  modelContent: string
  contextPaths: string[]
  runId: string | null
  status: ConversationMessageStatus
  error: string | null
  toolActivities: ToolActivitySummary[]
  createdAt: number
  updatedAt: number
  ordinal: number
}

export interface RunRecord {
  id: string
  conversationId: string
  goalId: string | null
  providerId: string | null
  modelId: string | null
  intent: RunIntent
  trigger: RunTriggerSnapshot
  policyId: string
  attempt: number
  usage: RunUsageSnapshot
  outcomeSummary: string | null
  status: JournalRunStatus
  error: string | null
  startedAt: number
  finishedAt: number | null
}

export type AuditMetadataValue =
  | string
  | number
  | boolean
  | null
  | AuditMetadataValue[]
  | { [key: string]: AuditMetadataValue }

export interface AuditEventRecord {
  id: number
  conversationId: string | null
  runId: string | null
  type: string
  summary: string
  metadata: AuditMetadataValue
  createdAt: number
}

export interface PendingMutationRefresh {
  path: string
  failureCode: 'HASH_CONFLICT' | 'PATCH_CONFLICT'
  currentSha256: string
}

export interface ConversationDetail extends ConversationRecord {
  messages: ConversationMessageRecord[]
  runs: RunRecord[]
  auditEvents: AuditEventRecord[]
}

export interface EnsureConversationInput {
  id: string
  summary?: string
  status?: ConversationStatus
  providerId?: string | null
  providerGeneration?: number | null
  modelId?: string | null
  workspacePath?: string | null
}

export interface ConversationListFilter {
  workspacePath?: string | null
  archived?: boolean
  search?: string
  limit?: number
}

export interface AppendMessageInput {
  id?: string
  conversationId: string
  role: ConversationMessageRole
  displayContent: string
  modelContent?: string
  contextPaths?: string[]
  runId?: string | null
  status?: ConversationMessageStatus
  error?: string | null
  toolActivities?: ToolActivityInput[]
}

export interface UpdateMessagePatch {
  displayContent?: string
  modelContent?: string
  contextPaths?: string[]
  runId?: string | null
  status?: ConversationMessageStatus
  error?: string | null
  toolActivities?: ToolActivityInput[]
}

export interface MessageOwnership {
  conversationId: string
  runId: string
  role: ConversationMessageRole
}

export interface StartRunInput {
  id?: string
  conversationId: string
  goalId?: string | null
  providerId?: string | null
  modelId?: string | null
  intent?: RunIntent
  trigger?: RunTriggerSnapshot
  policyId?: string
  attempt?: number
}

export interface FinishRunInput {
  status: TerminalRunStatus
  error?: string | null
  usage?: RunUsageSnapshot
  outcomeSummary?: string | null
  goalFinish?: {
    goalId: string
    expectedRevision: number
    status: 'blocked' | 'completed'
    summary: string
  }
}

export type InterruptedHostSummaryAuditType =
  | 'provider.post_effect_recovery_exhausted'
  | 'run.applied_effect_interrupted'

export interface FinishInterruptedWithHostSummaryInput {
  conversationId: string
  assistantMessageId: string
  hostSummary: string
  error: string
  usage?: RunUsageSnapshot
  toolActivities: ToolActivityInput[]
  auditType: InterruptedHostSummaryAuditType
  auditSummary: string
  auditMetadata?: unknown
}

export interface InitializeRunInput {
  conversation: EnsureConversationInput
  run: StartRunInput & { id: string }
  userMessage: AppendMessageInput & { id: string }
  assistantMessage: AppendMessageInput & { id: string }
}

export interface InitializedRun {
  run: RunRecord
  userMessage: ConversationMessageRecord
  assistantMessage: ConversationMessageRecord
}

export interface AppendAuditEventInput {
  conversationId?: string | null
  runId?: string | null
  type: string
  summary: string
  metadata?: unknown
}

export interface ModelHistoryMessage {
  role: ConversationMessageRole
  content: string
}

export interface ForkConversationInput {
  id?: string
  summary?: string
  throughMessageId?: string
}

export interface RecoveryResult {
  runIds: string[]
  messageIds: string[]
}

export interface CreateGoalInput {
  id?: string
  /** Backwards-compatible alias for originConversationId. */
  conversationId?: string | null
  originConversationId?: string | null
  /** Required when an origin conversation is not supplied. */
  workspacePath?: string | null
  objective: string
  status?: GoalStatus
  progressSummary?: string
  blockedSummary?: string | null
  completionSummary?: string | null
  tokenBudget?: number | null
  usedTokens?: number
}

export interface UpdateGoalInput {
  expectedRevision: number
  objective?: string
  status?: GoalStatus
  progressSummary?: string
  blockedSummary?: string | null
  completionSummary?: string | null
  tokenBudget?: number | null
  usedTokens?: number
}

export interface GoalListOptions {
  limit?: number
}

export interface GoalListFilter extends GoalListOptions {
  workspacePath?: string | null
  originConversationId?: string | null
  statuses?: GoalStatus[]
}

export interface AppendGoalPlanInput {
  goalId: string
  expectedGoalRevision: number
  runId?: string | null
  explanation?: string
  items: GoalPlanItem[]
}

export interface AppendGoalCheckpointInput {
  goalId: string
  expectedGoalRevision: number
  runId?: string | null
  subagentRunId?: string | null
  summary: string
  /** Cumulative token usage after this checkpoint. It may not decrease. */
  usedTokens?: number
}

export interface StartSubagentRunInput {
  id?: string
  conversationId: string
  goalId?: string | null
  originRunId?: string | null
  parentSubagentRunId?: string | null
  name: string
  task: string
}

export interface FinishSubagentRunInput {
  status: TerminalSubagentRunStatus
  resultSummary?: string | null
  error?: string | null
}

export interface SubagentRunListOptions {
  goalId?: string | null
  status?: SubagentRunStatus
  limit?: number
}

export interface SubagentRecoveryResult {
  runIds: string[]
}

export interface ConversationRepositoryOptions {
  userDataPath?: string
  databasePath?: string
  fileName?: string
  now?: () => number
}

export type ConversationRepositoryErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'SCHEMA_TOO_NEW'
  | 'CLOSED'
  | 'CORRUPT'

export class ConversationRepositoryError extends Error {
  readonly code: ConversationRepositoryErrorCode

  constructor(code: ConversationRepositoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConversationRepositoryError'
    this.code = code
  }
}

type Row = Record<string, unknown>

const CONVERSATION_STATUSES = new Set<ConversationStatus>(['active', 'archived'])
const MESSAGE_ROLES = new Set<ConversationMessageRole>(['user', 'assistant'])
const MESSAGE_STATUSES = new Set<ConversationMessageStatus>([
  'starting',
  'running',
  'completed',
  'cancelled',
  'error',
  'interrupted',
])
const TERMINAL_RUN_STATUSES = new Set<TerminalRunStatus>([
  'completed',
  'cancelled',
  'error',
  'interrupted',
])
const RUN_INTENTS = new Set<RunIntent>(['answer', 'plan', 'act'])
const DEFAULT_RUN_TRIGGER_PROVIDER_ID = 'builtin:legacy'
const DEFAULT_RUN_TRIGGER_TYPE = 'legacy-run'
const DEFAULT_ACT_POLICY_ID = 'builtin:interactive'
const DEFAULT_READ_ONLY_POLICY_ID = 'builtin:read-only'
const TOOL_STATUSES = new Set<ToolActivitySummary['status']>(['running', 'completed', 'error'])
const GOAL_STATUSES = new Set<GoalStatus>(['active', 'paused', 'blocked', 'completed', 'cleared'])
const OPEN_GOAL_STATUSES = new Set<GoalStatus>(['active', 'paused', 'blocked'])
const GOAL_PLAN_ITEM_STATUSES = new Set<GoalPlanItemStatus>(['pending', 'in_progress', 'completed'])
const SUBAGENT_RUN_STATUSES = new Set<SubagentRunStatus>([
  'running',
  'completed',
  'cancelled',
  'error',
  'interrupted',
])
const TERMINAL_SUBAGENT_RUN_STATUSES = new Set<TerminalSubagentRunStatus>([
  'completed',
  'cancelled',
  'error',
  'interrupted',
])
const SENSITIVE_KEY = /(?:api[-_ ]?key|authorization|cookie|credential|password|secret|token)/i
const SAFE_USAGE_KEYS = new Set(['inputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'])
const SAFE_SHA256_KEYS = new Set(['currentSha256', 'expectedSha256', 'sha256'])
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const SECRET_ASSIGNMENT =
  /\b(api[-_ ]?key|authorization|cookie|credential|password|secret|token)\b\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
const PROVIDER_TOKEN = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/gi
const HIGH_ENTROPY_TOKEN = /\b[A-Za-z0-9+/_=-]{32,}\b/g
const OMITTED_AUDIT_FIELDS = new Set([
  'diff',
  'filecontent',
  'patch',
  'rawcontent',
  'rawoutput',
  'rawresult',
  'requestbody',
  'responsebody',
  'sourcecontent',
  'stderr',
  'stdout',
  'tooloutput',
  'toolresult',
])

function invalid(message: string): never {
  throw new ConversationRepositoryError('INVALID_INPUT', message)
}

function assertRecord(
  value: unknown,
  name: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(`${name} must be an object.`)
  }
  const record = value as Record<string, unknown>
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.includes(key))
  if (unknownKey) return invalid(`${name} contains an unsupported field: ${unknownKey}`)
  return record
}

function boundedString(
  value: unknown,
  name: string,
  maximum: number,
  options: { empty?: boolean; trim?: boolean } = {},
): string {
  if (typeof value !== 'string') return invalid(`${name} must be a string.`)
  const result = options.trim === false ? value : value.trim()
  if (!options.empty && result.length === 0) return invalid(`${name} cannot be empty.`)
  if (result.length > maximum) return invalid(`${name} exceeds ${maximum} characters.`)
  if (result.includes('\0')) return invalid(`${name} cannot contain null bytes.`)
  return result
}

function nullableString(value: unknown, name: string, maximum: number): string | null {
  if (value === null) return null
  return boundedString(value, name, maximum)
}

function positiveInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    return invalid(`${name} must be an integer between 1 and ${maximum}.`)
  }
  return value as number
}

function nonNegativeInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    return invalid(`${name} must be an integer between 0 and ${maximum}.`)
  }
  return value as number
}

function enumValue<T extends string>(value: unknown, name: string, values: Set<T>): T {
  if (typeof value !== 'string' || !values.has(value as T)) {
    return invalid(`${name} has an unsupported value.`)
  }
  return value as T
}

function validateGoalStatuses(value: unknown): GoalStatus[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > GOAL_STATUSES.size) {
    return invalid(`statuses must contain between 1 and ${GOAL_STATUSES.size} entries.`)
  }
  const statuses = value.map((status, index) =>
    enumValue(status, `statuses[${index}]`, GOAL_STATUSES),
  )
  if (new Set(statuses).size !== statuses.length) {
    return invalid('statuses cannot contain duplicate entries.')
  }
  return statuses
}

function defaultRunTrigger(runId: string): RunTriggerSnapshot {
  return {
    providerId: DEFAULT_RUN_TRIGGER_PROVIDER_ID,
    type: DEFAULT_RUN_TRIGGER_TYPE,
    dedupeKey: runId,
  }
}

function defaultRunPolicyId(intent: RunIntent): string {
  return intent === 'act' ? DEFAULT_ACT_POLICY_ID : DEFAULT_READ_ONLY_POLICY_ID
}

function validateRunTrigger(value: unknown): RunTriggerSnapshot {
  const record = assertRecord(value, 'run trigger', ['providerId', 'type', 'dedupeKey'])
  return {
    providerId: boundedString(record.providerId, 'trigger.providerId', LIMITS.runTriggerProviderId),
    type: boundedString(record.type, 'trigger.type', LIMITS.runTriggerType),
    dedupeKey: boundedString(record.dedupeKey, 'trigger.dedupeKey', LIMITS.runTriggerDedupeKey),
  }
}

function validateRunUsage(value: unknown): RunUsageSnapshot {
  const record = assertRecord(value, 'run usage', [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'totalTokens',
  ])
  return {
    inputTokens: nonNegativeInteger(
      record.inputTokens,
      'usage.inputTokens',
      Number.MAX_SAFE_INTEGER,
    ),
    outputTokens: nonNegativeInteger(
      record.outputTokens,
      'usage.outputTokens',
      Number.MAX_SAFE_INTEGER,
    ),
    reasoningTokens: nonNegativeInteger(
      record.reasoningTokens,
      'usage.reasoningTokens',
      Number.MAX_SAFE_INTEGER,
    ),
    totalTokens: nonNegativeInteger(
      record.totalTokens,
      'usage.totalTokens',
      Number.MAX_SAFE_INTEGER,
    ),
  }
}

function sameRunUsage(left: RunUsageSnapshot, right: RunUsageSnapshot): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningTokens === right.reasoningTokens &&
    left.totalTokens === right.totalTokens
  )
}

function assertRunUsageProgresses(
  current: RunUsageSnapshot,
  next: RunUsageSnapshot,
): RunUsageSnapshot {
  if (
    next.inputTokens < current.inputTokens ||
    next.outputTokens < current.outputTokens ||
    next.reasoningTokens < current.reasoningTokens ||
    next.totalTokens < current.totalTokens
  ) {
    return invalid('run usage cannot decrease.')
  }
  return next
}

function validateGoalPlanItems(value: unknown): GoalPlanItem[] {
  if (!Array.isArray(value)) return invalid('items must be an array.')
  if (value.length > LIMITS.goalPlanItems) {
    return invalid(`items cannot contain more than ${LIMITS.goalPlanItems} entries.`)
  }
  let inProgress = 0
  const items = value.map((item, index) => {
    const record = assertRecord(item, `items[${index}]`, ['step', 'status'])
    const status = enumValue(record.status, `items[${index}].status`, GOAL_PLAN_ITEM_STATUSES)
    if (status === 'in_progress') inProgress += 1
    const step = boundedString(record.step, `items[${index}].step`, LIMITS.goalPlanItem, {
      trim: false,
    })
    if (!step.trim()) return invalid(`items[${index}].step cannot be blank.`)
    return { step, status }
  })
  if (inProgress > 1) return invalid('items can contain at most one in_progress entry.')
  return items
}

function parsePersistedGoalPlanItems(source: unknown): GoalPlanItem[] {
  try {
    if (typeof source !== 'string') throw new TypeError('Plan items are not serialized text.')
    return validateGoalPlanItems(JSON.parse(source))
  } catch (error) {
    throw new ConversationRepositoryError('INVALID_STATE', 'Stored goal plan items are invalid.', {
      cause: error,
    })
  }
}

function assertGoalSummaries(
  status: GoalStatus,
  blockedSummary: string | null,
  completionSummary: string | null,
): void {
  if (status === 'blocked' && !blockedSummary) {
    invalid('blockedSummary is required when goal status is blocked.')
  }
  if (status === 'completed' && !completionSummary) {
    invalid('completionSummary is required when goal status is completed.')
  }
}

function assertGoalTransition(current: GoalStatus, next: GoalStatus): void {
  if (current === 'completed' && next !== 'completed') {
    throw new ConversationRepositoryError('INVALID_STATE', 'A completed goal is terminal.')
  }
  if (current === 'cleared' && next !== 'cleared') {
    throw new ConversationRepositoryError('INVALID_STATE', 'A cleared goal is terminal.')
  }
}

function redactText(value: string): string {
  return value
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(PROVIDER_TOKEN, '[REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(HIGH_ENTROPY_TOKEN, '[REDACTED]')
}

function sanitizeMetadata(value: unknown, depth = 0): AuditMetadataValue {
  if (value === null) return null
  if (typeof value === 'string') return redactText(value.slice(0, 4_000))
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (depth >= 5) return '[TRUNCATED]'
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeMetadata(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    const output: Record<string, AuditMetadataValue> = {}
    for (const [rawKey, item] of Object.entries(value).slice(0, 50)) {
      const key = rawKey.slice(0, 160)
      const normalizedKey = key.replace(/[-_\s]/g, '').toLowerCase()
      const safeUsageValue =
        SAFE_USAGE_KEYS.has(key) && typeof item === 'number' && Number.isFinite(item)
      const safeSha256Value =
        SAFE_SHA256_KEYS.has(key) && typeof item === 'string' && SHA256_PATTERN.test(item)
      output[key] = safeSha256Value
        ? item.toLowerCase()
        : SENSITIVE_KEY.test(key) && !safeUsageValue
          ? '[REDACTED]'
          : OMITTED_AUDIT_FIELDS.has(normalizedKey)
            ? '[OMITTED]'
            : sanitizeMetadata(item, depth + 1)
    }
    return output
  }
  return null
}

function serializeMetadata(value: unknown): string {
  let sanitized = sanitizeMetadata(value)
  let serialized = JSON.stringify(sanitized)
  if (serialized.length <= LIMITS.auditMetadata) return serialized
  sanitized = { truncated: true, summary: redactText(serialized.slice(0, 8_000)) }
  serialized = JSON.stringify(sanitized)
  return serialized
}

function validateContextPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return invalid('contextPaths must be an array.')
  if (value.length > LIMITS.contextPaths) {
    return invalid(`contextPaths cannot contain more than ${LIMITS.contextPaths} entries.`)
  }
  return value.map((path, index) =>
    boundedString(path, `contextPaths[${index}]`, LIMITS.workspacePath, { trim: false }),
  )
}

function validateToolActivities(value: unknown): ToolActivitySummary[] {
  if (!Array.isArray(value)) return invalid('toolActivities must be an array.')
  if (value.length > LIMITS.toolActivities) {
    return invalid(`toolActivities cannot contain more than ${LIMITS.toolActivities} entries.`)
  }
  return value.map((activity, index) => {
    const record = assertRecord(activity, `toolActivities[${index}]`, [
      'callId',
      'tool',
      'summary',
      'status',
      'startedAt',
      'completedAt',
    ])
    const timestamp = (item: unknown, name: string): number | null => {
      if (item === undefined || item === null) return null
      if (!Number.isSafeInteger(item) || (item as number) < 0) {
        return invalid(`${name} must be a non-negative timestamp.`)
      }
      return item as number
    }
    return {
      callId: boundedString(record.callId, `toolActivities[${index}].callId`, LIMITS.id),
      tool: boundedString(record.tool, `toolActivities[${index}].tool`, LIMITS.toolName),
      summary: redactText(
        boundedString(record.summary, `toolActivities[${index}].summary`, LIMITS.toolSummary, {
          empty: true,
          trim: false,
        }),
      ),
      status: enumValue(record.status, `toolActivities[${index}].status`, TOOL_STATUSES),
      startedAt: timestamp(record.startedAt, `toolActivities[${index}].startedAt`),
      completedAt: timestamp(record.completedAt, `toolActivities[${index}].completedAt`),
    }
  })
}

function safeJsonArray<T>(source: unknown, validator: (value: unknown) => T[]): T[] {
  if (typeof source !== 'string') return []
  try {
    return validator(JSON.parse(source))
  } catch {
    return []
  }
}

function safeMetadata(source: unknown): AuditMetadataValue {
  if (typeof source !== 'string') return null
  try {
    return sanitizeMetadata(JSON.parse(source))
  } catch {
    return null
  }
}

function auditMetadataRecord(value: AuditMetadataValue): Record<string, AuditMetadataValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function validAuditPath(value: AuditMetadataValue | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= LIMITS.workspacePath &&
    !value.includes('\0')
  )
}

function rowString(row: Row, key: string): string {
  return typeof row[key] === 'string' ? row[key] : ''
}

function rowNullableString(row: Row, key: string): string | null {
  return typeof row[key] === 'string' ? row[key] : null
}

function rowNumber(row: Row, key: string): number {
  const value = row[key]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function rowNullableNumber(row: Row, key: string): number | null {
  return row[key] === null || row[key] === undefined ? null : rowNumber(row, key)
}

function toConversation(row: Row): ConversationRecord {
  return {
    id: rowString(row, 'id'),
    summary: rowString(row, 'summary'),
    status: rowString(row, 'status') as ConversationStatus,
    providerId: rowNullableString(row, 'provider_id'),
    providerGeneration: rowNullableNumber(row, 'provider_generation'),
    modelId: rowNullableString(row, 'model_id'),
    workspacePath: rowNullableString(row, 'workspace_path'),
    createdAt: rowNumber(row, 'created_at'),
    updatedAt: rowNumber(row, 'updated_at'),
    archivedAt: rowNullableNumber(row, 'archived_at'),
    messageCount: rowNumber(row, 'message_count'),
    lastMessageAt: rowNullableNumber(row, 'last_message_at'),
  }
}

function toMessage(row: Row): ConversationMessageRecord {
  const displayContent = rowString(row, 'display_content')
  return {
    id: rowString(row, 'id'),
    conversationId: rowString(row, 'conversation_id'),
    role: rowString(row, 'role') as ConversationMessageRole,
    content: displayContent,
    displayContent,
    modelContent: rowString(row, 'model_content'),
    contextPaths: safeJsonArray(row.context_paths_json, validateContextPaths),
    runId: rowNullableString(row, 'run_id'),
    status: rowString(row, 'status') as ConversationMessageStatus,
    error: rowNullableString(row, 'error'),
    toolActivities: safeJsonArray(row.tool_activities_json, validateToolActivities),
    createdAt: rowNumber(row, 'created_at'),
    updatedAt: rowNumber(row, 'updated_at'),
    ordinal: rowNumber(row, 'ordinal'),
  }
}

function toRun(row: Row): RunRecord {
  return {
    id: rowString(row, 'id'),
    conversationId: rowString(row, 'conversation_id'),
    goalId: rowNullableString(row, 'goal_id'),
    providerId: rowNullableString(row, 'provider_id'),
    modelId: rowNullableString(row, 'model_id'),
    intent: rowString(row, 'intent') as RunIntent,
    trigger: {
      providerId: rowString(row, 'trigger_provider_id'),
      type: rowString(row, 'trigger_type'),
      dedupeKey: rowString(row, 'trigger_dedupe_key'),
    },
    policyId: rowString(row, 'policy_id'),
    attempt: rowNumber(row, 'attempt'),
    usage: {
      inputTokens: rowNumber(row, 'input_tokens'),
      outputTokens: rowNumber(row, 'output_tokens'),
      reasoningTokens: rowNumber(row, 'reasoning_tokens'),
      totalTokens: rowNumber(row, 'total_tokens'),
    },
    outcomeSummary: rowNullableString(row, 'outcome_summary'),
    status: rowString(row, 'status') as JournalRunStatus,
    error: rowNullableString(row, 'error'),
    startedAt: rowNumber(row, 'started_at'),
    finishedAt: rowNullableNumber(row, 'finished_at'),
  }
}

function toAuditEvent(row: Row): AuditEventRecord {
  return {
    id: rowNumber(row, 'id'),
    conversationId: rowNullableString(row, 'conversation_id'),
    runId: rowNullableString(row, 'run_id'),
    type: rowString(row, 'event_type'),
    summary: rowString(row, 'summary'),
    metadata: safeMetadata(row.metadata_json),
    createdAt: rowNumber(row, 'created_at'),
  }
}

function toGoal(row: Row): GoalRecord {
  const originConversationId = rowNullableString(row, 'conversation_id')
  return {
    id: rowString(row, 'id'),
    originConversationId,
    conversationId: originConversationId,
    workspacePath: rowNullableString(row, 'workspace_path'),
    objective: rowString(row, 'objective'),
    status: rowString(row, 'status') as GoalStatus,
    revision: rowNumber(row, 'revision'),
    planRevision: rowNumber(row, 'plan_revision'),
    progressSummary: rowString(row, 'progress_summary'),
    blockedSummary: rowNullableString(row, 'blocked_summary'),
    completionSummary: rowNullableString(row, 'completion_summary'),
    tokenBudget: rowNullableNumber(row, 'token_budget'),
    usedTokens: rowNumber(row, 'used_tokens'),
    createdAt: rowNumber(row, 'created_at'),
    updatedAt: rowNumber(row, 'updated_at'),
    completedAt: rowNullableNumber(row, 'completed_at'),
    clearedAt: rowNullableNumber(row, 'cleared_at'),
  }
}

function toGoalPlanRevision(row: Row): GoalPlanRevisionRecord {
  return {
    goalId: rowString(row, 'goal_id'),
    revision: rowNumber(row, 'revision'),
    goalRevision: rowNumber(row, 'goal_revision'),
    runId: rowNullableString(row, 'run_id'),
    explanation: rowString(row, 'explanation'),
    items: parsePersistedGoalPlanItems(row.items_json),
    createdAt: rowNumber(row, 'created_at'),
  }
}

function toGoalCheckpoint(row: Row): GoalCheckpointRecord {
  return {
    id: rowNumber(row, 'id'),
    goalId: rowString(row, 'goal_id'),
    goalRevision: rowNumber(row, 'goal_revision'),
    planRevision: rowNumber(row, 'plan_revision'),
    runId: rowNullableString(row, 'run_id'),
    subagentRunId: rowNullableString(row, 'subagent_run_id'),
    status: rowString(row, 'status') as GoalStatus,
    summary: rowString(row, 'summary'),
    usedTokens: rowNumber(row, 'used_tokens'),
    createdAt: rowNumber(row, 'created_at'),
  }
}

function toSubagentRun(row: Row): SubagentRunRecord {
  return {
    id: rowString(row, 'id'),
    conversationId: rowString(row, 'conversation_id'),
    goalId: rowNullableString(row, 'goal_id'),
    originRunId: rowNullableString(row, 'origin_run_id'),
    parentSubagentRunId: rowNullableString(row, 'parent_subagent_run_id'),
    name: rowString(row, 'name'),
    task: rowString(row, 'task'),
    status: rowString(row, 'status') as SubagentRunStatus,
    resultSummary: rowNullableString(row, 'result_summary'),
    error: rowNullableString(row, 'error'),
    startedAt: rowNumber(row, 'started_at'),
    finishedAt: rowNullableNumber(row, 'finished_at'),
  }
}

interface InterruptedGoalRecoveryEvidence {
  summary: string
  toolCount: number
  toolStatuses: Record<ToolActivitySummary['status'], number>
  changedPaths: string[]
  omittedChangedPathEntries: number
}

function boundedRedactedText(value: string, maximum: number): string {
  const redacted = redactText(value)
  if (redacted.length <= maximum) return redacted
  return `${redacted.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`
}

function interruptedGoalRecoveryEvidence(
  database: DatabaseSync,
  run: RunRecord,
  goal: GoalRecord,
  safeReason: string,
): InterruptedGoalRecoveryEvidence {
  const tools = new Map<string, { tool: string; status: ToolActivitySummary['status'] }>()
  let omittedToolActivities = 0
  const rememberTool = (
    callId: string,
    tool: string,
    status: ToolActivitySummary['status'],
  ): void => {
    if (tools.has(callId) || tools.size < LIMITS.toolActivities) {
      tools.set(callId, { tool, status })
    } else {
      omittedToolActivities += 1
    }
  }

  const messageRows = asRows(
    database
      .prepare(
        `SELECT tool_activities_json FROM messages
         WHERE conversation_id = ? AND run_id = ?
         ORDER BY ordinal ASC`,
      )
      .all(run.conversationId, run.id),
  )
  for (const row of messageRows) {
    for (const activity of safeJsonArray(row.tool_activities_json, validateToolActivities)) {
      rememberTool(activity.callId, activity.tool, activity.status)
    }
  }

  const changedPaths = new Set<string>()
  let omittedChangedPathEntries = 0
  const auditRows = asRows(
    database
      .prepare(
        `SELECT event_type, metadata_json FROM audit_events
         WHERE conversation_id = ? AND run_id = ?
         ORDER BY id ASC`,
      )
      .all(run.conversationId, run.id),
  )
  for (const row of auditRows) {
    const eventType = rowString(row, 'event_type')
    const metadata = auditMetadataRecord(safeMetadata(row.metadata_json))
    if (!metadata) continue
    if (eventType === 'files.changed' && Array.isArray(metadata.paths)) {
      for (const path of metadata.paths) {
        if (!validAuditPath(path) || changedPaths.has(path)) continue
        if (changedPaths.size < LIMITS.contextPaths) changedPaths.add(path)
        else omittedChangedPathEntries += 1
      }
      continue
    }
    if (!['tool.completed', 'tool.failed', 'tool.rejected'].includes(eventType)) continue
    const callId = metadata.callId
    const tool = metadata.tool
    if (
      typeof callId !== 'string' ||
      !callId ||
      callId.length > LIMITS.id ||
      callId.includes('\0') ||
      typeof tool !== 'string' ||
      !tool ||
      tool.length > LIMITS.toolName ||
      tool.includes('\0')
    ) {
      continue
    }
    rememberTool(callId, tool, eventType === 'tool.completed' ? 'completed' : 'error')
  }

  const toolStatuses: InterruptedGoalRecoveryEvidence['toolStatuses'] = {
    running: 0,
    completed: 0,
    error: 0,
  }
  const toolsByName = new Map<string, InterruptedGoalRecoveryEvidence['toolStatuses']>()
  for (const activity of tools.values()) {
    toolStatuses[activity.status] += 1
    const statuses = toolsByName.get(activity.tool) ?? { running: 0, completed: 0, error: 0 }
    statuses[activity.status] += 1
    toolsByName.set(activity.tool, statuses)
  }
  const toolDetails = [...toolsByName]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([tool, statuses]) =>
        `${tool} [completed=${statuses.completed}, error=${statuses.error}, running=${statuses.running}]`,
    )
    .join(', ')
  const toolSection = boundedRedactedText(
    tools.size === 0
      ? 'Tools: none recorded.'
      : `Tools: ${tools.size.toString()} recorded (completed=${toolStatuses.completed.toString()}, error=${toolStatuses.error.toString()}, running=${toolStatuses.running.toString()})${
          omittedToolActivities > 0
            ? `; ${omittedToolActivities.toString()} additional activities omitted`
            : ''
        }; ${toolDetails}.`,
    LIMITS.auditSummary,
  )
  const pathValues = [...changedPaths]
  const pathSection = boundedRedactedText(
    pathValues.length === 0
      ? 'Changed paths: none recorded.'
      : `Changed paths: ${pathValues.map((path) => JSON.stringify(path)).join(', ')}${
          omittedChangedPathEntries > 0
            ? `; ${omittedChangedPathEntries.toString()} additional path entries omitted`
            : ''
        }.`,
    LIMITS.auditSummary,
  )
  const reasonSection = boundedRedactedText(`Interruption: ${safeReason}`, LIMITS.auditSummary)
  const closing = `No completion was inferred; Goal status remains ${goal.status}.`
  const body = [
    'Host recovery checkpoint for an interrupted Goal run.',
    toolSection,
    pathSection,
    `Usage: total=${run.usage.totalTokens.toString()}, input=${run.usage.inputTokens.toString()}, output=${run.usage.outputTokens.toString()}, reasoning=${run.usage.reasoningTokens.toString()} tokens.`,
    reasonSection,
  ].join(' ')
  const boundedBody = boundedRedactedText(
    body,
    Math.max(1, LIMITS.goalSummary - closing.length - 1),
  )
  return {
    summary: `${boundedBody} ${closing}`,
    toolCount: tools.size,
    toolStatuses,
    changedPaths: pathValues,
    omittedChangedPathEntries,
  }
}

function asRows(value: unknown[]): Row[] {
  return value as Row[]
}

function asRow(value: unknown): Row | undefined {
  return value as Row | undefined
}

const transactionDepth = new WeakMap<DatabaseSync, number>()
let savepointSequence = 0

function withTransaction<T>(database: DatabaseSync, operation: () => T): T {
  const depth = transactionDepth.get(database) ?? 0
  const savepoint = `nested_${(++savepointSequence).toString()}`
  if (depth === 0) database.exec('BEGIN IMMEDIATE')
  else database.exec(`SAVEPOINT ${savepoint}`)
  transactionDepth.set(database, depth + 1)
  try {
    const result = operation()
    if (depth === 0) database.exec('COMMIT')
    else database.exec(`RELEASE SAVEPOINT ${savepoint}`)
    return result
  } catch (error) {
    try {
      if (depth === 0) database.exec('ROLLBACK')
      else {
        database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        database.exec(`RELEASE SAVEPOINT ${savepoint}`)
      }
    } catch {
      // Preserve the original error; a failed rollback only means SQLite already ended the tx.
    }
    throw error
  } finally {
    if (depth === 0) transactionDepth.delete(database)
    else transactionDepth.set(database, depth)
  }
}

function databasePath(options: ConversationRepositoryOptions): string {
  if (options.databasePath) {
    return boundedString(options.databasePath, 'databasePath', LIMITS.workspacePath, {
      trim: false,
    })
  }
  if (!options.userDataPath) {
    throw new ConversationRepositoryError(
      'INVALID_INPUT',
      'Either databasePath or userDataPath is required.',
    )
  }
  const root = boundedString(options.userDataPath, 'userDataPath', LIMITS.workspacePath, {
    trim: false,
  })
  const fileName = options.fileName
    ? boundedString(options.fileName, 'fileName', 255)
    : DEFAULT_DATABASE_NAME
  if (fileName.includes('/') || fileName.includes('\\')) {
    return invalid('fileName must not include path separators.')
  }
  if (fileName === '.' || fileName === '..') return invalid('fileName must name a database file.')
  return join(root, fileName)
}

function migrate(database: DatabaseSync): void {
  const versionRow = asRow(database.prepare('PRAGMA user_version').get())
  const version = versionRow ? rowNumber(versionRow, 'user_version') : 0
  if (version > SCHEMA_VERSION) {
    throw new ConversationRepositoryError(
      'SCHEMA_TOO_NEW',
      `Conversation database schema ${version} is newer than supported version ${SCHEMA_VERSION}.`,
    )
  }
  if (version === SCHEMA_VERSION) return

  withTransaction(database, () => {
    if (version < 1) {
      database.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          summary TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
          provider_id TEXT,
          model_id TEXT,
          workspace_path TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER
        ) STRICT;

        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          provider_id TEXT,
          model_id TEXT,
          status TEXT NOT NULL CHECK (
            status IN ('running', 'completed', 'cancelled', 'error', 'interrupted')
          ),
          error TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER
        ) STRICT;

        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          display_content TEXT NOT NULL,
          model_content TEXT NOT NULL,
          context_paths_json TEXT NOT NULL DEFAULT '[]',
          run_id TEXT,
          status TEXT NOT NULL CHECK (
            status IN ('starting', 'running', 'completed', 'cancelled', 'error', 'interrupted')
          ),
          error TEXT,
          tool_activities_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          ordinal INTEGER NOT NULL,
          UNIQUE (conversation_id, ordinal)
        ) STRICT;

        CREATE TABLE audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
          run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          summary TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT 'null',
          created_at INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX conversations_workspace_updated
          ON conversations(workspace_path, updated_at DESC);
        CREATE INDEX messages_conversation_ordinal
          ON messages(conversation_id, ordinal);
        CREATE INDEX runs_conversation_started
          ON runs(conversation_id, started_at);
        CREATE INDEX audit_conversation_created
          ON audit_events(conversation_id, created_at);

        CREATE TRIGGER audit_events_immutable
        BEFORE UPDATE ON audit_events
        BEGIN
          SELECT RAISE(ABORT, 'audit events are immutable');
        END;
      `)
      database.exec('PRAGMA user_version = 1')
    }
    if (version < 2) {
      database.exec('ALTER TABLE conversations ADD COLUMN provider_generation INTEGER')
      database.exec('PRAGMA user_version = 2')
    }
    if (version < 3) {
      database.exec(`
        CREATE TABLE goals (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          objective TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('active', 'paused', 'blocked', 'completed', 'cleared')
          ),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          plan_revision INTEGER NOT NULL DEFAULT 0 CHECK (plan_revision >= 0),
          progress_summary TEXT NOT NULL DEFAULT '',
          blocked_summary TEXT,
          completion_summary TEXT,
          token_budget INTEGER CHECK (
            token_budget IS NULL OR (token_budget >= 1 AND token_budget <= 9007199254740991)
          ),
          used_tokens INTEGER NOT NULL DEFAULT 0 CHECK (
            used_tokens >= 0 AND used_tokens <= 9007199254740991
          ),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER,
          cleared_at INTEGER,
          CHECK (status != 'blocked' OR blocked_summary IS NOT NULL),
          CHECK (status != 'completed' OR completion_summary IS NOT NULL),
          CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
          CHECK ((status = 'cleared') = (cleared_at IS NOT NULL))
        ) STRICT;

        CREATE UNIQUE INDEX goals_one_open_per_conversation
          ON goals(conversation_id)
          WHERE status IN ('active', 'paused', 'blocked');
        CREATE INDEX goals_conversation_updated
          ON goals(conversation_id, updated_at DESC);

        CREATE TABLE goal_plan_revisions (
          goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          goal_revision INTEGER NOT NULL CHECK (goal_revision >= 1),
          run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
          explanation TEXT NOT NULL DEFAULT '',
          items_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (goal_id, revision)
        ) STRICT;

        CREATE INDEX goal_plans_created
          ON goal_plan_revisions(goal_id, created_at DESC);

        CREATE TRIGGER goal_plan_revisions_immutable
        BEFORE UPDATE ON goal_plan_revisions
        BEGIN
          SELECT RAISE(ABORT, 'goal plan revisions are immutable');
        END;

        CREATE TABLE subagent_runs (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          goal_id TEXT REFERENCES goals(id) ON DELETE CASCADE,
          origin_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
          parent_subagent_run_id TEXT REFERENCES subagent_runs(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          task TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('running', 'completed', 'cancelled', 'error', 'interrupted')
          ),
          result_summary TEXT,
          error TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER
        ) STRICT;

        CREATE INDEX subagents_conversation_started
          ON subagent_runs(conversation_id, started_at DESC);
        CREATE INDEX subagents_goal_started
          ON subagent_runs(goal_id, started_at DESC);
        CREATE INDEX subagents_parent_started
          ON subagent_runs(parent_subagent_run_id, started_at);

        CREATE TABLE goal_checkpoints (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
          goal_revision INTEGER NOT NULL CHECK (goal_revision >= 1),
          plan_revision INTEGER NOT NULL CHECK (plan_revision >= 0),
          run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
          subagent_run_id TEXT REFERENCES subagent_runs(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (
            status IN ('active', 'paused', 'blocked', 'completed', 'cleared')
          ),
          summary TEXT NOT NULL,
          used_tokens INTEGER NOT NULL CHECK (
            used_tokens >= 0 AND used_tokens <= 9007199254740991
          ),
          created_at INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX goal_checkpoints_created
          ON goal_checkpoints(goal_id, created_at DESC, id DESC);

        CREATE TRIGGER goal_checkpoints_immutable
        BEFORE UPDATE ON goal_checkpoints
        BEGIN
          SELECT RAISE(ABORT, 'goal checkpoints are immutable');
        END;
      `)
      database.exec('PRAGMA user_version = 3')
    }
  })

  if (version < 4) migrateGoalOwnershipV4(database)
  if (version < 5) migrateRunSnapshotsV5(database)
}

function migrateGoalOwnershipV4(database: DatabaseSync): void {
  const foreignKeyRow = asRow(database.prepare('PRAGMA foreign_keys').get())
  const restoreForeignKeys = Boolean(foreignKeyRow && rowNumber(foreignKeyRow, 'foreign_keys'))

  // Foreign keys must be disabled before BEGIN. Dropping the old parent table while they are
  // enabled performs an implicit delete and would cascade into durable goal history.
  database.exec('PRAGMA foreign_keys = OFF')
  try {
    withTransaction(database, () => {
      const before = {
        goals: rowNumber(
          asRow(database.prepare('SELECT COUNT(*) AS count FROM goals').get()) ?? {},
          'count',
        ),
        plans: rowNumber(
          asRow(database.prepare('SELECT COUNT(*) AS count FROM goal_plan_revisions').get()) ?? {},
          'count',
        ),
        checkpoints: rowNumber(
          asRow(database.prepare('SELECT COUNT(*) AS count FROM goal_checkpoints').get()) ?? {},
          'count',
        ),
      }

      database.exec(`
        CREATE TABLE goals_v4 (
          id TEXT PRIMARY KEY,
          conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          workspace_path TEXT,
          objective TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('active', 'paused', 'blocked', 'completed', 'cleared')
          ),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          plan_revision INTEGER NOT NULL DEFAULT 0 CHECK (plan_revision >= 0),
          progress_summary TEXT NOT NULL DEFAULT '',
          blocked_summary TEXT,
          completion_summary TEXT,
          token_budget INTEGER CHECK (
            token_budget IS NULL OR (token_budget >= 1 AND token_budget <= 9007199254740991)
          ),
          used_tokens INTEGER NOT NULL DEFAULT 0 CHECK (
            used_tokens >= 0 AND used_tokens <= 9007199254740991
          ),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER,
          cleared_at INTEGER,
          CHECK (status != 'blocked' OR blocked_summary IS NOT NULL),
          CHECK (status != 'completed' OR completion_summary IS NOT NULL),
          CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
          CHECK ((status = 'cleared') = (cleared_at IS NOT NULL))
        ) STRICT;

        INSERT INTO goals_v4
          (id, conversation_id, workspace_path, objective, status, revision, plan_revision,
           progress_summary, blocked_summary, completion_summary, token_budget, used_tokens,
           created_at, updated_at, completed_at, cleared_at)
        SELECT g.id, g.conversation_id, c.workspace_path, g.objective, g.status, g.revision,
               g.plan_revision, g.progress_summary, g.blocked_summary, g.completion_summary,
               g.token_budget, g.used_tokens, g.created_at, g.updated_at, g.completed_at,
               g.cleared_at
        FROM goals AS g
        LEFT JOIN conversations AS c ON c.id = g.conversation_id;

        CREATE TABLE goal_plan_revisions_v4 (
          goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          goal_revision INTEGER NOT NULL CHECK (goal_revision >= 1),
          run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
          explanation TEXT NOT NULL DEFAULT '',
          items_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (goal_id, revision)
        ) STRICT;

        INSERT INTO goal_plan_revisions_v4
          (goal_id, revision, goal_revision, run_id, explanation, items_json, created_at)
        SELECT goal_id, revision, goal_revision, run_id, explanation, items_json, created_at
        FROM goal_plan_revisions;

        CREATE TABLE goal_checkpoints_v4 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
          goal_revision INTEGER NOT NULL CHECK (goal_revision >= 1),
          plan_revision INTEGER NOT NULL CHECK (plan_revision >= 0),
          run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
          subagent_run_id TEXT REFERENCES subagent_runs(id) ON DELETE SET NULL,
          status TEXT NOT NULL CHECK (
            status IN ('active', 'paused', 'blocked', 'completed', 'cleared')
          ),
          summary TEXT NOT NULL,
          used_tokens INTEGER NOT NULL CHECK (
            used_tokens >= 0 AND used_tokens <= 9007199254740991
          ),
          created_at INTEGER NOT NULL
        ) STRICT;

        INSERT INTO goal_checkpoints_v4
          (id, goal_id, goal_revision, plan_revision, run_id, subagent_run_id, status,
           summary, used_tokens, created_at)
        SELECT id, goal_id, goal_revision, plan_revision, run_id, subagent_run_id, status,
               summary, used_tokens, created_at
        FROM goal_checkpoints;
      `)

      const copied = {
        goals: rowNumber(
          asRow(database.prepare('SELECT COUNT(*) AS count FROM goals_v4').get()) ?? {},
          'count',
        ),
        plans: rowNumber(
          asRow(database.prepare('SELECT COUNT(*) AS count FROM goal_plan_revisions_v4').get()) ??
            {},
          'count',
        ),
        checkpoints: rowNumber(
          asRow(database.prepare('SELECT COUNT(*) AS count FROM goal_checkpoints_v4').get()) ?? {},
          'count',
        ),
      }
      if (
        copied.goals !== before.goals ||
        copied.plans !== before.plans ||
        copied.checkpoints !== before.checkpoints
      ) {
        throw new ConversationRepositoryError(
          'CORRUPT',
          'Goal ownership migration did not preserve every durable record.',
        )
      }

      database.exec(`
        DROP TRIGGER goal_checkpoints_immutable;
        DROP TRIGGER goal_plan_revisions_immutable;
        DROP TABLE goal_checkpoints;
        DROP TABLE goal_plan_revisions;
        DROP TABLE goals;

        ALTER TABLE goals_v4 RENAME TO goals;
        ALTER TABLE goal_plan_revisions_v4 RENAME TO goal_plan_revisions;
        ALTER TABLE goal_checkpoints_v4 RENAME TO goal_checkpoints;

        CREATE INDEX goals_workspace_updated
          ON goals(workspace_path, updated_at DESC, id DESC);
        CREATE INDEX goals_conversation_updated
          ON goals(conversation_id, updated_at DESC);
        CREATE INDEX goal_plans_created
          ON goal_plan_revisions(goal_id, created_at DESC);
        CREATE INDEX goal_checkpoints_created
          ON goal_checkpoints(goal_id, created_at DESC, id DESC);

        CREATE TRIGGER goal_plan_revisions_immutable
        BEFORE UPDATE ON goal_plan_revisions
        WHEN NOT (
          NEW.goal_id IS OLD.goal_id AND
          NEW.revision IS OLD.revision AND
          NEW.goal_revision IS OLD.goal_revision AND
          (NEW.run_id IS OLD.run_id OR (OLD.run_id IS NOT NULL AND NEW.run_id IS NULL)) AND
          NEW.explanation IS OLD.explanation AND
          NEW.items_json IS OLD.items_json AND
          NEW.created_at IS OLD.created_at
        )
        BEGIN
          SELECT RAISE(ABORT, 'goal plan revisions are immutable');
        END;

        CREATE TRIGGER goal_checkpoints_immutable
        BEFORE UPDATE ON goal_checkpoints
        WHEN NOT (
          NEW.id IS OLD.id AND
          NEW.goal_id IS OLD.goal_id AND
          NEW.goal_revision IS OLD.goal_revision AND
          NEW.plan_revision IS OLD.plan_revision AND
          (NEW.run_id IS OLD.run_id OR (OLD.run_id IS NOT NULL AND NEW.run_id IS NULL)) AND
          (
            NEW.subagent_run_id IS OLD.subagent_run_id OR
            (OLD.subagent_run_id IS NOT NULL AND NEW.subagent_run_id IS NULL)
          ) AND
          NEW.status IS OLD.status AND
          NEW.summary IS OLD.summary AND
          NEW.used_tokens IS OLD.used_tokens AND
          NEW.created_at IS OLD.created_at
        )
        BEGIN
          SELECT RAISE(ABORT, 'goal checkpoints are immutable');
        END;
      `)

      const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all()
      if (foreignKeyViolations.length > 0) {
        throw new ConversationRepositoryError(
          'CORRUPT',
          'Goal ownership migration produced invalid foreign-key references.',
        )
      }
      database.exec('PRAGMA user_version = 4')
    })
  } finally {
    database.exec(`PRAGMA foreign_keys = ${restoreForeignKeys ? 'ON' : 'OFF'}`)
  }
}

function migrateRunSnapshotsV5(database: DatabaseSync): void {
  const foreignKeyRow = asRow(database.prepare('PRAGMA foreign_keys').get())
  const restoreForeignKeys = Boolean(foreignKeyRow && rowNumber(foreignKeyRow, 'foreign_keys'))

  // runs is referenced by audit, goal history, and subagent rows. Rebuild it with foreign keys
  // disabled outside the transaction so the old parent can be replaced without cascading data.
  database.exec('PRAGMA foreign_keys = OFF')
  try {
    withTransaction(database, () => {
      const before = rowNumber(
        asRow(database.prepare('SELECT COUNT(*) AS count FROM runs').get()) ?? {},
        'count',
      )
      database.exec(`
        CREATE TABLE runs_v5 (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
          provider_id TEXT,
          model_id TEXT,
          intent TEXT NOT NULL CHECK (intent IN ('answer', 'plan', 'act')),
          trigger_provider_id TEXT NOT NULL,
          trigger_type TEXT NOT NULL,
          trigger_dedupe_key TEXT NOT NULL,
          policy_id TEXT NOT NULL,
          attempt INTEGER NOT NULL CHECK (attempt >= 1 AND attempt <= 9007199254740991),
          input_tokens INTEGER NOT NULL CHECK (
            input_tokens >= 0 AND input_tokens <= 9007199254740991
          ),
          output_tokens INTEGER NOT NULL CHECK (
            output_tokens >= 0 AND output_tokens <= 9007199254740991
          ),
          reasoning_tokens INTEGER NOT NULL CHECK (
            reasoning_tokens >= 0 AND reasoning_tokens <= 9007199254740991
          ),
          total_tokens INTEGER NOT NULL CHECK (
            total_tokens >= 0 AND total_tokens <= 9007199254740991
          ),
          outcome_summary TEXT,
          status TEXT NOT NULL CHECK (
            status IN ('running', 'completed', 'cancelled', 'error', 'interrupted')
          ),
          error TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER
        ) STRICT;
      `)
      database
        .prepare(
          `INSERT INTO runs_v5
            (id, conversation_id, goal_id, provider_id, model_id, intent,
             trigger_provider_id, trigger_type, trigger_dedupe_key, policy_id, attempt,
             input_tokens, output_tokens, reasoning_tokens, total_tokens, outcome_summary,
             status, error, started_at, finished_at)
           SELECT id, conversation_id, NULL, provider_id, model_id, ?, ?, ?, id, ?, 1,
                  0, 0, 0, 0, NULL, status, error, started_at, finished_at
           FROM runs`,
        )
        .run(
          'act',
          DEFAULT_RUN_TRIGGER_PROVIDER_ID,
          DEFAULT_RUN_TRIGGER_TYPE,
          DEFAULT_ACT_POLICY_ID,
        )
      const copied = rowNumber(
        asRow(database.prepare('SELECT COUNT(*) AS count FROM runs_v5').get()) ?? {},
        'count',
      )
      if (copied !== before) {
        throw new ConversationRepositoryError(
          'CORRUPT',
          'Run snapshot migration did not preserve every run record.',
        )
      }

      database.exec(`
        DROP TABLE runs;
        ALTER TABLE runs_v5 RENAME TO runs;

        CREATE INDEX runs_conversation_started
          ON runs(conversation_id, started_at);
        CREATE INDEX runs_goal_started
          ON runs(goal_id, started_at DESC, id DESC);
      `)
      const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all()
      if (foreignKeyViolations.length > 0) {
        throw new ConversationRepositoryError(
          'CORRUPT',
          'Run snapshot migration produced invalid foreign-key references.',
        )
      }
      database.exec('PRAGMA user_version = 5')
    })
  } finally {
    database.exec(`PRAGMA foreign_keys = ${restoreForeignKeys ? 'ON' : 'OFF'}`)
  }
}

function chmodPrivate(path: string): void {
  if (process.platform === 'win32' || !existsSync(path)) return
  chmodSync(path, 0o600)
}

function configureDatabase(database: DatabaseSync, path: string): void {
  chmodPrivate(path)
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = NORMAL')
  database.exec('PRAGMA busy_timeout = 5000')
  database.exec('PRAGMA trusted_schema = OFF')
  migrate(database)
  const quickCheck = asRow(database.prepare('PRAGMA quick_check').get())
  if (!quickCheck || rowString(quickCheck, 'quick_check') !== 'ok') {
    throw new ConversationRepositoryError(
      'CORRUPT',
      'The conversation database failed its integrity check.',
    )
  }
  chmodPrivate(path)
  chmodPrivate(`${path}-wal`)
  chmodPrivate(`${path}-shm`)
}

function isDatabaseCorruption(error: unknown): boolean {
  if (error instanceof ConversationRepositoryError) return error.code === 'CORRUPT'
  if (!error || typeof error !== 'object') return false
  const candidate = error as { errcode?: unknown; errstr?: unknown }
  return (
    candidate.errcode === 11 ||
    candidate.errcode === 26 ||
    (typeof candidate.errstr === 'string' &&
      /\b(?:corrupt|malformed|not a database)\b/i.test(candidate.errstr))
  )
}

export interface ConversationRecoveryNotice {
  type: 'conversation-database-quarantined'
  backupPath: string
}

function openDatabaseWithRecovery(path: string): {
  database: DatabaseSync
  recoveryNotice: ConversationRecoveryNotice | null
} {
  let database: DatabaseSync | null = null
  try {
    database = new DatabaseSync(path)
    configureDatabase(database, path)
    return { database, recoveryNotice: null }
  } catch (error) {
    database?.close()
    if (error instanceof ConversationRepositoryError && error.code === 'SCHEMA_TOO_NEW') {
      throw error
    }
    if (!isDatabaseCorruption(error)) throw error
    if (!existsSync(path)) throw error

    const suffix = `corrupt-${Date.now().toString()}-${randomUUID()}`
    const backupPath = `${path}.${suffix}`
    try {
      renameSync(path, backupPath)
      chmodPrivate(backupPath)
      for (const sidecar of ['-wal', '-shm']) {
        const sidecarPath = path + sidecar
        if (existsSync(sidecarPath)) {
          const backupSidecarPath = backupPath + sidecar
          renameSync(sidecarPath, backupSidecarPath)
          chmodPrivate(backupSidecarPath)
        }
      }
    } catch (backupError) {
      throw new ConversationRepositoryError(
        'INVALID_STATE',
        'The damaged conversation database could not be quarantined.',
        { cause: new AggregateError([error, backupError]) },
      )
    }

    const replacement = new DatabaseSync(path)
    try {
      configureDatabase(replacement, path)
      return {
        database: replacement,
        recoveryNotice: { type: 'conversation-database-quarantined', backupPath },
      }
    } catch (replacementError) {
      replacement.close()
      throw replacementError
    }
  }
}

function insertAuditEvent(
  database: DatabaseSync,
  now: () => number,
  input: AppendAuditEventInput,
): AuditEventRecord {
  const record = assertRecord(input, 'audit event', [
    'conversationId',
    'runId',
    'type',
    'summary',
    'metadata',
  ])
  let conversationId =
    record.conversationId === undefined
      ? null
      : nullableString(record.conversationId, 'conversationId', LIMITS.id)
  const runId = record.runId === undefined ? null : nullableString(record.runId, 'runId', LIMITS.id)

  if (runId) {
    const run = asRow(database.prepare('SELECT conversation_id FROM runs WHERE id = ?').get(runId))
    if (!run) {
      throw new ConversationRepositoryError('NOT_FOUND', `Run not found: ${runId}`)
    }
    const runConversationId = rowString(run, 'conversation_id')
    if (conversationId && conversationId !== runConversationId) {
      return invalid('conversationId does not match the run conversation.')
    }
    conversationId = runConversationId
  } else if (conversationId) {
    const exists = database
      .prepare('SELECT 1 AS present FROM conversations WHERE id = ?')
      .get(conversationId)
    if (!exists) {
      throw new ConversationRepositoryError(
        'NOT_FOUND',
        `Conversation not found: ${conversationId}`,
      )
    }
  }

  const type = boundedString(record.type, 'type', LIMITS.auditType)
  const summary = redactText(
    boundedString(record.summary, 'summary', LIMITS.auditSummary, { empty: true, trim: false }),
  )
  const metadata = serializeMetadata(record.metadata)
  const createdAt = now()
  const result = database
    .prepare(
      `INSERT INTO audit_events
        (conversation_id, run_id, event_type, summary, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(conversationId, runId, type, summary, metadata, createdAt)
  const id = Number(result.lastInsertRowid)
  const row = asRow(database.prepare('SELECT * FROM audit_events WHERE id = ?').get(id))
  if (!row) throw new ConversationRepositoryError('INVALID_STATE', 'Audit insert failed.')
  return toAuditEvent(row)
}

/**
 * Transactional run lifecycle and append-only audit facade. It is owned by a
 * ConversationRepository so both use one SQLite connection and one foreign-key domain.
 */
export class RunJournal {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => number,
    private readonly assertOpen: () => void,
  ) {}

  startRun(input: StartRunInput): RunRecord {
    this.assertOpen()
    const record = assertRecord(input, 'run', [
      'id',
      'conversationId',
      'goalId',
      'providerId',
      'modelId',
      'intent',
      'trigger',
      'policyId',
      'attempt',
    ])
    const id = record.id === undefined ? randomUUID() : boundedString(record.id, 'id', LIMITS.id)
    const conversationId = boundedString(record.conversationId, 'conversationId', LIMITS.id)
    const goalId =
      record.goalId === undefined || record.goalId === null
        ? null
        : nullableString(record.goalId, 'goalId', LIMITS.id)
    const providerId =
      record.providerId === undefined
        ? null
        : nullableString(record.providerId, 'providerId', LIMITS.providerId)
    const modelId =
      record.modelId === undefined
        ? null
        : nullableString(record.modelId, 'modelId', LIMITS.modelId)
    const intent =
      record.intent === undefined ? 'act' : enumValue(record.intent, 'intent', RUN_INTENTS)
    const trigger =
      record.trigger === undefined ? defaultRunTrigger(id) : validateRunTrigger(record.trigger)
    const policyId =
      record.policyId === undefined
        ? defaultRunPolicyId(intent)
        : boundedString(record.policyId, 'policyId', LIMITS.runPolicyId)
    const attempt =
      record.attempt === undefined
        ? 1
        : positiveInteger(record.attempt, 'attempt', Number.MAX_SAFE_INTEGER)
    const startedAt = this.now()

    return withTransaction(this.database, () => {
      const conversation = asRow(
        this.database
          .prepare('SELECT workspace_path FROM conversations WHERE id = ?')
          .get(conversationId),
      )
      if (!conversation) {
        throw new ConversationRepositoryError(
          'NOT_FOUND',
          `Conversation not found: ${conversationId}`,
        )
      }
      if (goalId) {
        const goal = asRow(
          this.database
            .prepare('SELECT workspace_path, status FROM goals WHERE id = ?')
            .get(goalId),
        )
        if (!goal) throw new ConversationRepositoryError('NOT_FOUND', `Goal not found: ${goalId}`)
        if (
          rowNullableString(goal, 'workspace_path') !==
          rowNullableString(conversation, 'workspace_path')
        ) {
          return invalid('goalId belongs to a different workspace than the run conversation.')
        }
        if (rowString(goal, 'status') !== 'active') {
          throw new ConversationRepositoryError(
            'INVALID_STATE',
            'A Goal-linked run requires an active goal.',
          )
        }
      }
      try {
        this.database
          .prepare(
            `INSERT INTO runs
              (id, conversation_id, goal_id, provider_id, model_id, intent,
               trigger_provider_id, trigger_type, trigger_dedupe_key, policy_id, attempt,
               input_tokens, output_tokens, reasoning_tokens, total_tokens, outcome_summary,
               status, error, started_at, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL,
                     'running', NULL, ?, NULL)`,
          )
          .run(
            id,
            conversationId,
            goalId,
            providerId,
            modelId,
            intent,
            trigger.providerId,
            trigger.type,
            trigger.dedupeKey,
            policyId,
            attempt,
            startedAt,
          )
      } catch (error) {
        throw new ConversationRepositoryError('CONFLICT', `Run already exists: ${id}`, {
          cause: error,
        })
      }
      insertAuditEvent(this.database, this.now, {
        conversationId,
        runId: id,
        type: 'run.started',
        summary: 'Agent run started.',
        metadata: { goalId, providerId, modelId, intent, trigger, policyId, attempt },
      })
      const row = asRow(this.database.prepare('SELECT * FROM runs WHERE id = ?').get(id))
      if (!row) throw new ConversationRepositoryError('INVALID_STATE', 'Run insert failed.')
      return toRun(row)
    })
  }

  recordUsage(runIdValue: string, usageValue: RunUsageSnapshot): RunRecord {
    this.assertOpen()
    const runId = boundedString(runIdValue, 'runId', LIMITS.id)
    const usage = validateRunUsage(usageValue)
    return withTransaction(this.database, () => {
      const currentRow = asRow(this.database.prepare('SELECT * FROM runs WHERE id = ?').get(runId))
      if (!currentRow) {
        throw new ConversationRepositoryError('NOT_FOUND', `Run not found: ${runId}`)
      }
      const current = toRun(currentRow)
      if (current.status !== 'running') {
        if (sameRunUsage(current.usage, usage)) return current
        throw new ConversationRepositoryError(
          'INVALID_STATE',
          `Run ${runId} is already ${current.status}; usage cannot change.`,
        )
      }
      this.applyUsageSnapshot(current, usage)
      const row = asRow(this.database.prepare('SELECT * FROM runs WHERE id = ?').get(runId))
      if (!row) throw new ConversationRepositoryError('INVALID_STATE', 'Run usage update failed.')
      return toRun(row)
    })
  }

  finishRun(runIdValue: string, input: FinishRunInput): RunRecord {
    this.assertOpen()
    const runId = boundedString(runIdValue, 'runId', LIMITS.id)
    const record = assertRecord(input, 'run completion', [
      'status',
      'error',
      'usage',
      'outcomeSummary',
      'goalFinish',
    ])
    const status = enumValue(record.status, 'status', TERMINAL_RUN_STATUSES)
    const hasError = record.error !== undefined
    const error =
      record.error === undefined || record.error === null
        ? null
        : redactText(boundedString(record.error, 'error', LIMITS.error, { trim: false }))
    const usage = record.usage === undefined ? undefined : validateRunUsage(record.usage)
    const hasOutcomeSummary = record.outcomeSummary !== undefined
    const outcomeSummary =
      record.outcomeSummary === undefined || record.outcomeSummary === null
        ? null
        : redactText(
            boundedString(record.outcomeSummary, 'outcomeSummary', LIMITS.runOutcomeSummary, {
              trim: false,
            }),
          )
    const goalFinish =
      record.goalFinish === undefined
        ? null
        : (() => {
            const value = assertRecord(record.goalFinish, 'run goal finish', [
              'goalId',
              'expectedRevision',
              'status',
              'summary',
            ])
            return {
              goalId: boundedString(value.goalId, 'goalFinish.goalId', LIMITS.id),
              expectedRevision: positiveInteger(
                value.expectedRevision,
                'goalFinish.expectedRevision',
                Number.MAX_SAFE_INTEGER,
              ),
              status: enumValue(
                value.status,
                'goalFinish.status',
                new Set<GoalStatus>(['blocked', 'completed']),
              ) as 'blocked' | 'completed',
              summary: boundedString(value.summary, 'goalFinish.summary', LIMITS.goalSummary, {
                trim: false,
              }),
            }
          })()
    if (goalFinish && status !== 'completed') {
      return invalid('goalFinish requires a completed run.')
    }

    return withTransaction(this.database, () => {
      const currentRow = asRow(this.database.prepare('SELECT * FROM runs WHERE id = ?').get(runId))
      if (!currentRow) {
        throw new ConversationRepositoryError('NOT_FOUND', `Run not found: ${runId}`)
      }
      const current = toRun(currentRow)
      if (current.status !== 'running') {
        const goalFinishMatches =
          !goalFinish ||
          (current.goalId === goalFinish.goalId && this.goalFinishMatches(current.id, goalFinish))
        if (
          current.status === status &&
          (!hasError || current.error === error) &&
          (!usage || sameRunUsage(current.usage, usage)) &&
          (!hasOutcomeSummary || current.outcomeSummary === outcomeSummary) &&
          goalFinishMatches
        ) {
          return current
        }
        throw new ConversationRepositoryError(
          'INVALID_STATE',
          `Run ${runId} is already ${current.status} with a different terminal snapshot.`,
        )
      }

      const finishedAt = this.now()
      const finalUsage = usage ? assertRunUsageProgresses(current.usage, usage) : current.usage
      this.applyUsageSnapshot(current, finalUsage)
      const finalOutcomeSummary = hasOutcomeSummary ? outcomeSummary : current.outcomeSummary
      if (goalFinish) this.applyGoalFinish(current, goalFinish, finishedAt)
      this.database
        .prepare(
          `UPDATE runs
           SET status = ?, error = ?, input_tokens = ?, output_tokens = ?, reasoning_tokens = ?,
               total_tokens = ?, outcome_summary = ?, finished_at = ?
           WHERE id = ?`,
        )
        .run(
          status,
          error,
          finalUsage.inputTokens,
          finalUsage.outputTokens,
          finalUsage.reasoningTokens,
          finalUsage.totalTokens,
          finalOutcomeSummary,
          finishedAt,
          runId,
        )
      this.database
        .prepare(
          `UPDATE messages
           SET status = ?, error = COALESCE(?, error), updated_at = ?
           WHERE run_id = ? AND conversation_id = ? AND status IN ('starting', 'running')`,
        )
        .run(status, error, finishedAt, runId, current.conversationId)
      this.database
        .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(finishedAt, current.conversationId)
      insertAuditEvent(this.database, this.now, {
        conversationId: current.conversationId,
        runId,
        type: `run.${status}`,
        summary: `Agent run ${status}.`,
        metadata: { error, usage: finalUsage, outcomeSummary: finalOutcomeSummary },
      })
      const row = asRow(this.database.prepare('SELECT * FROM runs WHERE id = ?').get(runId))
      if (!row) throw new ConversationRepositoryError('INVALID_STATE', 'Run update failed.')
      return toRun(row)
    })
  }

  appendAuditEvent(input: AppendAuditEventInput): AuditEventRecord {
    this.assertOpen()
    return withTransaction(this.database, () => insertAuditEvent(this.database, this.now, input))
  }

  recoverInterruptedRuns(reason = 'Application exited before the run completed.'): RecoveryResult {
    this.assertOpen()
    const safeReason = redactText(
      boundedString(reason, 'reason', LIMITS.error, { empty: false, trim: false }),
    )
    return withTransaction(this.database, () => {
      const runRows = asRows(
        this.database
          .prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at, id")
          .all(),
      )
      const messageRows = asRows(
        this.database
          .prepare(
            `SELECT id, conversation_id, run_id FROM messages
             WHERE status IN ('starting', 'running')
             ORDER BY conversation_id, ordinal`,
          )
          .all(),
      )
      if (runRows.length === 0 && messageRows.length === 0) {
        return { runIds: [], messageIds: [] }
      }
      const recoveredAt = this.now()
      this.database
        .prepare(
          `UPDATE runs SET status = 'interrupted', error = COALESCE(error, ?), finished_at = ?
           WHERE status = 'running'`,
        )
        .run(safeReason, recoveredAt)
      this.database
        .prepare(
          `UPDATE messages SET status = 'interrupted', error = COALESCE(error, ?), updated_at = ?
           WHERE status IN ('starting', 'running')`,
        )
        .run(safeReason, recoveredAt)

      const touchedConversationIds = new Set<string>()
      for (const row of runRows) {
        const run = toRun(row)
        const runId = run.id
        const conversationId = run.conversationId
        touchedConversationIds.add(conversationId)
        this.appendInterruptedGoalRecoveryCheckpoint(run, safeReason, recoveredAt)
        insertAuditEvent(this.database, this.now, {
          conversationId,
          runId,
          type: 'run.interrupted',
          summary: 'Agent run recovered as interrupted.',
          metadata: { reason: safeReason },
        })
      }
      for (const row of messageRows) {
        const conversationId = rowString(row, 'conversation_id')
        touchedConversationIds.add(conversationId)
        if (rowNullableString(row, 'run_id')) continue
        insertAuditEvent(this.database, this.now, {
          conversationId,
          type: 'message.interrupted',
          summary: 'Unfinished assistant message recovered as interrupted.',
          metadata: { messageId: rowString(row, 'id'), reason: safeReason },
        })
      }
      const updateConversation = this.database.prepare(
        'UPDATE conversations SET updated_at = ? WHERE id = ?',
      )
      for (const conversationId of touchedConversationIds) {
        updateConversation.run(recoveredAt, conversationId)
      }
      return {
        runIds: runRows.map((row) => rowString(row, 'id')),
        messageIds: messageRows.map((row) => rowString(row, 'id')),
      }
    })
  }

  private appendInterruptedGoalRecoveryCheckpoint(
    run: RunRecord,
    safeReason: string,
    recoveredAt: number,
  ): void {
    if (!run.goalId) return
    if (
      this.database
        .prepare('SELECT 1 FROM goal_checkpoints WHERE goal_id = ? AND run_id = ? LIMIT 1')
        .get(run.goalId, run.id)
    ) {
      return
    }
    const goalRow = asRow(this.database.prepare('SELECT * FROM goals WHERE id = ?').get(run.goalId))
    if (!goalRow) return
    const goal = toGoal(goalRow)
    if (!OPEN_GOAL_STATUSES.has(goal.status)) return

    const evidence = interruptedGoalRecoveryEvidence(this.database, run, goal, safeReason)
    const nextRevision = goal.revision + 1
    if (!Number.isSafeInteger(nextRevision)) invalid('goal revision overflowed.')
    const update = this.database
      .prepare(
        `UPDATE goals SET revision = ?, progress_summary = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(nextRevision, evidence.summary, recoveredAt, goal.id, goal.revision)
    if (update.changes !== 1) {
      throw new ConversationRepositoryError(
        'CONFLICT',
        'Goal changed during interrupted run recovery.',
      )
    }
    const insert = this.database
      .prepare(
        `INSERT INTO goal_checkpoints
          (goal_id, goal_revision, plan_revision, run_id, subagent_run_id, status,
           summary, used_tokens, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        goal.id,
        nextRevision,
        goal.planRevision,
        run.id,
        goal.status,
        evidence.summary,
        goal.usedTokens,
        recoveredAt,
      )
    insertAuditEvent(this.database, this.now, {
      conversationId: run.conversationId,
      runId: run.id,
      type: 'goal.checkpoint.created',
      summary: 'Host recovery checkpoint recorded for an interrupted Goal run.',
      metadata: {
        goalId: goal.id,
        checkpointId: Number(insert.lastInsertRowid),
        goalRevision: nextRevision,
        planRevision: goal.planRevision,
        usedTokens: goal.usedTokens,
        hostOwned: true,
        recovery: 'interrupted-run',
        toolCount: evidence.toolCount,
        toolStatuses: evidence.toolStatuses,
        changedPaths: evidence.changedPaths,
        omittedChangedPathEntries: evidence.omittedChangedPathEntries,
      },
    })
  }

  private goalFinishMatches(
    runId: string,
    goalFinish: NonNullable<FinishRunInput['goalFinish']>,
  ): boolean {
    const row = asRow(
      this.database.prepare('SELECT * FROM goals WHERE id = ?').get(goalFinish.goalId),
    )
    if (!row) return false
    const goal = toGoal(row)
    const goalMatches =
      goal.status === goalFinish.status &&
      goal.revision === goalFinish.expectedRevision + 1 &&
      (goalFinish.status === 'completed'
        ? goal.completionSummary === goalFinish.summary
        : goal.blockedSummary === goalFinish.summary)
    if (!goalMatches) return false
    return asRows(
      this.database
        .prepare(
          `SELECT * FROM audit_events
           WHERE run_id = ? AND event_type = 'goal.updated'
           ORDER BY id DESC`,
        )
        .all(runId),
    )
      .map(toAuditEvent)
      .some((event) => {
        if (
          !event.metadata ||
          typeof event.metadata !== 'object' ||
          Array.isArray(event.metadata)
        ) {
          return false
        }
        return (
          event.summary === 'Goal finished with its run.' &&
          event.metadata.status === goalFinish.status &&
          event.metadata.revision === goalFinish.expectedRevision + 1
        )
      })
  }

  private applyGoalFinish(
    run: RunRecord,
    goalFinish: NonNullable<FinishRunInput['goalFinish']>,
    finishedAt: number,
  ): void {
    if (run.goalId !== goalFinish.goalId) {
      invalid('goalFinish does not belong to this run.')
    }
    const goalRow = asRow(
      this.database.prepare('SELECT * FROM goals WHERE id = ?').get(goalFinish.goalId),
    )
    if (!goalRow) {
      throw new ConversationRepositoryError('NOT_FOUND', `Goal not found: ${goalFinish.goalId}`)
    }
    const goal = toGoal(goalRow)
    if (goal.revision !== goalFinish.expectedRevision) {
      throw new ConversationRepositoryError(
        'CONFLICT',
        `Goal revision changed from ${goalFinish.expectedRevision} to ${goal.revision}.`,
      )
    }
    if (goal.status !== 'active') {
      throw new ConversationRepositoryError(
        'INVALID_STATE',
        'Only an active goal can be finished by a run.',
      )
    }
    if (!goalFinish.summary.trim()) invalid('goalFinish.summary cannot be blank.')
    if (goalFinish.status === 'completed') {
      const planRow = asRow(
        this.database
          .prepare('SELECT * FROM goal_plan_revisions WHERE goal_id = ? AND revision = ?')
          .get(goal.id, goal.planRevision),
      )
      const plan = planRow ? toGoalPlanRevision(planRow) : null
      if (
        !plan ||
        plan.items.length === 0 ||
        plan.items.some((item) => item.status !== 'completed')
      ) {
        throw new ConversationRepositoryError(
          'INVALID_STATE',
          'A completed goal requires a fully completed current plan.',
        )
      }
      const checkpointRow = asRow(
        this.database
          .prepare(
            `SELECT * FROM goal_checkpoints
             WHERE goal_id = ? AND run_id = ? AND plan_revision = ?
             ORDER BY id DESC LIMIT 1`,
          )
          .get(goal.id, run.id, plan.revision),
      )
      if (!checkpointRow) {
        throw new ConversationRepositoryError(
          'INVALID_STATE',
          'A completed goal requires a current-plan checkpoint from this run.',
        )
      }
    }

    const nextRevision = goal.revision + 1
    if (!Number.isSafeInteger(nextRevision)) invalid('goal revision overflowed.')
    const result = this.database
      .prepare(
        `UPDATE goals
         SET status = ?, revision = ?, blocked_summary = ?, completion_summary = ?,
             updated_at = ?, completed_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(
        goalFinish.status,
        nextRevision,
        goalFinish.status === 'blocked' ? goalFinish.summary : null,
        goalFinish.status === 'completed' ? goalFinish.summary : null,
        finishedAt,
        goalFinish.status === 'completed' ? finishedAt : null,
        goal.id,
        goal.revision,
      )
    if (result.changes !== 1) {
      throw new ConversationRepositoryError('CONFLICT', 'Goal changed during run completion.')
    }
    insertAuditEvent(this.database, this.now, {
      conversationId: run.conversationId,
      runId: run.id,
      type: 'goal.updated',
      summary: 'Goal finished with its run.',
      metadata: {
        goalId: goal.id,
        previousStatus: goal.status,
        status: goalFinish.status,
        revision: nextRevision,
      },
    })
  }

  private applyUsageSnapshot(current: RunRecord, next: RunUsageSnapshot): void {
    assertRunUsageProgresses(current.usage, next)
    if (sameRunUsage(current.usage, next)) return
    const totalTokenDelta = next.totalTokens - current.usage.totalTokens
    const updatedAt = this.now()
    if (current.goalId && totalTokenDelta > 0) {
      const goalRow = asRow(
        this.database.prepare('SELECT used_tokens FROM goals WHERE id = ?').get(current.goalId),
      )
      if (!goalRow) {
        throw new ConversationRepositoryError('NOT_FOUND', `Goal not found: ${current.goalId}`)
      }
      const usedTokens = rowNumber(goalRow, 'used_tokens') + totalTokenDelta
      if (!Number.isSafeInteger(usedTokens)) invalid('goal token usage overflowed.')
      this.database
        .prepare('UPDATE goals SET used_tokens = ?, updated_at = ? WHERE id = ?')
        .run(usedTokens, updatedAt, current.goalId)
    }
    this.database
      .prepare(
        `UPDATE runs
         SET input_tokens = ?, output_tokens = ?, reasoning_tokens = ?, total_tokens = ?
         WHERE id = ?`,
      )
      .run(next.inputTokens, next.outputTokens, next.reasoningTokens, next.totalTokens, current.id)
    insertAuditEvent(this.database, this.now, {
      conversationId: current.conversationId,
      runId: current.id,
      type: 'run.usage',
      summary: 'Token usage recorded.',
      metadata: next,
    })
  }
}

/** Durable, synchronous storage for conversations and their resumable UI state. */
export class ConversationRepository {
  private readonly database: DatabaseSync
  private readonly now: () => number
  private closed = false
  readonly runJournal: RunJournal
  readonly recoveryNotice: ConversationRecoveryNotice | null

  constructor(options: ConversationRepositoryOptions) {
    const path = databasePath(options)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(dirname(path), 0o700)
    const opened = openDatabaseWithRecovery(path)
    this.database = opened.database
    this.recoveryNotice = opened.recoveryNotice
    this.now = options.now ?? Date.now
    this.runJournal = new RunJournal(this.database, this.now, () => this.assertOpen())
  }

  ensureConversation(input: EnsureConversationInput): ConversationRecord {
    this.assertOpen()
    const record = assertRecord(input, 'conversation', [
      'id',
      'summary',
      'status',
      'providerId',
      'providerGeneration',
      'modelId',
      'workspacePath',
    ])
    const id = boundedString(record.id, 'id', LIMITS.id)
    const summary =
      record.summary === undefined
        ? undefined
        : boundedString(record.summary, 'summary', LIMITS.summary, {
            empty: true,
            trim: false,
          })
    const status =
      record.status === undefined
        ? undefined
        : enumValue(record.status, 'status', CONVERSATION_STATUSES)
    const providerId =
      record.providerId === undefined
        ? undefined
        : nullableString(record.providerId, 'providerId', LIMITS.providerId)
    const providerGeneration =
      record.providerGeneration === undefined
        ? undefined
        : record.providerGeneration === null
          ? null
          : positiveInteger(
              record.providerGeneration,
              'providerGeneration',
              Number.MAX_SAFE_INTEGER,
            )
    const modelId =
      record.modelId === undefined
        ? undefined
        : nullableString(record.modelId, 'modelId', LIMITS.modelId)
    const workspacePath =
      record.workspacePath === undefined
        ? undefined
        : nullableString(record.workspacePath, 'workspacePath', LIMITS.workspacePath)
    const updatedAt = this.now()

    return withTransaction(this.database, () => {
      const exists = this.database
        .prepare('SELECT 1 AS present FROM conversations WHERE id = ?')
        .get(id)
      if (!exists) {
        const initialStatus = status ?? 'active'
        this.database
          .prepare(
            `INSERT INTO conversations
              (id, summary, status, provider_id, provider_generation, model_id, workspace_path,
               created_at, updated_at, archived_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            summary ?? '',
            initialStatus,
            providerId ?? null,
            providerGeneration ?? null,
            modelId ?? null,
            workspacePath ?? null,
            updatedAt,
            updatedAt,
            initialStatus === 'archived' ? updatedAt : null,
          )
      } else {
        const assignments = ['updated_at = ?']
        const values: SQLInputValue[] = [updatedAt]
        if (summary !== undefined) {
          assignments.push('summary = ?')
          values.push(summary)
        }
        if (status !== undefined) {
          assignments.push('status = ?', 'archived_at = ?')
          values.push(status, status === 'archived' ? updatedAt : null)
        }
        if (providerId !== undefined) {
          assignments.push('provider_id = ?')
          values.push(providerId)
        }
        if (providerGeneration !== undefined) {
          assignments.push('provider_generation = ?')
          values.push(providerGeneration)
        }
        if (modelId !== undefined) {
          assignments.push('model_id = ?')
          values.push(modelId)
        }
        if (workspacePath !== undefined) {
          assignments.push('workspace_path = ?')
          values.push(workspacePath)
        }
        values.push(id)
        this.database
          .prepare(`UPDATE conversations SET ${assignments.join(', ')} WHERE id = ?`)
          .run(...values)
      }
      const result = this.getConversationRecord(id)
      if (!result) {
        throw new ConversationRepositoryError('INVALID_STATE', 'Conversation upsert failed.')
      }
      return result
    })
  }

  listConversations(filter: ConversationListFilter = {}): ConversationRecord[] {
    this.assertOpen()
    const record = assertRecord(filter, 'conversation filter', [
      'workspacePath',
      'archived',
      'search',
      'limit',
    ])
    const conditions: string[] = []
    const parameters: SQLInputValue[] = []
    if (record.workspacePath !== undefined) {
      const path = nullableString(record.workspacePath, 'workspacePath', LIMITS.workspacePath)
      conditions.push(path === null ? 'c.workspace_path IS NULL' : 'c.workspace_path = ?')
      if (path !== null) parameters.push(path)
    }
    if (record.archived !== undefined) {
      if (typeof record.archived !== 'boolean') return invalid('archived must be a boolean.')
      conditions.push(record.archived ? "c.status = 'archived'" : "c.status != 'archived'")
    }
    if (record.search !== undefined) {
      const search = boundedString(record.search, 'search', LIMITS.search)
      const escaped = `%${search.replace(/[\\%_]/g, '\\$&')}%`
      conditions.push(`(
        lower(c.summary) LIKE lower(?) ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM messages search_message
          WHERE search_message.conversation_id = c.id
            AND (
              lower(search_message.display_content) LIKE lower(?) ESCAPE '\\'
              OR lower(search_message.model_content) LIKE lower(?) ESCAPE '\\'
            )
        )
      )`)
      parameters.push(escaped, escaped, escaped)
    }
    const limit =
      record.limit === undefined ? 100 : positiveInteger(record.limit, 'limit', LIMITS.list)
    parameters.push(limit)
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = asRows(
      this.database
        .prepare(
          `SELECT c.*,
             (SELECT COUNT(*) FROM messages count_message WHERE count_message.conversation_id = c.id)
               AS message_count,
             (SELECT MAX(created_at) FROM messages last_message WHERE last_message.conversation_id = c.id)
               AS last_message_at
           FROM conversations c
           ${where}
           ORDER BY c.updated_at DESC, c.id ASC
           LIMIT ?`,
        )
        .all(...parameters),
    )
    return rows.map(toConversation)
  }

  getConversationMetadata(idValue: string): ConversationRecord | null {
    this.assertOpen()
    const id = boundedString(idValue, 'id', LIMITS.id)
    return this.getConversationRecord(id)
  }

  getConversation(idValue: string): ConversationDetail | null {
    this.assertOpen()
    const id = boundedString(idValue, 'id', LIMITS.id)
    const conversation = this.getConversationRecord(id)
    if (!conversation) return null
    const messages = asRows(
      this.database
        .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY ordinal ASC')
        .all(id),
    ).map(toMessage)
    const runs = asRows(
      this.database
        .prepare('SELECT * FROM runs WHERE conversation_id = ? ORDER BY started_at ASC, id ASC')
        .all(id),
    ).map(toRun)
    const auditEvents = asRows(
      this.database
        .prepare('SELECT * FROM audit_events WHERE conversation_id = ? ORDER BY id ASC')
        .all(id),
    ).map(toAuditEvent)
    return { ...conversation, messages, runs, auditEvents }
  }

  pendingMutationRefreshes(conversationIdValue: string): PendingMutationRefresh[] {
    this.assertOpen()
    const conversationId = boundedString(conversationIdValue, 'conversationId', LIMITS.id)
    const rows = asRows(
      this.database
        .prepare(
          `SELECT event_type, metadata_json
           FROM audit_events
           WHERE conversation_id = ?
             AND event_type IN ('tool.failed', 'mutation.refresh_required', 'mutation.refresh_completed')
           ORDER BY id ASC`,
        )
        .all(conversationId),
    )
    const pending = new Map<string, PendingMutationRefresh>()

    for (const row of rows) {
      const eventType = rowString(row, 'event_type')
      const metadata = auditMetadataRecord(safeMetadata(row.metadata_json))
      if (!metadata) continue
      if (eventType === 'mutation.refresh_completed') {
        if (validAuditPath(metadata.path)) pending.delete(metadata.path)
        continue
      }

      const source =
        eventType === 'tool.failed' ? auditMetadataRecord(metadata.failureDetails) : metadata
      if (!source) continue
      const failureCode = metadata.failureCode
      if (failureCode !== 'HASH_CONFLICT' && failureCode !== 'PATCH_CONFLICT') continue
      if (!validAuditPath(source.path)) continue
      if (typeof source.currentSha256 !== 'string' || !SHA256_PATTERN.test(source.currentSha256)) {
        continue
      }
      const currentSha256 = source.currentSha256.toLowerCase()
      pending.set(source.path, {
        path: source.path,
        failureCode,
        currentSha256,
      })
    }
    return [...pending.values()]
  }

  appendMessage(input: AppendMessageInput): ConversationMessageRecord {
    this.assertOpen()
    const record = assertRecord(input, 'message', [
      'id',
      'conversationId',
      'role',
      'displayContent',
      'modelContent',
      'contextPaths',
      'runId',
      'status',
      'error',
      'toolActivities',
    ])
    const id = record.id === undefined ? randomUUID() : boundedString(record.id, 'id', LIMITS.id)
    const conversationId = boundedString(record.conversationId, 'conversationId', LIMITS.id)
    const role = enumValue(record.role, 'role', MESSAGE_ROLES)
    const displayContent = boundedString(
      record.displayContent,
      'displayContent',
      LIMITS.messageContent,
      { empty: true, trim: false },
    )
    const modelContent =
      record.modelContent === undefined
        ? displayContent
        : boundedString(record.modelContent, 'modelContent', LIMITS.messageContent, {
            empty: true,
            trim: false,
          })
    const contextPaths =
      record.contextPaths === undefined ? [] : validateContextPaths(record.contextPaths)
    const runId =
      record.runId === undefined ? null : nullableString(record.runId, 'runId', LIMITS.id)
    const status =
      record.status === undefined
        ? role === 'user'
          ? 'completed'
          : 'starting'
        : enumValue(record.status, 'status', MESSAGE_STATUSES)
    const error =
      record.error === undefined || record.error === null
        ? null
        : redactText(boundedString(record.error, 'error', LIMITS.error, { trim: false }))
    const toolActivities =
      record.toolActivities === undefined ? [] : validateToolActivities(record.toolActivities)
    const timestamp = this.now()

    return withTransaction(this.database, () => {
      const conversation = this.database
        .prepare('SELECT 1 AS present FROM conversations WHERE id = ?')
        .get(conversationId)
      if (!conversation) {
        throw new ConversationRepositoryError(
          'NOT_FOUND',
          `Conversation not found: ${conversationId}`,
        )
      }
      if (runId) {
        const run = asRow(
          this.database.prepare('SELECT conversation_id FROM runs WHERE id = ?').get(runId),
        )
        if (!run) throw new ConversationRepositoryError('NOT_FOUND', `Run not found: ${runId}`)
        if (rowString(run, 'conversation_id') !== conversationId) {
          return invalid('runId belongs to a different conversation than the message.')
        }
      }
      const ordinalRow = asRow(
        this.database
          .prepare(
            'SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal FROM messages WHERE conversation_id = ?',
          )
          .get(conversationId),
      )
      const ordinal = ordinalRow ? rowNumber(ordinalRow, 'next_ordinal') : 1
      try {
        this.database
          .prepare(
            `INSERT INTO messages
              (id, conversation_id, role, display_content, model_content, context_paths_json,
               run_id, status, error, tool_activities_json, created_at, updated_at, ordinal)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            conversationId,
            role,
            displayContent,
            modelContent,
            JSON.stringify(contextPaths),
            runId,
            status,
            error,
            JSON.stringify(toolActivities),
            timestamp,
            timestamp,
            ordinal,
          )
      } catch (cause) {
        throw new ConversationRepositoryError('CONFLICT', `Message already exists: ${id}`, {
          cause,
        })
      }
      this.database
        .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(timestamp, conversationId)
      const row = asRow(this.database.prepare('SELECT * FROM messages WHERE id = ?').get(id))
      if (!row) throw new ConversationRepositoryError('INVALID_STATE', 'Message insert failed.')
      return toMessage(row)
    })
  }

  updateMessage(
    messageIdValue: string,
    patch: UpdateMessagePatch,
    ownership?: MessageOwnership,
  ): ConversationMessageRecord {
    this.assertOpen()
    const messageId = boundedString(messageIdValue, 'messageId', LIMITS.id)
    const record = assertRecord(patch, 'message patch', [
      'displayContent',
      'modelContent',
      'contextPaths',
      'runId',
      'status',
      'error',
      'toolActivities',
    ])
    const owner = ownership
      ? {
          conversationId: boundedString(
            ownership.conversationId,
            'ownership.conversationId',
            LIMITS.id,
          ),
          runId: boundedString(ownership.runId, 'ownership.runId', LIMITS.id),
          role: enumValue(ownership.role, 'ownership.role', MESSAGE_ROLES),
        }
      : null
    if (owner && record.runId !== undefined) {
      return invalid('an ownership-bound message update cannot change runId.')
    }
    if (Object.keys(record).length === 0) return invalid('message patch cannot be empty.')
    const assignments: string[] = []
    const values: SQLInputValue[] = []
    const patchedRunId =
      record.runId === undefined ? undefined : nullableString(record.runId, 'runId', LIMITS.id)
    if (record.displayContent !== undefined) {
      assignments.push('display_content = ?')
      values.push(
        boundedString(record.displayContent, 'displayContent', LIMITS.messageContent, {
          empty: true,
          trim: false,
        }),
      )
    }
    if (record.modelContent !== undefined) {
      assignments.push('model_content = ?')
      values.push(
        boundedString(record.modelContent, 'modelContent', LIMITS.messageContent, {
          empty: true,
          trim: false,
        }),
      )
    }
    if (record.contextPaths !== undefined) {
      assignments.push('context_paths_json = ?')
      values.push(JSON.stringify(validateContextPaths(record.contextPaths)))
    }
    if (record.runId !== undefined) {
      assignments.push('run_id = ?')
      values.push(patchedRunId ?? null)
    }
    if (record.status !== undefined) {
      assignments.push('status = ?')
      values.push(enumValue(record.status, 'status', MESSAGE_STATUSES))
    }
    if (record.error !== undefined) {
      assignments.push('error = ?')
      values.push(
        record.error === null
          ? null
          : redactText(boundedString(record.error, 'error', LIMITS.error, { trim: false })),
      )
    }
    if (record.toolActivities !== undefined) {
      assignments.push('tool_activities_json = ?')
      values.push(JSON.stringify(validateToolActivities(record.toolActivities)))
    }
    const updatedAt = this.now()
    assignments.push('updated_at = ?')
    values.push(updatedAt, messageId)
    const ownershipPredicate = owner ? ' AND conversation_id = ? AND run_id = ? AND role = ?' : ''
    if (owner) values.push(owner.conversationId, owner.runId, owner.role)

    return withTransaction(this.database, () => {
      const current = asRow(
        this.database.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(messageId),
      )
      if (!current) {
        throw new ConversationRepositoryError('NOT_FOUND', `Message not found: ${messageId}`)
      }
      if (patchedRunId) {
        const run = asRow(
          this.database.prepare('SELECT conversation_id FROM runs WHERE id = ?').get(patchedRunId),
        )
        if (!run) {
          throw new ConversationRepositoryError('NOT_FOUND', `Run not found: ${patchedRunId}`)
        }
        if (rowString(run, 'conversation_id') !== rowString(current, 'conversation_id')) {
          return invalid('runId belongs to a different conversation than the message.')
        }
      }
      const result = this.database
        .prepare(`UPDATE messages SET ${assignments.join(', ')} WHERE id = ?${ownershipPredicate}`)
        .run(...values)
      if (result.changes === 0) {
        throw new ConversationRepositoryError('NOT_FOUND', `Message not found: ${messageId}`)
      }
      const row = asRow(this.database.prepare('SELECT * FROM messages WHERE id = ?').get(messageId))
      if (!row) throw new ConversationRepositoryError('INVALID_STATE', 'Message update failed.')
      this.database
        .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(updatedAt, rowString(row, 'conversation_id'))
      return toMessage(row)
    })
  }

  initializeRun(input: InitializeRunInput): InitializedRun {
    this.assertOpen()
    const record = assertRecord(input, 'run initialization', [
      'conversation',
      'run',
      'userMessage',
      'assistantMessage',
    ])
    const run = record.run as InitializeRunInput['run']
    const conversation = record.conversation as InitializeRunInput['conversation']
    const userMessage = record.userMessage as InitializeRunInput['userMessage']
    const assistantMessage = record.assistantMessage as InitializeRunInput['assistantMessage']
    const runId = boundedString(run?.id, 'run.id', LIMITS.id)
    const conversationId = boundedString(run?.conversationId, 'run.conversationId', LIMITS.id)
    const userMessageId = boundedString(userMessage?.id, 'userMessage.id', LIMITS.id)
    const assistantMessageId = boundedString(assistantMessage?.id, 'assistantMessage.id', LIMITS.id)
    if (userMessageId === assistantMessageId) {
      return invalid('userMessage.id and assistantMessage.id must be distinct.')
    }
    if (
      userMessage.conversationId !== conversationId ||
      assistantMessage.conversationId !== conversationId ||
      userMessage.runId !== runId ||
      assistantMessage.runId !== runId ||
      userMessage.role !== 'user' ||
      assistantMessage.role !== 'assistant'
    ) {
      return invalid('run initialization messages must match the run owner and roles.')
    }

    return withTransaction(this.database, () => {
      const initializedConversation = this.ensureConversation(conversation)
      if (initializedConversation.id !== conversationId) {
        throw new ConversationRepositoryError(
          'INVALID_STATE',
          'Initialized conversation does not own the run.',
        )
      }
      return {
        run: this.runJournal.startRun(run),
        userMessage: this.appendMessage(userMessage),
        assistantMessage: this.appendMessage(assistantMessage),
      }
    })
  }

  startRun(input: StartRunInput): RunRecord {
    return this.runJournal.startRun(input)
  }

  recordRunUsage(runId: string, usage: RunUsageSnapshot): RunRecord {
    return this.runJournal.recordUsage(runId, usage)
  }

  finishRun(runId: string, input: FinishRunInput): RunRecord {
    return this.runJournal.finishRun(runId, input)
  }

  finishInterruptedWithHostSummary(
    runIdValue: string,
    input: FinishInterruptedWithHostSummaryInput,
  ): RunRecord {
    this.assertOpen()
    const runId = boundedString(runIdValue, 'runId', LIMITS.id)
    const record = assertRecord(input, 'interrupted host summary', [
      'conversationId',
      'assistantMessageId',
      'hostSummary',
      'error',
      'usage',
      'toolActivities',
      'auditType',
      'auditSummary',
      'auditMetadata',
    ])
    const conversationId = boundedString(record.conversationId, 'conversationId', LIMITS.id)
    const assistantMessageId = boundedString(
      record.assistantMessageId,
      'assistantMessageId',
      LIMITS.id,
    )
    const hostSummary = boundedString(record.hostSummary, 'hostSummary', LIMITS.messageContent, {
      trim: false,
    })
    const error = boundedString(record.error, 'error', LIMITS.error, { trim: false })
    const usage = record.usage === undefined ? undefined : validateRunUsage(record.usage)
    const toolActivities = validateToolActivities(record.toolActivities)
    const auditType = enumValue(
      record.auditType,
      'auditType',
      new Set<InterruptedHostSummaryAuditType>([
        'provider.post_effect_recovery_exhausted',
        'run.applied_effect_interrupted',
      ]),
    )
    const auditSummary = boundedString(record.auditSummary, 'auditSummary', LIMITS.auditSummary, {
      trim: false,
    })

    return withTransaction(this.database, () => {
      this.updateMessage(
        assistantMessageId,
        {
          displayContent: hostSummary,
          modelContent: hostSummary,
          toolActivities,
          error,
        },
        { conversationId, runId, role: 'assistant' },
      )
      const run = this.runJournal.finishRun(runId, {
        status: 'interrupted',
        error,
        ...(usage ? { usage } : {}),
      })
      this.runJournal.appendAuditEvent({
        conversationId,
        runId,
        type: auditType,
        summary: auditSummary,
        ...(record.auditMetadata === undefined ? {} : { metadata: record.auditMetadata }),
      })
      return run
    })
  }

  appendAuditEvent(input: AppendAuditEventInput): AuditEventRecord {
    return this.runJournal.appendAuditEvent(input)
  }

  recoverInterruptedRuns(reason?: string): RecoveryResult {
    return this.runJournal.recoverInterruptedRuns(reason)
  }

  createGoal(input: CreateGoalInput): GoalRecord {
    this.assertOpen()
    const record = assertRecord(input, 'goal', [
      'id',
      'conversationId',
      'originConversationId',
      'workspacePath',
      'objective',
      'status',
      'progressSummary',
      'blockedSummary',
      'completionSummary',
      'tokenBudget',
      'usedTokens',
    ])
    const id = record.id === undefined ? randomUUID() : boundedString(record.id, 'id', LIMITS.id)
    if (record.conversationId !== undefined && record.originConversationId !== undefined) {
      return invalid('Use either conversationId or originConversationId, not both.')
    }
    const originConversationIdValue =
      record.originConversationId === undefined
        ? record.conversationId
        : record.originConversationId
    const originConversationId =
      originConversationIdValue === undefined || originConversationIdValue === null
        ? null
        : nullableString(originConversationIdValue, 'originConversationId', LIMITS.id)
    const requestedWorkspacePath =
      record.workspacePath === undefined
        ? undefined
        : record.workspacePath === null
          ? null
          : boundedString(record.workspacePath, 'workspacePath', LIMITS.workspacePath, {
              trim: false,
            })
    if (!originConversationId && requestedWorkspacePath === undefined) {
      return invalid('workspacePath is required when no origin conversation is supplied.')
    }
    const objective = boundedString(record.objective, 'objective', LIMITS.goalObjective, {
      trim: false,
    })
    if (!objective.trim()) return invalid('objective cannot be blank.')
    const status =
      record.status === undefined ? 'active' : enumValue(record.status, 'status', GOAL_STATUSES)
    const progressSummary =
      record.progressSummary === undefined
        ? ''
        : boundedString(record.progressSummary, 'progressSummary', LIMITS.goalSummary, {
            empty: true,
            trim: false,
          })
    const blockedSummary =
      record.blockedSummary === undefined || record.blockedSummary === null
        ? null
        : nullableString(record.blockedSummary, 'blockedSummary', LIMITS.goalSummary)
    const completionSummary =
      record.completionSummary === undefined || record.completionSummary === null
        ? null
        : nullableString(record.completionSummary, 'completionSummary', LIMITS.goalSummary)
    if (status !== 'blocked' && blockedSummary) {
      return invalid('blockedSummary is only valid for a blocked goal.')
    }
    if (status !== 'completed' && completionSummary) {
      return invalid('completionSummary is only valid for a completed goal.')
    }
    assertGoalSummaries(status, blockedSummary, completionSummary)
    const tokenBudget =
      record.tokenBudget === undefined || record.tokenBudget === null
        ? null
        : positiveInteger(record.tokenBudget, 'tokenBudget', Number.MAX_SAFE_INTEGER)
    const usedTokens =
      record.usedTokens === undefined
        ? 0
        : nonNegativeInteger(record.usedTokens, 'usedTokens', Number.MAX_SAFE_INTEGER)
    const timestamp = this.now()

    return withTransaction(this.database, () => {
      let workspacePath = requestedWorkspacePath
      if (originConversationId) {
        const conversation = asRow(
          this.database
            .prepare('SELECT workspace_path FROM conversations WHERE id = ?')
            .get(originConversationId),
        )
        if (!conversation) {
          throw new ConversationRepositoryError(
            'NOT_FOUND',
            `Conversation not found: ${originConversationId}`,
          )
        }
        const originWorkspacePath = rowNullableString(conversation, 'workspace_path')
        if (workspacePath === undefined) workspacePath = originWorkspacePath
        else if (workspacePath !== originWorkspacePath) {
          return invalid('workspacePath does not match the origin conversation workspace.')
        }
      }
      if (workspacePath === undefined) return invalid('workspacePath could not be resolved.')
      try {
        this.database
          .prepare(
            `INSERT INTO goals
              (id, conversation_id, workspace_path, objective, status, revision, plan_revision,
               progress_summary, blocked_summary, completion_summary, token_budget, used_tokens,
               created_at, updated_at, completed_at, cleared_at)
             VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            originConversationId,
            workspacePath,
            objective,
            status,
            progressSummary,
            blockedSummary,
            completionSummary,
            tokenBudget,
            usedTokens,
            timestamp,
            timestamp,
            status === 'completed' ? timestamp : null,
            status === 'cleared' ? timestamp : null,
          )
      } catch (error) {
        throw new ConversationRepositoryError('CONFLICT', `Goal already exists: ${id}`, {
          cause: error,
        })
      }
      if (originConversationId) {
        this.database
          .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
          .run(timestamp, originConversationId)
      }
      insertAuditEvent(this.database, this.now, {
        ...(originConversationId ? { conversationId: originConversationId } : {}),
        type: 'goal.created',
        summary: 'Goal created.',
        metadata: { goalId: id, status, tokenBudget },
      })
      const row = asRow(this.database.prepare('SELECT * FROM goals WHERE id = ?').get(id))
      if (!row) throw new ConversationRepositoryError('INVALID_STATE', 'Goal insert failed.')
      return toGoal(row)
    })
  }

  getGoal(goalIdValue: string): GoalRecord | null {
    this.assertOpen()
    const goalId = boundedString(goalIdValue, 'goalId', LIMITS.id)
    const row = asRow(this.database.prepare('SELECT * FROM goals WHERE id = ?').get(goalId))
    return row ? toGoal(row) : null
  }

  /** @deprecated A conversation may have multiple open goals; use listGoals with a filter. */
  getOpenGoal(conversationIdValue: string): GoalRecord | null {
    this.assertOpen()
    const conversationId = boundedString(conversationIdValue, 'conversationId', LIMITS.id)
    const row = asRow(
      this.database
        .prepare(
          `SELECT * FROM goals
           WHERE conversation_id = ? AND status IN ('active', 'paused', 'blocked')
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(conversationId),
    )
    return row ? toGoal(row) : null
  }

  listGoals(conversationIdValue: string, options?: GoalListOptions): GoalRecord[]
  listGoals(filter?: GoalListFilter): GoalRecord[]
  listGoals(
    conversationIdOrFilter: string | GoalListFilter = {},
    legacyOptions: GoalListOptions = {},
  ): GoalRecord[] {
    this.assertOpen()
    const conditions: string[] = []
    const values: SQLInputValue[] = []
    let record: Record<string, unknown>
    if (typeof conversationIdOrFilter === 'string') {
      const conversationId = boundedString(conversationIdOrFilter, 'conversationId', LIMITS.id)
      record = assertRecord(legacyOptions, 'goal list options', ['limit'])
      conditions.push('conversation_id = ?')
      values.push(conversationId)
    } else {
      record = assertRecord(conversationIdOrFilter, 'goal list filter', [
        'workspacePath',
        'originConversationId',
        'statuses',
        'limit',
      ])
      if (record.workspacePath !== undefined) {
        if (record.workspacePath === null) conditions.push('workspace_path IS NULL')
        else {
          conditions.push('workspace_path = ?')
          values.push(
            boundedString(record.workspacePath, 'workspacePath', LIMITS.workspacePath, {
              trim: false,
            }),
          )
        }
      }
      if (record.originConversationId !== undefined) {
        if (record.originConversationId === null) conditions.push('conversation_id IS NULL')
        else {
          conditions.push('conversation_id = ?')
          values.push(boundedString(record.originConversationId, 'originConversationId', LIMITS.id))
        }
      }
      if (record.statuses !== undefined) {
        const statuses = validateGoalStatuses(record.statuses)
        conditions.push(`status IN (${statuses.map(() => '?').join(', ')})`)
        values.push(...statuses)
      }
    }
    const limit =
      record.limit === undefined ? 100 : positiveInteger(record.limit, 'limit', LIMITS.list)
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    return asRows(
      this.database
        .prepare(`SELECT * FROM goals${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...values, limit),
    ).map(toGoal)
  }

  updateGoal(goalIdValue: string, input: UpdateGoalInput): GoalRecord {
    this.assertOpen()
    const goalId = boundedString(goalIdValue, 'goalId', LIMITS.id)
    const record = assertRecord(input, 'goal update', [
      'expectedRevision',
      'objective',
      'status',
      'progressSummary',
      'blockedSummary',
      'completionSummary',
      'tokenBudget',
      'usedTokens',
    ])
    const expectedRevision = positiveInteger(
      record.expectedRevision,
      'expectedRevision',
      Number.MAX_SAFE_INTEGER,
    )
    if (Object.keys(record).length === 1) return invalid('goal update must change a field.')
    const timestamp = this.now()

    return withTransaction(this.database, () => {
      const row = asRow(this.database.prepare('SELECT * FROM goals WHERE id = ?').get(goalId))
      if (!row) throw new ConversationRepositoryError('NOT_FOUND', `Goal not found: ${goalId}`)
      const current = toGoal(row)
      if (current.revision !== expectedRevision) {
        throw new ConversationRepositoryError(
          'CONFLICT',
          `Goal revision changed from ${expectedRevision} to ${current.revision}.`,
        )
      }

      const objective =
        record.objective === undefined
          ? current.objective
          : boundedString(record.objective, 'objective', LIMITS.goalObjective, { trim: false })
      if (!objective.trim()) return invalid('objective cannot be blank.')
      if (
        (current.status === 'completed' || current.status === 'cleared') &&
        record.objective !== undefined &&
        objective !== current.objective
      ) {
        throw new ConversationRepositoryError(
          'INVALID_STATE',
          'A terminal goal objective cannot be edited.',
        )
      }
      const status =
        record.status === undefined
          ? current.status
          : enumValue(record.status, 'status', GOAL_STATUSES)
      assertGoalTransition(current.status, status)
      const progressSummary =
        record.progressSummary === undefined
          ? current.progressSummary
          : boundedString(record.progressSummary, 'progressSummary', LIMITS.goalSummary, {
              empty: true,
              trim: false,
            })
      let blockedSummary =
        record.blockedSummary === undefined
          ? current.blockedSummary
          : record.blockedSummary === null
            ? null
            : nullableString(record.blockedSummary, 'blockedSummary', LIMITS.goalSummary)
      let completionSummary =
        record.completionSummary === undefined
          ? current.completionSummary
          : record.completionSummary === null
            ? null
            : nullableString(record.completionSummary, 'completionSummary', LIMITS.goalSummary)
      if (status !== 'blocked') {
        if (record.blockedSummary !== undefined && blockedSummary) {
          return invalid('blockedSummary is only valid for a blocked goal.')
        }
        blockedSummary = null
      }
      if (status !== 'completed') {
        if (record.completionSummary !== undefined && completionSummary) {
          return invalid('completionSummary is only valid for a completed goal.')
        }
        completionSummary = null
      }
      assertGoalSummaries(status, blockedSummary, completionSummary)
      const tokenBudget =
        record.tokenBudget === undefined
          ? current.tokenBudget
          : record.tokenBudget === null
            ? null
            : positiveInteger(record.tokenBudget, 'tokenBudget', Number.MAX_SAFE_INTEGER)
      const usedTokens =
        record.usedTokens === undefined
          ? current.usedTokens
          : nonNegativeInteger(record.usedTokens, 'usedTokens', Number.MAX_SAFE_INTEGER)
      if (usedTokens < current.usedTokens) {
        return invalid('usedTokens cannot decrease.')
      }
      const nextRevision = current.revision + 1
      if (!Number.isSafeInteger(nextRevision)) return invalid('goal revision overflowed.')
      const result = this.database
        .prepare(
          `UPDATE goals
           SET objective = ?, status = ?, revision = ?, progress_summary = ?,
               blocked_summary = ?, completion_summary = ?, token_budget = ?, used_tokens = ?,
               updated_at = ?, completed_at = ?, cleared_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          objective,
          status,
          nextRevision,
          progressSummary,
          blockedSummary,
          completionSummary,
          tokenBudget,
          usedTokens,
          timestamp,
          status === 'completed' ? (current.completedAt ?? timestamp) : null,
          status === 'cleared' ? (current.clearedAt ?? timestamp) : null,
          goalId,
          expectedRevision,
        )
      if (result.changes !== 1) {
        throw new ConversationRepositoryError('CONFLICT', 'Goal changed during update.')
      }
      if (current.originConversationId) {
        this.database
          .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
          .run(timestamp, current.originConversationId)
      }
      insertAuditEvent(this.database, this.now, {
        ...(current.originConversationId ? { conversationId: current.originConversationId } : {}),
        type: 'goal.updated',
        summary: 'Goal updated.',
        metadata: {
          goalId,
          previousStatus: current.status,
          status,
          revision: nextRevision,
          usedTokens,
        },
      })
      const updated = asRow(this.database.prepare('SELECT * FROM goals WHERE id = ?').get(goalId))
      if (!updated) throw new ConversationRepositoryError('INVALID_STATE', 'Goal update failed.')
      return toGoal(updated)
    })
  }

  appendGoalPlan(input: AppendGoalPlanInput): GoalPlanRevisionRecord {
    this.assertOpen()
    const record = assertRecord(input, 'goal plan', [
      'goalId',
      'expectedGoalRevision',
      'runId',
      'explanation',
      'items',
    ])
    const goalId = boundedString(record.goalId, 'goalId', LIMITS.id)
    const expectedGoalRevision = positiveInteger(
      record.expectedGoalRevision,
      'expectedGoalRevision',
      Number.MAX_SAFE_INTEGER,
    )
    const runId =
      record.runId === undefined || record.runId === null
        ? null
        : nullableString(record.runId, 'runId', LIMITS.id)
    const explanation =
      record.explanation === undefined
        ? ''
        : boundedString(record.explanation, 'explanation', LIMITS.goalPlanExplanation, {
            empty: true,
            trim: false,
          })
    const items = validateGoalPlanItems(record.items)
    const timestamp = this.now()

    return withTransaction(this.database, () => {
      const goalRow = asRow(this.database.prepare('SELECT * FROM goals WHERE id = ?').get(goalId))
      if (!goalRow) {
        throw new ConversationRepositoryError('NOT_FOUND', `Goal not found: ${goalId}`)
      }
      const goal = toGoal(goalRow)
      if (goal.revision !== expectedGoalRevision) {
        throw new ConversationRepositoryError(
          'CONFLICT',
          `Goal revision changed from ${expectedGoalRevision} to ${goal.revision}.`,
        )
      }
      if (!OPEN_GOAL_STATUSES.has(goal.status)) {
        throw new ConversationRepositoryError(
          'INVALID_STATE',
          'A plan cannot be updated for a terminal goal.',
        )
      }
      if (runId) this.assertRunBelongsToGoalWorkspace(runId, goal)
      const revision = goal.planRevision + 1
      const goalRevision = goal.revision + 1
      if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(goalRevision)) {
        return invalid('goal plan revision overflowed.')
      }
      this.database
        .prepare(
          `INSERT INTO goal_plan_revisions
            (goal_id, revision, goal_revision, run_id, explanation, items_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(goalId, revision, goalRevision, runId, explanation, JSON.stringify(items), timestamp)
      const update = this.database
        .prepare(
          `UPDATE goals SET revision = ?, plan_revision = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(goalRevision, revision, timestamp, goalId, expectedGoalRevision)
      if (update.changes !== 1) {
        throw new ConversationRepositoryError('CONFLICT', 'Goal changed during plan update.')
      }
      if (goal.originConversationId) {
        this.database
          .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
          .run(timestamp, goal.originConversationId)
      }
      insertAuditEvent(this.database, this.now, {
        ...(runId
          ? { runId }
          : goal.originConversationId
            ? { conversationId: goal.originConversationId }
            : {}),
        type: 'goal.plan.updated',
        summary: 'Goal plan snapshot recorded.',
        metadata: {
          goalId,
          revision,
          goalRevision,
          itemCount: items.length,
          statuses: items.map((item) => item.status),
        },
      })
      const row = asRow(
        this.database
          .prepare('SELECT * FROM goal_plan_revisions WHERE goal_id = ? AND revision = ?')
          .get(goalId, revision),
      )
      if (!row) {
        throw new ConversationRepositoryError('INVALID_STATE', 'Goal plan insert failed.')
      }
      return toGoalPlanRevision(row)
    })
  }

  getCurrentGoalPlan(goalIdValue: string): GoalPlanRevisionRecord | null {
    this.assertOpen()
    const goalId = boundedString(goalIdValue, 'goalId', LIMITS.id)
    const goal = asRow(
      this.database.prepare('SELECT plan_revision FROM goals WHERE id = ?').get(goalId),
    )
    if (!goal) throw new ConversationRepositoryError('NOT_FOUND', `Goal not found: ${goalId}`)
    const revision = rowNumber(goal, 'plan_revision')
    if (revision === 0) return null
    const row = asRow(
      this.database
        .prepare('SELECT * FROM goal_plan_revisions WHERE goal_id = ? AND revision = ?')
        .get(goalId, revision),
    )
    if (!row) {
      throw new ConversationRepositoryError(
        'INVALID_STATE',
        'The current goal plan revision is missing.',
      )
    }
    return toGoalPlanRevision(row)
  }

  listGoalPlanRevisions(
    goalIdValue: string,
    options: GoalListOptions = {},
  ): GoalPlanRevisionRecord[] {
    this.assertOpen()
    const goalId = boundedString(goalIdValue, 'goalId', LIMITS.id)
    const record = assertRecord(options, 'goal plan list options', ['limit'])
    const limit =
      record.limit === undefined ? 100 : positiveInteger(record.limit, 'limit', LIMITS.list)
    if (!this.database.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId)) {
      throw new ConversationRepositoryError('NOT_FOUND', `Goal not found: ${goalId}`)
    }
    return asRows(
      this.database
        .prepare(
          `SELECT * FROM goal_plan_revisions
           WHERE goal_id = ? ORDER BY revision DESC LIMIT ?`,
        )
        .all(goalId, limit),
    ).map(toGoalPlanRevision)
  }

  appendGoalCheckpoint(input: AppendGoalCheckpointInput): GoalCheckpointRecord {
    this.assertOpen()
    const record = assertRecord(input, 'goal checkpoint', [
      'goalId',
      'expectedGoalRevision',
      'runId',
      'subagentRunId',
      'summary',
      'usedTokens',
    ])
    const goalId = boundedString(record.goalId, 'goalId', LIMITS.id)
    const expectedGoalRevision = positiveInteger(
      record.expectedGoalRevision,
      'expectedGoalRevision',
      Number.MAX_SAFE_INTEGER,
    )
    const runId =
      record.runId === undefined || record.runId === null
        ? null
        : nullableString(record.runId, 'runId', LIMITS.id)
    const subagentRunId =
      record.subagentRunId === undefined || record.subagentRunId === null
        ? null
        : nullableString(record.subagentRunId, 'subagentRunId', LIMITS.id)
    if (runId && subagentRunId) {
      return invalid('A checkpoint cannot reference both runId and subagentRunId.')
    }
    const summary = boundedString(record.summary, 'summary', LIMITS.goalSummary, {
      trim: false,
    })
    if (!summary.trim()) return invalid('summary cannot be blank.')
    const timestamp = this.now()

    return withTransaction(this.database, () => {
      const goalRow = asRow(this.database.prepare('SELECT * FROM goals WHERE id = ?').get(goalId))
      if (!goalRow) {
        throw new ConversationRepositoryError('NOT_FOUND', `Goal not found: ${goalId}`)
      }
      const goal = toGoal(goalRow)
      if (goal.revision !== expectedGoalRevision) {
        throw new ConversationRepositoryError(
          'CONFLICT',
          `Goal revision changed from ${expectedGoalRevision} to ${goal.revision}.`,
        )
      }
      if (!OPEN_GOAL_STATUSES.has(goal.status)) {
        throw new ConversationRepositoryError(
          'INVALID_STATE',
          'A checkpoint cannot update a terminal goal.',
        )
      }
      if (runId) this.assertRunBelongsToGoalWorkspace(runId, goal)
      if (subagentRunId) {
        const subagent = this.requireSubagentRun(subagentRunId)
        if (subagent.goalId !== goal.id) {
          return invalid('subagentRunId does not belong to the checkpoint goal.')
        }
      }
      const usedTokens =
        record.usedTokens === undefined
          ? goal.usedTokens
          : nonNegativeInteger(record.usedTokens, 'usedTokens', Number.MAX_SAFE_INTEGER)
      if (usedTokens < goal.usedTokens) return invalid('usedTokens cannot decrease.')
      const goalRevision = goal.revision + 1
      if (!Number.isSafeInteger(goalRevision)) return invalid('goal revision overflowed.')
      const update = this.database
        .prepare(
          `UPDATE goals SET revision = ?, progress_summary = ?, used_tokens = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(goalRevision, summary, usedTokens, timestamp, goalId, expectedGoalRevision)
      if (update.changes !== 1) {
        throw new ConversationRepositoryError('CONFLICT', 'Goal changed during checkpoint.')
      }
      const insert = this.database
        .prepare(
          `INSERT INTO goal_checkpoints
            (goal_id, goal_revision, plan_revision, run_id, subagent_run_id, status,
             summary, used_tokens, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          goalId,
          goalRevision,
          goal.planRevision,
          runId,
          subagentRunId,
          goal.status,
          summary,
          usedTokens,
          timestamp,
        )
      if (goal.originConversationId) {
        this.database
          .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
          .run(timestamp, goal.originConversationId)
      }
      insertAuditEvent(this.database, this.now, {
        ...(runId
          ? { runId }
          : goal.originConversationId
            ? { conversationId: goal.originConversationId }
            : {}),
        type: 'goal.checkpoint.created',
        summary: 'Goal checkpoint recorded.',
        metadata: {
          goalId,
          checkpointId: Number(insert.lastInsertRowid),
          goalRevision,
          planRevision: goal.planRevision,
          subagentRunId,
          usedTokens,
        },
      })
      const row = asRow(
        this.database
          .prepare('SELECT * FROM goal_checkpoints WHERE id = ?')
          .get(Number(insert.lastInsertRowid)),
      )
      if (!row) {
        throw new ConversationRepositoryError('INVALID_STATE', 'Goal checkpoint insert failed.')
      }
      return toGoalCheckpoint(row)
    })
  }

  listGoalCheckpoints(goalIdValue: string, options: GoalListOptions = {}): GoalCheckpointRecord[] {
    this.assertOpen()
    const goalId = boundedString(goalIdValue, 'goalId', LIMITS.id)
    const record = assertRecord(options, 'goal checkpoint list options', ['limit'])
    const limit =
      record.limit === undefined ? 100 : positiveInteger(record.limit, 'limit', LIMITS.list)
    if (!this.database.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId)) {
      throw new ConversationRepositoryError('NOT_FOUND', `Goal not found: ${goalId}`)
    }
    return asRows(
      this.database
        .prepare(
          `SELECT * FROM goal_checkpoints
           WHERE goal_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(goalId, limit),
    ).map(toGoalCheckpoint)
  }

  startSubagentRun(input: StartSubagentRunInput): SubagentRunRecord {
    this.assertOpen()
    const record = assertRecord(input, 'subagent run', [
      'id',
      'conversationId',
      'goalId',
      'originRunId',
      'parentSubagentRunId',
      'name',
      'task',
    ])
    const id = record.id === undefined ? randomUUID() : boundedString(record.id, 'id', LIMITS.id)
    const conversationId = boundedString(record.conversationId, 'conversationId', LIMITS.id)
    let goalId =
      record.goalId === undefined || record.goalId === null
        ? null
        : nullableString(record.goalId, 'goalId', LIMITS.id)
    const originRunId =
      record.originRunId === undefined || record.originRunId === null
        ? null
        : nullableString(record.originRunId, 'originRunId', LIMITS.id)
    const parentSubagentRunId =
      record.parentSubagentRunId === undefined || record.parentSubagentRunId === null
        ? null
        : nullableString(record.parentSubagentRunId, 'parentSubagentRunId', LIMITS.id)
    if (parentSubagentRunId === id) {
      return invalid('A subagent run cannot be its own parent.')
    }
    const name = boundedString(record.name, 'name', LIMITS.subagentName)
    const task = boundedString(record.task, 'task', LIMITS.subagentTask, { trim: false })
    if (!task.trim()) return invalid('task cannot be blank.')
    const timestamp = this.now()

    return withTransaction(this.database, () => {
      const conversation = asRow(
        this.database
          .prepare('SELECT status, workspace_path FROM conversations WHERE id = ?')
          .get(conversationId),
      )
      if (!conversation) {
        throw new ConversationRepositoryError(
          'NOT_FOUND',
          `Conversation not found: ${conversationId}`,
        )
      }
      if (rowString(conversation, 'status') !== 'active') {
        throw new ConversationRepositoryError(
          'INVALID_STATE',
          'Subagents cannot start in an archived conversation.',
        )
      }
      let parent: SubagentRunRecord | null = null
      if (parentSubagentRunId) {
        parent = this.requireSubagentRun(parentSubagentRunId)
        if (parent.conversationId !== conversationId) {
          return invalid('parentSubagentRunId belongs to a different conversation.')
        }
        if (parent.status !== 'running') {
          throw new ConversationRepositoryError(
            'INVALID_STATE',
            'A child subagent can only start under a running parent.',
          )
        }
        if (record.goalId === undefined) goalId = parent.goalId
        if (parent.goalId !== goalId) {
          return invalid('A child subagent must use the same goal as its parent.')
        }
      }
      if (goalId) {
        const goal = this.requireGoal(goalId)
        if (goal.workspacePath !== rowNullableString(conversation, 'workspace_path')) {
          return invalid('goalId belongs to a different workspace.')
        }
        if (goal.status !== 'active') {
          throw new ConversationRepositoryError(
            'INVALID_STATE',
            'A goal subagent can only start while its goal is active.',
          )
        }
      }
      if (originRunId) this.assertRunBelongsToConversation(originRunId, conversationId)
      try {
        this.database
          .prepare(
            `INSERT INTO subagent_runs
              (id, conversation_id, goal_id, origin_run_id, parent_subagent_run_id,
               name, task, status, result_summary, error, started_at, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)`,
          )
          .run(id, conversationId, goalId, originRunId, parentSubagentRunId, name, task, timestamp)
      } catch (error) {
        throw new ConversationRepositoryError('CONFLICT', `Subagent run already exists: ${id}`, {
          cause: error,
        })
      }
      this.database
        .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(timestamp, conversationId)
      insertAuditEvent(this.database, this.now, {
        conversationId,
        ...(originRunId ? { runId: originRunId } : {}),
        type: 'subagent.started',
        summary: 'Subagent run started.',
        metadata: { subagentRunId: id, goalId, parentSubagentRunId, name },
      })
      const row = asRow(this.database.prepare('SELECT * FROM subagent_runs WHERE id = ?').get(id))
      if (!row) {
        throw new ConversationRepositoryError('INVALID_STATE', 'Subagent run insert failed.')
      }
      return toSubagentRun(row)
    })
  }

  getSubagentRun(subagentRunIdValue: string): SubagentRunRecord | null {
    this.assertOpen()
    const subagentRunId = boundedString(subagentRunIdValue, 'subagentRunId', LIMITS.id)
    const row = asRow(
      this.database.prepare('SELECT * FROM subagent_runs WHERE id = ?').get(subagentRunId),
    )
    return row ? toSubagentRun(row) : null
  }

  finishSubagentRun(subagentRunIdValue: string, input: FinishSubagentRunInput): SubagentRunRecord {
    this.assertOpen()
    const subagentRunId = boundedString(subagentRunIdValue, 'subagentRunId', LIMITS.id)
    const record = assertRecord(input, 'subagent completion', ['status', 'resultSummary', 'error'])
    const status = enumValue(record.status, 'status', TERMINAL_SUBAGENT_RUN_STATUSES)
    const resultSummary =
      record.resultSummary === undefined || record.resultSummary === null
        ? null
        : nullableString(record.resultSummary, 'resultSummary', LIMITS.goalSummary)
    const error =
      record.error === undefined || record.error === null
        ? null
        : redactText(boundedString(record.error, 'error', LIMITS.error, { trim: false }))
    if (status === 'completed' && error)
      return invalid('A completed subagent cannot have an error.')
    if (status === 'error' && !error) return invalid('error is required when status is error.')
    const timestamp = this.now()

    return withTransaction(this.database, () => {
      const current = this.requireSubagentRun(subagentRunId)
      if (current.status !== 'running') {
        if (current.status === status) return current
        throw new ConversationRepositoryError(
          'INVALID_STATE',
          `Subagent run ${subagentRunId} is already ${current.status}.`,
        )
      }
      this.database
        .prepare(
          `UPDATE subagent_runs
           SET status = ?, result_summary = ?, error = ?, finished_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(status, resultSummary, error, timestamp, subagentRunId)
      this.database
        .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(timestamp, current.conversationId)
      insertAuditEvent(this.database, this.now, {
        conversationId: current.conversationId,
        ...(current.originRunId ? { runId: current.originRunId } : {}),
        type: `subagent.${status}`,
        summary: `Subagent run ${status}.`,
        metadata: { subagentRunId, goalId: current.goalId, error },
      })
      const row = asRow(
        this.database.prepare('SELECT * FROM subagent_runs WHERE id = ?').get(subagentRunId),
      )
      if (!row) {
        throw new ConversationRepositoryError('INVALID_STATE', 'Subagent run update failed.')
      }
      return toSubagentRun(row)
    })
  }

  listSubagentRuns(
    conversationIdValue: string,
    options: SubagentRunListOptions = {},
  ): SubagentRunRecord[] {
    this.assertOpen()
    const conversationId = boundedString(conversationIdValue, 'conversationId', LIMITS.id)
    const record = assertRecord(options, 'subagent list options', ['goalId', 'status', 'limit'])
    const goalId =
      record.goalId === undefined
        ? undefined
        : record.goalId === null
          ? null
          : nullableString(record.goalId, 'goalId', LIMITS.id)
    const status =
      record.status === undefined
        ? undefined
        : enumValue(record.status, 'status', SUBAGENT_RUN_STATUSES)
    const limit =
      record.limit === undefined ? 100 : positiveInteger(record.limit, 'limit', LIMITS.subagentList)
    const conditions = ['conversation_id = ?']
    const values: SQLInputValue[] = [conversationId]
    if (goalId !== undefined) {
      conditions.push(goalId === null ? 'goal_id IS NULL' : 'goal_id = ?')
      if (goalId !== null) values.push(goalId)
    }
    if (status !== undefined) {
      conditions.push('status = ?')
      values.push(status)
    }
    values.push(limit)
    return asRows(
      this.database
        .prepare(
          `SELECT * FROM subagent_runs WHERE ${conditions.join(' AND ')}
           ORDER BY started_at ASC, rowid ASC LIMIT ?`,
        )
        .all(...values),
    ).map(toSubagentRun)
  }

  recoverInterruptedSubagentRuns(
    reason = 'Application exited before the subagent completed.',
  ): SubagentRecoveryResult {
    this.assertOpen()
    const safeReason = redactText(boundedString(reason, 'reason', LIMITS.error, { trim: false }))
    const timestamp = this.now()
    return withTransaction(this.database, () => {
      const rows = asRows(
        this.database
          .prepare(
            `SELECT * FROM subagent_runs
             WHERE status = 'running' ORDER BY started_at ASC, rowid ASC`,
          )
          .all(),
      )
      if (rows.length === 0) return { runIds: [] }
      this.database
        .prepare(
          `UPDATE subagent_runs SET status = 'interrupted', error = COALESCE(error, ?),
           finished_at = ? WHERE status = 'running'`,
        )
        .run(safeReason, timestamp)
      const touchedConversations = new Set<string>()
      for (const row of rows) {
        const subagent = toSubagentRun(row)
        touchedConversations.add(subagent.conversationId)
        insertAuditEvent(this.database, this.now, {
          conversationId: subagent.conversationId,
          ...(subagent.originRunId ? { runId: subagent.originRunId } : {}),
          type: 'subagent.interrupted',
          summary: 'Subagent run recovered as interrupted.',
          metadata: {
            subagentRunId: subagent.id,
            goalId: subagent.goalId,
            reason: safeReason,
          },
        })
      }
      const updateConversation = this.database.prepare(
        'UPDATE conversations SET updated_at = ? WHERE id = ?',
      )
      for (const conversationId of touchedConversations) {
        updateConversation.run(timestamp, conversationId)
      }
      return { runIds: rows.map((row) => rowString(row, 'id')) }
    })
  }

  modelHistory(
    conversationIdValue: string,
    options: { limit?: number; maxCharacters?: number } = {},
  ): ModelHistoryMessage[] {
    this.assertOpen()
    const conversationId = boundedString(conversationIdValue, 'conversationId', LIMITS.id)
    const record = assertRecord(options, 'history options', ['limit', 'maxCharacters'])
    const limit =
      record.limit === undefined ? 200 : positiveInteger(record.limit, 'limit', LIMITS.history)
    const maxCharacters =
      record.maxCharacters === undefined
        ? null
        : positiveInteger(record.maxCharacters, 'maxCharacters', LIMITS.messageContent)
    const rows = asRows(
      maxCharacters === null
        ? this.database
            .prepare(
              `SELECT role, model_content FROM (
                 SELECT role, model_content, ordinal
                 FROM messages AS message
                 WHERE conversation_id = ?
                   AND model_content != ''
                   AND (
                     status = 'completed'
                     OR (
                       status = 'interrupted'
                       AND EXISTS (
                         SELECT 1 FROM audit_events AS audit
                         WHERE audit.run_id = message.run_id
                           AND audit.conversation_id = message.conversation_id
                           AND audit.event_type IN (
                             'provider.post_effect_recovery_exhausted',
                             'run.applied_effect_interrupted'
                           )
                       )
                       AND EXISTS (
                         SELECT 1 FROM messages AS host_summary
                         WHERE host_summary.run_id = message.run_id
                           AND host_summary.conversation_id = message.conversation_id
                           AND host_summary.role = 'assistant'
                           AND host_summary.status = 'interrupted'
                           AND host_summary.model_content != ''
                       )
                     )
                   )
                 ORDER BY ordinal DESC
                 LIMIT ?
               ) ORDER BY ordinal ASC`,
            )
            .all(conversationId, limit)
        : this.database
            .prepare(
              `SELECT role, model_content FROM (
                 SELECT role, model_content, ordinal,
                        SUM(length(model_content)) OVER (
                          ORDER BY ordinal DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                        ) AS cumulative_characters
                 FROM messages AS message
                 WHERE conversation_id = ?
                   AND model_content != ''
                   AND (
                     status = 'completed'
                     OR (
                       status = 'interrupted'
                       AND EXISTS (
                         SELECT 1 FROM audit_events AS audit
                         WHERE audit.run_id = message.run_id
                           AND audit.conversation_id = message.conversation_id
                           AND audit.event_type IN (
                             'provider.post_effect_recovery_exhausted',
                             'run.applied_effect_interrupted'
                           )
                       )
                       AND EXISTS (
                         SELECT 1 FROM messages AS host_summary
                         WHERE host_summary.run_id = message.run_id
                           AND host_summary.conversation_id = message.conversation_id
                           AND host_summary.role = 'assistant'
                           AND host_summary.status = 'interrupted'
                           AND host_summary.model_content != ''
                       )
                     )
                   )
               )
               WHERE cumulative_characters <= ?
               ORDER BY ordinal DESC
               LIMIT ?`,
            )
            .all(conversationId, maxCharacters, limit)
            .reverse(),
    )
    const history = rows.map((row) => ({
      role: rowString(row, 'role') as ConversationMessageRole,
      content: rowString(row, 'model_content'),
    }))
    while (history[0]?.role === 'assistant') history.shift()
    return history
  }

  archive(idValue: string, archived = true): ConversationRecord {
    this.assertOpen()
    const id = boundedString(idValue, 'id', LIMITS.id)
    if (typeof archived !== 'boolean') return invalid('archived must be a boolean.')
    const timestamp = this.now()
    return withTransaction(this.database, () => {
      const result = this.database
        .prepare(
          'UPDATE conversations SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(archived ? 'archived' : 'active', archived ? timestamp : null, timestamp, id)
      if (result.changes === 0) {
        throw new ConversationRepositoryError('NOT_FOUND', `Conversation not found: ${id}`)
      }
      const conversation = this.getConversationRecord(id)
      if (!conversation) {
        throw new ConversationRepositoryError('INVALID_STATE', 'Conversation archive failed.')
      }
      return conversation
    })
  }

  delete(idValue: string): boolean {
    this.assertOpen()
    const id = boundedString(idValue, 'id', LIMITS.id)
    return this.database.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0
  }

  fork(sourceConversationIdValue: string, input: ForkConversationInput = {}): ConversationDetail {
    this.assertOpen()
    const sourceConversationId = boundedString(
      sourceConversationIdValue,
      'sourceConversationId',
      LIMITS.id,
    )
    const record = assertRecord(input, 'fork input', ['id', 'summary', 'throughMessageId'])
    const targetId =
      record.id === undefined ? randomUUID() : boundedString(record.id, 'id', LIMITS.id)
    const summary =
      record.summary === undefined
        ? undefined
        : boundedString(record.summary, 'summary', LIMITS.summary, {
            empty: true,
            trim: false,
          })
    const throughMessageId =
      record.throughMessageId === undefined
        ? undefined
        : boundedString(record.throughMessageId, 'throughMessageId', LIMITS.id)
    const timestamp = this.now()

    withTransaction(this.database, () => {
      const source = this.getConversationRecord(sourceConversationId)
      if (!source) {
        throw new ConversationRepositoryError(
          'NOT_FOUND',
          `Conversation not found: ${sourceConversationId}`,
        )
      }
      if (this.getConversationRecord(targetId)) {
        throw new ConversationRepositoryError(
          'CONFLICT',
          `Conversation already exists: ${targetId}`,
        )
      }

      let maximumOrdinal: number | null = null
      if (throughMessageId) {
        const through = asRow(
          this.database
            .prepare('SELECT conversation_id, ordinal FROM messages WHERE id = ?')
            .get(throughMessageId),
        )
        if (!through || rowString(through, 'conversation_id') !== sourceConversationId) {
          throw new ConversationRepositoryError(
            'NOT_FOUND',
            `Fork message not found in conversation: ${throughMessageId}`,
          )
        }
        maximumOrdinal = rowNumber(through, 'ordinal')
      }

      this.database
        .prepare(
          `INSERT INTO conversations
            (id, summary, status, provider_id, provider_generation, model_id, workspace_path,
             created_at, updated_at, archived_at)
           VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          targetId,
          summary ?? source.summary,
          source.providerId,
          source.providerGeneration,
          source.modelId,
          source.workspacePath,
          timestamp,
          timestamp,
        )
      const sourceMessages = asRows(
        maximumOrdinal === null
          ? this.database
              .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY ordinal ASC')
              .all(sourceConversationId)
          : this.database
              .prepare(
                `SELECT * FROM messages
                 WHERE conversation_id = ? AND ordinal <= ? ORDER BY ordinal ASC`,
              )
              .all(sourceConversationId, maximumOrdinal),
      )
      const insertMessage = this.database.prepare(
        `INSERT INTO messages
          (id, conversation_id, role, display_content, model_content, context_paths_json,
           run_id, status, error, tool_activities_json, created_at, updated_at, ordinal)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      for (const row of sourceMessages) {
        const sourceMessage = toMessage(row)
        const sourceStatus = sourceMessage.status
        const status =
          sourceStatus === 'starting' || sourceStatus === 'running' ? 'interrupted' : sourceStatus
        insertMessage.run(
          randomUUID(),
          targetId,
          sourceMessage.role,
          sourceMessage.displayContent,
          sourceMessage.modelContent,
          JSON.stringify(sourceMessage.contextPaths),
          status,
          status === 'interrupted'
            ? (sourceMessage.error ?? 'Forked from an unfinished message.')
            : sourceMessage.error,
          JSON.stringify(sourceMessage.toolActivities),
          timestamp,
          timestamp,
          rowNumber(row, 'ordinal'),
        )
      }
      insertAuditEvent(this.database, this.now, {
        conversationId: targetId,
        type: 'conversation.forked',
        summary: 'Conversation forked.',
        metadata: {
          sourceConversationId,
          throughMessageId: throughMessageId ?? null,
        },
      })
    })

    const result = this.getConversation(targetId)
    if (!result) throw new ConversationRepositoryError('INVALID_STATE', 'Conversation fork failed.')
    return result
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ConversationRepositoryError('CLOSED', 'Conversation repository is closed.')
    }
  }

  private requireGoal(goalId: string): GoalRecord {
    const row = asRow(this.database.prepare('SELECT * FROM goals WHERE id = ?').get(goalId))
    if (!row) throw new ConversationRepositoryError('NOT_FOUND', `Goal not found: ${goalId}`)
    return toGoal(row)
  }

  private requireSubagentRun(subagentRunId: string): SubagentRunRecord {
    const row = asRow(
      this.database.prepare('SELECT * FROM subagent_runs WHERE id = ?').get(subagentRunId),
    )
    if (!row) {
      throw new ConversationRepositoryError('NOT_FOUND', `Subagent run not found: ${subagentRunId}`)
    }
    return toSubagentRun(row)
  }

  private assertRunBelongsToGoalWorkspace(runId: string, goal: GoalRecord): void {
    const row = asRow(
      this.database
        .prepare(
          `SELECT runs.goal_id, runs.status, conversations.workspace_path
           FROM runs
           JOIN conversations ON conversations.id = runs.conversation_id
           WHERE runs.id = ?`,
        )
        .get(runId),
    )
    if (!row) throw new ConversationRepositoryError('NOT_FOUND', `Run not found: ${runId}`)
    if (rowNullableString(row, 'workspace_path') !== goal.workspacePath) {
      invalid('runId belongs to a different goal workspace.')
    }
    if (rowNullableString(row, 'goal_id') !== goal.id) {
      invalid('runId is not attached to this goal.')
    }
    if (rowString(row, 'status') !== 'running') {
      throw new ConversationRepositoryError(
        'INVALID_STATE',
        'runId must still be running to record Goal evidence.',
      )
    }
  }

  private assertRunBelongsToConversation(runId: string, conversationId: string): void {
    const row = asRow(
      this.database.prepare('SELECT conversation_id FROM runs WHERE id = ?').get(runId),
    )
    if (!row) throw new ConversationRepositoryError('NOT_FOUND', `Run not found: ${runId}`)
    if (rowString(row, 'conversation_id') !== conversationId) {
      invalid('runId belongs to a different conversation.')
    }
  }

  private getConversationRecord(id: string): ConversationRecord | null {
    const row = asRow(
      this.database
        .prepare(
          `SELECT c.*,
             (SELECT COUNT(*) FROM messages count_message WHERE count_message.conversation_id = c.id)
               AS message_count,
             (SELECT MAX(created_at) FROM messages last_message WHERE last_message.conversation_id = c.id)
               AS last_message_at
           FROM conversations c WHERE c.id = ?`,
        )
        .get(id),
    )
    return row ? toConversation(row) : null
  }
}
