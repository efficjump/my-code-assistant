import { basename } from 'node:path'
import {
  type AgentEvent,
  type AppLocale,
  agentRunInputSchema,
  type ConversationDetail,
  type ConversationSummary,
  cancelRunInputSchema,
  conversationIdInputSchema,
  createGoalInputSchema,
  DEFAULT_APP_LOCALE,
  expandSlashCommandInputSchema,
  type GitStatusResult,
  type GoalCheckpoint,
  type GoalDetail,
  type GoalPlanRevision,
  type GoalSummary,
  gitDiffInputSchema,
  goalIdInputSchema,
  listConversationsInputSchema,
  listGoalsInputSchema,
  listWorkspaceInputSchema,
  type MutateGoalInput,
  mutateGoalInputSchema,
  providerIdSchema,
  providerInputSchema,
  resolveApprovalInputSchema,
  type SkillDescriptor,
  settingsInputSchema,
  undoMutationInputSchema,
  type WorkspaceApprovalPolicyConfiguration,
  workspaceApprovalPolicyConfigurationSchema,
  workspacePathSchema,
  workspaceTrustInputSchema,
} from '@shared/contracts'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import { buildReadinessSnapshot } from '@shared/readiness'
import {
  app,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  type WebFrameMain,
} from 'electron'
import { type ZodType, z } from 'zod'
import type { AgentService } from './services/agent'
import type { CommandService } from './services/commands'
import type {
  ConversationRecord,
  ConversationRepository,
  GoalCheckpointRecord,
  GoalPlanRevisionRecord,
  GoalRecord,
  ConversationDetail as StoredConversationDetail,
} from './services/conversations'
import { type GitRepositoryStatus, type GitService, GitServiceError } from './services/git'
import { formatHostError, HostError } from './services/host-errors'
import { hostMessages, redactHostText } from './services/host-messages'
import type { SettingsStore } from './services/settings'
import type { SkillsService } from './services/skills'
import type { TrustStore } from './services/trust'
import type { WorkspaceService } from './services/workspace'

interface MutationUndoService {
  getUndoStatus(): Promise<{
    available: boolean
    actionHash: string | null
    journalId: string | null
    summary: string | null
    paths: string[]
  }>
  undoLast(options?: {
    signal?: AbortSignal
    expectedActionHash?: string
    expectedJournalId?: string
  }): Promise<{ restoredPaths: string[] }>
}

interface IpcDependencies {
  getWindow: () => BrowserWindow | null
  isTrustedRendererUrl: (url: string) => boolean
  settings: SettingsStore
  startupReady: Promise<void>
  workspace: WorkspaceService
  agent: AgentService
  commands: CommandService
  conversations: ConversationRepository
  git: GitService
  mutations: MutationUndoService
  recoverWorkspaceMutations: () => Promise<void>
  takeRecoveryNotice: () => Promise<string | null> | string | null
  skills: SkillsService
  trust: TrustStore
}

const noPayloadSchema = z.undefined()

function assertTrustedRenderer(
  event: IpcMainInvokeEvent,
  window: BrowserWindow | null,
  isTrustedRendererUrl: (url: string) => boolean,
): void {
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new HostError({ code: 'ipc.untrusted_renderer' })
  }

  if (event.senderFrame !== event.sender.mainFrame) {
    throw new HostError({ code: 'ipc.subframe_forbidden' })
  }

  if (!isTrustedRendererUrl(event.senderFrame.url)) {
    throw new HostError({ code: 'ipc.origin_forbidden' })
  }
}

async function safeError(error: unknown, settings: SettingsStore): Promise<Error> {
  const locale = await settings
    .getSettings()
    .then((current) => current.locale)
    .catch(() => DEFAULT_APP_LOCALE)
  const message =
    formatHostError(error, locale) ??
    (error instanceof Error && error.message.trim()
      ? error.message
      : locale === 'en'
        ? 'The request could not be processed.'
        : '요청을 처리하지 못했습니다.')
  return new Error(redactHostText(message).slice(0, 4_000))
}

