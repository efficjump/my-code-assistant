import { z } from 'zod'
import type { AppLocale } from '../../shared/contracts'

export const MAX_RECOVERY_NOTICE_COUNT = 32
export const MAX_RECOVERY_NOTICE_CHARACTERS = 12_000
const MAX_RECOVERY_PATHS = 100
const MAX_RECOVERY_PATH_CHARACTERS = 4_096
const MAX_RECOVERY_REASON_CHARACTERS = 4_000

export type HostEffectKind = 'workspace-change' | 'process' | 'mcp'
export type HostInterruptionCause = 'provider-transport' | 'run-interruption'

export type HostValidationIssue =
  | { kind: 'invalid-type'; expected: string }
  | {
      kind: 'too-small' | 'too-big'
      origin: string
      bound: string
      inclusive: boolean
      exact: boolean
    }
  | { kind: 'invalid-format'; format: string }
  | { kind: 'not-multiple-of'; divisor: string }
  | { kind: 'unrecognized-keys'; keys: string[] }
  | { kind: 'invalid-value'; values: string[] }
  | { kind: 'invalid-union' }
  | { kind: 'invalid-key'; origin: string }
  | { kind: 'invalid-element'; origin: string }
  | {
      kind: 'custom'
      rule: 'action-effect-required' | 'response-effect-forbidden' | 'invalid-value'
    }

export type HostRecoveryNotice =
  | { type: 'conversation-database-quarantined'; backupPath: string }
  | { type: 'file-mutations-recovered'; actionCount: number; paths: string[] }
  | { type: 'file-mutation-recovery-failed'; reason: string | null }
  | { type: 'credential-migration-incomplete' }
  | { type: 'invalid-recovery-notice' }

const boundedRecoveryText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        [...value].every((character) => {
          const codePoint = character.codePointAt(0) ?? 0
          return codePoint > 0x1f && codePoint !== 0x7f
        }),
      'Recovery text must not contain control characters.',
    )

const hostRecoveryNoticeSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('conversation-database-quarantined'),
      backupPath: boundedRecoveryText(MAX_RECOVERY_PATH_CHARACTERS),
    })
    .strict(),
  z
    .object({
      type: z.literal('file-mutations-recovered'),
      actionCount: z.number().int().min(0).max(10_000),
      paths: z
        .array(boundedRecoveryText(MAX_RECOVERY_PATH_CHARACTERS))
        .min(1)
        .max(MAX_RECOVERY_PATHS)
        .refine(
          (paths) =>
            paths.reduce((characters, path) => characters + path.length, 0) <=
            MAX_RECOVERY_NOTICE_CHARACTERS,
          'Recovery paths exceed the aggregate character limit.',
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal('file-mutation-recovery-failed'),
      reason: boundedRecoveryText(MAX_RECOVERY_REASON_CHARACTERS).nullable(),
    })
    .strict(),
  z.object({ type: z.literal('credential-migration-incomplete') }).strict(),
  z.object({ type: z.literal('invalid-recovery-notice') }).strict(),
])

interface HostMessageCatalog {
  tool: {
    fallback: (tool: string) => string
    completed: (summary: string) => string
    failed: (summary: string, failure: string) => string
    unknownFailure: string
    listFiles: (path: string | null) => string
    readFile: (path: string) => string
    searchText: (query: string, path: string | null) => string
    gitStatus: string
    gitDiff: (path: string | null) => string
    listSkills: string
    readSkill: (id: string) => string
    readGoal: string
    updateGoalPlan: string
    checkpointGoal: string
    finishGoal: (status: 'completed' | 'blocked') => string
    proposeChanges: (summary: string) => string
    proposePatches: (summary: string) => string
    runCommand: (summary: string) => string
    mcpRequest: (serverId: string, toolName: string) => string
    mcpServerStart: string
    mcpFallback: string
    validationFailed: (issues: string[], omitted: number) => string
    validationInputPath: string
    validationInvalidValue: string
    validationIssue: (issue: HostValidationIssue) => string
  }
  lifecycle: {
    unknownError: string
    newConversationTitle: string
    selectProvider: string
    selectModel: string
    providerNotFound: (providerId: string) => string
    goalToolsUnsupported: string
    conversationBindingMismatch: string
    archivedConversation: string
    assistantResponseLimit: (characters: number) => string
    assistantPersistenceFailed: (failure: string) => string
    providerFinalReportMissing: string
    providerTurnMissing: string
    completionPolicyExhausted: string
    toolBudgetExhausted: string
    requiredToolMissing: string
    completionContractMissing: string
    completionContractInvalidJson: string
    cancelled: string
    timeout: (minutes: number) => string
    timeoutAfterEffect: string
    interruptedAfterEffect: string
    providerInterruptedAfterEffect: string
    postEffectHeading: string
    fileChangesApplied: (paths: string[]) => string
    fileChangesAppliedWithoutPaths: string
    processApplied: string
    mcpApplied: string
    postEffectFooter: (cause: HostInterruptionCause) => string
    persistenceAlsoFailed: (failure: string) => string
  }
  recovery: {
    conversationDatabaseQuarantined: (backupPath: string) => string
    fileMutationsRecovered: (actionCount: number, paths: string[]) => string
    fileMutationRecoveryFailed: (reason: string | null) => string
    credentialMigrationIncomplete: string
    invalidNotice: string
    interruptedRunReason: string
    interruptedSubagentReason: string
  }
}

