import type { AppLocale } from '../../shared/contracts'

export type CommandErrorCode =
  | 'COMMAND_NOT_FOUND'
  | 'COMMAND_CHANGED'
  | 'INVALID_ARGUMENTS'
  | 'EXPANSION_TOO_LARGE'
  | 'WORKSPACE_CHANGED'

export type CommandErrorDetail =
  | { code: 'COMMAND_NOT_FOUND' }
  | { code: 'COMMAND_CHANGED' }
  | {
      code: 'INVALID_ARGUMENTS'
      identifier?: 'incomplete-escape' | 'unclosed-quote'
    }
  | { code: 'EXPANSION_TOO_LARGE'; maximumCharacters?: number }
  | { code: 'WORKSPACE_CHANGED' }

export type CommandServiceErrorDescriptor = { service: 'command' } & CommandErrorDetail

export type WorkspaceErrorCode =
  | 'NO_WORKSPACE'
  | 'CANCELLED'
  | 'OUTSIDE_WORKSPACE'
  | 'PATH_NOT_FOUND'
  | 'NOT_A_DIRECTORY'
  | 'NOT_A_FILE'
  | 'SENSITIVE_FILE'
  | 'BINARY_FILE'
  | 'FILE_TOO_LARGE'
  | 'INVALID_QUERY'

export type WorkspaceErrorDetail =
  | { code: 'NO_WORKSPACE' }
  | { code: 'CANCELLED' }
  | {
      code: 'OUTSIDE_WORKSPACE'
      identifier?: 'invalid-path' | 'path' | 'symlink' | 'changed-during-read'
      path?: string
    }
  | {
      code: 'PATH_NOT_FOUND'
      identifier?: 'path-required' | 'workspace' | 'path' | 'replaced-during-read'
      path?: string
    }
  | { code: 'NOT_A_DIRECTORY'; identifier?: 'workspace' | 'path'; path?: string }
  | { code: 'NOT_A_FILE'; path?: string }
  | {
      code: 'SENSITIVE_FILE'
      identifier?: 'workspace-root' | 'path' | 'content'
      path?: string
    }
  | { code: 'BINARY_FILE'; path?: string }
  | { code: 'FILE_TOO_LARGE'; path?: string; maximumBytes?: number }
  | { code: 'INVALID_QUERY'; minimumCharacters?: number; maximumCharacters?: number }

export type WorkspaceServiceErrorDescriptor = { service: 'workspace' } & WorkspaceErrorDetail

export type StructuredProcessErrorCode =
  | 'NO_WORKSPACE'
  | 'INVALID_ARGUMENTS'
  | 'INVALID_CWD'
  | 'INVALID_STDIN'
  | 'OUTSIDE_WORKSPACE'

export type StructuredProcessErrorDetail =
  | { code: 'NO_WORKSPACE' }
  | {
      code: 'INVALID_ARGUMENTS'
      identifier?:
        | 'argv-count'
        | 'argv-entry'
        | 'argv-entry-too-large'
        | 'argv-total'
        | 'executable-path-not-found'
        | 'executable-not-on-path'
        | 'timeout'
      index?: number
      minimum?: number
      maximum?: number
      maximumBytes?: number
      executable?: string
    }
  | {
      code: 'INVALID_CWD'
      identifier?: 'nul' | 'not-found' | 'not-directory'
      path?: string
    }
  | { code: 'INVALID_STDIN'; identifier?: 'type' | 'too-large'; maximumBytes?: number }
  | { code: 'OUTSIDE_WORKSPACE'; path?: string }

export type StructuredProcessServiceErrorDescriptor = {
  service: 'execution'
} & StructuredProcessErrorDetail

export type GitOperation =
  | 'status'
  | 'repository-head'
  | 'repository-branch'
  | 'safe-diff-paths'
  | 'staged-diff'
  | 'unstaged-diff'
  | 'repository-root'
  | 'repository-process-filters'

export type GitServiceErrorCode =
  | 'NO_WORKSPACE'
  | 'NOT_A_REPOSITORY'
  | 'INVALID_PATH'
  | 'SENSITIVE_PATH'
  | 'SENSITIVE_CONTENT'
  | 'UNSAFE_REPOSITORY'
  | 'GIT_NOT_FOUND'
  | 'GIT_FAILED'
  | 'GIT_TIMEOUT'
  | 'CANCELLED'

export type GitServiceErrorDetail =
  | { code: 'NO_WORKSPACE' }
  | {
      code: 'NOT_A_REPOSITORY'
      identifier?: 'workspace' | 'invalid-root' | 'unrelated-root'
      path?: string
      externalDetail?: string
    }
  | {
      code: 'INVALID_PATH'
      identifier?: 'requested' | 'outside' | 'workspace-root' | 'reported'
      path?: string
    }
  | { code: 'SENSITIVE_PATH'; path?: string }
  | { code: 'SENSITIVE_CONTENT'; path?: string }
  | { code: 'UNSAFE_REPOSITORY' }
  | { code: 'GIT_NOT_FOUND'; executable?: string }
  | {
      code: 'GIT_FAILED'
      identifier?: 'changed-path-list-too-large' | 'too-many-changed-paths' | 'command'
      operation?: GitOperation
      maximumPaths?: number
      maximumPathspecBytes?: number
      externalDetail?: string
      exitCode?: number | null
    }
  | { code: 'GIT_TIMEOUT'; operation?: GitOperation }
  | { code: 'CANCELLED' }

export type GitServiceErrorDescriptor = { service: 'git' } & GitServiceErrorDetail

export type SettingsStoreErrorCode =
  | 'INVALID_SETTINGS_FILE'
  | 'SETTINGS_READ_FAILED'
  | 'SETTINGS_WRITE_FAILED'
  | 'ENCRYPTION_UNAVAILABLE'
  | 'ENCRYPTION_FAILED'
  | 'CREDENTIAL_TOO_LARGE'
  | 'CREDENTIAL_REENTRY_REQUIRED'
  | 'PROVIDER_NOT_FOUND'
  | 'INVALID_ACTIVE_SELECTION'

export type SettingsStoreErrorDetail =
  | {
      code: 'INVALID_SETTINGS_FILE'
      identifier?: 'provider-generation' | 'backup-failed' | 'write-validation'
      providerId?: string
      path?: string
    }
  | { code: 'SETTINGS_READ_FAILED'; path?: string }
  | { code: 'SETTINGS_WRITE_FAILED'; path?: string }
  | { code: 'ENCRYPTION_UNAVAILABLE'; operation?: 'save' | 'read' }
  | { code: 'ENCRYPTION_FAILED'; operation?: 'encrypt' | 'decrypt' }
  | { code: 'CREDENTIAL_TOO_LARGE'; identifier: 'api-key'; maximumBytes: number }
  | {
      code: 'CREDENTIAL_TOO_LARGE'
      identifier: 'encrypted-api-key'
      maximumCharacters: number
    }
  | { code: 'CREDENTIAL_REENTRY_REQUIRED' }
  | {
      code: 'PROVIDER_NOT_FOUND'
      identifier?: 'id-required' | 'update'
      providerId?: string
    }
  | {
      code: 'INVALID_ACTIVE_SELECTION'
      identifier?: 'provider-required' | 'provider-missing'
      providerId?: string
    }

export type SettingsServiceErrorDescriptor = { service: 'settings' } & SettingsStoreErrorDetail

