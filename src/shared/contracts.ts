import { z } from 'zod'

export const MAX_AGENT_MESSAGE_CHARACTERS = 100_000
export const MAX_PROVIDER_API_KEY_BYTES = 16_384
export const DEFAULT_AGENT_RUN_TIMEOUT_MINUTES = 15
export const MAX_AGENT_RUN_TIMEOUT_MINUTES = 60
export const DEFAULT_MAX_TOTAL_TOOL_CALLS = 100
export const MAX_TOTAL_TOOL_CALLS = 1_000
export const APP_LOCALES = ['ko', 'en'] as const
export const DEFAULT_APP_LOCALE = 'ko' as const satisfies (typeof APP_LOCALES)[number]
export const agentRunIntentSchema = z.enum(['answer', 'plan', 'act'])
export const appLocaleSchema = z.enum(APP_LOCALES)

export const providerUrlSchema = z
  .url()
  .max(2_048)
  .transform((value) => value.replace(/\/+$/, ''))
  .refine((value) => {
    const url = new URL(value)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    const secureTransport = url.protocol === 'https:' || (url.protocol === 'http:' && loopback)
    return secureTransport && !url.username && !url.password && !url.search && !url.hash
  }, '공급자 URL은 쿼리·자격 증명이 없는 HTTPS 또는 로컬 루프백 주소여야 합니다.')

export const providerInputSchema = z
  .object({
    id: z.string().trim().min(1).max(120).optional(),
    name: z.string().trim().min(1).max(80),
    baseUrl: providerUrlSchema,
    driverId: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]{0,79}$/)
      .optional(),
    // This is a coarse transport bound. SettingsStore enforces the authoritative UTF-8 byte limit.
    apiKey: z.string().trim().min(1).max(MAX_PROVIDER_API_KEY_BYTES).optional(),
    clearApiKey: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !(value.apiKey && value.clearApiKey), {
    message: 'API 키 입력과 저장된 키 제거를 동시에 요청할 수 없습니다.',
  })

export const providerIdSchema = z
  .object({
    providerId: z.string().trim().min(1).max(120),
  })
  .strict()

export const approvalModeSchema = z.enum(['manual', 'auto'])
export const approvalScopeSchema = z.enum(['goals-only', 'all-act-runs'])
export const fileChangeOperationSchema = z.enum(['create', 'update', 'delete'])

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

const workspaceBoundPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value === value.trim() && !value.includes('\0'), {
    message: 'Workspace paths must not contain surrounding whitespace or NUL characters.',
  })
  .refine((value) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value), {
    message: 'Workspace approval policies must be bound to an absolute canonical path.',
  })

const relativePolicyPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value === value.trim() && !containsControlCharacter(value), {
    message: 'Policy paths must not contain surrounding whitespace or control characters.',
  })
  .refine((value) => {
    if (value === '.') return true
    if (value.includes('\\') || value.startsWith('/') || value.endsWith('/')) return false
    if (/^[A-Za-z]:/.test(value) || value.includes('//')) return false
    return value
      .split('/')
      .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  }, 'Policy paths must be normalized workspace-relative prefixes, or "." for the workspace root.')

const absoluteExecutablePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value === value.trim() && !containsControlCharacter(value), {
    message: 'Executable paths must not contain surrounding whitespace or control characters.',
  })
  .refine((value) => {
    const normalized = value.replaceAll('\\', '/')
    let pathWithoutRoot: string
    if (normalized.startsWith('//')) {
      pathWithoutRoot = normalized.slice(2)
      if (pathWithoutRoot.split('/').length < 3) return false
    } else if (normalized.startsWith('/')) {
      pathWithoutRoot = normalized.slice(1)
    } else if (/^[A-Za-z]:\//.test(normalized)) {
      pathWithoutRoot = normalized.slice(3)
    } else {
      return false
    }
    const segments = pathWithoutRoot.split('/')
    return (
      segments.length > 0 &&
      segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    )
  }, 'Executables must be normalized absolute file paths without traversal segments.')

const uniqueStringArray = <T extends z.ZodType<string>>(schema: T, maximum: number) =>
  z
    .array(schema)
    .min(1)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, {
      message: 'Policy values must not contain duplicates.',
    })

export const fileChangeApprovalRuleSchema = z
  .object({
    pathPrefix: relativePolicyPathSchema,
    operations: uniqueStringArray(
      fileChangeOperationSchema,
      fileChangeOperationSchema.options.length,
    ),
  })
  .strict()