const koreanValidationTerm = (value: string): string =>
  ({
    array: '배열',
    bigint: '큰 정수',
    boolean: '불리언',
    date: '날짜',
    file: '파일',
    function: '함수',
    int: '정수',
    map: '맵',
    nan: 'NaN',
    nonoptional: '필수 값',
    null: 'null',
    number: '숫자',
    object: '객체',
    record: '레코드',
    set: '집합',
    string: '문자열',
    symbol: '심볼',
    tuple: '튜플',
    undefined: 'undefined',
  })[value] ?? value

const ko: HostMessageCatalog = {
  tool: {
    fallback: (tool) => `${tool} 도구 실행`,
    completed: (summary) => `${summary} 완료`,
    failed: (summary, failure) => `${summary} 실패: ${failure}`,
    unknownFailure: '알 수 없는 오류',
    listFiles: (path) => (path ? `파일 목록 확인: ${path}` : '워크스페이스 파일 목록 확인'),
    readFile: (path) => `파일 읽기: ${path}`,
    searchText: (query, path) =>
      path ? `텍스트 검색: “${query}” (${path})` : `텍스트 검색: “${query}”`,
    gitStatus: 'Git 상태 확인',
    gitDiff: (path) => (path ? `Git diff 확인: ${path}` : 'Git diff 확인'),
    listSkills: '저장소 Skills 목록 확인',
    readSkill: (id) => `저장소 Skill 읽기: ${id}`,
    readGoal: 'Goal 상태 확인',
    updateGoalPlan: 'Goal 계획 갱신',
    checkpointGoal: 'Goal checkpoint 기록',
    finishGoal: (status) => (status === 'completed' ? 'Goal 완료 검증' : 'Goal 차단 상태 기록'),
    proposeChanges: (summary) => `파일 변경 제안: ${summary}`,
    proposePatches: (summary) => `파일 patch 제안: ${summary}`,
    runCommand: (summary) => `명령 실행 요청: ${summary}`,
    mcpRequest: (serverId, toolName) => `MCP 도구 요청: ${JSON.stringify({ serverId, toolName })}`,
    mcpServerStart: '워크스페이스 MCP 서버 시작',
    mcpFallback: 'MCP 도구 실행',
    validationFailed: (issues, omitted) =>
      issues.length > 0
        ? `도구 입력 검증 실패: ${issues.join('; ')}${omitted > 0 ? `; 외 ${omitted}건` : ''}`
        : '도구 입력 검증에 실패했습니다.',
    validationInputPath: '입력',
    validationInvalidValue: '값이 올바르지 않습니다.',
    validationIssue: (issue) => {
      switch (issue.kind) {
        case 'invalid-type':
          return `${koreanValidationTerm(issue.expected)} 형식이어야 합니다.`
        case 'too-small':
          return issue.exact
            ? `${koreanValidationTerm(issue.origin)} 크기는 ${issue.bound}이어야 합니다.`
            : `${koreanValidationTerm(issue.origin)} 크기는 ${issue.bound}${issue.inclusive ? ' 이상' : ' 초과'}이어야 합니다.`
        case 'too-big':
          return issue.exact
            ? `${koreanValidationTerm(issue.origin)} 크기는 ${issue.bound}이어야 합니다.`
            : `${koreanValidationTerm(issue.origin)} 크기는 ${issue.bound}${issue.inclusive ? ' 이하' : ' 미만'}여야 합니다.`
        case 'invalid-format':
          return `${issue.format} 형식과 일치해야 합니다.`
        case 'not-multiple-of':
          return `${issue.divisor}의 배수여야 합니다.`
        case 'unrecognized-keys':
          return `허용되지 않은 필드입니다: ${issue.keys.join(', ')}`
        case 'invalid-value':
          return issue.values.length > 0
            ? `허용되는 값 중 하나여야 합니다: ${issue.values.join(', ')}`
            : '값이 올바르지 않습니다.'
        case 'invalid-union':
          return '허용되는 입력 구조 중 하나와 일치해야 합니다.'
        case 'invalid-key':
          return `${koreanValidationTerm(issue.origin)} 키가 올바르지 않습니다.`
        case 'invalid-element':
          return `${koreanValidationTerm(issue.origin)} 항목이 올바르지 않습니다.`
        case 'custom':
          return issue.rule === 'action-effect-required'
            ? 'action 계약에는 하나 이상의 효과 유형이 필요합니다.'
            : issue.rule === 'response-effect-forbidden'
              ? 'response 계약에는 효과 유형을 지정할 수 없습니다.'
              : '값이 올바르지 않습니다.'
      }
    },
  },
  lifecycle: {
    unknownError: '알 수 없는 오류가 발생했습니다.',
    newConversationTitle: '새 대화',
    selectProvider: '활성 공급자를 먼저 선택해 주세요.',
    selectModel: '활성 모델을 먼저 선택해 주세요.',
    providerNotFound: (providerId) => `선택한 공급자를 찾을 수 없습니다: ${providerId}`,
    goalToolsUnsupported: '선택한 assistant driver는 Goal 도구 호출을 지원하지 않습니다.',
    conversationBindingMismatch: '이 대화는 현재 워크스페이스, 공급자 또는 모델에 속하지 않습니다.',
    archivedConversation:
      '보관된 대화에서는 새 작업을 시작할 수 없습니다. 먼저 대화를 복원해 주세요.',
    assistantResponseLimit: (characters) =>
      `assistant 응답이 ${characters.toLocaleString('ko-KR')}자 한도를 초과했습니다.`,
    assistantPersistenceFailed: (failure) => `assistant 메시지 저장에 실패했습니다: ${failure}`,
    providerFinalReportMissing: '공급자가 적용된 작업의 최종 보고를 생성하지 못했습니다.',
    providerTurnMissing: '공급자 응답 시도가 결과 없이 종료되었습니다.',
    completionPolicyExhausted: '공급자가 완료 조건을 충족하는 최종 답변을 생성하지 못했습니다.',
    toolBudgetExhausted:
      '요청된 작업을 완료하기 전에 설정된 도구 실행 예산이 소진되었습니다. 설정에서 도구 응답 라운드 또는 총 호출 한도를 늘려 주세요.',
    requiredToolMissing:
      '공급자가 실제 실행이 필요한 요청에서 필수 도구 호출 없이 응답을 종료했습니다.',
    completionContractMissing:
      '공급자가 실행 완료 계약을 구조화된 단일 도구 호출로 반환하지 않았습니다.',
    completionContractInvalidJson: '공급자가 반환한 실행 완료 계약이 올바른 JSON이 아닙니다.',
    cancelled: '작업이 취소되었습니다.',
    timeout: (minutes) => `응답 생성 시간이 ${minutes.toLocaleString('ko-KR')}분을 초과했습니다.`,
    timeoutAfterEffect: '작업 제한 시간에 도달했지만 이미 적용된 작업은 유지됩니다.',
    interruptedAfterEffect: '일부 작업은 적용됐지만 최종 응답을 완료하지 못했습니다.',
    providerInterruptedAfterEffect:
      '일부 작업은 적용됐지만 공급자 연결이 종료되어 최종 응답을 완료하지 못했습니다.',
    postEffectHeading: '확인된 작업 결과:',
    fileChangesApplied: (paths) =>
      `파일 ${paths.length.toLocaleString('ko-KR')}개 변경이 적용되었습니다: ${paths.join(', ')}`,
    fileChangesAppliedWithoutPaths: '파일 변경이 적용되었습니다.',
    processApplied: '요청된 명령 실행이 성공했습니다.',
    mcpApplied: '요청된 MCP 작업이 적용되었습니다.',
    postEffectFooter: (cause) =>
      cause === 'provider-transport'
        ? '공급자 연결이 최종 답변 전에 종료되어 요청 전체의 완료 여부는 확인하지 못했습니다. 위 작업은 적용된 상태로 유지됩니다. 다음 메시지에서 계속 진행하면 현재 워크스페이스를 다시 확인한 뒤 남은 작업을 이어갈 수 있습니다.'
        : '실행이 최종 답변 전에 중단되어 요청 전체의 완료 여부는 확인하지 못했습니다. 위 작업은 적용된 상태로 유지됩니다. 다음 메시지에서 계속 진행하면 현재 워크스페이스를 다시 확인한 뒤 남은 작업을 이어갈 수 있습니다.',
    persistenceAlsoFailed: (failure) => `대화 상태 저장에도 실패했습니다: ${failure}`,
  },
  recovery: {
    conversationDatabaseQuarantined: (backupPath) =>
      `손상된 대화 데이터베이스를 격리하고 새 저장소를 만들었습니다. 원본 백업: ${backupPath}`,
    fileMutationsRecovered: (actionCount, paths) =>
      `중단됐던 파일 변경 ${actionCount.toLocaleString('ko-KR')}건을 자동 복구했습니다: ${paths.join(', ')}`,
    fileMutationRecoveryFailed: (reason) =>
      `중단됐던 파일 변경을 자동 복구하지 못했습니다. 안전을 위해 새 파일 변경이 차단됩니다. ${reason ?? '알 수 없는 복구 오류'}`,
    credentialMigrationIncomplete:
      '일부 저장된 API 키를 새 보안 저장소로 이전하지 못했습니다. 해당 공급자의 API 키를 설정에서 다시 입력해 주세요.',
    invalidNotice: '복구 알림의 형식이 올바르지 않아 안전하게 표시하지 못했습니다.',
    interruptedRunReason: '앱이 종료되어 진행 중이던 작업이 중단되었습니다.',
    interruptedSubagentReason: '앱이 종료되어 진행 중이던 하위 작업이 중단되었습니다.',
  },
}

