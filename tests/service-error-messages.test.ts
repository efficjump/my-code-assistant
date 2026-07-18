import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CommandError } from '../src/main/services/commands'
import { StructuredProcessError } from '../src/main/services/execution'
import { GitServiceError } from '../src/main/services/git'
import { MutationError } from '../src/main/services/mutation'
import {
  formatServiceError,
  isRecoverableServiceErrorDescriptor,
  type MutationErrorCode,
} from '../src/main/services/service-error-messages'
import {
  MAX_PERSISTED_CREDENTIAL_CHARACTERS,
  SettingsStore,
  SettingsStoreError,
} from '../src/main/services/settings'
import { SkillError } from '../src/main/services/skills'
import { TrustStoreError } from '../src/main/services/trust'
import { WorkspaceError } from '../src/main/services/workspace'
import { MAX_PROVIDER_API_KEY_BYTES } from '../src/shared/contracts'

describe('formatServiceError', () => {
  it('classifies only explicitly transient or refresh-driven service descriptors as recoverable', () => {
    expect(
      isRecoverableServiceErrorDescriptor({
        service: 'git',
        code: 'GIT_TIMEOUT',
        operation: 'status',
      }),
    ).toBe(true)
    expect(
      isRecoverableServiceErrorDescriptor({
        service: 'git',
        code: 'GIT_FAILED',
        operation: 'status',
      }),
    ).toBe(false)
    expect(
      isRecoverableServiceErrorDescriptor({
        service: 'mutation',
        code: 'HASH_CONFLICT',
        path: 'src/example.ts',
      }),
    ).toBe(true)
    expect(
      isRecoverableServiceErrorDescriptor({
        service: 'mutation',
        code: 'INVALID_PATH',
        identifier: 'path-value',
        path: 'src/example.ts',
      }),
    ).toBe(false)
    expect(isRecoverableServiceErrorDescriptor({ service: 'mutation', code: 'APPLY_FAILED' })).toBe(
      false,
    )
  })

  it('formats app-owned service errors from stable descriptors in Korean and English', () => {
    const cases = [
      {
        error: new CommandError({
          code: 'INVALID_ARGUMENTS',
          identifier: 'incomplete-escape',
        }),
        ko: '슬래시 명령 인수의 이스케이프 문자가 완전하지 않습니다.',
        en: 'A slash-command argument ends with an incomplete escape sequence.',
      },
      {
        error: new WorkspaceError({
          code: 'FILE_TOO_LARGE',
          path: 'src/원문.ts',
          maximumBytes: 1_024,
        }),
        ko: '파일이 1,024바이트 읽기 한도를 초과했습니다: src/원문.ts',
        en: 'The file exceeds the 1,024-byte read limit: src/원문.ts',
      },
      {
        error: new WorkspaceError({ code: 'CANCELLED' }),
        ko: '작업 공간 작업이 취소되었습니다.',
        en: 'The workspace operation was cancelled.',
      },
      {
        error: new StructuredProcessError({
          code: 'INVALID_ARGUMENTS',
          identifier: 'executable-not-on-path',
          executable: '도구 --literal',
        }),
        ko: 'PATH에서 실행 파일을 찾을 수 없습니다: 도구 --literal',
        en: 'The executable could not be found on PATH: 도구 --literal',
      },
      {
        error: new SettingsStoreError({
          code: 'INVALID_ACTIVE_SELECTION',
          identifier: 'provider-missing',
          providerId: 'provider/원문-id',
        }),
        ko: '선택한 공급자가 존재하지 않습니다: provider/원문-id',
        en: 'The selected provider does not exist: provider/원문-id',
      },
      {
        error: new SettingsStoreError({ code: 'CREDENTIAL_REENTRY_REQUIRED' }),
        ko: '기존 저장 API 키를 현재 앱에서 열 수 없으므로 같은 공급자에 API 키를 다시 입력해 저장하세요. 기존 암호문은 덮어쓰기 전까지 보존됩니다.',
        en: 'The previously saved API key cannot be opened by the current app. Re-enter and save the API key for the same provider. The existing ciphertext is preserved until it is overwritten.',
      },
      {
        error: new SettingsStoreError({
          code: 'CREDENTIAL_TOO_LARGE',
          identifier: 'api-key',
          maximumBytes: MAX_PROVIDER_API_KEY_BYTES,
        }),
        ko: `API 키가 UTF-8 기준 ${MAX_PROVIDER_API_KEY_BYTES.toLocaleString('ko-KR')}바이트 한도를 초과했습니다. 더 짧은 API 키를 입력해 주세요.`,
        en: `The API key exceeds the ${MAX_PROVIDER_API_KEY_BYTES.toLocaleString('en-US')}-byte UTF-8 limit. Enter a shorter API key.`,
      },
      {
        error: new SettingsStoreError({
          code: 'CREDENTIAL_TOO_LARGE',
          identifier: 'encrypted-api-key',
          maximumCharacters: MAX_PERSISTED_CREDENTIAL_CHARACTERS,
        }),
        ko: `보안 저장소가 ${MAX_PERSISTED_CREDENTIAL_CHARACTERS.toLocaleString('ko-KR')}자 저장 한도를 초과하는 암호문을 반환했습니다. 더 짧은 API 키를 입력하거나 보안 저장소 설정을 확인해 주세요.`,
        en: `Secure storage returned ciphertext that exceeds the ${MAX_PERSISTED_CREDENTIAL_CHARACTERS.toLocaleString('en-US')}-character persistence limit. Enter a shorter API key or check the secure-storage configuration.`,
      },
      {
        error: new SkillError({ code: 'REVISION_MISMATCH' }),
        ko: '목록을 확인한 뒤 작업 공간 Skill이 변경되었습니다. 다시 검토한 후 불러와 주세요.',
        en: 'The workspace Skill changed after discovery. Review it again before loading.',
      },
      {
        error: new SkillError({ code: 'INVALID_RESOURCE', identifier: 'not-listed' }),
        ko: '요청한 경로가 해당 Skill에 등록된 리소스가 아닙니다.',
        en: 'The requested path is not a listed resource for this Skill.',
      },
    ] as const

    for (const { error, ko, en } of cases) {
      expect(formatServiceError(error, 'ko')).toBe(ko)
      expect(formatServiceError(error, 'en')).toBe(en)
    }
  })

  it('preserves genuine Git stderr verbatim under each localized wrapper', () => {
    const externalDetail = 'fatal: 외부 Git 상세\nsecond line\n'
    const error = new GitServiceError({
      code: 'GIT_FAILED',
      identifier: 'command',
      operation: 'staged-diff',
      externalDetail,
      exitCode: 128,
    })

    expect(formatServiceError(error, 'ko')).toBe(
      `Git staged diff 읽기에 실패했습니다. ${externalDetail}`,
    )
    expect(formatServiceError(error, 'en')).toBe(`Git staged diff read failed. ${externalDetail}`)
  })

  it('keeps legacy constructors compatible without reusing their message for localization', () => {
    const error = new WorkspaceError('PATH_NOT_FOUND', 'legacy app-owned message')
    const skillError = new SkillError('SKILL_NOT_FOUND', 'legacy Skill message')

    expect(error.message).toBe('legacy app-owned message')
    expect(error.code).toBe('PATH_NOT_FOUND')
    expect(formatServiceError(error, 'ko')).toBe('경로를 찾을 수 없습니다.')
    expect(formatServiceError(error, 'en')).toBe('The path could not be found.')
    expect(skillError.message).toBe('legacy Skill message')
    expect(skillError.code).toBe('SKILL_NOT_FOUND')
    expect(formatServiceError(skillError, 'ko')).toBe('요청한 작업 공간 Skill을 찾을 수 없습니다.')
    expect(formatServiceError(skillError, 'en')).toBe(
      'The requested workspace Skill could not be found.',
    )
  })

  it('does not reinterpret external errors as app-owned service messages', () => {
    const external = new Error('provider 자유 형식 오류')

    expect(formatServiceError(external, 'ko')).toBeNull()
    expect(formatServiceError(external, 'en')).toBeNull()
  })

  it('wraps settings read and atomic write failures while preserving their causes', async () => {
    const readRoot = await mkdtemp(join(tmpdir(), 'service-error-read-'))
    const writeRoot = await mkdtemp(join(tmpdir(), 'service-error-write-'))
    try {
      await mkdir(join(readRoot, 'settings.json'))
      const encryption = {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString('utf8'),
      }
      const readStore = new SettingsStore({ userDataPath: readRoot, encryption })
      const readError = await readStore.getSettings().catch((error: unknown) => error)
      expect(readError).toBeInstanceOf(SettingsStoreError)
      expect(readError).toMatchObject({ code: 'SETTINGS_READ_FAILED' })
      expect((readError as SettingsStoreError).cause).toBeInstanceOf(Error)

      const writeStore = new SettingsStore({ userDataPath: writeRoot, encryption })
      await writeStore.getSettings()
      await rm(writeRoot, { recursive: true })
      await writeFile(writeRoot, 'blocks directory recreation')
      const writeError = await writeStore.setLastWorkspace(null).catch((error: unknown) => error)
      expect(writeError).toBeInstanceOf(SettingsStoreError)
      expect(writeError).toMatchObject({ code: 'SETTINGS_WRITE_FAILED' })
      expect((writeError as SettingsStoreError).cause).toBeInstanceOf(Error)
    } finally {
      await Promise.all([
        rm(readRoot, { recursive: true, force: true }),
        rm(writeRoot, { recursive: true, force: true }),
      ])
    }
  })

  it('preserves mutation paths and hashes while keeping the legacy details contract narrow', () => {
    const currentSha256 = 'a'.repeat(64)
    const expectedSha256 = 'b'.repeat(64)
    const error = new MutationError({
      code: 'HASH_CONFLICT',
      identifier: 'file-changed',
      path: 'src/원문.ts',
      currentSha256,
      expectedSha256,
      maximumBytes: 123,
      index: 7,
    })

    expect(error.details).toEqual({ path: 'src/원문.ts', currentSha256, expectedSha256 })
    expect(error.details).not.toHaveProperty('code')
    expect(error.details).not.toHaveProperty('identifier')
    expect(formatServiceError(error, 'ko')).toBe(
      `파일을 읽은 뒤 내용이 변경되었습니다. 최신 파일을 다시 읽고 변경을 다시 준비해 주세요. 경로: src/원문.ts / 현재 SHA-256: ${currentSha256} / 예상 SHA-256: ${expectedSha256}`,
    )
    expect(formatServiceError(error, 'en')).toBe(
      `The file changed after it was read. Read the latest file and prepare the mutation again. Path: src/원문.ts / Current SHA-256: ${currentSha256} / Expected SHA-256: ${expectedSha256}`,
    )
  })

  it('provides localized generic fallbacks for every mutation error code', () => {
    const codes = [
      'NO_WORKSPACE',
      'INVALID_PROPOSAL',
      'INVALID_PATH',
      'DUPLICATE_PATH',
      'HASH_CONFLICT',
      'PATCH_CONFLICT',
      'SYMLINK_REJECTED',
      'NOT_REGULAR_FILE',
      'FILE_TOO_LARGE',
      'BINARY_FILE',
      'ACTION_NOT_FOUND',
      'ACTION_TAMPERED',
      'APPLY_FAILED',
      'RECOVERY_REQUIRED',
      'NO_UNDO',
      'JOURNAL_INVALID',
      'UNDO_CONFLICT',
      'CANCELLED',
    ] as const satisfies readonly MutationErrorCode[]

    for (const code of codes) {
      const error = new MutationError(code, `unlocalized-${code}`)
      const korean = formatServiceError(error, 'ko')
      const english = formatServiceError(error, 'en')
      expect(korean).toBeTruthy()
      expect(english).toBeTruthy()
      expect(korean).not.toContain('unlocalized-')
      expect(english).not.toContain('unlocalized-')
    }
  })

  it('formats trust errors from structured paths without translating the path', () => {
    const error = new TrustStoreError({
      code: 'INVALID_WORKSPACE',
      identifier: 'canonicalize',
      path: '/원문/workspace path',
    })

    expect(formatServiceError(error, 'ko')).toBe(
      '작업 공간 경로를 확인할 수 없습니다: /원문/workspace path',
    )
    expect(formatServiceError(error, 'en')).toBe(
      'The workspace path cannot be canonicalized: /원문/workspace path',
    )
  })
})