const manualFileChangeApprovalPolicySchema = z.object({ mode: z.literal('manual') }).strict()

const automaticFileChangeApprovalPolicySchema = z
  .object({
    mode: z.literal('auto'),
    scope: approvalScopeSchema,
    rules: z
      .array(fileChangeApprovalRuleSchema)
      .min(1)
      .max(100)
      .refine(
        (rules) =>
          new Set(
            rules.map((rule) => `${rule.pathPrefix}\0${[...rule.operations].sort().join(',')}`),
          ).size === rules.length,
        { message: 'File-change approval rules must not contain duplicates.' },
      ),
    maxFilesPerRequest: z.number().int().min(1).max(1_000),
    maxChangedLinesPerRequest: z.number().int().min(1).max(1_000_000),
    maxChangedBytesPerRequest: z.number().int().min(1).max(1_000_000_000),
  })
  .strict()

export const fileChangeApprovalPolicySchema = z.discriminatedUnion('mode', [
  manualFileChangeApprovalPolicySchema,
  automaticFileChangeApprovalPolicySchema,
])

const commandArgumentSchema = z
  .string()
  .max(64_000)
  .refine((value) => !value.includes('\0'), 'Command arguments must not contain NUL characters.')

export const commandApprovalRuleSchema = z
  .object({
    executable: absoluteExecutablePathSchema,
    argumentPrefix: z.array(commandArgumentSchema).max(255),
    allowAdditionalArguments: z.boolean(),
    workingDirectoryPrefix: relativePolicyPathSchema,
    maxTimeoutMs: z
      .number()
      .int()
      .min(1)
      .max(60 * 60 * 1_000),
    allowHostNetwork: z.boolean(),
  })
  .strict()
  .refine((rule) => !rule.allowAdditionalArguments || rule.argumentPrefix.length > 0, {
    message: 'Additional command arguments require at least one exact argument-prefix token.',
    path: ['argumentPrefix'],
  })

const manualCommandApprovalPolicySchema = z.object({ mode: z.literal('manual') }).strict()

const automaticCommandApprovalPolicySchema = z
  .object({
    mode: z.literal('auto'),
    scope: approvalScopeSchema,
    rules: z
      .array(commandApprovalRuleSchema)
      .min(1)
      .max(100)
      .refine((rules) => new Set(rules.map((rule) => JSON.stringify(rule))).size === rules.length, {
        message: 'Command approval rules must not contain duplicates.',
      }),
  })
  .strict()

export const commandApprovalPolicySchema = z.discriminatedUnion('mode', [
  manualCommandApprovalPolicySchema,
  automaticCommandApprovalPolicySchema,
])

export const workspaceApprovalPolicyConfigurationSchema = z
  .object({
    fileChanges: fileChangeApprovalPolicySchema,
    commands: commandApprovalPolicySchema,
  })
  .strict()

export const workspaceApprovalPolicySchema = z
  .object({
    workspacePath: workspaceBoundPathSchema,
    ...workspaceApprovalPolicyConfigurationSchema.shape,
  })
  .strict()

export const workspaceApprovalPoliciesSchema = z
  .array(workspaceApprovalPolicySchema)
  .max(200)
  .refine(
    (policies) => new Set(policies.map((policy) => policy.workspacePath)).size === policies.length,
    { message: 'Only one approval policy may be stored for each workspace.' },
  )

export const settingsInputSchema = z
  .object({
    activeProviderId: z.string().trim().min(1).max(120).nullable(),
    activeModelId: z.string().trim().min(1).max(512).nullable(),
    theme: z.enum(['system', 'dark', 'light']),
    locale: appLocaleSchema.optional(),
    maxToolIterations: z.number().int().min(1).max(20),
    maxTotalToolCalls: z.number().int().min(1).max(MAX_TOTAL_TOOL_CALLS).optional(),
    runTimeoutMinutes: z.number().int().min(1).max(MAX_AGENT_RUN_TIMEOUT_MINUTES).optional(),
  })
  .strict()

export const workspacePathSchema = z
  .object({
    path: z.string().max(4096),
  })
  .strict()

export const listWorkspaceInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes('\0'))
      .nullable(),
    cursor: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable(),
  })
  .strict()