const en: HostMessageCatalog = {
  tool: {
    fallback: (tool) => `Run tool: ${tool}`,
    completed: (summary) => `${summary} completed`,
    failed: (summary, failure) => `${summary} failed: ${failure}`,
    unknownFailure: 'Unknown error',
    listFiles: (path) => (path ? `List files: ${path}` : 'List workspace files'),
    readFile: (path) => `Read file: ${path}`,
    searchText: (query, path) =>
      path ? `Search text: “${query}” (${path})` : `Search text: “${query}”`,
    gitStatus: 'Check Git status',
    gitDiff: (path) => (path ? `Check Git diff: ${path}` : 'Check Git diff'),
    listSkills: 'List repository skills',
    readSkill: (id) => `Read repository skill: ${id}`,
    readGoal: 'Check goal status',
    updateGoalPlan: 'Update goal plan',
    checkpointGoal: 'Record goal checkpoint',
    finishGoal: (status) =>
      status === 'completed' ? 'Verify goal completion' : 'Record blocked goal state',
    proposeChanges: (summary) => `Propose file changes: ${summary}`,
    proposePatches: (summary) => `Propose file patches: ${summary}`,
    runCommand: (summary) => `Request command execution: ${summary}`,
    mcpRequest: (serverId, toolName) =>
      `Request MCP tool: ${JSON.stringify({ serverId, toolName })}`,
    mcpServerStart: 'Start workspace MCP server',
    mcpFallback: 'Run MCP tool',
    validationFailed: (issues, omitted) =>
      issues.length > 0
        ? `Tool input validation failed: ${issues.join('; ')}${omitted > 0 ? `; ${omitted} more` : ''}`
        : 'Tool input validation failed.',
    validationInputPath: 'input',
    validationInvalidValue: 'Invalid value.',
    validationIssue: (issue) => {
      switch (issue.kind) {
        case 'invalid-type':
          return `Expected ${issue.expected}.`
        case 'too-small':
          return issue.exact
            ? `${issue.origin} size must be exactly ${issue.bound}.`
            : `${issue.origin} size must be ${issue.inclusive ? 'at least' : 'greater than'} ${issue.bound}.`
        case 'too-big':
          return issue.exact
            ? `${issue.origin} size must be exactly ${issue.bound}.`
            : `${issue.origin} size must be ${issue.inclusive ? 'at most' : 'less than'} ${issue.bound}.`
        case 'invalid-format':
          return `Value must match the ${issue.format} format.`
        case 'not-multiple-of':
          return `Value must be a multiple of ${issue.divisor}.`
        case 'unrecognized-keys':
          return `Unrecognized field${issue.keys.length === 1 ? '' : 's'}: ${issue.keys.join(', ')}`
        case 'invalid-value':
          return issue.values.length > 0
            ? `Expected one of: ${issue.values.join(', ')}`
            : 'Invalid value.'
        case 'invalid-union':
          return 'Input must match one of the allowed structures.'
        case 'invalid-key':
          return `The ${issue.origin} key is invalid.`
        case 'invalid-element':
          return `The ${issue.origin} element is invalid.`
        case 'custom':
          return issue.rule === 'action-effect-required'
            ? 'An action contract must include at least one required effect.'
            : issue.rule === 'response-effect-forbidden'
              ? 'A response contract cannot include required effects.'
              : 'Invalid value.'
      }
    },
  },
  lifecycle: {
    unknownError: 'An unknown error occurred.',
    newConversationTitle: 'New conversation',
    selectProvider: 'Select an active provider first.',
    selectModel: 'Select an active model first.',
    providerNotFound: (providerId) => `The selected provider could not be found: ${providerId}`,
    goalToolsUnsupported: 'The selected assistant driver does not support goal tool calls.',
    conversationBindingMismatch:
      'This conversation belongs to a different workspace, provider, or model.',
    archivedConversation: 'Restore this archived conversation before starting a new task in it.',
    assistantResponseLimit: (characters) =>
      `The assistant response exceeded the ${characters.toLocaleString('en-US')}-character limit.`,
    assistantPersistenceFailed: (failure) => `Saving the assistant message failed: ${failure}`,
    providerFinalReportMissing: 'The provider did not produce a final report for the applied work.',
    providerTurnMissing: 'The provider response attempts ended without a result.',
    completionPolicyExhausted:
      'The provider did not produce a final answer that satisfied the completion requirements.',
    toolBudgetExhausted:
      'The configured tool budget was exhausted before the requested work was complete. Increase the tool-response round or total-call limit in Settings.',
    requiredToolMissing:
      'The provider ended a request that required observable action without calling a required tool.',
    completionContractMissing:
      'The provider did not return the run-completion contract as one structured tool call.',
    completionContractInvalidJson:
      'The provider returned invalid JSON for the run-completion contract.',
    cancelled: 'The task was cancelled.',
    timeout: (minutes) =>
      `Response generation exceeded the ${minutes.toLocaleString('en-US')}-minute limit.`,
    timeoutAfterEffect: 'The run reached its time limit, but already applied work was preserved.',
    interruptedAfterEffect: 'Some work was applied, but the final response could not be completed.',
    providerInterruptedAfterEffect:
      'Some work was applied, but the provider connection closed before the final response completed.',
    postEffectHeading: 'Confirmed results:',
    fileChangesApplied: (paths) =>
      `${paths.length.toLocaleString('en-US')} file change${paths.length === 1 ? '' : 's'} applied: ${paths.join(', ')}`,
    fileChangesAppliedWithoutPaths: 'File changes were applied.',
    processApplied: 'The requested command completed successfully.',
    mcpApplied: 'The requested MCP operation was applied.',
    postEffectFooter: (cause) =>
      cause === 'provider-transport'
        ? 'The provider connection closed before the final response, so completion of the full request could not be confirmed. The work listed above remains applied. Continue in the next message to re-check the current workspace and finish any remaining work.'
        : 'The run stopped before the final response, so completion of the full request could not be confirmed. The work listed above remains applied. Continue in the next message to re-check the current workspace and finish any remaining work.',
    persistenceAlsoFailed: (failure) => `Saving the conversation state also failed: ${failure}`,
  },
  recovery: {
    conversationDatabaseQuarantined: (backupPath) =>
      `The damaged conversation database was quarantined and a new store was created. Original backup: ${backupPath}`,
    fileMutationsRecovered: (actionCount, paths) =>
      `Automatically recovered ${actionCount.toLocaleString('en-US')} interrupted file change${actionCount === 1 ? '' : 's'}: ${paths.join(', ')}`,
    fileMutationRecoveryFailed: (reason) =>
      `Interrupted file changes could not be recovered. New file changes are blocked for safety. ${reason ?? 'Unknown recovery error.'}`,
    credentialMigrationIncomplete:
      'Some saved API keys could not be moved to the new secure store. Re-enter the API key for each affected provider in Settings.',
    invalidNotice: 'A recovery notice could not be displayed safely because it was invalid.',
    interruptedRunReason: 'The application exited before the task completed.',
    interruptedSubagentReason: 'The application exited before the subtask completed.',
  },
}

