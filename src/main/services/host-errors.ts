import type { AppLocale } from '../../shared/contracts'
import { formatServiceError } from './service-error-messages'

export type HostErrorDescriptor =
  | { code: 'ipc.invalid_request' }
  | { code: 'ipc.untrusted_renderer' }
  | { code: 'ipc.subframe_forbidden' }
  | { code: 'ipc.origin_forbidden' }
  | { code: 'ipc.workspace_required' }
  | { code: 'ipc.workspace_trust_required' }
  | { code: 'ipc.workspace_changed' }
  | { code: 'ipc.conversation_not_found' }
  | { code: 'ipc.conversation_workspace_mismatch' }
  | { code: 'ipc.goal_not_found' }
  | { code: 'ipc.goal_edit_closed' }
  | { code: 'ipc.goal_pause_invalid' }
  | { code: 'ipc.goal_resume_invalid' }
  | { code: 'ipc.goal_clear_invalid' }
  | { code: 'ipc.goal_complete_invalid' }
  | { code: 'ipc.goal_revision_changed'; expected: number; current: number }
  | { code: 'ipc.approval_automation_trust_required' }
  | { code: 'ipc.renderer_document_unavailable' }
  | { code: 'ipc.run_not_owned' }
  | { code: 'ipc.approval_not_owned' }
  | { code: 'approval.identifier_invalid' }
  | { code: 'approval.pending_limit' }
  | { code: 'approval.not_found' }
  | { code: 'approval.expired' }
  | { code: 'agent.intent_conflict'; intent: string; mode: string }
  | { code: 'agent.runs_suspended' }
  | { code: 'agent.conversation_active' }
  | { code: 'agent.goal_active' }
  | { code: 'agent.goal_mutation_active' }
  | { code: 'agent.concurrent_limit'; limit: number }
  | { code: 'agent.goal_mutation_conflict' }
  | { code: 'agent.suspension_active' }
  | { code: 'agent.cancelled' }
  | { code: 'agent.provider_not_found'; providerId: string }
  | { code: 'agent.model_list_timeout'; providerName: string }
  | { code: 'agent.model_list_failed'; providerName: string; reason: string }
  | { code: 'agent.goal_repository_unavailable' }
  | { code: 'agent.goal_trust_required' }
  | { code: 'agent.goal_tools_after_finish' }
  | { code: 'agent.goal_lifecycle_tool_must_be_single' }
  | { code: 'agent.tool_iteration_limit'; limit: number }
  | { code: 'agent.tool_call_budget_exceeded'; requested: number; remaining: number }
  | { code: 'agent.tool_call_ids_invalid' }
  | { code: 'agent.side_effect_duplicate' }
  | { code: 'agent.tool_failure_repeated' }
  | { code: 'agent.context_too_large'; limit: number }
  | { code: 'agent.context_file_read_failed'; path: string; reason: string }
  | { code: 'agent.completion_contract_invalid' }
  | { code: 'agent.goal_context_mismatch' }
  | { code: 'agent.workspace_trust_changed' }
  | { code: 'agent.workspace_changed' }
  | { code: 'agent.goal_not_found' }
  | { code: 'agent.goal_not_active' }
  | { code: 'agent.goal_budget_exhausted' }
  | {
      code: 'agent.driver_usage_invalid'
      problem: 'not-object' | 'invalid-counter' | 'overflow' | 'decreased' | 'event-mismatch'
      field?: string
    }
  | { code: 'agent.driver_stream_invalid'; problem: 'missing-prefix' | 'content-mismatch' }
  | { code: 'tool.registration_invalid'; tool: string }
  | { code: 'tool.strict_required'; tool: string }
  | { code: 'tool.unavailable'; tool: string }
  | { code: 'tool.arguments_too_long'; limit: number }
  | { code: 'tool.invalid_json' }
  | { code: 'tool.receipt_invalid'; tool: string }
  | { code: 'tool.receipt_inconsistent'; tool: string }
  | { code: 'tool.mcp_arguments_invalid' }
  | { code: 'tool.git_unavailable' }
  | { code: 'tool.skills_unavailable' }
  | { code: 'tool.file_mutation_unavailable' }
  | { code: 'tool.execution_unavailable' }
  | { code: 'tool.workspace_required' }
  | { code: 'tool.run_time_exhausted' }
  | { code: 'tool.duplicate_failure_suppressed' }
  | { code: 'tool.batch_validation_blocked' }
  | { code: 'tool.file_refresh_required'; paths: string[] }
  | { code: 'tool.goal_not_attached' }
  | { code: 'tool.goal_not_found' }
  | { code: 'tool.goal_plan_incomplete' }
  | { code: 'tool.goal_checkpoint_required' }
  | { code: 'tool.goal_checkpoint_stale' }
  | { code: 'tool.goal_completion_evidence_required' }
  | { code: 'tool.goal_unresolved_effect_failure'; effects: string[] }
  | { code: 'tool.goal_finish_duplicate' }

