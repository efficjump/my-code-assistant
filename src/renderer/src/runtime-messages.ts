import type { AppLocale, AppSettings } from '@shared/contracts'
import { useCallback } from 'react'
import { useI18n } from './i18n'

const ko = {
  workspaceLoadFailed: () => '작업 공간 파일을 불러오지 못했습니다.',
  slashCommandsLoadFailed: () => '사용자 슬래시 명령을 불러오지 못했습니다.',
  skillsLoadFailed: () => 'Skills를 불러오지 못했습니다.',
  historyLoadFailed: () => '대화 기록을 불러오지 못했습니다.',
  goalsLoadFailed: () => 'Goals를 불러오지 못했습니다.',
  workspaceDetailsLoadFailed: () => '워크스페이스 정보를 불러오지 못했습니다.',
  modelsLoadFailed: () => '모델 목록을 불러오지 못했습니다.',
  bootstrapLoadFailed: () => '앱 정보를 불러오지 못했습니다.',
  filesChanged: ({ count, undoAvailable }: { count: number; undoAvailable: boolean }) =>
    `파일 ${count}개가 변경되었습니다.${undoAvailable ? ' 상단의 되돌리기를 사용할 수 있습니다.' : ''}`,
  workspaceOpenFailed: () => '작업 공간을 열지 못했습니다.',
  fileReadFailed: () => '파일을 읽지 못했습니다.',
  contextLimit: () => '컨텍스트에는 파일을 최대 20개까지 추가할 수 있습니다.',
  modelSaveFailed: () => '모델 설정을 저장하지 못했습니다.',
  runStartFailed: () => '응답을 시작하지 못했습니다.',
  runCancelFailed: () => '응답을 중지하지 못했습니다.',
  trustPartialLoadFailed: () =>
    '워크스페이스는 신뢰했지만 사용자 명령 또는 Skills를 불러오지 못했습니다.',
  workspaceTrusted: ({ commandCount, skillCount }: { commandCount: number; skillCount: number }) =>
    `워크스페이스를 신뢰했습니다. 사용자 명령 ${commandCount}개 · Skill ${skillCount}개를 사용할 수 있습니다.`,
  restrictedModeEnabled: () => '제한 모드로 전환했습니다. 직접 선택한 파일 컨텍스트는 유지됩니다.',
  trustChangeFailed: () => '신뢰 설정을 변경하지 못했습니다.',
  approvalResolveFailed: () => '승인 결정을 전달하지 못했습니다.',
  conversationMissing: () => '대화가 삭제되었거나 더 이상 존재하지 않습니다.',
  conversationOpenFailed: () => '대화를 열지 못했습니다.',
  conversationForked: () => '원본을 보존한 새 대화 분기를 열었습니다.',
  conversationForkFailed: () => '대화를 분기하지 못했습니다.',
  conversationArchived: () => '대화를 보관했습니다.',
  conversationArchiveFailed: () => '대화를 보관하지 못했습니다.',
  conversationDeleted: () => '대화를 영구 삭제했습니다.',
  conversationDeleteFailed: () => '대화를 삭제하지 못했습니다.',
  goalLoadFailed: () => 'Goal을 불러오지 못했습니다.',
  goalOperationBusy: () => '다른 Goal 작업이 진행 중입니다.',
  goalCreated: () => 'Goal을 만들었습니다.',
  goalCreateFailed: () => 'Goal을 만들지 못했습니다.',
  goalUpdated: () => 'Goal 상태를 갱신했습니다.',
  goalUpdateFailed: () => 'Goal 상태를 갱신하지 못했습니다.',
  goalTrustRequired: () => 'Goal을 실행하려면 현재 작업 공간을 먼저 신뢰해 주세요.',
  goalWaitRequired: () => '현재 대화의 실행이 끝난 뒤 Goal을 계속할 수 있습니다.',
  goalContinueDisplay: ({ objective }: { objective: string }) => `Goal 계속: ${objective}`,
  goalStartFailed: () => 'Goal 실행을 시작하지 못했습니다.',
  undoReloadRequired: () => '되돌릴 변경 정보를 다시 불러와 주세요.',
  filesRestored: ({ count }: { count: number }) => `파일 ${count}개를 복원했습니다.`,
  noFileChangesToUndo: () => '되돌릴 파일 변경이 없습니다.',
  undoFailed: () => '마지막 변경을 되돌리지 못했습니다.',
  providerRequired: () => '설정에서 AI 공급자를 연결해 주세요.',
  modelsLoading: () => '모델 목록을 불러오는 중…',
  modelRequired: () => '사용할 모델을 선택해 주세요.',
  analysisWorkspaceRequired: () => '먼저 분석할 워크스페이스를 열어 주세요.',
  currentModel: ({ model }: { model: string }) => `현재 모델: ${model}`,
  contextDescription: ({ count }: { count: number }) =>
    `현재 ${count}개 첨부 · 파일을 지정하거나 미리보기의 파일을 추가합니다.`,
  commandsDescription: ({ count }: { count: number }) =>
    `워크스페이스 사용자 명령 ${count}개를 다시 검색합니다.`,
  commandsRestrictedDescription: () =>
    '제한 모드에서는 워크스페이스 사용자 명령을 불러오지 않습니다.',
  workspaceTrustRequired: () => '사용하려면 먼저 워크스페이스를 신뢰해 주세요.',
  workspaceRequired: () => '먼저 워크스페이스를 열어 주세요.',
  noContextToRemove: () => '제거할 파일 컨텍스트가 없습니다.',
  noApprovedChangesToUndo: () => '되돌릴 수 있는 승인된 파일 변경이 없습니다.',
  noAnswerToCopy: () => '복사할 AI 답변이 없습니다.',
  sourceApp: () => '앱',
  workspacePromptDescription: ({ path }: { path: string }) => `${path}의 사용자 프롬프트`,
  userPromptCategory: () => '사용자 프롬프트',
  sourceWorkspace: () => '워크스페이스',
  workspacePromptsRestricted: () =>
    '제한 모드에서는 워크스페이스 사용자 프롬프트를 실행하지 않습니다.',
  contextPathRequired: () =>
    '/context 뒤에 파일 경로를 입력하거나 탐색기에서 파일을 선택해 주세요.',
  ambiguousFile: ({ path }: { path: string }) =>
    `“${path}”와 일치하는 파일이 여러 개입니다. 워크스페이스 상대 경로를 입력해 주세요.`,
  fileAlreadyInContext: ({ path }: { path: string }) => `${path} 파일은 이미 컨텍스트에 있습니다.`,
  fileAddedToContext: ({ path }: { path: string }) => `${path} 파일을 컨텍스트에 추가했습니다.`,
  commandTakesNoArguments: ({ command }: { command: string }) =>
    `/${command} 명령은 인수를 받지 않습니다.`,
  newConversationStarted: () => '새 대화를 시작하고 파일 컨텍스트를 비웠습니다.',
  conversationCleared: () => '첨부 파일을 유지한 채 대화 기록을 비웠습니다.',
  lastAnswerCopied: () => '마지막 AI 답변을 복사했습니다.',
  workspaceRefreshFailed: () => '워크스페이스 새로고침을 완료하지 못했습니다.',
  workspaceRefreshed: ({
    commandCount,
    skillCount,
  }: {
    commandCount: number
    skillCount: number
  }) => `파일 탐색기 · 사용자 명령 ${commandCount}개 · Skill ${skillCount}개를 새로고침했습니다.`,
  commandsRefreshFailed: () => '사용자 명령을 다시 검색하지 못했습니다.',
  commandsFound: ({ count }: { count: number }) =>
    `워크스페이스 사용자 명령 ${count}개를 찾았습니다.`,
  contextCleared: () => '파일 컨텍스트를 모두 제거했습니다.',
  gitDiffLoadFailed: () => 'Git diff를 불러오지 못했습니다.',
  skillsTrustRequired: () => 'Skills를 사용하려면 먼저 워크스페이스를 신뢰해 주세요.',
  noCurrentModel: () => '현재 선택한 모델이 없습니다.',
  modelNotFound: ({ model }: { model: string }) => `불러온 모델에서 “${model}”을 찾지 못했습니다.`,
  ambiguousModel: ({ examples, hasMore }: { examples: string; hasMore: boolean }) =>
    `모델 이름이 모호합니다: ${examples}${hasMore ? ' 외' : ''}`,
  modelSwitchTargetMissing: () => '전환할 모델을 찾지 못했습니다.',
  modelAlreadyActive: ({ model }: { model: string }) => `이미 ${model} 모델을 사용 중입니다.`,
  modelSwitchFailed: () => '모델을 전환하지 못했습니다.',
  modelSwitched: ({ model }: { model: string }) => `${model} 모델로 전환했습니다.`,
  currentTheme: ({ theme }: { theme: AppSettings['theme'] }) => `현재 테마: ${theme}`,
  invalidTheme: () => '테마는 system, dark, light 중 하나여야 합니다.',
  themeSwitched: ({ theme }: { theme: AppSettings['theme'] }) => `${theme} 테마로 전환했습니다.`,
  statusSummary: ({
    workspace,
    model,
    contextCount,
    commandCount,
    skillCount,
    trusted,
  }: {
    workspace: string | null
    model: string | null
    contextCount: number
    commandCount: number
    skillCount: number
    trusted: boolean
  }) =>
    [
      `워크스페이스: ${workspace ?? '없음'}`,
      `모델: ${model ?? '없음'}`,
      `컨텍스트: ${contextCount}개`,
      `사용자 명령: ${commandCount}개`,
      `Skills: ${skillCount}개`,
      `신뢰: ${trusted ? '신뢰함' : '제한 모드'}`,
    ].join(' · '),
  invalidSlashCommand: () =>
    '올바른 슬래시 명령을 입력해 주세요. / 를 입력하면 명령 목록이 열립니다.',
  unknownCommand: ({ command }: { command: string }) => `알 수 없는 명령입니다: /${command}`,
  workspacePromptTrustRequired: () =>
    '워크스페이스 사용자 프롬프트를 사용하려면 먼저 신뢰해 주세요.',
  commandExecutionFailed: () => '명령을 실행하지 못했습니다.',
} as const