const CATALOGS = { ko, en } satisfies Record<AppLocale, HostMessageCatalog>

export function hostMessages(locale: AppLocale): HostMessageCatalog {
  return CATALOGS[locale]
}

export function postEffectInterruptionSummary(
  locale: AppLocale,
  effects: ReadonlySet<HostEffectKind>,
  changedPaths: ReadonlySet<string>,
  cause: HostInterruptionCause,
): string {
  const messages = hostMessages(locale).lifecycle
  const outcomes: string[] = []
  if (effects.has('workspace-change')) {
    const paths = [...changedPaths]
    outcomes.push(
      paths.length > 0
        ? messages.fileChangesApplied(paths)
        : messages.fileChangesAppliedWithoutPaths,
    )
  }
  if (effects.has('process')) outcomes.push(messages.processApplied)
  if (effects.has('mcp')) outcomes.push(messages.mcpApplied)
  return [
    messages.postEffectHeading,
    ...outcomes.map((outcome) => `- ${outcome}`),
    '',
    messages.postEffectFooter(cause),
  ].join('\n')
}

export function redactHostText(source: string): string {
  return source
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
}

export function validateRecoveryNotice(value: unknown): HostRecoveryNotice {
  try {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as { type?: unknown }).type === 'file-mutations-recovered'
    ) {
      const paths = (value as { paths?: unknown }).paths
      if (!Array.isArray(paths) || paths.length > MAX_RECOVERY_PATHS) {
        return { type: 'invalid-recovery-notice' }
      }
    }
    const parsed = hostRecoveryNoticeSchema.safeParse(value)
    return parsed.success ? parsed.data : { type: 'invalid-recovery-notice' }
  } catch {
    return { type: 'invalid-recovery-notice' }
  }
}