type HostErrorCode = HostErrorDescriptor['code']
type DescriptorFor<Code extends HostErrorCode> = Extract<HostErrorDescriptor, { code: Code }>
type HostErrorCatalog = {
  [Code in HostErrorCode]: (descriptor: DescriptorFor<Code>) => string
}

const RECOVERABLE_HOST_ERROR_CODES = new Set<HostErrorCode>([
  'ipc.workspace_changed',
  'ipc.goal_revision_changed',
  'approval.not_found',
  'approval.expired',
  'agent.cancelled',
  'agent.model_list_timeout',
  'agent.workspace_trust_changed',
  'agent.workspace_changed',
  'tool.file_refresh_required',
])

export function isRecoverableHostErrorDescriptor(descriptor: HostErrorDescriptor): boolean {
  return RECOVERABLE_HOST_ERROR_CODES.has(descriptor.code)
}

const ko = {
  'ipc.invalid_request': () => '요청 형식이 올바르지 않습니다.',
  'ipc.untrusted_renderer': () => '신뢰할 수 없는 렌더러 요청입니다.',
  'ipc.subframe_forbidden': () => '하위 프레임에서는 이 기능을 호출할 수 없습니다.',
  'ipc.origin_forbidden': () => '허용되지 않은 렌더러 출처입니다.',
  'ipc.workspace_required': () => '먼저 작업 공간을 선택해 주세요.',
  'ipc.workspace_trust_required': () =>
    '이 기능을 사용하려면 현재 작업 공간을 먼저 신뢰해야 합니다.',
  'ipc.workspace_changed': () => '요청을 처리하는 동안 작업 공간이 변경되었습니다.',
  'ipc.conversation_not_found': () => '대화를 찾을 수 없습니다.',
  'ipc.conversation_workspace_mismatch': () => '이 대화는 현재 작업 공간에 속하지 않습니다.',
  'ipc.goal_not_found': () => '현재 작업 공간에서 Goal을 찾을 수 없습니다.',
  'ipc.goal_edit_closed': () => '완료되거나 종료된 Goal의 목표는 수정할 수 없습니다.',
  'ipc.goal_pause_invalid': () => '활성 또는 차단된 Goal만 일시정지할 수 있습니다.',
  'ipc.goal_resume_invalid': () => '일시정지되거나 차단된 Goal만 재개할 수 있습니다.',
  'ipc.goal_clear_invalid': () => '열린 Goal만 종료할 수 있습니다.',
  'ipc.goal_complete_invalid': () => '활성 Goal만 완료할 수 있습니다.',
  'ipc.goal_revision_changed': ({ expected, current }) =>
    `Goal revision이 ${expected.toString()}에서 ${current.toString()}(으)로 변경되었습니다.`,
  'ipc.approval_automation_trust_required': () =>
    '승인 자동화를 사용하려면 현재 작업 공간을 먼저 신뢰해야 합니다.',
  'ipc.renderer_document_unavailable': () => '렌더러 문서 정보를 확인할 수 없습니다.',
  'ipc.run_not_owned': () => '이 렌더러가 소유한 작업이 아닙니다.',
  'ipc.approval_not_owned': () => '이 렌더러가 소유한 작업의 승인 요청이 아닙니다.',
  'approval.identifier_invalid': () => '승인 요청 식별자가 올바르지 않거나 이미 사용 중입니다.',
  'approval.pending_limit': () => '대기 중인 승인 요청이 안전 한도를 초과했습니다.',
  'approval.not_found': () => '현재 작업에 속한 승인 요청을 찾을 수 없습니다.',
  'approval.expired': () => '승인 요청이 만료되었습니다.',
  'agent.intent_conflict': ({ intent, mode }) =>
    `intent와 legacy mode가 충돌합니다: ${intent} / ${mode}`,
  'agent.runs_suspended': () =>
    '작업 공간 전환 또는 복구가 진행 중이어서 새 작업을 시작할 수 없습니다.',
  'agent.conversation_active': () => '같은 대화에서 이미 응답을 생성하고 있습니다.',
  'agent.goal_active': () => '같은 Goal에서 이미 작업을 실행하고 있습니다.',
  'agent.goal_mutation_active': () =>
    'Goal 상태 변경이 진행 중이어서 새 작업을 시작할 수 없습니다.',
  'agent.concurrent_limit': ({ limit }) =>
    `동시에 실행할 수 있는 작업은 최대 ${limit.toLocaleString('ko-KR')}개입니다.`,
  'agent.goal_mutation_conflict': () => '같은 Goal의 다른 상태 변경이 진행 중입니다.',
  'agent.suspension_active': () => '다른 작업 공간 전환 또는 복구 작업이 이미 진행 중입니다.',
  'agent.cancelled': () => '작업이 취소되었습니다.',
  'agent.provider_not_found': ({ providerId }) => `공급자를 찾을 수 없습니다: ${providerId}`,
  'agent.model_list_timeout': ({ providerName }) =>
    `${providerName}의 모델 목록 요청 시간이 초과되었습니다.`,
  'agent.model_list_failed': ({ providerName, reason }) =>
    `${providerName}의 모델 목록을 불러오지 못했습니다: ${reason}`,
  'agent.goal_repository_unavailable': () => 'Goal 실행 저장소를 사용할 수 없습니다.',
  'agent.goal_trust_required': () => 'Goal을 실행하려면 현재 작업 공간을 먼저 신뢰해야 합니다.',
  'agent.goal_tools_after_finish': () => 'Goal 종료 요청 뒤에는 추가 도구를 호출할 수 없습니다.',
  'agent.goal_lifecycle_tool_must_be_single': () =>
    'Goal checkpoint와 종료 요청은 단독 도구 호출로 실행해야 합니다.',
  'agent.tool_iteration_limit': ({ limit }) =>
    `도구 호출이 설정된 최대 반복 횟수(${limit.toLocaleString('ko-KR')})를 초과했습니다.`,
  'agent.tool_call_budget_exceeded': ({ requested, remaining }) =>
    `요청된 도구 호출 수(${requested.toLocaleString('ko-KR')})가 이 실행에 남은 총 호출 예산(${remaining.toLocaleString('ko-KR')})을 초과했습니다. 어떤 호출도 실행하지 않았습니다.`,
  'agent.tool_call_ids_invalid': () =>
    '공급자가 비어 있거나 중복된 도구 호출 식별자를 반환했습니다. 어떤 호출도 실행하지 않았습니다.',
  'agent.side_effect_duplicate': () =>
    '같은 응답에서 동일한 부수효과 도구 호출을 두 번 요청할 수 없습니다.',
  'agent.tool_failure_repeated': () =>
    '공급자가 실패한 도구 호출을 수정하지 않고 반복하여 실행을 중단했습니다.',
  'agent.context_too_large': ({ limit }) =>
    `선택한 파일의 전체 크기가 컨텍스트 한도(${limit.toLocaleString('ko-KR')}자)를 초과합니다.`,
  'agent.context_file_read_failed': ({ path, reason }) =>
    `선택한 컨텍스트 파일을 읽지 못했습니다 (${path}): ${reason}`,
  'agent.completion_contract_invalid': () =>
    '공급자가 반환한 실행 완료 계약이 요구된 구조와 일치하지 않습니다.',
  'agent.goal_context_mismatch': () => 'Goal 컨텍스트가 현재 작업 공간과 일치하지 않습니다.',
  'agent.workspace_trust_changed': () =>
    '작업 공간 지침을 불러오는 동안 신뢰 상태가 변경되었습니다.',
  'agent.workspace_changed': () => '작업 도중 작업 공간이 변경되어 안전하게 중단했습니다.',
  'agent.goal_not_found': () => '현재 작업 공간에서 실행할 Goal을 찾을 수 없습니다.',
  'agent.goal_not_active': () => '활성 상태의 Goal만 계속 실행할 수 있습니다.',
  'agent.goal_budget_exhausted': () =>
    'Goal의 토큰 예산을 모두 사용했습니다. 예산을 조정한 뒤 다시 시도해 주세요.',
  'agent.driver_usage_invalid': ({ problem, field }) =>
    problem === 'not-object'
      ? '공급자가 올바른 토큰 사용량 정보를 반환하지 않았습니다.'
      : problem === 'invalid-counter'
        ? `공급자가 올바르지 않은 토큰 사용량을 반환했습니다${field ? `: ${field}` : ''}.`
        : problem === 'overflow'
          ? '공급자의 누적 토큰 사용량이 안전한 범위를 초과했습니다.'
          : problem === 'decreased'
            ? '공급자의 누적 토큰 사용량이 이전 값보다 감소했습니다.'
            : '공급자 이벤트와 최종 결과의 토큰 사용량이 일치하지 않습니다.',
  'agent.driver_stream_invalid': ({ problem }) =>
    problem === 'missing-prefix'
      ? '공급자의 최종 응답에 이미 스트리밍된 내용이 포함되지 않았습니다.'
      : '공급자의 최종 응답과 스트리밍된 내용이 일치하지 않습니다.',
  'tool.registration_invalid': ({ tool }) => `도구 이름이 올바르지 않거나 중복되었습니다: ${tool}`,
  'tool.strict_required': ({ tool }) => `도구는 strict function 정의여야 합니다: ${tool}`,
  'tool.unavailable': ({ tool }) => `허용되지 않았거나 현재 사용할 수 없는 도구입니다: ${tool}`,
  'tool.arguments_too_long': ({ limit }) =>
    `도구 인수가 ${limit.toLocaleString('ko-KR')}자 한도를 초과했습니다.`,
  'tool.invalid_json': () => '도구 인수가 올바른 JSON 형식이 아닙니다.',
  'tool.receipt_invalid': ({ tool }) => `도구 효과 receipt가 올바르지 않습니다: ${tool}`,
  'tool.receipt_inconsistent': ({ tool }) =>
    `도구 효과 receipt의 상태가 일관되지 않습니다: ${tool}`,
  'tool.mcp_arguments_invalid': () => 'MCP argumentsJson은 JSON 객체여야 합니다.',
  'tool.git_unavailable': () => 'Git 서비스를 사용할 수 없습니다.',
  'tool.skills_unavailable': () => 'Skills 서비스를 사용할 수 없습니다.',
  'tool.file_mutation_unavailable': () => '파일 변경 서비스를 사용할 수 없습니다.',
  'tool.execution_unavailable': () => '명령 실행 서비스를 사용할 수 없습니다.',
  'tool.workspace_required': () => '먼저 작업 공간을 선택해 주세요.',
  'tool.run_time_exhausted': () => '명령을 안전하게 실행할 Agent run 시간이 남아 있지 않습니다.',
  'tool.duplicate_failure_suppressed': () =>
    '직전에 동일한 도구와 인수가 실패하여 중복 실행하지 않았습니다. 이전 오류와 등록된 입력 스키마를 바탕으로 인수를 수정하거나 다른 방법을 선택하세요.',
  'tool.batch_validation_blocked': () =>
    '같은 응답의 다른 도구 호출이 입력 검증에 실패하여 이 호출도 실행하지 않았습니다. 전체 호출을 수정해 다시 시도하세요.',
  'tool.file_refresh_required': ({ paths }) =>
    `파일 상태 충돌을 복구하려면 먼저 다음 경로를 read_file로 다시 읽어야 합니다: ${paths.join(', ')}. list_files나 다른 파일 변경은 이 요구사항을 충족하지 않습니다.`,
  'tool.goal_not_attached': () => '이 실행에는 Goal이 연결되지 않았습니다.',
  'tool.goal_not_found': () => '현재 작업 공간에서 Goal을 찾을 수 없습니다.',
  'tool.goal_plan_incomplete': () => '모든 계획 항목이 완료된 revision을 먼저 기록해야 합니다.',
  'tool.goal_checkpoint_required': () =>
    '현재 완료 계획 revision의 검증 checkpoint를 먼저 기록해야 합니다.',
  'tool.goal_checkpoint_stale': () =>
    '마지막 부수효과 이후 검증 checkpoint를 다시 기록해야 합니다.',
  'tool.goal_completion_evidence_required': () =>
    '현재 실행에서 파일 읽기나 성공한 작업 근거를 확보한 뒤 Goal을 완료해야 합니다.',
  'tool.goal_unresolved_effect_failure': ({ effects }) =>
    `아직 복구되지 않은 작업 실패가 있습니다: ${effects.join(', ')}. 성공한 재검증 근거를 기록한 뒤 Goal을 완료하세요.`,
  'tool.goal_finish_duplicate': () => '현재 실행에는 이미 Goal 종료 요청이 기록되었습니다.',
} satisfies HostErrorCatalog