export type MutationErrorCode =
  | 'NO_WORKSPACE'
  | 'INVALID_PROPOSAL'
  | 'INVALID_PATH'
  | 'DUPLICATE_PATH'
  | 'HASH_CONFLICT'
  | 'PATCH_CONFLICT'
  | 'SYMLINK_REJECTED'
  | 'NOT_REGULAR_FILE'
  | 'FILE_TOO_LARGE'
  | 'BINARY_FILE'
  | 'ACTION_NOT_FOUND'
  | 'ACTION_TAMPERED'
  | 'APPLY_FAILED'
  | 'RECOVERY_REQUIRED'
  | 'NO_UNDO'
  | 'JOURNAL_INVALID'
  | 'UNDO_CONFLICT'
  | 'CANCELLED'

export type MutationErrorIdentifier =
  | 'sha256'
  | 'patch-file-count'
  | 'patch-entry'
  | 'patch-hunk-count'
  | 'patch-hunk'
  | 'change-count'
  | 'change-entry'
  | 'new-content'
  | 'create-base-hash'
  | 'delete-missing'
  | 'unchanged'
  | 'summary-required'
  | 'summary-length'
  | 'path-value'
  | 'parent-missing'
  | 'path-length'
  | 'outside-workspace'
  | 'workspace-root'
  | 'git-metadata'
  | 'patch-duplicate'
  | 'change-duplicate'
  | 'create-conflict'
  | 'file-changed'
  | 'recovery-image'
  | 'patch-target-missing'
  | 'patch-no-match'
  | 'patch-ambiguous'
  | 'patch-overlap'
  | 'nul-content'
  | 'binary-content'
  | 'invalid-utf8'
  | 'patch-total'
  | 'file-content'
  | 'proposal-total'
  | 'journal-size'
  | 'hash-required'
  | 'prepared-action-missing'
  | 'workspace-changed'
  | 'integrity-check'
  | 'apply'
  | 'undo'
  | 'latest-action-changed'
  | 'pending-recovery'

export interface MutationErrorFields {
  identifier?: MutationErrorIdentifier
  path?: string
  parentPath?: string
  field?: string
  currentSha256?: string | null
  expectedSha256?: string | null
  actionHash?: string
  journalId?: string
  index?: number
  hunkIndex?: number
  minimum?: number
  maximum?: number
  maximumBytes?: number
}

export type MutationErrorDetail = { code: MutationErrorCode } & MutationErrorFields

export type MutationServiceErrorDescriptor = { service: 'mutation' } & MutationErrorDetail

export type TrustStoreErrorCode =
  | 'INVALID_WORKSPACE'
  | 'INVALID_TRUST_FILE'
  | 'TRUST_READ_FAILED'
  | 'TRUST_WRITE_FAILED'

export type TrustStoreErrorDetail =
  | {
      code: 'INVALID_WORKSPACE'
      identifier?: 'path-required' | 'not-directory' | 'canonicalize'
      path?: string
    }
  | { code: 'INVALID_TRUST_FILE'; identifier?: 'backup-failed'; path?: string }
  | { code: 'TRUST_READ_FAILED'; path?: string }
  | { code: 'TRUST_WRITE_FAILED'; path?: string }

export type TrustServiceErrorDescriptor = { service: 'trust' } & TrustStoreErrorDetail

export type SkillErrorCode = 'SKILL_NOT_FOUND' | 'REVISION_MISMATCH' | 'INVALID_RESOURCE'

export type SkillErrorDetail =
  | { code: 'SKILL_NOT_FOUND' }
  | { code: 'REVISION_MISMATCH' }
  | { code: 'INVALID_RESOURCE'; identifier?: 'not-listed' | 'read-failed' }

export type SkillServiceErrorDescriptor = { service: 'skill' } & SkillErrorDetail

export type ServiceErrorDescriptor =
  | CommandServiceErrorDescriptor
  | WorkspaceServiceErrorDescriptor
  | StructuredProcessServiceErrorDescriptor
  | GitServiceErrorDescriptor
  | SettingsServiceErrorDescriptor
  | MutationServiceErrorDescriptor
  | TrustServiceErrorDescriptor
  | SkillServiceErrorDescriptor

export const SERVICE_ERROR_MARKER: unique symbol = Symbol('service-error')

export interface ServiceErrorCarrier extends Error {
  readonly [SERVICE_ERROR_MARKER]: true
  readonly descriptor: ServiceErrorDescriptor
}

type ServiceCode<Service extends ServiceErrorDescriptor['service']> = Extract<
  ServiceErrorDescriptor,
  { service: Service }
>['code']

type RecoverableServiceErrorCodes = {
  [Service in ServiceErrorDescriptor['service']]: ReadonlySet<ServiceCode<Service>>
}

const RECOVERABLE_SERVICE_ERROR_CODES = {
  command: new Set<CommandErrorCode>(['COMMAND_CHANGED', 'WORKSPACE_CHANGED']),
  workspace: new Set<WorkspaceErrorCode>(['CANCELLED']),
  execution: new Set<StructuredProcessErrorCode>(),
  git: new Set<GitServiceErrorCode>(['GIT_TIMEOUT', 'CANCELLED']),
  settings: new Set<SettingsStoreErrorCode>(),
  mutation: new Set<MutationErrorCode>(['HASH_CONFLICT', 'PATCH_CONFLICT', 'CANCELLED']),
  trust: new Set<TrustStoreErrorCode>(),
  skill: new Set<SkillErrorCode>(['REVISION_MISMATCH']),
} satisfies RecoverableServiceErrorCodes

export function isRecoverableServiceErrorDescriptor(descriptor: ServiceErrorDescriptor): boolean {
  switch (descriptor.service) {
    case 'command':
      return RECOVERABLE_SERVICE_ERROR_CODES.command.has(descriptor.code)
    case 'workspace':
      return (
        RECOVERABLE_SERVICE_ERROR_CODES.workspace.has(descriptor.code) ||
        (descriptor.code === 'OUTSIDE_WORKSPACE' &&
          descriptor.identifier === 'changed-during-read') ||
        (descriptor.code === 'PATH_NOT_FOUND' && descriptor.identifier === 'replaced-during-read')
      )
    case 'execution':
      return RECOVERABLE_SERVICE_ERROR_CODES.execution.has(descriptor.code)
    case 'git':
      return RECOVERABLE_SERVICE_ERROR_CODES.git.has(descriptor.code)
    case 'settings':
      return RECOVERABLE_SERVICE_ERROR_CODES.settings.has(descriptor.code)
    case 'mutation':
      return RECOVERABLE_SERVICE_ERROR_CODES.mutation.has(descriptor.code)
    case 'trust':
      return RECOVERABLE_SERVICE_ERROR_CODES.trust.has(descriptor.code)
    case 'skill':
      return RECOVERABLE_SERVICE_ERROR_CODES.skill.has(descriptor.code)
  }
}

function formattedNumber(locale: AppLocale, value: number): string {
  return value.toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US')
}

function withValue(message: string, value: string | undefined): string {
  return value === undefined ? message : `${message}: ${value}`
}