export function formatRecoveryNotice(locale: AppLocale, value: unknown): string {
  const notice = validateRecoveryNotice(value)
  const messages = hostMessages(locale).recovery
  let formatted: string
  switch (notice.type) {
    case 'conversation-database-quarantined':
      formatted = messages.conversationDatabaseQuarantined(notice.backupPath)
      break
    case 'file-mutations-recovered':
      formatted = messages.fileMutationsRecovered(notice.actionCount, notice.paths)
      break
    case 'file-mutation-recovery-failed':
      formatted = messages.fileMutationRecoveryFailed(notice.reason)
      break
    case 'credential-migration-incomplete':
      formatted = messages.credentialMigrationIncomplete
      break
    case 'invalid-recovery-notice':
      formatted = messages.invalidNotice
      break
  }
  return redactHostText(formatted).slice(0, MAX_RECOVERY_NOTICE_CHARACTERS)
}

export function formatRecoveryNotices(
  locale: AppLocale,
  values: readonly unknown[],
): string | null {
  if (values.length === 0) return null
  const bounded = values.slice(0, MAX_RECOVERY_NOTICE_COUNT)
  if (values.length > MAX_RECOVERY_NOTICE_COUNT) {
    bounded.push({ type: 'invalid-recovery-notice' })
  }
  let result = ''
  for (const value of bounded) {
    const formatted = formatRecoveryNotice(locale, value)
    const separator = result ? '\n' : ''
    const remaining = MAX_RECOVERY_NOTICE_CHARACTERS - result.length
    if (remaining <= separator.length) break
    result += (separator + formatted).slice(0, remaining)
    if (result.length >= MAX_RECOVERY_NOTICE_CHARACTERS) break
  }
  return result
}

export class RecoveryNoticeQueue {
  private readonly notices: HostRecoveryNotice[] = []
  private overflowed = false

  add(value: unknown): void {
    if (this.notices.length >= MAX_RECOVERY_NOTICE_COUNT) {
      this.overflowed = true
      return
    }
    this.notices.push(validateRecoveryNotice(value))
  }

  take(locale: AppLocale): string | null {
    if (this.notices.length === 0 && !this.overflowed) return null
    const pending = this.notices.splice(0, this.notices.length)
    if (this.overflowed) pending.push({ type: 'invalid-recovery-notice' })
    this.overflowed = false
    return formatRecoveryNotices(locale, pending)
  }
}
