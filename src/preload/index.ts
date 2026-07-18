import type {
  AgentEvent,
  AgentRunInput,
  AppSettings,
  AssistantApi,
  BootstrapState,
  ConversationDetail,
  ConversationSummary,
  CreateGoalInput,
  ExpandSlashCommandInput,
  FilePreview,
  GitDiffInput,
  GitDiffResult,
  GitStatusResult,
  GoalDetail,
  GoalIdInput,
  GoalSummary,
  ListConversationsInput,
  ListGoalsInput,
  ListWorkspaceInput,
  ModelOption,
  MutateGoalInput,
  ProviderInput,
  ResolveApprovalInput,
  SettingsInput,
  SkillDescriptor,
  SlashCommandDescriptor,
  SlashCommandExpansion,
  UndoMutationInput,
  UndoStatus,
  WorkspaceApprovalPolicyConfiguration,
  WorkspaceDirectoryPage,
  WorkspaceSummary,
} from '@shared/contracts'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import { contextBridge, ipcRenderer } from 'electron'

const assistantApi: AssistantApi = {
  bootstrap: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrap) as Promise<BootstrapState>,
  chooseWorkspace: () =>
    ipcRenderer.invoke(IPC_CHANNELS.chooseWorkspace) as Promise<WorkspaceSummary | null>,
  listWorkspace: (input: ListWorkspaceInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.listWorkspace, input) as Promise<WorkspaceDirectoryPage>,
  readWorkspaceFile: (input: { path: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.readWorkspaceFile, input) as Promise<FilePreview>,
  setWorkspaceTrust: (input: { trusted: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.setWorkspaceTrust, input) as Promise<{ trusted: boolean }>,
  listSlashCommands: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listSlashCommands) as Promise<SlashCommandDescriptor[]>,
  expandSlashCommand: (input: ExpandSlashCommandInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.expandSlashCommand, input) as Promise<SlashCommandExpansion>,
  listSkills: () => ipcRenderer.invoke(IPC_CHANNELS.listSkills) as Promise<SkillDescriptor[]>,
  listConversations: (input: ListConversationsInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.listConversations, input) as Promise<ConversationSummary[]>,
  readConversation: (input: { conversationId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.readConversation, input) as Promise<ConversationDetail | null>,
  forkConversation: (input: { conversationId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.forkConversation, input) as Promise<ConversationDetail>,
  archiveConversation: (input: { conversationId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.archiveConversation, input) as Promise<void>,
  deleteConversation: (input: { conversationId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteConversation, input) as Promise<void>,
  listGoals: (input: ListGoalsInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.listGoals, input) as Promise<GoalSummary[]>,
  readGoal: (input: GoalIdInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.readGoal, input) as Promise<GoalDetail>,
  createGoal: (input: CreateGoalInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.createGoal, input) as Promise<GoalDetail>,
  mutateGoal: (input: MutateGoalInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.mutateGoal, input) as Promise<GoalDetail>,
  getGitStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getGitStatus) as Promise<GitStatusResult>,
  getGitDiff: (input: GitDiffInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.getGitDiff, input) as Promise<GitDiffResult>,
  getUndoStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getUndoStatus) as Promise<UndoStatus>,
  undoLastMutation: (input: UndoMutationInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.undoLastMutation, input) as Promise<{
      restoredPaths: string[]
    }>,
  saveProvider: (input: ProviderInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveProvider, input) as Promise<AppSettings>,
  removeProvider: (input: { providerId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.removeProvider, input) as Promise<AppSettings>,
  saveSettings: (input: SettingsInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveSettings, input) as Promise<AppSettings>,
  saveWorkspaceApprovalPolicy: (input: WorkspaceApprovalPolicyConfiguration) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.saveWorkspaceApprovalPolicy,
      input,
    ) as Promise<WorkspaceApprovalPolicyConfiguration>,
  listModels: (input: { providerId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.listModels, input) as Promise<ModelOption[]>,
  startRun: (input: AgentRunInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.startRun, input) as Promise<{ runId: string }>,
  cancelRun: (input: { runId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelRun, input) as Promise<void>,
  resolveApproval: (input: ResolveApprovalInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.resolveApproval, input) as Promise<void>,
  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent): void =>
      listener(payload)
    ipcRenderer.on(IPC_CHANNELS.agentEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.agentEvent, handler)
  },
}

contextBridge.exposeInMainWorld('assistant', Object.freeze(assistantApi))