function formatCommandError(locale: AppLocale, descriptor: CommandServiceErrorDescriptor): string {
  const korean = locale === 'ko'
  switch (descriptor.code) {
    case 'COMMAND_NOT_FOUND':
      return korean
        ? '현재 작업 공간에서 해당 슬래시 명령을 찾을 수 없습니다.'
        : 'The slash command could not be found in the current workspace.'
    case 'COMMAND_CHANGED':
      return korean
        ? '슬래시 명령이 목록을 불러온 뒤 변경되었습니다. 명령 목록을 새로고침해 주세요.'
        : 'The slash command changed after the list was loaded. Refresh the command list.'
    case 'INVALID_ARGUMENTS':
      if (descriptor.identifier === 'incomplete-escape') {
        return korean
          ? '슬래시 명령 인수의 이스케이프 문자가 완전하지 않습니다.'
          : 'A slash-command argument ends with an incomplete escape sequence.'
      }
      if (descriptor.identifier === 'unclosed-quote') {
        return korean
          ? '슬래시 명령 인수의 따옴표가 닫히지 않았습니다.'
          : 'A quote in the slash-command arguments is not closed.'
      }
      return korean
        ? '슬래시 명령 인수가 올바르지 않습니다.'
        : 'The slash-command arguments are invalid.'
    case 'EXPANSION_TOO_LARGE': {
      const limit = descriptor.maximumCharacters
      if (limit !== undefined) {
        return korean
          ? `확장된 명령이 ${formattedNumber(locale, limit)}자 한도를 초과했습니다.`
          : `The expanded command exceeds the ${formattedNumber(locale, limit)}-character limit.`
      }
      return korean
        ? '확장된 명령이 허용된 최대 크기를 초과했습니다.'
        : 'The expanded command exceeds the allowed size.'
    }
    case 'WORKSPACE_CHANGED':
      return korean
        ? '명령을 불러오는 동안 작업 공간이 변경되었습니다. 다시 시도해 주세요.'
        : 'The workspace changed while commands were loading. Try again.'
  }
}

function formatWorkspaceError(
  locale: AppLocale,
  descriptor: WorkspaceServiceErrorDescriptor,
): string {
  const korean = locale === 'ko'
  switch (descriptor.code) {
    case 'NO_WORKSPACE':
      return korean ? '먼저 작업 공간을 선택해 주세요.' : 'Select a workspace first.'
    case 'CANCELLED':
      return korean ? '작업 공간 작업이 취소되었습니다.' : 'The workspace operation was cancelled.'
    case 'OUTSIDE_WORKSPACE':
      switch (descriptor.identifier) {
        case 'invalid-path':
          return korean ? '요청한 경로가 올바르지 않습니다.' : 'The requested path is invalid.'
        case 'path':
          return withValue(
            korean ? '요청한 경로가 작업 공간을 벗어납니다' : 'The path leaves the workspace',
            descriptor.path,
          )
        case 'symlink':
          return withValue(
            korean
              ? '심볼릭 링크가 작업 공간 밖의 경로를 가리킵니다'
              : 'A symbolic link resolves outside the workspace',
            descriptor.path,
          )
        case 'changed-during-read':
          return withValue(
            korean
              ? '파일을 읽는 동안 파일 경로가 작업 공간 밖으로 변경되었습니다'
              : 'The file path moved outside the workspace while the file was being read',
            descriptor.path,
          )
        default:
          return korean
            ? '요청한 경로는 작업 공간 밖에 있습니다.'
            : 'The requested path is outside the workspace.'
      }
    case 'PATH_NOT_FOUND':
      switch (descriptor.identifier) {
        case 'path-required':
          return korean
            ? '올바른 작업 공간 경로가 필요합니다.'
            : 'A valid workspace path is required.'
        case 'workspace':
          return withValue(
            korean ? '작업 공간 경로가 존재하지 않습니다' : 'The workspace does not exist',
            descriptor.path,
          )
        case 'path':
          return withValue(
            korean ? '경로가 존재하지 않습니다' : 'The path does not exist',
            descriptor.path,
          )
        case 'replaced-during-read':
          return withValue(
            korean
              ? '파일을 읽는 동안 파일이 교체되었습니다. 다시 시도해 주세요'
              : 'The file was replaced while it was being read. Try again',
            descriptor.path,
          )
        default:
          return korean ? '경로를 찾을 수 없습니다.' : 'The path could not be found.'
      }
    case 'NOT_A_DIRECTORY':
      return withValue(
        descriptor.identifier === 'workspace'
          ? korean
            ? '작업 공간 경로가 디렉터리가 아닙니다'
            : 'The workspace path is not a directory'
          : korean
            ? '디렉터리가 아닙니다'
            : 'The path is not a directory',
        descriptor.path,
      )
    case 'NOT_A_FILE':
      return withValue(
        korean ? '일반 파일이 아닙니다' : 'The path is not a regular file',
        descriptor.path,
      )
    case 'SENSITIVE_FILE':
      switch (descriptor.identifier) {
        case 'workspace-root':
          return withValue(
            korean
              ? '보안 자격 증명 경로는 작업 공간으로 열 수 없습니다'
              : 'A credential-sensitive path cannot be opened as a workspace',
            descriptor.path,
          )
        case 'content':
          return withValue(
            korean
              ? '자격 증명으로 보이는 내용이 감지되어 파일 읽기를 차단했습니다'
              : 'The file read was blocked because credential-like content was detected',
            descriptor.path,
          )
        default:
          return withValue(
            korean
              ? '민감한 경로에 대한 접근을 차단했습니다'
              : 'Access to a sensitive path was blocked',
            descriptor.path,
          )
      }
    case 'BINARY_FILE':
      return withValue(
        korean ? '바이너리 파일은 읽을 수 없습니다' : 'Binary files cannot be read',
        descriptor.path,
      )
    case 'FILE_TOO_LARGE': {
      const limit = descriptor.maximumBytes
      const message =
        limit === undefined
          ? korean
            ? '파일이 읽기 크기 한도를 초과했습니다'
            : 'The file exceeds the read limit'
          : korean
            ? `파일이 ${formattedNumber(locale, limit)}바이트 읽기 한도를 초과했습니다`
            : `The file exceeds the ${formattedNumber(locale, limit)}-byte read limit`
      return withValue(message, descriptor.path)
    }
    case 'INVALID_QUERY': {
      const minimum = descriptor.minimumCharacters
      const maximum = descriptor.maximumCharacters
      if (minimum !== undefined && maximum !== undefined) {
        return korean
          ? `검색어는 ${formattedNumber(locale, minimum)}자 이상 ${formattedNumber(locale, maximum)}자 이하여야 합니다.`
          : `Search text must contain between ${formattedNumber(locale, minimum)} and ${formattedNumber(locale, maximum)} characters.`
      }
      return korean ? '검색어가 올바르지 않습니다.' : 'The search text is invalid.'
    }
  }
}