function toConversationSummary(record: ConversationRecord, locale: AppLocale): ConversationSummary {
  return {
    id: record.id,
    title: record.summary || hostMessages(locale).lifecycle.newConversationTitle,
    workspaceName: record.workspacePath ? basename(record.workspacePath) : null,
    providerId: record.providerId,
    modelId: record.modelId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function toConversationDetail(
  record: StoredConversationDetail,
  locale: AppLocale,
): ConversationDetail {
  const runsById = new Map(record.runs.map((run) => [run.id, run]))
  const changedPathsByRun = new Map<string, Set<string>>()
  for (const event of record.auditEvents) {
    if (event.type !== 'files.changed' || !event.runId) continue
    if (!event.metadata || typeof event.metadata !== 'object' || Array.isArray(event.metadata)) {
      continue
    }
    const paths = event.metadata.paths
    if (!Array.isArray(paths)) continue
    const changedPaths = changedPathsByRun.get(event.runId) ?? new Set<string>()
    for (const path of paths) {
      if (typeof path === 'string') changedPaths.add(path)
    }
    changedPathsByRun.set(event.runId, changedPaths)
  }
  return {
    summary: toConversationSummary(record, locale),
    messages: record.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.displayContent,
      contextPaths: [...message.contextPaths],
      runId: message.runId,
      status: message.status === 'starting' ? 'pending' : message.status,
      error: message.error,
      tools: message.toolActivities.map((activity) => ({
        callId: activity.callId,
        tool: activity.tool,
        summary: activity.summary,
        status: activity.status,
      })),
      usage: message.runId ? (runsById.get(message.runId)?.usage ?? null) : null,
      changedPaths: message.runId ? [...(changedPathsByRun.get(message.runId) ?? [])] : [],
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    })),
    runs: record.runs.map((run) => ({
      id: run.id,
      goalId: run.goalId,
      intent: run.intent,
      trigger: { ...run.trigger },
      policyId: run.policyId,
      attempt: run.attempt,
      usage: { ...run.usage },
      outcomeSummary: run.outcomeSummary,
      status: run.status,
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })),
  }
}

function toGoalSummary(record: GoalRecord): GoalSummary {
  return {
    id: record.id,
    originConversationId: record.originConversationId,
    workspacePath: record.workspacePath,
    objective: record.objective,
    status: record.status,
    revision: record.revision,
    planRevision: record.planRevision,
    progressSummary: record.progressSummary,
    blockedSummary: record.blockedSummary,
    completionSummary: record.completionSummary,
    tokenBudget: record.tokenBudget,
    usedTokens: record.usedTokens,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    clearedAt: record.clearedAt,
  }
}

function toGoalPlan(record: GoalPlanRevisionRecord | null): GoalPlanRevision | null {
  if (!record) return null
  return {
    goalId: record.goalId,
    revision: record.revision,
    goalRevision: record.goalRevision,
    runId: record.runId,
    explanation: record.explanation,
    items: record.items.map((item) => ({ ...item })),
    createdAt: record.createdAt,
  }
}

function toGoalCheckpoint(record: GoalCheckpointRecord): GoalCheckpoint {
  return { ...record }
}

function toGitStatus(status: GitRepositoryStatus): GitStatusResult {
  return {
    repository: true,
    branch: status.branch,
    head: status.head,
    entries: status.entries.map((entry) => ({
      path: entry.path,
      ...(entry.originalPath ? { originalPath: entry.originalPath } : {}),
      indexStatus: entry.index,
      worktreeStatus: entry.worktree,
    })),
    truncated: status.porcelainTruncated,
  }
}

function toSkillDescriptor(
  descriptor: Awaited<ReturnType<SkillsService['list']>>[number],
): SkillDescriptor {
  return {
    id: descriptor.id,
    revision: descriptor.revision,
    name: descriptor.name,
    description: descriptor.description,
    path: descriptor.path,
    source: 'workspace',
    hasScripts: descriptor.resources.scripts.length > 0,
    hasReferences: descriptor.resources.references.length > 0,
    hasAssets: descriptor.resources.assets.length > 0,
  }
}

function handle<TSchema extends ZodType, TResult>(
  channel: string,
  schema: TSchema,
  dependencies: Pick<
    IpcDependencies,
    'getWindow' | 'isTrustedRendererUrl' | 'settings' | 'startupReady'
  >,
  handler: (payload: z.output<TSchema>, event: IpcMainInvokeEvent) => Promise<TResult> | TResult,
): void {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      assertTrustedRenderer(event, dependencies.getWindow(), dependencies.isTrustedRendererUrl)
      const parsed = schema.safeParse(payload)
      if (!parsed.success) throw new HostError({ code: 'ipc.invalid_request' })
      await dependencies.startupReady
      return await handler(parsed.data, event)
    } catch (error) {
      throw await safeError(error, dependencies.settings)
    }
  })
}

