import { type AgentRunIntent, type AppLocale, DEFAULT_APP_LOCALE } from './contracts'

export type BuiltinCommandAction =
  | 'clear'
  | 'commands'
  | 'context'
  | 'context-clear'
  | 'copy'
  | 'git-diff'
  | 'git-status'
  | 'history'
  | 'model'
  | 'new'
  | 'refresh'
  | 'settings'
  | 'skills'
  | 'status'
  | 'theme'
  | 'undo'
  | 'workspace'

export type BuiltinWorkflowCommandName = 'review' | 'explain' | 'plan' | 'tests'
export type BuiltinCommandName = BuiltinCommandAction | BuiltinWorkflowCommandName

export interface BuiltinLocalCommand {
  id: `app:${string}`
  name: BuiltinCommandName
  description: string
  argumentHint?: string
  category: string
  keywords: string[]
  source: 'app'
  kind: 'local'
  action: BuiltinCommandAction
}

export interface BuiltinPromptCommand {
  id: `workflow:${string}`
  name: BuiltinCommandName
  description: string
  argumentHint?: string
  category: string
  keywords: string[]
  source: 'workflow'
  kind: 'prompt'
  intent: AgentRunIntent
  buildPrompt: (argumentsText: string) => string
}

export type BuiltinSlashCommand = BuiltinLocalCommand | BuiltinPromptCommand

/** Parses one optional local-command argument while preserving unquoted spaces in paths/model IDs. */
export type BuiltinCommandArgumentErrorCode =
  | 'DOUBLE_QUOTE_UNTERMINATED'
  | 'ARGUMENT_NOT_STRING'
  | 'DOUBLE_QUOTE_INVALID_ESCAPE'
  | 'SINGLE_QUOTE_UNTERMINATED'

const ARGUMENT_ERROR_MESSAGES: Record<
  AppLocale,
  Record<BuiltinCommandArgumentErrorCode, string>
> = {
  ko: {
    DOUBLE_QUOTE_UNTERMINATED: '명령 인수의 큰따옴표가 닫히지 않았습니다.',
    ARGUMENT_NOT_STRING: '명령 인수는 문자열이어야 합니다.',
    DOUBLE_QUOTE_INVALID_ESCAPE: '큰따옴표 명령 인수의 이스케이프가 올바르지 않습니다.',
    SINGLE_QUOTE_UNTERMINATED: '명령 인수의 작은따옴표가 닫히지 않았습니다.',
  },
  en: {
    DOUBLE_QUOTE_UNTERMINATED: 'The double quote in the command argument is not closed.',
    ARGUMENT_NOT_STRING: 'The command argument must be a string.',
    DOUBLE_QUOTE_INVALID_ESCAPE: 'The quoted command argument contains an invalid escape.',
    SINGLE_QUOTE_UNTERMINATED: 'The single quote in the command argument is not closed.',
  },
}

export class BuiltinCommandArgumentError extends Error {
  readonly code: BuiltinCommandArgumentErrorCode

  constructor(code: BuiltinCommandArgumentErrorCode, locale: AppLocale) {
    super(ARGUMENT_ERROR_MESSAGES[locale][code])
    this.name = 'BuiltinCommandArgumentError'
    this.code = code
  }
}

export function parseSingleCommandArgument(
  value: string,
  locale: AppLocale = DEFAULT_APP_LOCALE,
): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed

  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"')) {
      throw new BuiltinCommandArgumentError('DOUBLE_QUOTE_UNTERMINATED', locale)
    }
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'string') {
        throw new BuiltinCommandArgumentError('ARGUMENT_NOT_STRING', locale)
      }
      return parsed
    } catch (cause) {
      if (cause instanceof BuiltinCommandArgumentError) throw cause
      throw new BuiltinCommandArgumentError('DOUBLE_QUOTE_INVALID_ESCAPE', locale)
    }
  }

  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'")) {
      throw new BuiltinCommandArgumentError('SINGLE_QUOTE_UNTERMINATED', locale)
    }
    return trimmed.slice(1, -1)
  }

  return trimmed
}

const localCommand = (
  command: Omit<BuiltinLocalCommand, 'id' | 'source' | 'kind'>,
): BuiltinLocalCommand => ({
  ...command,
  id: `app:${command.name}`,
  source: 'app',
  kind: 'local',
})