function formatExecutionError(
  locale: AppLocale,
  descriptor: StructuredProcessServiceErrorDescriptor,
): string {
  const korean = locale === 'ko'
  switch (descriptor.code) {
    case 'NO_WORKSPACE':
      return korean
        ? '명령을 실행할 작업 공간을 먼저 선택해 주세요.'
        : 'Select a workspace before running a process.'
    case 'INVALID_ARGUMENTS': {
      const minimum = descriptor.minimum
      const maximum = descriptor.maximum
      switch (descriptor.identifier) {
        case 'argv-count':
          return minimum !== undefined && maximum !== undefined
            ? korean
              ? `argv 항목은 ${formattedNumber(locale, minimum)}개 이상 ${formattedNumber(locale, maximum)}개 이하여야 합니다.`
              : `argv must contain between ${formattedNumber(locale, minimum)} and ${formattedNumber(locale, maximum)} entries.`
            : korean
              ? 'argv 항목 수가 올바르지 않습니다.'
              : 'The argv entry count is invalid.'
        case 'argv-entry':
          return descriptor.index === undefined
            ? korean
              ? 'argv 항목은 NUL 문자가 없는 문자열이어야 합니다.'
              : 'Each argv entry must be a string without NUL characters.'
            : korean
              ? `argv[${descriptor.index.toString()}]은(는) NUL 문자가 없는 문자열이어야 합니다.`
              : `argv[${descriptor.index.toString()}] must be a string without NUL characters.`
        case 'argv-entry-too-large': {
          const identifier =
            descriptor.index === undefined ? 'argv 항목' : `argv[${descriptor.index.toString()}]`
          return descriptor.maximumBytes === undefined
            ? korean
              ? `${identifier}이(가) 크기 한도를 초과했습니다.`
              : `${identifier} exceeds the size limit.`
            : korean
              ? `${identifier}이(가) ${formattedNumber(locale, descriptor.maximumBytes)}바이트 한도를 초과했습니다.`
              : `${identifier} exceeds the ${formattedNumber(locale, descriptor.maximumBytes)}-byte limit.`
        }
        case 'argv-total':
          return descriptor.maximumBytes === undefined
            ? korean
              ? 'argv에는 비어 있지 않은 실행 파일과 올바른 전체 크기가 필요합니다.'
              : 'argv must have a non-empty executable and a valid total size.'
            : korean
              ? `argv에는 비어 있지 않은 실행 파일이 필요하며 전체 크기는 ${formattedNumber(locale, descriptor.maximumBytes)}바이트 이하여야 합니다.`
              : `argv must have a non-empty executable and use at most ${formattedNumber(locale, descriptor.maximumBytes)} bytes.`
        case 'executable-path-not-found':
          return withValue(
            korean
              ? '실행 파일 경로를 확인할 수 없습니다'
              : 'The executable path could not be resolved',
            descriptor.executable,
          )
        case 'executable-not-on-path':
          return withValue(
            korean
              ? 'PATH에서 실행 파일을 찾을 수 없습니다'
              : 'The executable could not be found on PATH',
            descriptor.executable,
          )
        case 'timeout':
          return minimum !== undefined && maximum !== undefined
            ? korean
              ? `timeoutMs는 ${formattedNumber(locale, minimum)} 이상 ${formattedNumber(locale, maximum)} 이하여야 합니다.`
              : `timeoutMs must be between ${formattedNumber(locale, minimum)} and ${formattedNumber(locale, maximum)}.`
            : korean
              ? 'timeoutMs가 올바르지 않습니다.'
              : 'timeoutMs is invalid.'
        default:
          return korean ? '명령 인수가 올바르지 않습니다.' : 'The process arguments are invalid.'
      }
    }
    case 'INVALID_CWD':
      switch (descriptor.identifier) {
        case 'nul':
          return korean
            ? 'cwd에는 NUL 문자를 사용할 수 없습니다.'
            : 'cwd cannot contain NUL characters.'
        case 'not-found':
          return withValue(
            korean ? '작업 디렉터리가 존재하지 않습니다' : 'The working directory does not exist',
            descriptor.path,
          )
        case 'not-directory':
          return withValue(
            korean ? 'cwd가 디렉터리가 아닙니다' : 'cwd does not refer to a directory',
            descriptor.path,
          )
        default:
          return korean ? '작업 디렉터리가 올바르지 않습니다.' : 'The working directory is invalid.'
      }
    case 'INVALID_STDIN':
      if (descriptor.identifier === 'too-large') {
        return descriptor.maximumBytes === undefined
          ? korean
            ? 'stdin이 입력 크기 한도를 초과했습니다.'
            : 'stdin exceeds the input size limit.'
          : korean
            ? `stdin이 ${formattedNumber(locale, descriptor.maximumBytes)}바이트 입력 한도를 초과했습니다.`
            : `stdin exceeds the ${formattedNumber(locale, descriptor.maximumBytes)}-byte input limit.`
      }
      return korean ? 'stdin은 UTF-8 문자열이어야 합니다.' : 'stdin must be a UTF-8 string.'
    case 'OUTSIDE_WORKSPACE':
      return withValue(
        korean
          ? '요청한 작업 디렉터리가 작업 공간 밖의 경로로 해석됩니다'
          : 'The requested working directory resolves outside the workspace',
        descriptor.path,
      )
  }
}

function gitOperationName(locale: AppLocale, operation: GitOperation | undefined): string {
  const names: Record<GitOperation, readonly [string, string]> = {
    status: ['상태 확인', 'status inspection'],
    'repository-head': ['저장소 HEAD 확인', 'repository HEAD lookup'],
    'repository-branch': ['저장소 브랜치 확인', 'repository branch lookup'],
    'safe-diff-paths': ['diff 경로 안전성 확인', 'diff path safety check'],
    'staged-diff': ['staged diff 읽기', 'staged diff read'],
    'unstaged-diff': ['unstaged diff 읽기', 'unstaged diff read'],
    'repository-root': ['저장소 루트 확인', 'repository root inspection'],
    'repository-process-filters': [
      '저장소 프로세스 필터 확인',
      'repository process-filter inspection',
    ],
  }
  if (operation === undefined) return locale === 'ko' ? '명령 실행' : 'command execution'
  return names[operation][locale === 'ko' ? 0 : 1]
}

function formatGitCommandFailure(
  locale: AppLocale,
  descriptor: Extract<GitServiceErrorDescriptor, { code: 'GIT_FAILED' }>,
): string {
  const korean = locale === 'ko'
  const operation = gitOperationName(locale, descriptor.operation)
  const base = korean ? `Git ${operation}에 실패했습니다.` : `Git ${operation} failed.`
  if (descriptor.externalDetail) return `${base} ${descriptor.externalDetail}`
  if (typeof descriptor.exitCode === 'number') {
    return korean
      ? `${base} 종료 코드: ${descriptor.exitCode.toString()}`
      : `${base} Exit code: ${descriptor.exitCode.toString()}`
  }
  return base
}