export function registerIpc(dependencies: IpcDependencies): () => void {
  const { settings, workspace, agent, commands, conversations, git, mutations, skills, trust } =
    dependencies
  const runOwners = new Map<string, { webContentsId: number; frame: WebFrameMain }>()

  const workspaceTrust = async (): Promise<boolean> => {
    const selected = workspace.getWorkspace()
    return selected ? trust.isTrusted(selected.path) : false
  }

  const withTrustedWorkspace = async <T>(operation: () => Promise<T> | T): Promise<T> => {
    const selected = workspace.getWorkspace()
    if (!selected) throw new HostError({ code: 'ipc.workspace_required' })
    if (!(await trust.isTrusted(selected.path))) {
      throw new HostError({ code: 'ipc.workspace_trust_required' })
    }
    if (workspace.getWorkspace()?.path !== selected.path) {
      throw new HostError({ code: 'ipc.workspace_changed' })
    }
    const result = await operation()
    if (workspace.getWorkspace()?.path !== selected.path) {
      throw new HostError({ code: 'ipc.workspace_changed' })
    }
    return result
  }

  const conversationInCurrentWorkspace = (conversationId: string): StoredConversationDetail => {
    const conversation = conversations.getConversation(conversationId)
    if (!conversation) throw new HostError({ code: 'ipc.conversation_not_found' })
    const currentWorkspacePath = workspace.getWorkspace()?.path ?? null
    if (conversation.workspacePath !== currentWorkspacePath) {
      throw new HostError({ code: 'ipc.conversation_workspace_mismatch' })
    }
    return conversation
  }

  const goalInCurrentWorkspace = (goalId: string): GoalRecord => {
    const currentWorkspacePath = workspace.getWorkspace()?.path ?? null
    const goal = conversations.getGoal(goalId)
    if (!currentWorkspacePath || !goal || goal.workspacePath !== currentWorkspacePath) {
      throw new HostError({ code: 'ipc.goal_not_found' })
    }
    return goal
  }

  const goalDetail = (goal: GoalRecord): GoalDetail => ({
    summary: toGoalSummary(goal),
    plan: toGoalPlan(conversations.getCurrentGoalPlan(goal.id)),
    checkpoints: conversations.listGoalCheckpoints(goal.id, { limit: 100 }).map(toGoalCheckpoint),
  })

  const assertGoalMutationAllowed = (goal: GoalRecord, input: MutateGoalInput): void => {
    switch (input.action) {
      case 'edit':
        if (
          (goal.status === 'completed' || goal.status === 'cleared') &&
          input.objective !== undefined &&
          input.objective !== goal.objective
        ) {
          throw new HostError({ code: 'ipc.goal_edit_closed' })
        }
        break
      case 'pause':
        if (goal.status !== 'active' && goal.status !== 'blocked') {
          throw new HostError({ code: 'ipc.goal_pause_invalid' })
        }
        break
      case 'resume':
        if (goal.status !== 'paused' && goal.status !== 'blocked') {
          throw new HostError({ code: 'ipc.goal_resume_invalid' })
        }
        break
      case 'clear':
        if (!['active', 'paused', 'blocked'].includes(goal.status)) {
          throw new HostError({ code: 'ipc.goal_clear_invalid' })
        }
        break
      case 'complete':
        if (goal.status !== 'active') {
          throw new HostError({ code: 'ipc.goal_complete_invalid' })
        }
        break
    }
  }

  handle(IPC_CHANNELS.bootstrap, noPayloadSchema, dependencies, async () => {
    const selected = workspace.getWorkspace()
    const policy = selected ? await settings.getWorkspaceApprovalPolicy(selected.path) : null
    const currentSettings = await settings.getSettings()
    const trusted = await workspaceTrust()
    return {
      appVersion: app.getVersion(),
      platform: process.platform,
      settings: currentSettings,
      workspace: selected,
      workspaceTrusted: trusted,
      workspaceApprovalPolicy: policy
        ? ({
            fileChanges: policy.fileChanges,
            commands: policy.commands,
          } satisfies WorkspaceApprovalPolicyConfiguration)
        : null,
      readiness: buildReadinessSnapshot({
        providerSelected: Boolean(currentSettings.activeProviderId),
        modelSelected: Boolean(currentSettings.activeModelId),
        workspaceSelected: Boolean(selected),
        workspaceTrusted: trusted,
      }),
      recoveryNotice: await dependencies.takeRecoveryNotice(),
    }
  })

  handle(IPC_CHANNELS.chooseWorkspace, noPayloadSchema, dependencies, async () => {
    return agent.withRunsSuspended(async () => {
      await agent.suspendWorkspaceCapabilities()
      const selected = await workspace.chooseWorkspace(dependencies.getWindow() ?? undefined)
      if (selected) await dependencies.recoverWorkspaceMutations()
      return selected
    })
  })

  handle(IPC_CHANNELS.listWorkspace, listWorkspaceInputSchema, dependencies, (input) =>
    workspace.listWorkspace(input),
  )

  handle(IPC_CHANNELS.readWorkspaceFile, workspacePathSchema, dependencies, ({ path }) =>
    workspace.readFile(path),
  )

  handle(IPC_CHANNELS.setWorkspaceTrust, workspaceTrustInputSchema, dependencies, async (input) => {
    return agent.withRunsSuspended(async () => {
      const selected = workspace.getWorkspace()
      if (!selected) throw new HostError({ code: 'ipc.workspace_required' })
      if (!input.trusted) await agent.suspendWorkspaceCapabilities()
      const decision = await trust.setWorkspaceTrust(selected.path, input.trusted)
      if (workspace.getWorkspace()?.path !== selected.path) {
        throw new HostError({ code: 'ipc.workspace_changed' })
      }
      return { trusted: decision.trusted }
    })
  })

  handle(IPC_CHANNELS.listSlashCommands, noPayloadSchema, dependencies, () =>
    withTrustedWorkspace(() => commands.listSlashCommands()),
  )

  handle(IPC_CHANNELS.expandSlashCommand, expandSlashCommandInputSchema, dependencies, (input) =>
    withTrustedWorkspace(() => commands.expandSlashCommand(input)),
  )

  handle(IPC_CHANNELS.listSkills, noPayloadSchema, dependencies, () =>
    withTrustedWorkspace(async () => (await skills.list()).map(toSkillDescriptor)),
  )

  handle(
    IPC_CHANNELS.listConversations,
    listConversationsInputSchema,
    dependencies,
    async (input) => {
      const selected = workspace.getWorkspace()
      const locale = (await settings.getSettings()).locale
      return conversations
        .listConversations({
          workspacePath: selected?.path ?? null,
          archived: input.archived ?? false,
          ...(input.search ? { search: input.search } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        })
        .map((record) => toConversationSummary(record, locale))
    },
  )

  handle(
    IPC_CHANNELS.readConversation,
    conversationIdInputSchema,
    dependencies,
    async ({ conversationId }) => {
      const locale = (await settings.getSettings()).locale
      return toConversationDetail(conversationInCurrentWorkspace(conversationId), locale)
    },
  )

  handle(
    IPC_CHANNELS.forkConversation,
    conversationIdInputSchema,
    dependencies,
    async ({ conversationId }) => {
      conversationInCurrentWorkspace(conversationId)
      const locale = (await settings.getSettings()).locale
      return toConversationDetail(conversations.fork(conversationId), locale)
    },
  )

  handle(
    IPC_CHANNELS.archiveConversation,
    conversationIdInputSchema,
    dependencies,
    ({ conversationId }) =>
      agent.withRunsSuspended(async () => {
        conversationInCurrentWorkspace(conversationId)
        conversations.archive(conversationId)
        agent.evictConversation(conversationId)
      }),
  )

  handle(
    IPC_CHANNELS.deleteConversation,
    conversationIdInputSchema,
    dependencies,
    ({ conversationId }) =>
      agent.withRunsSuspended(async () => {
        conversationInCurrentWorkspace(conversationId)
        conversations.delete(conversationId)
        agent.evictConversation(conversationId)
      }),
  )

  handle(IPC_CHANNELS.listGoals, listGoalsInputSchema, dependencies, (input) => {
    const selected = workspace.getWorkspace()
    if (!selected) throw new HostError({ code: 'ipc.workspace_required' })
    return conversations
      .listGoals({
        workspacePath: selected.path,
        ...(input.statuses ? { statuses: input.statuses } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      })
      .map(toGoalSummary)
  })

  handle(IPC_CHANNELS.readGoal, goalIdInputSchema, dependencies, ({ goalId }) => {
    return goalDetail(goalInCurrentWorkspace(goalId))
  })

  handle(IPC_CHANNELS.createGoal, createGoalInputSchema, dependencies, (input) => {
    const selected = workspace.getWorkspace()
    if (!selected) throw new HostError({ code: 'ipc.workspace_required' })
    const goal = conversations.createGoal({
      workspacePath: selected.path,
      objective: input.objective,
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
    })
    return goalDetail(goal)
  })

  handle(IPC_CHANNELS.mutateGoal, mutateGoalInputSchema, dependencies, async (input) => {
    return agent.withGoalMutation(
      input.goalId,
      () => {
        const current = goalInCurrentWorkspace(input.goalId)
        if (current.revision !== input.expectedRevision) {
          throw new HostError({
            code: 'ipc.goal_revision_changed',
            expected: input.expectedRevision,
            current: current.revision,
          })
        }
        assertGoalMutationAllowed(current, input)
      },
      () => {
        const current = goalInCurrentWorkspace(input.goalId)
        assertGoalMutationAllowed(current, input)
        // Cancelling an active run can append a fallback checkpoint and advance the Goal revision.
        // Rebase the user-authorized mutation on that settled snapshot while retaining repository
        // CAS protection against writers that race after this read.
        const settledRevision = current.revision
        let updated: GoalRecord
        switch (input.action) {
          case 'edit':
            updated = conversations.updateGoal(current.id, {
              expectedRevision: settledRevision,
              ...(input.objective !== undefined ? { objective: input.objective } : {}),
              ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
            })
            break
          case 'pause':
            updated = conversations.updateGoal(current.id, {
              expectedRevision: settledRevision,
              status: 'paused',
            })
            break
          case 'resume':
            updated = conversations.updateGoal(current.id, {
              expectedRevision: settledRevision,
              status: 'active',
            })
            break
          case 'clear':
            updated = conversations.updateGoal(current.id, {
              expectedRevision: settledRevision,
              status: 'cleared',
            })
            break
          case 'complete':
            updated = conversations.updateGoal(current.id, {
              expectedRevision: settledRevision,
              status: 'completed',
              completionSummary: input.summary,
            })
            break
        }
        return goalDetail(updated)
      },
    )
  })

  handle(IPC_CHANNELS.getGitStatus, noPayloadSchema, dependencies, async () => {
    try {
      return toGitStatus(await git.getStatus())
    } catch (error) {
      if (error instanceof GitServiceError && error.code === 'NOT_A_REPOSITORY') {
        return {
          repository: false,
          branch: null,
          head: null,
          entries: [],
          truncated: false,
        } satisfies GitStatusResult
      }
      throw error
    }
  })

  handle(IPC_CHANNELS.getGitDiff, gitDiffInputSchema, dependencies, async (input) => {
    const diff = await git.getDiff({ ...(input.path ? { path: input.path } : {}) })
    const section = input.staged ? diff.staged : diff.unstaged
    return { patch: section.content, truncated: section.truncated }
  })

  handle(IPC_CHANNELS.getUndoStatus, noPayloadSchema, dependencies, () =>
    withTrustedWorkspace(() => mutations.getUndoStatus()),
  )

  handle(IPC_CHANNELS.undoLastMutation, undoMutationInputSchema, dependencies, (input) =>
    withTrustedWorkspace(async () => {
      return agent.withRunsSuspended(() =>
        mutations.undoLast({
          expectedActionHash: input.actionHash,
          expectedJournalId: input.journalId,
        }),
      )
    }),
  )

  handle(IPC_CHANNELS.saveProvider, providerInputSchema, dependencies, (input) =>
    settings.saveProvider(input),
  )

  handle(IPC_CHANNELS.removeProvider, providerIdSchema, dependencies, ({ providerId }) =>
    settings.removeProvider(providerId),
  )

  handle(IPC_CHANNELS.saveSettings, settingsInputSchema, dependencies, (input) =>
    settings.saveSettings(input),
  )

  handle(
    IPC_CHANNELS.saveWorkspaceApprovalPolicy,
    workspaceApprovalPolicyConfigurationSchema,
    dependencies,
    (input) =>
      agent.withRunsSuspended(async () => {
        const selected = workspace.getWorkspace()
        if (!selected) throw new HostError({ code: 'ipc.workspace_required' })
        const enablesAutomation =
          input.fileChanges.mode === 'auto' || input.commands.mode === 'auto'
        if (enablesAutomation && !(await trust.isTrusted(selected.path))) {
          throw new HostError({ code: 'ipc.approval_automation_trust_required' })
        }
        if (workspace.getWorkspace()?.path !== selected.path) {
          throw new HostError({ code: 'ipc.workspace_changed' })
        }
        const policy = await settings.saveWorkspaceApprovalPolicy(selected.path, input)
        if (workspace.getWorkspace()?.path !== selected.path) {
          throw new HostError({ code: 'ipc.workspace_changed' })
        }
        return {
          fileChanges: policy.fileChanges,
          commands: policy.commands,
        } satisfies WorkspaceApprovalPolicyConfiguration
      }),
  )

  handle(IPC_CHANNELS.listModels, providerIdSchema, dependencies, ({ providerId }) =>
    agent.listModels(providerId),
  )

  handle(IPC_CHANNELS.startRun, agentRunInputSchema, dependencies, (input, invokeEvent) => {
    const owner = invokeEvent.sender
    const ownerFrame = invokeEvent.senderFrame
    if (!ownerFrame) throw new HostError({ code: 'ipc.renderer_document_unavailable' })
    let ownedRunId = ''
    const handleOwnerDestroyed = (): void => {
      if (!ownedRunId) return
      runOwners.delete(ownedRunId)
      void agent.cancelRun(ownedRunId)
    }
    const emit = (event: AgentEvent): void => {
      const activeWindow = dependencies.getWindow()
      if (
        owner.isDestroyed() ||
        owner.mainFrame !== ownerFrame ||
        !activeWindow ||
        activeWindow.isDestroyed() ||
        activeWindow.webContents !== owner ||
        !dependencies.isTrustedRendererUrl(owner.getURL())
      ) {
        runOwners.delete(event.runId)
        owner.removeListener('destroyed', handleOwnerDestroyed)
        void agent.cancelRun(event.runId)
        return
      }

      try {
        owner.send(IPC_CHANNELS.agentEvent, event)
      } catch {
        runOwners.delete(event.runId)
        owner.removeListener('destroyed', handleOwnerDestroyed)
        void agent.cancelRun(event.runId)
        return
      } finally {
        if (['completed', 'interrupted', 'cancelled', 'error'].includes(event.type)) {
          runOwners.delete(event.runId)
          owner.removeListener('destroyed', handleOwnerDestroyed)
        }
      }
    }
    const run = agent.startRun(input, emit)
    ownedRunId = run.runId
    runOwners.set(run.runId, { webContentsId: owner.id, frame: ownerFrame })
    owner.once('destroyed', handleOwnerDestroyed)
    return run
  })

  handle(IPC_CHANNELS.cancelRun, cancelRunInputSchema, dependencies, ({ runId }, invokeEvent) => {
    const runOwner = runOwners.get(runId)
    if (
      !runOwner ||
      runOwner.webContentsId !== invokeEvent.sender.id ||
      runOwner.frame !== invokeEvent.senderFrame
    ) {
      throw new HostError({ code: 'ipc.run_not_owned' })
    }
    return agent.cancelRun(runId)
  })

  handle(
    IPC_CHANNELS.resolveApproval,
    resolveApprovalInputSchema,
    dependencies,
    ({ runId, approvalId, decision }, invokeEvent) => {
      const runOwner = runOwners.get(runId)
      if (
        !runOwner ||
        runOwner.webContentsId !== invokeEvent.sender.id ||
        runOwner.frame !== invokeEvent.senderFrame
      ) {
        throw new HostError({ code: 'ipc.approval_not_owned' })
      }
      agent.resolveApproval(runId, approvalId, decision)
    },
  )

  return () => {
    agent.cancelAllRuns()
    runOwners.clear()
    for (const channel of Object.values(IPC_CHANNELS)) {
      if (channel !== IPC_CHANNELS.agentEvent) ipcMain.removeHandler(channel)
    }
  }
}