type RuntimeMessageCatalog = {
  [Key in keyof typeof ko]: (...args: Parameters<(typeof ko)[Key]>) => string
}

const en: RuntimeMessageCatalog = {
  workspaceLoadFailed: () => 'Could not load workspace files.',
  slashCommandsLoadFailed: () => 'Could not load custom slash commands.',
  skillsLoadFailed: () => 'Could not load skills.',
  historyLoadFailed: () => 'Could not load conversation history.',
  goalsLoadFailed: () => 'Could not load Goals.',
  workspaceDetailsLoadFailed: () => 'Could not load workspace details.',
  modelsLoadFailed: () => 'Could not load the model list.',
  bootstrapLoadFailed: () => 'Could not load application information.',
  filesChanged: ({ count, undoAvailable }) =>
    `${count} file${count === 1 ? '' : 's'} changed.${undoAvailable ? ' You can undo the changes from the top bar.' : ''}`,
  workspaceOpenFailed: () => 'Could not open the workspace.',
  fileReadFailed: () => 'Could not read the file.',
  contextLimit: () => 'You can add up to 20 files to the context.',
  modelSaveFailed: () => 'Could not save the model setting.',
  runStartFailed: () => 'Could not start the response.',
  runCancelFailed: () => 'Could not stop the response.',
  trustPartialLoadFailed: () =>
    'The workspace is trusted, but custom commands or skills could not be loaded.',
  workspaceTrusted: ({ commandCount, skillCount }) =>
    `Workspace trusted. ${commandCount} custom command${commandCount === 1 ? '' : 's'} and ${skillCount} skill${skillCount === 1 ? '' : 's'} are available.`,
  restrictedModeEnabled: () =>
    'Restricted mode enabled. Manually selected file context has been preserved.',
  trustChangeFailed: () => 'Could not change the trust setting.',
  approvalResolveFailed: () => 'Could not submit the approval decision.',
  conversationMissing: () => 'This conversation was deleted or no longer exists.',
  conversationOpenFailed: () => 'Could not open the conversation.',
  conversationForked: () => 'Opened a new conversation branch while preserving the original.',
  conversationForkFailed: () => 'Could not fork the conversation.',
  conversationArchived: () => 'Conversation archived.',
  conversationArchiveFailed: () => 'Could not archive the conversation.',
  conversationDeleted: () => 'Conversation permanently deleted.',
  conversationDeleteFailed: () => 'Could not delete the conversation.',
  goalLoadFailed: () => 'Could not load the Goal.',
  goalOperationBusy: () => 'Another Goal operation is in progress.',
  goalCreated: () => 'Goal created.',
  goalCreateFailed: () => 'Could not create the Goal.',
  goalUpdated: () => 'Goal status updated.',
  goalUpdateFailed: () => 'Could not update the Goal status.',
  goalTrustRequired: () => 'Trust the current workspace before running this Goal.',
  goalWaitRequired: () => 'You can continue the Goal after the current run finishes.',
  goalContinueDisplay: ({ objective }) => `Continue Goal: ${objective}`,
  goalStartFailed: () => 'Could not start the Goal run.',
  undoReloadRequired: () => 'Reload the change details before undoing.',
  filesRestored: ({ count }) => `Restored ${count} file${count === 1 ? '' : 's'}.`,
  noFileChangesToUndo: () => 'There are no file changes to undo.',
  undoFailed: () => 'Could not undo the last change.',
  providerRequired: () => 'Connect an AI provider in Settings.',
  modelsLoading: () => 'Loading models…',
  modelRequired: () => 'Select a model to use.',
  analysisWorkspaceRequired: () => 'Open a workspace to analyze first.',
  currentModel: ({ model }) => `Current model: ${model}`,
  contextDescription: ({ count }) =>
    `${count} file${count === 1 ? '' : 's'} attached · Specify a file or add the previewed file.`,
  commandsDescription: ({ count }) =>
    `Find the ${count} workspace command${count === 1 ? '' : 's'} again.`,
  commandsRestrictedDescription: () => 'Workspace commands are not loaded in restricted mode.',
  workspaceTrustRequired: () => 'Trust the workspace first.',
  workspaceRequired: () => 'Open a workspace first.',
  noContextToRemove: () => 'There is no file context to remove.',
  noApprovedChangesToUndo: () => 'There are no approved file changes to undo.',
  noAnswerToCopy: () => 'There is no AI response to copy.',
  sourceApp: () => 'App',
  workspacePromptDescription: ({ path }) => `Custom prompt from ${path}`,
  userPromptCategory: () => 'Custom prompts',
  sourceWorkspace: () => 'Workspace',
  workspacePromptsRestricted: () => 'Workspace prompts cannot run in restricted mode.',
  contextPathRequired: () => 'Enter a file path after /context, or select a file in the explorer.',
  ambiguousFile: ({ path }) => `Multiple files match “${path}”. Enter a workspace-relative path.`,
  fileAlreadyInContext: ({ path }) => `${path} is already in the context.`,
  fileAddedToContext: ({ path }) => `Added ${path} to the context.`,
  commandTakesNoArguments: ({ command }) => `/${command} does not accept arguments.`,
  newConversationStarted: () => 'Started a new conversation and cleared the file context.',
  conversationCleared: () => 'Cleared the conversation while preserving attached files.',
  lastAnswerCopied: () => 'Copied the latest AI response.',
  workspaceRefreshFailed: () => 'Could not finish refreshing the workspace.',
  workspaceRefreshed: ({ commandCount, skillCount }) =>
    `Refreshed the explorer, ${commandCount} custom command${commandCount === 1 ? '' : 's'}, and ${skillCount} skill${skillCount === 1 ? '' : 's'}.`,
  commandsRefreshFailed: () => 'Could not refresh custom commands.',
  commandsFound: ({ count }) => `Found ${count} workspace command${count === 1 ? '' : 's'}.`,
  contextCleared: () => 'Removed all file context.',
  gitDiffLoadFailed: () => 'Could not load the Git diff.',
  skillsTrustRequired: () => 'Trust the workspace before using skills.',
  noCurrentModel: () => 'No model is currently selected.',
  modelNotFound: ({ model }) => `Could not find “${model}” in the loaded models.`,
  ambiguousModel: ({ examples, hasMore }) =>
    `The model name is ambiguous: ${examples}${hasMore ? ', and more' : ''}`,
  modelSwitchTargetMissing: () => 'Could not find a model to switch to.',
  modelAlreadyActive: ({ model }) => `${model} is already active.`,
  modelSwitchFailed: () => 'Could not switch models.',
  modelSwitched: ({ model }) => `Switched to ${model}.`,
  currentTheme: ({ theme }) => `Current theme: ${theme}`,
  invalidTheme: () => 'Theme must be system, dark, or light.',
  themeSwitched: ({ theme }) => `Switched to the ${theme} theme.`,
  statusSummary: ({ workspace, model, contextCount, commandCount, skillCount, trusted }) =>
    [
      `Workspace: ${workspace ?? 'None'}`,
      `Model: ${model ?? 'None'}`,
      `Context: ${contextCount}`,
      `Custom commands: ${commandCount}`,
      `Skills: ${skillCount}`,
      `Trust: ${trusted ? 'Trusted' : 'Restricted mode'}`,
    ].join(' · '),
  invalidSlashCommand: () => 'Enter a valid slash command. Type / to open the command list.',
  unknownCommand: ({ command }) => `Unknown command: /${command}`,
  workspacePromptTrustRequired: () => 'Trust the workspace before using its custom prompts.',
  commandExecutionFailed: () => 'Could not run the command.',
}

const catalogs: Record<AppLocale, RuntimeMessageCatalog> = { ko, en }

export type RuntimeMessage = <Key extends keyof RuntimeMessageCatalog>(
  key: Key,
  ...args: Parameters<RuntimeMessageCatalog[Key]>
) => string

export function useRuntimeMessages(): RuntimeMessage {
  const { locale } = useI18n()
  return useCallback(
    (<Key extends keyof RuntimeMessageCatalog>(
      key: Key,
      ...args: Parameters<RuntimeMessageCatalog[Key]>
    ) => {
      const message = catalogs[locale][key] as (
        ...values: Parameters<RuntimeMessageCatalog[Key]>
      ) => string
      return message(...args)
    }) as RuntimeMessage,
    [locale],
  )
}