function formatGitError(locale: AppLocale, descriptor: GitServiceErrorDescriptor): string {
  const korean = locale === 'ko'
  switch (descriptor.code) {
    case 'NO_WORKSPACE':
      return korean
        ? 'Git을 확인할 작업 공간을 먼저 선택해 주세요.'
        : 'Select a workspace before inspecting Git.'
    case 'NOT_A_REPOSITORY': {
      let message: string
      switch (descriptor.identifier) {
        case 'invalid-root':
          message = korean
            ? 'Git이 올바르지 않은 저장소 루트를 반환했습니다.'
            : 'Git reported an invalid repository root.'
          break
        case 'unrelated-root':
          message = korean
            ? 'Git 저장소 루트가 현재 작업 공간과 관련이 없습니다.'
            : 'The Git repository root is unrelated to the current workspace.'
          break
        default:
          message = korean
            ? '현재 작업 공간은 Git 저장소가 아닙니다.'
            : 'The current workspace is not a Git repository.'
      }
      if (descriptor.path !== undefined) message = `${message} ${descriptor.path}`
      if (descriptor.externalDetail) message = `${message} ${descriptor.externalDetail}`
      return message
    }
    case 'INVALID_PATH':
      switch (descriptor.identifier) {
        case 'requested':
          return withValue(
            korean
              ? 'diff 경로는 비어 있지 않은 작업 공간 상대 경로여야 합니다'
              : 'A diff path must be a non-empty workspace-relative path',
            descriptor.path,
          )
        case 'outside':
          return withValue(
            korean
              ? 'diff 경로가 작업 공간 밖에 있습니다'
              : 'The diff path is outside the workspace',
            descriptor.path,
          )
        case 'workspace-root':
          return withValue(
            korean
              ? '파일 또는 디렉터리 경로가 필요합니다'
              : 'A file or directory path is required',
            descriptor.path,
          )
        case 'reported':
          return withValue(
            korean
              ? 'Git이 안전하지 않은 변경 경로를 반환했습니다'
              : 'Git reported an unsafe changed path',
            descriptor.path,
          )
        default:
          return korean ? 'Git 경로가 올바르지 않습니다.' : 'The Git path is invalid.'
      }
    case 'SENSITIVE_PATH':
      return withValue(
        korean
          ? '민감한 경로는 Git으로 확인할 수 없습니다'
          : 'Sensitive paths cannot be inspected with Git',
        descriptor.path,
      )
    case 'SENSITIVE_CONTENT':
      return withValue(
        korean
          ? '자격 증명으로 보이는 내용이 감지되어 Git diff를 차단했습니다'
          : 'The Git diff was blocked because credential-like content was detected',
        descriptor.path,
      )
    case 'UNSAFE_REPOSITORY':
      return korean
        ? '저장소에 정의된 Git 프로세스 필터와 diff 드라이버는 실행할 수 없습니다.'
        : 'Repository-defined Git process filters and diff drivers cannot be executed.'
    case 'GIT_NOT_FOUND':
      return withValue(
        korean
          ? '작업 공간 밖에서 실행 가능한 정규 Git 실행 파일을 찾을 수 없습니다'
          : 'A canonical executable Git binary outside the workspace could not be found',
        descriptor.executable,
      )
    case 'GIT_FAILED':
      if (descriptor.identifier === 'changed-path-list-too-large') {
        return korean
          ? '변경 경로 목록이 너무 큽니다. 더 좁은 diff 경로를 요청해 주세요.'
          : 'The changed path list is too large. Request a narrower diff path.'
      }
      if (descriptor.identifier === 'too-many-changed-paths') {
        if (
          descriptor.maximumPaths !== undefined &&
          descriptor.maximumPathspecBytes !== undefined
        ) {
          return korean
            ? `변경 경로가 ${formattedNumber(locale, descriptor.maximumPaths)}개 또는 전체 ${formattedNumber(locale, descriptor.maximumPathspecBytes)}바이트 한도를 초과했습니다. 더 좁은 diff 경로를 요청해 주세요.`
            : `Changed paths exceed the ${formattedNumber(locale, descriptor.maximumPaths)}-path or ${formattedNumber(locale, descriptor.maximumPathspecBytes)}-byte aggregate limit. Request a narrower diff path.`
        }
        return korean
          ? '변경 경로가 너무 많습니다. 더 좁은 diff 경로를 요청해 주세요.'
          : 'There are too many changed paths. Request a narrower diff path.'
      }
      return formatGitCommandFailure(locale, descriptor)
    case 'GIT_TIMEOUT': {
      const operation = gitOperationName(locale, descriptor.operation)
      return korean ? `Git ${operation} 시간이 초과되었습니다.` : `Git ${operation} timed out.`
    }
    case 'CANCELLED':
      return korean ? 'Git 확인이 취소되었습니다.' : 'Git inspection was cancelled.'
  }
}

function formatSettingsError(
  locale: AppLocale,
  descriptor: SettingsServiceErrorDescriptor,
): string {
  const korean = locale === 'ko'
  switch (descriptor.code) {
    case 'INVALID_SETTINGS_FILE':
      if (descriptor.identifier === 'provider-generation') {
        return withValue(
          korean
            ? '공급자 설정 세대를 안전하게 증가시킬 수 없습니다'
            : 'The provider configuration generation cannot be advanced safely',
          descriptor.providerId,
        )
      }
      if (descriptor.identifier === 'backup-failed') {
        return withValue(
          korean
            ? '올바르지 않은 설정 파일을 백업하지 못했습니다'
            : 'The invalid settings file could not be backed up',
          descriptor.path,
        )
      }
      if (descriptor.identifier === 'write-validation') {
        return withValue(
          korean
            ? '현재 설정 상태가 저장 형식과 맞지 않아 기존 설정 파일을 유지했습니다. 설정을 다시 불러온 뒤 재시도하세요'
            : 'The current settings state does not match the persisted format, so the existing settings file was preserved. Reload settings and try again',
          descriptor.path,
        )
      }
      return korean ? '설정 파일이 올바르지 않습니다.' : 'The settings file is invalid.'
    case 'SETTINGS_READ_FAILED':
      return withValue(
        korean ? '설정 파일을 읽지 못했습니다' : 'The settings file could not be read',
        descriptor.path,
      )
    case 'SETTINGS_WRITE_FAILED':
      return withValue(
        korean ? '설정 파일을 저장하지 못했습니다' : 'The settings file could not be saved',
        descriptor.path,
      )
    case 'ENCRYPTION_UNAVAILABLE':
      if (descriptor.operation === 'read') {
        return korean
          ? '보안 자격 증명 저장소를 사용할 수 없어 저장된 API 키를 읽을 수 없습니다.'
          : 'Secure credential storage is unavailable, so the saved API key cannot be read.'
      }
      return korean
        ? '보안 자격 증명 저장소를 사용할 수 없어 API 키를 저장하지 않았습니다.'
        : 'Secure credential storage is unavailable, so the API key was not saved.'
    case 'ENCRYPTION_FAILED':
      if (descriptor.operation === 'decrypt') {
        return korean
          ? '저장된 API 키를 복호화하지 못했습니다.'
          : 'The saved API key could not be decrypted.'
      }
      return korean
        ? 'API 키를 암호화하지 못해 저장하지 않았습니다.'
        : 'The API key could not be encrypted and was not saved.'
    case 'CREDENTIAL_TOO_LARGE':
      if (descriptor.identifier === 'api-key') {
        return korean
          ? `API 키가 UTF-8 기준 ${formattedNumber(locale, descriptor.maximumBytes)}바이트 한도를 초과했습니다. 더 짧은 API 키를 입력해 주세요.`
          : `The API key exceeds the ${formattedNumber(locale, descriptor.maximumBytes)}-byte UTF-8 limit. Enter a shorter API key.`
      }
      return korean
        ? `보안 저장소가 ${formattedNumber(locale, descriptor.maximumCharacters)}자 저장 한도를 초과하는 암호문을 반환했습니다. 더 짧은 API 키를 입력하거나 보안 저장소 설정을 확인해 주세요.`
        : `Secure storage returned ciphertext that exceeds the ${formattedNumber(locale, descriptor.maximumCharacters)}-character persistence limit. Enter a shorter API key or check the secure-storage configuration.`
    case 'CREDENTIAL_REENTRY_REQUIRED':
      return korean
        ? '기존 저장 API 키를 현재 앱에서 열 수 없으므로 같은 공급자에 API 키를 다시 입력해 저장하세요. 기존 암호문은 덮어쓰기 전까지 보존됩니다.'
        : 'The previously saved API key cannot be opened by the current app. Re-enter and save the API key for the same provider. The existing ciphertext is preserved until it is overwritten.'
    case 'PROVIDER_NOT_FOUND':
      if (descriptor.identifier === 'id-required') {
        return korean ? '공급자 ID가 필요합니다.' : 'A provider ID is required.'
      }
      return withValue(
        descriptor.identifier === 'update'
          ? korean
            ? '존재하지 않는 공급자는 수정할 수 없습니다'
            : 'A provider that does not exist cannot be updated'
          : korean
            ? '공급자를 찾을 수 없습니다'
            : 'The provider could not be found',
        descriptor.providerId,
      )
    case 'INVALID_ACTIVE_SELECTION':
      if (descriptor.identifier === 'provider-required') {
        return korean
          ? '활성 공급자를 선택하지 않으면 모델을 선택할 수 없습니다.'
          : 'A model cannot be selected without an active provider.'
      }
      return withValue(
        descriptor.identifier === 'provider-missing'
          ? korean
            ? '선택한 공급자가 존재하지 않습니다'
            : 'The selected provider does not exist'
          : korean
            ? '활성 공급자 또는 모델 선택이 올바르지 않습니다'
            : 'The active provider or model selection is invalid',
        descriptor.providerId,
      )
  }
}