export const executionTriggerSchema = z
  .object({
    providerId: z.string().trim().min(1).max(160),
    type: z.string().trim().min(1).max(160),
    dedupeKey: z.string().trim().min(1).max(240),
  })
  .strict()

export const agentRunInputSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(120),
    userMessageId: z.string().trim().min(1).max(120),
    assistantMessageId: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(MAX_AGENT_MESSAGE_CHARACTERS),
    displayMessage: z.string().trim().min(1).max(MAX_AGENT_MESSAGE_CHARACTERS),
    contextPaths: z.array(z.string().min(1).max(4096)).max(20),
    goalId: z.string().trim().min(1).max(120).optional(),
    trigger: executionTriggerSchema.optional(),
    mode: z.enum(['interactive', 'plan', 'goal']).optional(),
    intent: agentRunIntentSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.userMessageId === input.assistantMessageId) {
      context.addIssue({
        code: 'custom',
        path: ['assistantMessageId'],
        message: 'assistantMessageId must differ from userMessageId.',
      })
    }
    if (!input.mode || !input.intent) return
    const legacyIntent: AgentRunIntent = input.mode === 'plan' ? 'plan' : 'act'
    if (legacyIntent !== input.intent) {
      context.addIssue({
        code: 'custom',
        path: ['intent'],
        message: `intent must be ${legacyIntent} when legacy mode is ${input.mode}.`,
      })
    }
  })

export const cancelRunInputSchema = z.object({ runId: z.string().trim().min(1).max(120) }).strict()

export const workspaceTrustInputSchema = z.object({ trusted: z.boolean() }).strict()

export const conversationIdInputSchema = z
  .object({ conversationId: z.string().trim().min(1).max(120) })
  .strict()