const promptCommand = (
  command: Omit<BuiltinPromptCommand, 'id' | 'source' | 'kind' | 'buildPrompt'> & {
    instruction: string
    fallbackTarget: string
  },
): BuiltinPromptCommand => ({
  id: `workflow:${command.name}`,
  name: command.name,
  description: command.description,
  argumentHint: command.argumentHint,
  category: command.category,
  keywords: command.keywords,
  source: 'workflow',
  kind: 'prompt',
  intent: command.intent,
  buildPrompt: (argumentsText) => {
    const target = argumentsText.trim() || command.fallbackTarget
    return [
      command.instruction,
      'Use the available workspace tools to inspect the relevant source before answering. Base conclusions on repository evidence and cite workspace-relative paths when useful.',
      `Requested focus: ${JSON.stringify(target)}`,
    ].join('\n')
  },
})

/**
 * Commands implemented by the application itself. Provider, model, workspace, file, and context
 * values are resolved at execution time; this registry contains behavior and discoverability only.
 */
export const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
  localCommand({
    name: 'new',
    description: '첨부 컨텍스트까지 비우고 새 대화를 시작합니다.',
    category: '대화',
    keywords: ['새 대화', 'reset', 'conversation'],
    action: 'new',
  }),
  localCommand({
    name: 'clear',
    description: '첨부 파일은 유지하고 대화 기록만 비웁니다.',
    category: '대화',
    keywords: ['기록', '초기화', 'history'],
    action: 'clear',
  }),
  localCommand({
    name: 'copy',
    description: '마지막 AI 답변을 클립보드에 복사합니다.',
    category: '대화',
    keywords: ['복사', 'clipboard', 'answer'],
    action: 'copy',
  }),
  localCommand({
    name: 'workspace',
    description: '다른 워크스페이스 폴더를 선택합니다.',
    category: '워크스페이스',
    keywords: ['폴더', '저장소', 'repo', 'open'],
    action: 'workspace',
  }),
  localCommand({
    name: 'refresh',
    description: '파일 탐색기와 사용자 명령을 다시 검색합니다.',
    category: '워크스페이스',
    keywords: ['새로고침', 'reload', 'commands'],
    action: 'refresh',
  }),
  localCommand({
    name: 'commands',
    description: '워크스페이스의 사용자 슬래시 명령을 다시 검색합니다.',
    category: '워크스페이스',
    keywords: ['명령', '프롬프트', 'reload', 'discover'],
    action: 'commands',
  }),
  localCommand({
    name: 'context',
    description: '현재 파일 또는 지정한 워크스페이스 파일을 컨텍스트에 추가합니다.',
    argumentHint: '[path]',
    category: '워크스페이스',
    keywords: ['파일', '첨부', 'attach', 'path'],
    action: 'context',
  }),
  localCommand({
    name: 'context-clear',
    description: '첨부한 파일 컨텍스트를 모두 제거합니다.',
    category: '워크스페이스',
    keywords: ['파일', '첨부', '제거', 'detach'],
    action: 'context-clear',
  }),
  localCommand({
    name: 'git-status',
    description: '현재 브랜치와 Git 작업 트리 상태를 엽니다.',
    category: '워크스페이스',
    keywords: ['git', '상태', 'branch', 'changes'],
    action: 'git-status',
  }),
  localCommand({
    name: 'git-diff',
    description: '전체 또는 지정 경로의 unstaged Git diff를 엽니다.',
    argumentHint: '[path]',
    category: '워크스페이스',
    keywords: ['git', 'diff', '변경', 'patch'],
    action: 'git-diff',
  }),
  localCommand({
    name: 'skills',
    description: '신뢰한 워크스페이스의 Skills를 검색하고 엽니다.',
    category: '워크스페이스',
    keywords: ['skills', '확장', 'workflow', 'repository'],
    action: 'skills',
  }),
  localCommand({
    name: 'undo',
    description: '마지막으로 승인해 적용한 파일 변경의 되돌리기 화면을 엽니다.',
    category: '워크스페이스',
    keywords: ['undo', '되돌리기', 'rollback', 'change'],
    action: 'undo',
  }),
  localCommand({
    name: 'history',
    description: '저장된 대화의 검색·복원·분기·보관 화면을 엽니다.',
    category: '대화',
    keywords: ['history', '대화', 'resume', 'fork'],
    action: 'history',
  }),
  localCommand({
    name: 'model',
    description: '현재 모델을 확인하거나 불러온 모델 중 하나로 전환합니다.',
    argumentHint: '[model-id]',
    category: '앱',
    keywords: ['모델', 'provider', 'switch'],
    action: 'model',
  }),
  localCommand({
    name: 'theme',
    description: '현재 테마를 확인하거나 system, dark, light 중 하나로 전환합니다.',
    argumentHint: '[system|dark|light]',
    category: '앱',
    keywords: ['테마', '다크', '라이트', 'appearance'],
    action: 'theme',
  }),
  localCommand({
    name: 'settings',
    description: '공급자, 모델, 테마 설정을 엽니다.',
    category: '앱',
    keywords: ['설정', 'provider', 'api key'],
    action: 'settings',
  }),
  localCommand({
    name: 'status',
    description: '현재 워크스페이스, 모델, 컨텍스트 상태를 확인합니다.',
    category: '앱',
    keywords: ['상태', '정보', 'info'],
    action: 'status',
  }),
  promptCommand({
    name: 'review',
    description: '정확성, 보안, 회귀, 테스트 관점에서 코드를 검토합니다.',
    argumentHint: '[focus]',
    category: 'AI 워크플로',
    keywords: ['리뷰', '검토', 'security', 'bug'],
    intent: 'answer',
    instruction:
      'Perform a focused code review. Report actionable findings in severity order, including the reason, impact, and a concrete remediation. If no actionable issue is found, say so and identify residual risks or untested areas.',
    fallbackTarget: 'Select the most relevant central code in the current workspace.',
  }),
  promptCommand({
    name: 'explain',
    description: '선택한 대상의 구조와 실행 흐름을 근거와 함께 설명합니다.',
    argumentHint: '[target]',
    category: 'AI 워크플로',
    keywords: ['설명', 'architecture', 'flow'],
    intent: 'answer',
    instruction:
      'Explain the requested code or subsystem clearly. Cover its responsibility, important data flow, dependencies, and noteworthy edge cases at the level appropriate for a developer joining the project.',
    fallbackTarget: 'Infer the most useful architectural entry point from the current workspace.',
  }),
  promptCommand({
    name: 'plan',
    description: '목표를 구현 가능한 작업 계획으로 구체화합니다.',
    argumentHint: '<goal>',
    category: 'AI 워크플로',
    keywords: ['계획', '설계', 'implementation'],
    intent: 'plan',
    instruction:
      'Create an implementation plan for the requested goal. Identify the existing code that must change, key design choices, ordered implementation steps, verification, and risks. Do not claim that files were modified.',
    fallbackTarget: 'Derive a high-value improvement from the current workspace and plan it.',
  }),
  promptCommand({
    name: 'tests',
    description: '대상의 실패 모드와 의미 있는 테스트 케이스를 설계합니다.',
    argumentHint: '[target]',
    category: 'AI 워크플로',
    keywords: ['테스트', 'coverage', 'edge case'],
    intent: 'answer',
    instruction:
      'Design a practical test strategy for the requested target. Inspect the current test conventions, prioritize realistic failure modes and regressions, and propose concrete test cases with the right test level. Include sample code only when it improves precision.',
    fallbackTarget: 'Identify the current workspace area with the most valuable missing coverage.',
  }),
]