function mutationFieldSuffix(
  locale: AppLocale,
  descriptor: MutationServiceErrorDescriptor,
): string {
  const korean = locale === 'ko'
  const fields: string[] = []
  if (descriptor.path !== undefined) {
    fields.push(`${korean ? '경로' : 'Path'}: ${descriptor.path}`)
  }
  if (descriptor.currentSha256 !== undefined) {
    fields.push(
      `${korean ? '현재 SHA-256' : 'Current SHA-256'}: ${descriptor.currentSha256 ?? 'null'}`,
    )
  }
  if (descriptor.expectedSha256 !== undefined) {
    fields.push(
      `${korean ? '예상 SHA-256' : 'Expected SHA-256'}: ${descriptor.expectedSha256 ?? 'null'}`,
    )
  }
  if (descriptor.actionHash !== undefined) {
    fields.push(`${korean ? '작업 해시' : 'Action hash'}: ${descriptor.actionHash}`)
  }
  if (descriptor.journalId !== undefined) {
    fields.push(`${korean ? '저널 ID' : 'Journal ID'}: ${descriptor.journalId}`)
  }
  return fields.length > 0 ? ` ${fields.join(' / ')}` : ''
}

function formatMutationError(
  locale: AppLocale,
  descriptor: MutationServiceErrorDescriptor,
): string {
  const korean = locale === 'ko'
  let message: string
  switch (descriptor.code) {
    case 'NO_WORKSPACE':
      message = korean
        ? '파일을 변경할 작업 공간을 먼저 선택해 주세요.'
        : 'Select a workspace before modifying files.'
      break
    case 'INVALID_PROPOSAL':
      switch (descriptor.identifier) {
        case 'sha256':
          message = descriptor.field
            ? korean
              ? `${descriptor.field}은(는) 소문자 SHA-256 해시여야 합니다.`
              : `${descriptor.field} must be a lowercase SHA-256 hash.`
            : korean
              ? 'SHA-256 해시가 올바르지 않습니다.'
              : 'The SHA-256 hash is invalid.'
          break
        case 'patch-file-count':
        case 'change-count': {
          const noun = descriptor.identifier === 'patch-file-count' ? 'patches' : 'changes'
          message =
            descriptor.minimum !== undefined && descriptor.maximum !== undefined
              ? korean
                ? `${noun}에는 ${formattedNumber(locale, descriptor.minimum)}개 이상 ${formattedNumber(locale, descriptor.maximum)}개 이하의 파일이 있어야 합니다.`
                : `${noun} must contain between ${formattedNumber(locale, descriptor.minimum)} and ${formattedNumber(locale, descriptor.maximum)} files.`
              : korean
                ? `${noun}의 파일 수가 올바르지 않습니다.`
                : `The ${noun} file count is invalid.`
          break
        }
        case 'patch-entry':
        case 'change-entry': {
          const noun = descriptor.identifier === 'patch-entry' ? 'patches' : 'changes'
          message =
            descriptor.index === undefined
              ? korean
                ? `${noun} 항목은 객체여야 합니다.`
                : `Each ${noun} entry must be an object.`
              : korean
                ? `${noun}[${descriptor.index.toString()}]은(는) 객체여야 합니다.`
                : `${noun}[${descriptor.index.toString()}] must be an object.`
          break
        }
        case 'patch-hunk-count':
          message =
            descriptor.index !== undefined &&
            descriptor.minimum !== undefined &&
            descriptor.maximum !== undefined
              ? korean
                ? `patches[${descriptor.index.toString()}].hunks에는 ${formattedNumber(locale, descriptor.minimum)}개 이상 ${formattedNumber(locale, descriptor.maximum)}개 이하의 항목이 있어야 합니다.`
                : `patches[${descriptor.index.toString()}].hunks must contain between ${formattedNumber(locale, descriptor.minimum)} and ${formattedNumber(locale, descriptor.maximum)} items.`
              : korean
                ? 'patch hunks의 항목 수가 올바르지 않습니다.'
                : 'The patch hunk count is invalid.'
          break
        case 'patch-hunk':
          message =
            descriptor.index !== undefined && descriptor.hunkIndex !== undefined
              ? korean
                ? `patches[${descriptor.index.toString()}].hunks[${descriptor.hunkIndex.toString()}]에는 비어 있지 않은 oldText와 문자열 newText가 필요합니다.`
                : `patches[${descriptor.index.toString()}].hunks[${descriptor.hunkIndex.toString()}] must contain non-empty oldText and string newText.`
              : korean
                ? 'patch hunk가 올바르지 않습니다.'
                : 'The patch hunk is invalid.'
          break
        case 'new-content':
          message =
            descriptor.index === undefined
              ? korean
                ? 'newContent는 문자열 또는 null이어야 합니다.'
                : 'newContent must be text or null.'
              : korean
                ? `changes[${descriptor.index.toString()}].newContent는 문자열 또는 null이어야 합니다.`
                : `changes[${descriptor.index.toString()}].newContent must be text or null.`
          break
        case 'create-base-hash':
          message = korean
            ? '새 파일을 만들 때 baseSha256은 null이어야 합니다.'
            : 'baseSha256 must be null when creating a file.'
          break
        case 'delete-missing':
          message = korean
            ? '존재하지 않는 파일은 삭제할 수 없습니다.'
            : 'A missing file cannot be deleted.'
          break
        case 'unchanged':
          message = korean
            ? '제안된 파일 내용이 현재 내용과 같습니다.'
            : 'The proposed file content is unchanged.'
          break
        case 'summary-required':
          message = korean ? '텍스트 요약이 필요합니다.' : 'A text summary is required.'
          break
        case 'summary-length':
          message =
            descriptor.minimum !== undefined && descriptor.maximum !== undefined
              ? korean
                ? `요약은 ${formattedNumber(locale, descriptor.minimum)}자 이상 ${formattedNumber(locale, descriptor.maximum)}자 이하여야 합니다.`
                : `The summary must contain between ${formattedNumber(locale, descriptor.minimum)} and ${formattedNumber(locale, descriptor.maximum)} characters.`
              : korean
                ? '요약이 너무 깁니다.'
                : 'The summary is too long.'
          break
        default:
          message = korean
            ? '파일 변경 제안이 올바르지 않습니다.'
            : 'The file mutation proposal is invalid.'
      }
      break
    case 'INVALID_PATH':
      switch (descriptor.identifier) {
        case 'path-value':
          message = korean
            ? '파일 변경 경로는 올바른 작업 공간 상대 경로여야 합니다.'
            : 'A mutation path must be a valid workspace-relative path.'
          break
        case 'parent-missing':
          message = korean
            ? '새 파일의 부모 디렉터리가 없습니다. 파일 변경을 다시 제안하기 전에 run_command로 shell 없이 /bin/mkdir -p -- 를 실행해 필요한 디렉터리를 먼저 준비해야 합니다.'
            : 'The new file parent directory is missing. Before proposing file changes again, use run_command to prepare it with shell-disabled /bin/mkdir -p --.'
          if (descriptor.parentPath) {
            message = `${message} ${korean ? '필요한 부모 경로' : 'Required parent path'}: ${descriptor.parentPath}`
          }
          break
        case 'path-length':
          message =
            descriptor.maximumBytes !== undefined
              ? korean
                ? `파일 변경 경로가 ${formattedNumber(locale, descriptor.maximumBytes)}바이트 한도를 초과했습니다.`
                : `The mutation path exceeds the ${formattedNumber(locale, descriptor.maximumBytes)}-byte limit.`
              : korean
                ? '파일 변경 경로가 너무 깁니다.'
                : 'The mutation path is too long.'
          break
        case 'outside-workspace':
          message = korean
            ? '파일 변경 경로가 작업 공간 밖의 경로로 해석됩니다.'
            : 'The mutation path resolves outside the workspace.'
          break
        case 'workspace-root':
          message = korean
            ? '작업 공간 안의 파일 경로가 필요합니다.'
            : 'A file path inside the workspace is required.'
          break
        case 'git-metadata':
          message = korean
            ? '이 서비스에서는 Git 메타데이터를 변경할 수 없습니다.'
            : 'Git metadata cannot be modified by this service.'
          break
        default:
          message = korean ? '파일 변경 경로가 올바르지 않습니다.' : 'The mutation path is invalid.'
      }
      break
    case 'DUPLICATE_PATH':
      message =
        descriptor.identifier === 'patch-duplicate'
          ? korean
            ? '같은 파일은 한 번만 patch할 수 있습니다.'
            : 'A file can only be patched once.'
          : korean
            ? '같은 파일은 한 번만 변경할 수 있습니다.'
            : 'A file can only be changed once.'
      break
    case 'HASH_CONFLICT':
      if (descriptor.identifier === 'create-conflict') {
        message = korean
          ? '새 파일을 만들려는 경로에 이미 파일이 있습니다.'
          : 'A file already exists at the requested creation path.'
      } else if (descriptor.identifier === 'recovery-image') {
        message = korean
          ? '복구 중 파일에서 알 수 없는 상태가 감지되어 중단했습니다.'
          : 'Recovery stopped because a file has an unknown image.'
      } else {
        message = korean
          ? '파일을 읽은 뒤 내용이 변경되었습니다. 최신 파일을 다시 읽고 변경을 다시 준비해 주세요.'
          : 'The file changed after it was read. Read the latest file and prepare the mutation again.'
      }
      break
    case 'PATCH_CONFLICT':
      switch (descriptor.identifier) {
        case 'patch-target-missing':
          message = korean
            ? 'patch 대상 파일이 존재하지 않습니다.'
            : 'The patch target does not exist.'
          break
        case 'patch-no-match':
          message =
            descriptor.hunkIndex === undefined
              ? korean
                ? 'patch hunk가 현재 파일과 일치하지 않습니다.'
                : 'The patch hunk did not match the current file.'
              : korean
                ? `${formattedNumber(locale, descriptor.hunkIndex + 1)}번째 patch hunk가 현재 파일과 일치하지 않습니다.`
                : `Patch hunk ${formattedNumber(locale, descriptor.hunkIndex + 1)} did not match the current file.`
          break
        case 'patch-ambiguous':
          message = korean
            ? 'patch hunk가 여러 위치와 일치합니다. 변경되지 않은 문맥을 더 포함해 주세요.'
            : 'The patch hunk is ambiguous. Include more unchanged context.'
          break
        case 'patch-overlap':
          message = korean
            ? '현재 파일에서 patch hunk가 서로 겹칩니다.'
            : 'Patch hunks overlap in the current file.'
          break
        default:
          message = korean
            ? 'patch를 현재 파일에 적용할 수 없습니다.'
            : 'The patch cannot be applied to the current file.'
      }
      break
    case 'SYMLINK_REJECTED':
      message = korean ? '심볼릭 링크는 변경할 수 없습니다.' : 'Symbolic links cannot be changed.'
      break
    case 'NOT_REGULAR_FILE':
      message = korean ? '일반 파일만 변경할 수 있습니다.' : 'Only regular files can be changed.'
      break
    case 'FILE_TOO_LARGE':
      if (descriptor.identifier === 'journal-size') {
        message = korean
          ? '비공개 실행 취소 저널이 크기 한도를 초과합니다.'
          : 'The private undo journal would exceed its size limit.'
      } else if (descriptor.identifier === 'patch-total') {
        message =
          descriptor.maximumBytes === undefined
            ? korean
              ? 'patch 제안이 전체 크기 한도를 초과했습니다.'
              : 'The patch proposal exceeds the aggregate size limit.'
            : korean
              ? `patch 제안이 전체 ${formattedNumber(locale, descriptor.maximumBytes)}바이트 한도를 초과했습니다.`
              : `The patch proposal exceeds the ${formattedNumber(locale, descriptor.maximumBytes)}-byte aggregate limit.`
      } else {
        message =
          descriptor.maximumBytes === undefined
            ? korean
              ? '파일 변경이 크기 한도를 초과했습니다.'
              : 'The file mutation exceeds a size limit.'
            : korean
              ? `파일 변경이 ${formattedNumber(locale, descriptor.maximumBytes)}바이트 한도를 초과했습니다.`
              : `The file mutation exceeds the ${formattedNumber(locale, descriptor.maximumBytes)}-byte limit.`
      }
      break
    case 'BINARY_FILE':
      if (descriptor.identifier === 'nul-content') {
        message = korean
          ? '파일 내용에는 NUL 바이트를 사용할 수 없습니다.'
          : 'File content cannot contain NUL bytes.'
      } else if (descriptor.identifier === 'invalid-utf8') {
        message = korean
          ? '파일 내용은 올바른 UTF-8 텍스트여야 합니다.'
          : 'File content must be valid UTF-8 text.'
      } else {
        message = korean
          ? '바이너리로 보이는 파일은 변경할 수 없습니다.'
          : 'Binary-looking files cannot be changed.'
      }
      break
    case 'ACTION_NOT_FOUND':
      message =
        descriptor.identifier === 'hash-required'
          ? korean
            ? '준비된 작업 해시가 필요합니다.'
            : 'A prepared action hash is required.'
          : descriptor.identifier === 'workspace-changed'
            ? korean
              ? '파일 변경을 준비한 뒤 작업 공간이 변경되었습니다.'
              : 'The workspace changed after the file mutation was prepared.'
            : korean
              ? '준비된 파일 변경 작업을 찾을 수 없습니다.'
              : 'The prepared file mutation could not be found.'
      break
    case 'ACTION_TAMPERED':
      message =
        descriptor.identifier === 'workspace-changed'
          ? korean
            ? '파일 변경을 준비한 뒤 작업 공간이 변경되었습니다.'
            : 'The workspace changed after the file mutation was prepared.'
          : korean
            ? '준비된 파일 변경의 무결성 검사에 실패했습니다.'
            : 'The prepared file mutation failed its integrity check.'
      break
    case 'APPLY_FAILED':
      message =
        descriptor.identifier === 'undo'
          ? korean
            ? '마지막 파일 변경을 실행 취소하지 못했습니다.'
            : 'The last file mutation could not be undone.'
          : korean
            ? '파일 변경을 적용하지 못했습니다.'
            : 'The file mutation could not be applied.'
      break
    case 'RECOVERY_REQUIRED':
      message =
        descriptor.identifier === 'undo'
          ? korean
            ? '실행 취소를 안전하게 완료하지 못했습니다. 복구를 위해 write-ahead marker를 유지했습니다.'
            : 'Undo could not be finalized safely. Its write-ahead marker was retained for recovery.'
          : descriptor.identifier === 'pending-recovery'
            ? korean
              ? '중단된 파일 변경을 아직 복구해야 합니다. 새 파일 변경 전에 복구를 완료해 주세요.'
              : 'An interrupted file mutation still requires recovery. Complete recovery before changing more files.'
            : korean
              ? '파일 변경을 안전하게 완료하지 못했습니다. 복구를 위해 write-ahead 저널을 유지했습니다.'
              : 'The file mutation could not be finalized safely. Its write-ahead journal was retained for recovery.'
      break
    case 'NO_UNDO':
      message = korean ? '실행 취소할 파일 변경이 없습니다.' : 'There is no file mutation to undo.'
      break
    case 'JOURNAL_INVALID':
      message =
        descriptor.identifier === 'pending-recovery'
          ? korean
            ? '중단된 파일 변경을 아직 복구해야 합니다. 새 파일 변경 전에 복구를 완료해 주세요.'
            : 'An interrupted file mutation still requires recovery. Complete recovery before changing more files.'
          : korean
            ? '파일 변경 저널이 올바르지 않습니다.'
            : 'The file mutation journal is invalid.'
      break
    case 'UNDO_CONFLICT':
      message =
        descriptor.identifier === 'latest-action-changed'
          ? korean
            ? '검토한 뒤 최신 파일 변경이 바뀌었습니다. 실행 취소 미리보기를 새로고침해 주세요.'
            : 'The latest file mutation changed after review. Refresh the undo preview.'
          : korean
            ? '파일 상태가 달라 실행 취소할 수 없습니다.'
            : 'The file state changed, so the mutation cannot be undone.'
      break
    case 'CANCELLED':
      message = korean ? '파일 변경이 취소되었습니다.' : 'The file mutation was cancelled.'
      break
  }
  return `${message}${mutationFieldSuffix(locale, descriptor)}`
}