const en = {
  'ipc.invalid_request': () => 'The request is invalid.',
  'ipc.untrusted_renderer': () => 'The renderer request is not trusted.',
  'ipc.subframe_forbidden': () => 'This operation is not available from a subframe.',
  'ipc.origin_forbidden': () => 'The renderer origin is not allowed.',
  'ipc.workspace_required': () => 'Select a workspace first.',
  'ipc.workspace_trust_required': () => 'Trust the current workspace before using this feature.',
  'ipc.workspace_changed': () => 'The workspace changed while the request was being processed.',
  'ipc.conversation_not_found': () => 'The conversation could not be found.',
  'ipc.conversation_workspace_mismatch': () =>
    'This conversation does not belong to the current workspace.',
  'ipc.goal_not_found': () => 'The goal could not be found in the current workspace.',
  'ipc.goal_edit_closed': () => 'The objective of a completed or closed goal cannot be edited.',
  'ipc.goal_pause_invalid': () => 'Only an active or blocked goal can be paused.',
  'ipc.goal_resume_invalid': () => 'Only a paused or blocked goal can be resumed.',
  'ipc.goal_clear_invalid': () => 'Only an open goal can be closed.',
  'ipc.goal_complete_invalid': () => 'Only an active goal can be completed.',
  'ipc.goal_revision_changed': ({ expected, current }) =>
    `The goal revision changed from ${expected.toString()} to ${current.toString()}.`,
  'ipc.approval_automation_trust_required': () =>
    'Trust the current workspace before enabling approval automation.',
  'ipc.renderer_document_unavailable': () => 'The renderer document could not be identified.',
  'ipc.run_not_owned': () => 'This renderer does not own the task.',
  'ipc.approval_not_owned': () => 'This renderer does not own the approval request.',
  'approval.identifier_invalid': () =>
    'The approval request identifier is invalid or already in use.',
  'approval.pending_limit': () =>
    'The number of pending approval requests exceeded the safe limit.',
  'approval.not_found': () => 'The approval request for this task could not be found.',
  'approval.expired': () => 'The approval request has expired.',
  'agent.intent_conflict': ({ intent, mode }) =>
    `The intent conflicts with the legacy mode: ${intent} / ${mode}`,
  'agent.runs_suspended': () =>
    'A task cannot start while the workspace is switching or recovering.',
  'agent.conversation_active': () => 'This conversation is already generating a response.',
  'agent.goal_active': () => 'A task is already running for this goal.',
  'agent.goal_mutation_active': () => 'A goal state change is already in progress.',
  'agent.concurrent_limit': ({ limit }) =>
    `At most ${limit.toLocaleString('en-US')} tasks can run concurrently.`,
  'agent.goal_mutation_conflict': () =>
    'Another state change is already in progress for this goal.',
  'agent.suspension_active': () => 'Another workspace switch or recovery is already in progress.',
  'agent.cancelled': () => 'The task was cancelled.',
  'agent.provider_not_found': ({ providerId }) => `Provider not found: ${providerId}`,
  'agent.model_list_timeout': ({ providerName }) =>
    `The model list request for ${providerName} timed out.`,
  'agent.model_list_failed': ({ providerName, reason }) =>
    `Could not load the model list for ${providerName}: ${reason}`,
  'agent.goal_repository_unavailable': () => 'The Goal run repository is unavailable.',
  'agent.goal_trust_required': () => 'Trust the current workspace before running a Goal.',
  'agent.goal_tools_after_finish': () =>
    'No additional tools can be called after requesting Goal completion.',
  'agent.goal_lifecycle_tool_must_be_single': () =>
    'Goal checkpoint and completion requests must be the only tool call in a response.',
  'agent.tool_iteration_limit': ({ limit }) =>
    `Tool calls exceeded the configured ${limit.toLocaleString('en-US')}-round limit.`,
  'agent.tool_call_budget_exceeded': ({ requested, remaining }) =>
    `The provider requested ${requested.toLocaleString('en-US')} tool calls, exceeding the ${remaining.toLocaleString('en-US')} calls remaining in this run. No calls were executed.`,
  'agent.tool_call_ids_invalid': () =>
    'The provider returned empty or duplicate tool-call identifiers. No calls were executed.',
  'agent.side_effect_duplicate': () =>
    'The same side-effecting tool call cannot be requested twice in one response.',
  'agent.tool_failure_repeated': () =>
    'The provider repeated a failed tool call without correcting it, so the run was stopped.',
  'agent.context_too_large': ({ limit }) =>
    `The selected files exceed the ${limit.toLocaleString('en-US')}-character context limit.`,
  'agent.context_file_read_failed': ({ path, reason }) =>
    `Could not read the selected context file (${path}): ${reason}`,
  'agent.completion_contract_invalid': () =>
    'The run-completion contract returned by the provider does not match the required structure.',
  'agent.goal_context_mismatch': () => 'The Goal context does not match the current workspace.',
  'agent.workspace_trust_changed': () =>
    'Workspace trust changed while project instructions were loading.',
  'agent.workspace_changed': () =>
    'The workspace changed during the run, so the task was stopped safely.',
  'agent.goal_not_found': () => 'The Goal could not be found in the current workspace.',
  'agent.goal_not_active': () => 'Only an active Goal can continue running.',
  'agent.goal_budget_exhausted': () =>
    'The Goal has used its token budget. Adjust the budget before trying again.',
  'agent.driver_usage_invalid': ({ problem, field }) =>
    problem === 'not-object'
      ? 'The provider returned an invalid token-usage snapshot.'
      : problem === 'invalid-counter'
        ? `The provider returned an invalid token-usage counter${field ? `: ${field}` : ''}.`
        : problem === 'overflow'
          ? 'The cumulative provider token usage exceeded the safe integer range.'
          : problem === 'decreased'
            ? 'The cumulative provider token usage decreased unexpectedly.'
            : 'Token usage from provider events does not match the final result.',
  'agent.driver_stream_invalid': ({ problem }) =>
    problem === 'missing-prefix'
      ? 'The provider final response does not include the text already streamed.'
      : 'The provider final response does not match the text already streamed.',
  'tool.registration_invalid': ({ tool }) => `The tool name is invalid or duplicated: ${tool}`,
  'tool.strict_required': ({ tool }) => `The tool must use a strict function definition: ${tool}`,
  'tool.unavailable': ({ tool }) => `The tool is not allowed or currently unavailable: ${tool}`,
  'tool.arguments_too_long': ({ limit }) =>
    `Tool arguments exceeded the ${limit.toLocaleString('en-US')}-character limit.`,
  'tool.invalid_json': () => 'Tool arguments are not valid JSON.',
  'tool.receipt_invalid': ({ tool }) => `The tool effect receipt is invalid: ${tool}`,
  'tool.receipt_inconsistent': ({ tool }) => `The tool effect receipt is inconsistent: ${tool}`,
  'tool.mcp_arguments_invalid': () => 'MCP argumentsJson must be a JSON object.',
  'tool.git_unavailable': () => 'The Git service is unavailable.',
  'tool.skills_unavailable': () => 'The Skills service is unavailable.',
  'tool.file_mutation_unavailable': () => 'The file mutation service is unavailable.',
  'tool.execution_unavailable': () => 'The command execution service is unavailable.',
  'tool.workspace_required': () => 'Select a workspace first.',
  'tool.run_time_exhausted': () =>
    'There is not enough time left in the agent run to execute the command safely.',
  'tool.duplicate_failure_suppressed': () =>
    'The same tool and arguments just failed, so the duplicate call was not executed. Correct the arguments using the previous error and registered input schema, or use another approach.',
  'tool.batch_validation_blocked': () =>
    'Another tool call in the same response failed input validation, so this call was not executed either. Correct the full batch and try again.',
  'tool.file_refresh_required': ({ paths }) =>
    `To recover from the file-state conflict, first read these paths again with read_file: ${paths.join(', ')}. list_files and other file changes do not satisfy this requirement.`,
  'tool.goal_not_attached': () => 'This run does not have an attached Goal.',
  'tool.goal_not_found': () => 'The Goal could not be found in the current workspace.',
  'tool.goal_plan_incomplete': () =>
    'Record a revision with every plan item completed before finishing the Goal.',
  'tool.goal_checkpoint_required': () =>
    'Record a verification checkpoint for the current completed plan revision first.',
  'tool.goal_checkpoint_stale': () =>
    'Record another verification checkpoint after the latest side effect.',
  'tool.goal_completion_evidence_required': () =>
    'Read relevant files or record a successful operation in this run before finishing the Goal.',
  'tool.goal_unresolved_effect_failure': ({ effects }) =>
    `These operation failures have not been recovered: ${effects.join(', ')}. Record successful verification evidence before finishing the Goal.`,
  'tool.goal_finish_duplicate': () =>
    'A Goal completion request has already been recorded for this run.',
} satisfies HostErrorCatalog

const CATALOGS = { ko, en } satisfies Record<AppLocale, HostErrorCatalog>

export function formatHostErrorDescriptor(
  locale: AppLocale,
  descriptor: HostErrorDescriptor,
): string {
  const formatter = CATALOGS[locale][descriptor.code] as (value: HostErrorDescriptor) => string
  return formatter(descriptor)
}

export class HostError extends Error {
  readonly descriptor: HostErrorDescriptor
  readonly code: HostErrorCode

  constructor(
    descriptor: HostErrorDescriptor,
    options: ErrorOptions & { locale?: AppLocale } = {},
  ) {
    const { locale = 'ko', ...errorOptions } = options
    super(formatHostErrorDescriptor(locale, descriptor), errorOptions)
    this.name = 'HostError'
    this.descriptor = descriptor
    this.code = descriptor.code
  }
}

export function formatHostError(error: unknown, locale: AppLocale): string | null {
  return error instanceof HostError
    ? formatHostErrorDescriptor(locale, error.descriptor)
    : formatServiceError(error, locale)
}