interface LocalizedBuiltinCommandMetadata {
  description: string
  category: string
  keywords: readonly string[]
}

const ENGLISH_BUILTIN_COMMAND_METADATA = {
  new: {
    description: 'Start a new conversation and clear all attached file context.',
    category: 'Conversation',
    keywords: ['new conversation', 'reset', 'conversation'],
  },
  clear: {
    description: 'Clear the conversation history while keeping attached files.',
    category: 'Conversation',
    keywords: ['history', 'clear', 'reset'],
  },
  copy: {
    description: 'Copy the latest AI response to the clipboard.',
    category: 'Conversation',
    keywords: ['copy', 'clipboard', 'answer'],
  },
  workspace: {
    description: 'Select a different workspace folder.',
    category: 'Workspace',
    keywords: ['folder', 'repository', 'repo', 'open'],
  },
  refresh: {
    description: 'Refresh the file explorer and rediscover workspace commands.',
    category: 'Workspace',
    keywords: ['refresh', 'reload', 'files', 'commands'],
  },
  commands: {
    description: 'Rediscover slash commands from the current workspace.',
    category: 'Workspace',
    keywords: ['commands', 'prompts', 'reload', 'discover'],
  },
  context: {
    description: 'Add the current or specified workspace file to context.',
    category: 'Workspace',
    keywords: ['file', 'context', 'attach', 'path'],
  },
  'context-clear': {
    description: 'Remove all attached file context.',
    category: 'Workspace',
    keywords: ['file', 'context', 'remove', 'detach'],
  },
  'git-status': {
    description: 'Open the current branch and Git working tree status.',
    category: 'Workspace',
    keywords: ['git', 'status', 'branch', 'changes'],
  },
  'git-diff': {
    description: 'Open the unstaged Git diff for all files or a specified path.',
    category: 'Workspace',
    keywords: ['git', 'diff', 'changes', 'patch'],
  },
  skills: {
    description: 'Discover and open Skills from the trusted workspace.',
    category: 'Workspace',
    keywords: ['skills', 'extensions', 'workflow', 'repository'],
  },
  undo: {
    description: 'Open the restore screen for the last approved file change.',
    category: 'Workspace',
    keywords: ['undo', 'restore', 'rollback', 'change'],
  },
  history: {
    description: 'Search, resume, fork, or archive saved conversations.',
    category: 'Conversation',
    keywords: ['history', 'conversation', 'resume', 'fork'],
  },
  model: {
    description: 'Show the current model or switch to an available model.',
    category: 'App',
    keywords: ['model', 'provider', 'switch'],
  },
  theme: {
    description: 'Show or change the current system, dark, or light theme.',
    category: 'App',
    keywords: ['theme', 'dark', 'light', 'appearance'],
  },
  settings: {
    description: 'Open provider, model, theme, and app settings.',
    category: 'App',
    keywords: ['settings', 'provider', 'api key', 'preferences'],
  },
  status: {
    description: 'Show the current workspace, model, context, and trust status.',
    category: 'App',
    keywords: ['status', 'information', 'info'],
  },
  review: {
    description: 'Review code for correctness, security, regressions, and test coverage.',
    category: 'AI workflow',
    keywords: ['review', 'security', 'bug', 'regression'],
  },
  explain: {
    description: 'Explain the selected structure and execution flow using repository evidence.',
    category: 'AI workflow',
    keywords: ['explain', 'architecture', 'flow'],
  },
  plan: {
    description: 'Turn a goal into a concrete, actionable implementation plan.',
    category: 'AI workflow',
    keywords: ['plan', 'design', 'implementation'],
  },
  tests: {
    description: 'Design failure modes and meaningful test cases for the selected target.',
    category: 'AI workflow',
    keywords: ['tests', 'coverage', 'edge case'],
  },
} as const satisfies Record<BuiltinCommandName, LocalizedBuiltinCommandMetadata>

/**
 * Returns localized, renderer-facing metadata without changing command identity or behavior.
 * Search keywords remain bilingual so switching the app language never makes a known command
 * undiscoverable by its previous-language terms.
 */
export function localizeBuiltinSlashCommands(locale: AppLocale): BuiltinSlashCommand[] {
  return BUILTIN_SLASH_COMMANDS.map((command) => {
    if (locale === 'ko') {
      return { ...command, keywords: [...command.keywords] }
    }
    const localized = ENGLISH_BUILTIN_COMMAND_METADATA[command.name]
    return {
      ...command,
      description: localized.description,
      category: localized.category,
      keywords: [...new Set([...command.keywords, ...localized.keywords])],
    }
  })
}

export function findBuiltinSlashCommand(name: string): BuiltinSlashCommand | undefined {
  const normalized = name.trim().toLocaleLowerCase()
  return BUILTIN_SLASH_COMMANDS.find((command) => command.name === normalized)
}