function formatTrustError(locale: AppLocale, descriptor: TrustServiceErrorDescriptor): string {
  const korean = locale === 'ko'
  switch (descriptor.code) {
    case 'INVALID_WORKSPACE':
      if (descriptor.identifier === 'path-required') {
        return korean
          ? '올바른 작업 공간 경로가 필요합니다.'
          : 'A valid workspace path is required.'
      }
      if (descriptor.identifier === 'not-directory') {
        return withValue(
          korean
            ? '작업 공간 신뢰는 디렉터리에만 설정할 수 있습니다'
            : 'Workspace trust can only target a directory',
          descriptor.path,
        )
      }
      return withValue(
        korean
          ? '작업 공간 경로를 확인할 수 없습니다'
          : 'The workspace path cannot be canonicalized',
        descriptor.path,
      )
    case 'INVALID_TRUST_FILE':
      if (descriptor.identifier === 'backup-failed') {
        return withValue(
          korean
            ? '올바르지 않은 작업 공간 신뢰 파일을 백업하지 못했습니다'
            : 'The invalid workspace trust file could not be backed up',
          descriptor.path,
        )
      }
      return korean
        ? '작업 공간 신뢰 파일이 올바르지 않습니다.'
        : 'The workspace trust file is invalid.'
    case 'TRUST_READ_FAILED':
      return withValue(
        korean
          ? '작업 공간 신뢰 파일을 읽지 못했습니다'
          : 'The workspace trust file could not be read',
        descriptor.path,
      )
    case 'TRUST_WRITE_FAILED':
      return withValue(
        korean
          ? '작업 공간 신뢰 파일을 저장하지 못했습니다'
          : 'The workspace trust file could not be saved',
        descriptor.path,
      )
  }
}