export const listConversationsInputSchema = z
  .object({
    search: z.string().trim().max(200).optional(),
    archived: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict()

export const goalStatusSchema = z.enum(['active', 'paused', 'blocked', 'completed', 'cleared'])
export const goalPlanItemStatusSchema = z.enum(['pending', 'in_progress', 'completed'])

const goalIdSchema = z.string().trim().min(1).max(120)
const goalObjectiveSchema = z.string().trim().min(1).max(MAX_AGENT_MESSAGE_CHARACTERS)
const goalSummarySchema = z.string().trim().min(1).max(16_000)
const goalTokenBudgetSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const goalRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

export const listGoalsInputSchema = z
  .object({
    statuses: z
      .array(goalStatusSchema)
      .min(1)
      .max(goalStatusSchema.options.length)
      .refine((statuses) => new Set(statuses).size === statuses.length, {
        message: 'Goal statuses must not contain duplicates.',
      })
      .optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict()

export const goalIdInputSchema = z.object({ goalId: goalIdSchema }).strict()

export const createGoalInputSchema = z
  .object({
    objective: goalObjectiveSchema,
    tokenBudget: goalTokenBudgetSchema.optional(),
  })
  .strict()

const goalMutationIdentitySchema = {
  goalId: goalIdSchema,
  expectedRevision: goalRevisionSchema,
}

const editGoalInputSchema = z
  .object({
    action: z.literal('edit'),
    ...goalMutationIdentitySchema,
    objective: goalObjectiveSchema.optional(),
    tokenBudget: goalTokenBudgetSchema.nullable().optional(),
  })
  .strict()
  .refine((input) => input.objective !== undefined || input.tokenBudget !== undefined, {
    message: 'A goal edit must change the objective or token budget.',
  })

const goalLifecycleInputSchema = <Action extends 'pause' | 'resume' | 'clear'>(action: Action) =>
  z
    .object({
      action: z.literal(action),
      ...goalMutationIdentitySchema,
    })
    .strict()

export const mutateGoalInputSchema = z.discriminatedUnion('action', [
  editGoalInputSchema,
  goalLifecycleInputSchema('pause'),
  goalLifecycleInputSchema('resume'),
  goalLifecycleInputSchema('clear'),
  z
    .object({
      action: z.literal('complete'),
      ...goalMutationIdentitySchema,
      summary: goalSummarySchema,
    })
    .strict(),
])

export const resolveApprovalInputSchema = z
  .object({
    runId: z.string().trim().min(1).max(120),
    approvalId: z.string().trim().min(1).max(160),
    decision: z.enum(['approved', 'denied']),
  })
  .strict()

export const gitDiffInputSchema = z
  .object({
    staged: z.boolean().optional(),
    path: z.string().min(1).max(4096).optional(),
  })
  .strict()

export const undoMutationInputSchema = z
  .object({
    actionHash: z.string().regex(/^[a-f0-9]{64}$/),
    journalId: z.string().min(1).max(255),
  })
  .strict()

export const expandSlashCommandInputSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    arguments: z.string().max(16_384),
  })
  .strict()

export type ProviderInput = z.infer<typeof providerInputSchema>
export type SettingsInput = z.infer<typeof settingsInputSchema>
export type ListWorkspaceInput = z.infer<typeof listWorkspaceInputSchema>
export type AppLocale = z.infer<typeof appLocaleSchema>
export type ApprovalMode = z.infer<typeof approvalModeSchema>
export type ApprovalScope = z.infer<typeof approvalScopeSchema>
export type FileChangeOperation = z.infer<typeof fileChangeOperationSchema>
export type FileChangeApprovalRule = z.infer<typeof fileChangeApprovalRuleSchema>
export type FileChangeApprovalPolicy = z.infer<typeof fileChangeApprovalPolicySchema>
export type CommandApprovalRule = z.infer<typeof commandApprovalRuleSchema>
export type CommandApprovalPolicy = z.infer<typeof commandApprovalPolicySchema>
export type WorkspaceApprovalPolicyConfiguration = z.infer<
  typeof workspaceApprovalPolicyConfigurationSchema
>
export type WorkspaceApprovalPolicy = z.infer<typeof workspaceApprovalPolicySchema>
export type AgentRunInput = z.infer<typeof agentRunInputSchema>
export type AgentRunMode = 'interactive' | 'plan' | 'goal'
export type AgentRunIntent = z.infer<typeof agentRunIntentSchema>
export type ExecutionTrigger = z.infer<typeof executionTriggerSchema>
export type ExpandSlashCommandInput = z.infer<typeof expandSlashCommandInputSchema>
export type ListConversationsInput = z.infer<typeof listConversationsInputSchema>
export type GoalStatus = z.infer<typeof goalStatusSchema>
export type GoalPlanItemStatus = z.infer<typeof goalPlanItemStatusSchema>
export type ListGoalsInput = z.infer<typeof listGoalsInputSchema>
export type GoalIdInput = z.infer<typeof goalIdInputSchema>
export type CreateGoalInput = z.infer<typeof createGoalInputSchema>
export type MutateGoalInput = z.infer<typeof mutateGoalInputSchema>
export type ResolveApprovalInput = z.infer<typeof resolveApprovalInputSchema>
export type GitDiffInput = z.infer<typeof gitDiffInputSchema>
export type UndoMutationInput = z.infer<typeof undoMutationInputSchema>

export interface ProviderSummary {
  id: string
  name: string
  baseUrl: string
  driverId: string
  apiKeyConfigured: boolean
}

export interface ModelOption {
  id: string
  createdAt?: number
}

export interface AppSettings {
  providers: ProviderSummary[]
  activeProviderId: string | null
  activeModelId: string | null
  theme: 'system' | 'dark' | 'light'
  locale: AppLocale
  maxToolIterations: number
  maxTotalToolCalls: number
  runTimeoutMinutes: number
}

export interface WorkspaceSummary {
  name: string
  path: string
}

interface WorkspaceEntryBase {
  name: string
  path: string
}

export type WorkspaceEntry =
  | (WorkspaceEntryBase & {
      kind: 'directory'
      hasChildren: boolean
      /** Retained for internal recursive callers; directory-page IPC responses do not populate it. */
      children?: WorkspaceEntry[]
    })
  | (WorkspaceEntryBase & {
      kind: 'file'
      hasChildren?: never
      children?: never
    })

export interface WorkspaceDirectoryPage {
  entries: WorkspaceEntry[]
  complete: boolean
  nextCursor: string | null
}

export interface FilePreview {
  name: string
  path: string
  language: string
  content: string
  truncated: boolean
  /** Hash of the complete on-disk bytes, or null when the preview was truncated. */
  sha256: string | null
}

export interface SlashCommandDescriptor {
  id: string
  revision: string
  name: string
  description: string
  argumentHint: string | null
  path: string
  source: 'workspace'
}

export interface SlashCommandExpansion {
  id: string
  prompt: string
}

export interface SkillDescriptor {
  id: string
  revision: string
  name: string
  description: string
  path: string
  source: 'workspace'
  hasScripts: boolean
  hasReferences: boolean
  hasAssets: boolean
}

export interface ConversationToolActivity {
  callId: string
  tool: string
  summary: string
  status: 'running' | 'completed' | 'error'
}

export interface ConversationMessageRecord {
  id: string
  role: 'user' | 'assistant'
  content: string
  contextPaths: string[]
  runId: string | null
  status: 'pending' | 'running' | 'completed' | 'cancelled' | 'interrupted' | 'error'
  error: string | null
  tools: ConversationToolActivity[]
  usage: RunUsage | null
  changedPaths: string[]
  createdAt: number
  updatedAt: number
}

export interface ConversationSummary {
  id: string
  title: string
  workspaceName: string | null
  providerId: string | null
  modelId: string | null
  status: 'active' | 'archived'
  createdAt: number
  updatedAt: number
}

export interface ConversationDetail {
  summary: ConversationSummary
  messages: ConversationMessageRecord[]
  runs: ConversationRunRecord[]
}

export interface ConversationRunRecord {
  id: string
  goalId: string | null
  intent: AgentRunIntent
  trigger: ExecutionTrigger
  policyId: string
  attempt: number
  usage: RunUsage
  outcomeSummary: string | null
  status: 'running' | 'completed' | 'cancelled' | 'interrupted' | 'error'
  error: string | null
  startedAt: number
  finishedAt: number | null
}

export interface GoalPlanItem {
  step: string
  status: GoalPlanItemStatus
}

export interface GoalSummary {
  id: string
  originConversationId: string | null
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

export interface GoalPlanRevision {
  goalId: string
  revision: number
  goalRevision: number
  runId: string | null
  explanation: string
  items: GoalPlanItem[]
  createdAt: number
}

export interface GoalCheckpoint {
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

export interface GoalDetail {
  summary: GoalSummary
  plan: GoalPlanRevision | null
  checkpoints: GoalCheckpoint[]
}

export interface GitStatusEntry {
  path: string
  originalPath?: string
  indexStatus: string
  worktreeStatus: string
}

export interface GitStatusResult {
  repository: boolean
  branch: string | null
  head: string | null
  entries: GitStatusEntry[]
  truncated: boolean
}

export interface GitDiffResult {
  patch: string
  truncated: boolean
}

export interface UndoStatus {
  available: boolean
  actionHash: string | null
  journalId: string | null
  summary: string | null
  paths: string[]
}

export interface FileChangePreview {
  path: string
  kind: 'create' | 'update' | 'delete'
  diff: string
  additions: number
  deletions: number
  beforeHash: string | null
  afterHash: string | null
}

export type ApprovalRequest =
  | {
      kind: 'file-change'
      approvalId: string
      actionHash: string
      summary: string
      changes: FileChangePreview[]
      expiresAt: number
    }
  | {
      kind: 'command'
      approvalId: string
      actionHash: string
      summary: string
      argv: string[]
      cwd: string
      timeoutMs: number
      isolation: 'structured-process'
      network: 'host'
      expiresAt: number
    }
  | {
      kind: 'mcp-server'
      approvalId: string
      actionHash: string
      summary: string
      configurationRevision: string
      configPath: string
      servers: Array<{
        id: string
        name: string
        command: string
        argv: string[]
        cwd: string | null
        environment: Array<{ key: string; value: string }>
      }>
      isolation: 'structured-process'
      network: 'host'
      expiresAt: number
    }
  | {
      kind: 'mcp-tool'
      approvalId: string
      actionHash: string
      summary: string
      serverName: string
      toolName: string
      argumentsJson: string
      capabilities: Array<'process' | 'write' | 'network'>
      network: 'host'
      expiresAt: number
    }

export interface RunUsage {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
}

export type ReadinessStatus = 'action-required' | 'restricted' | 'ready'
export type ReadinessItemId = 'provider' | 'model' | 'workspace' | 'trust'
export type ReadinessItemStatus = 'blocked' | 'required' | 'recommended' | 'restricted' | 'complete'
export type ReadinessActionId =
  | 'settings.open-provider'
  | 'settings.select-model'
  | 'workspace.choose'
  | 'workspace.trust'
  | 'conversation.start'
export type ActionAvailability = 'available' | 'blocked' | 'hidden'

export interface ReadinessItem {
  id: ReadinessItemId
  status: ReadinessItemStatus
  actionId: ReadinessActionId | null
}

export interface ActionDescriptor {
  id: ReadinessActionId
  source: 'host'
  effects: Array<'read' | 'write' | 'process' | 'network'>
  availability: ActionAvailability
  reasonCode: string | null
  revision: string
}

export interface ReadinessSnapshot {
  status: ReadinessStatus
  items: ReadinessItem[]
  primaryActionId: ReadinessActionId
  actions: ActionDescriptor[]
}

export interface BootstrapState {
  appVersion: string
  platform: string
  settings: AppSettings
  workspace: WorkspaceSummary | null
  workspaceTrusted: boolean
  workspaceApprovalPolicy: WorkspaceApprovalPolicyConfiguration | null
  readiness: ReadinessSnapshot
  recoveryNotice: string | null
}

export type AgentEvent =
  | { runId: string; type: 'started' }
  | { runId: string; type: 'conversation-title'; conversationId: string; title: string }
  | { runId: string; type: 'text-delta'; delta: string }
  | { runId: string; type: 'tool-started'; callId: string; tool: string; summary: string }
  | {
      runId: string
      type: 'tool-completed'
      callId: string
      tool: string
      summary: string
      ok: boolean
    }
  | { runId: string; type: 'approval-requested'; request: ApprovalRequest }
  | {
      runId: string
      type: 'approval-resolved'
      approvalId: string
      decision: 'approved' | 'denied' | 'expired' | 'cancelled'
      automatic?: boolean
      policyRevision?: string
      ruleId?: string
    }
  | {
      runId: string
      type: 'command-output'
      callId: string
      stream: 'stdout' | 'stderr'
      delta: string
    }
  | { runId: string; type: 'usage'; usage: RunUsage }
  | { runId: string; type: 'files-changed'; paths: string[]; undoAvailable: boolean }
  | { runId: string; type: 'completed'; responseId: string | null }
  | { runId: string; type: 'interrupted'; message: string }
  | { runId: string; type: 'cancelled' }
  | { runId: string; type: 'error'; message: string }

export interface AssistantApi {
  bootstrap(): Promise<BootstrapState>
  chooseWorkspace(): Promise<WorkspaceSummary | null>
  listWorkspace(input: ListWorkspaceInput): Promise<WorkspaceDirectoryPage>
  readWorkspaceFile(input: { path: string }): Promise<FilePreview>
  setWorkspaceTrust(input: { trusted: boolean }): Promise<{ trusted: boolean }>
  listSlashCommands(): Promise<SlashCommandDescriptor[]>
  expandSlashCommand(input: ExpandSlashCommandInput): Promise<SlashCommandExpansion>
  listSkills(): Promise<SkillDescriptor[]>
  listConversations(input: ListConversationsInput): Promise<ConversationSummary[]>
  readConversation(input: { conversationId: string }): Promise<ConversationDetail | null>
  forkConversation(input: { conversationId: string }): Promise<ConversationDetail>
  archiveConversation(input: { conversationId: string }): Promise<void>
  deleteConversation(input: { conversationId: string }): Promise<void>
  listGoals(input: ListGoalsInput): Promise<GoalSummary[]>
  readGoal(input: GoalIdInput): Promise<GoalDetail>
  createGoal(input: CreateGoalInput): Promise<GoalDetail>
  mutateGoal(input: MutateGoalInput): Promise<GoalDetail>
  getGitStatus(): Promise<GitStatusResult>
  getGitDiff(input: GitDiffInput): Promise<GitDiffResult>
  getUndoStatus(): Promise<UndoStatus>
  undoLastMutation(input: UndoMutationInput): Promise<{ restoredPaths: string[] }>
  saveProvider(input: ProviderInput): Promise<AppSettings>
  removeProvider(input: { providerId: string }): Promise<AppSettings>
  saveSettings(input: SettingsInput): Promise<AppSettings>
  saveWorkspaceApprovalPolicy(
    input: WorkspaceApprovalPolicyConfiguration,
  ): Promise<WorkspaceApprovalPolicyConfiguration>
  listModels(input: { providerId: string }): Promise<ModelOption[]>
  startRun(input: AgentRunInput): Promise<{ runId: string }>
  cancelRun(input: { runId: string }): Promise<void>
  resolveApproval(input: ResolveApprovalInput): Promise<void>
  onAgentEvent(listener: (event: AgentEvent) => void): () => void
}