function formatSkillError(locale: AppLocale, descriptor: SkillServiceErrorDescriptor): string {
  const korean = locale === 'ko'
  switch (descriptor.code) {
    case 'SKILL_NOT_FOUND':
      return korean
        ? '요청한 작업 공간 Skill을 찾을 수 없습니다.'
        : 'The requested workspace Skill could not be found.'
    case 'REVISION_MISMATCH':
      return korean
        ? '목록을 확인한 뒤 작업 공간 Skill이 변경되었습니다. 다시 검토한 후 불러와 주세요.'
        : 'The workspace Skill changed after discovery. Review it again before loading.'
    case 'INVALID_RESOURCE':
      if (descriptor.identifier === 'not-listed') {
        return korean
          ? '요청한 경로가 해당 Skill에 등록된 리소스가 아닙니다.'
          : 'The requested path is not a listed resource for this Skill.'
      }
      if (descriptor.identifier === 'read-failed') {
        return korean
          ? 'Skill 리소스를 안전하게 읽을 수 없습니다.'
          : 'The Skill resource could not be read safely.'
      }
      return korean
        ? '요청한 Skill 리소스가 올바르지 않습니다.'
        : 'The requested Skill resource is invalid.'
  }
}

export function formatServiceErrorDescriptor(
  locale: AppLocale,
  descriptor: ServiceErrorDescriptor,
): string {
  switch (descriptor.service) {
    case 'command':
      return formatCommandError(locale, descriptor)
    case 'workspace':
      return formatWorkspaceError(locale, descriptor)
    case 'execution':
      return formatExecutionError(locale, descriptor)
    case 'git':
      return formatGitError(locale, descriptor)
    case 'settings':
      return formatSettingsError(locale, descriptor)
    case 'mutation':
      return formatMutationError(locale, descriptor)
    case 'trust':
      return formatTrustError(locale, descriptor)
    case 'skill':
      return formatSkillError(locale, descriptor)
  }
}

export function formatServiceError(error: unknown, locale: AppLocale): string | null {
  if (
    !(error instanceof Error) ||
    !(SERVICE_ERROR_MARKER in error) ||
    error[SERVICE_ERROR_MARKER] !== true
  ) {
    return null
  }
  return formatServiceErrorDescriptor(locale, (error as ServiceErrorCarrier).descriptor)
}
