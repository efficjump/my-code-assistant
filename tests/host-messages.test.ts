import { describe, expect, it } from 'vitest'
import {
  formatRecoveryNotice,
  hostMessages,
  MAX_RECOVERY_NOTICE_CHARACTERS,
  postEffectInterruptionSummary,
  RecoveryNoticeQueue,
  validateRecoveryNotice,
} from '../src/main/services/host-messages'

describe('host messages', () => {
  it('localizes host-owned tool wrappers in Korean and English without changing payload text', () => {
    const path = 'src/화면/Chat.tsx'
    const modelSummary = 'Keep This USER Summary 그대로'
    const providerFailure = 'Provider 자유 text 오류'

    expect(hostMessages('ko').tool.readFile(path)).toBe(`파일 읽기: ${path}`)
    expect(hostMessages('en').tool.readFile(path)).toBe(`Read file: ${path}`)
    expect(hostMessages('ko').tool.proposeChanges(modelSummary)).toBe(
      `파일 변경 제안: ${modelSummary}`,
    )
    expect(hostMessages('en').tool.proposeChanges(modelSummary)).toBe(
      `Propose file changes: ${modelSummary}`,
    )
    expect(hostMessages('ko').tool.failed('파일 읽기', providerFailure)).toContain(providerFailure)
    expect(hostMessages('en').tool.failed('Read file', providerFailure)).toBe(
      `Read file failed: ${providerFailure}`,
    )
  })

  it('formats structured validation issues without depending on Zod prose', () => {
    expect(
      hostMessages('ko').tool.validationIssue({ kind: 'invalid-type', expected: 'array' }),
    ).toBe('배열 형식이어야 합니다.')
    expect(
      hostMessages('en').tool.validationIssue({ kind: 'invalid-type', expected: 'array' }),
    ).toBe('Expected array.')
    expect(
      hostMessages('ko').tool.validationIssue({
        kind: 'too-big',
        origin: 'string',
        bound: '50',
        inclusive: true,
        exact: false,
      }),
    ).toBe('문자열 크기는 50 이하여야 합니다.')
    expect(
      hostMessages('en').tool.validationIssue({
        kind: 'unrecognized-keys',
        keys: ['unexpected'],
      }),
    ).toBe('Unrecognized field: unexpected')
  })

  it('localizes lifecycle and applied-effect summaries while preserving observed paths', () => {
    const paths = new Set(['src/한글.ts', 'README.md'])
    const effects = new Set(['workspace-change', 'process'] as const)

    expect(hostMessages('ko').lifecycle.timeout(15)).toBe('응답 생성 시간이 15분을 초과했습니다.')
    expect(hostMessages('en').lifecycle.timeout(15)).toBe(
      'Response generation exceeded the 15-minute limit.',
    )
    expect(hostMessages('ko').lifecycle.cancelled).toBe('작업이 취소되었습니다.')
    expect(hostMessages('en').lifecycle.cancelled).toBe('The task was cancelled.')
    expect(hostMessages('ko').lifecycle.newConversationTitle).toBe('새 대화')
    expect(hostMessages('en').lifecycle.newConversationTitle).toBe('New conversation')
    expect(hostMessages('en').lifecycle.interruptedAfterEffect).toBe(
      'Some work was applied, but the final response could not be completed.',
    )

    const korean = postEffectInterruptionSummary('ko', effects, paths, 'run-interruption')
    const english = postEffectInterruptionSummary('en', effects, paths, 'provider-transport')
    expect(korean).toContain('확인된 작업 결과:')
    expect(korean).toContain('src/한글.ts, README.md')
    expect(english).toContain('Confirmed results:')
    expect(english).toContain('src/한글.ts, README.md')
    expect(english).toContain('provider connection closed')
  })

  it('formats structured startup recovery notices in the selected locale', () => {
    const backupPath = '/tmp/대화/history.sqlite3.corrupt-123'
    expect(
      formatRecoveryNotice('ko', {
        type: 'conversation-database-quarantined',
        backupPath,
      }),
    ).toBe(`손상된 대화 데이터베이스를 격리하고 새 저장소를 만들었습니다. 원본 백업: ${backupPath}`)
    expect(
      formatRecoveryNotice('en', {
        type: 'conversation-database-quarantined',
        backupPath,
      }),
    ).toBe(
      `The damaged conversation database was quarantined and a new store was created. Original backup: ${backupPath}`,
    )
  })

  it('validates, redacts, bounds, and consumes recovery notices exactly once', () => {
    const queue = new RecoveryNoticeQueue()
    const secret = ['sk', 'super-secret-recovery-token'].join('-')
    queue.add({
      type: 'file-mutation-recovery-failed',
      reason: `Provider reason ${secret} Bearer another-secret`,
    })
    for (let index = 0; index < 40; index += 1) {
      queue.add({
        type: 'file-mutations-recovered',
        actionCount: 1,
        paths: [`src/${index.toString()}-${'x'.repeat(1_000)}-${secret}.ts`],
      })
    }

    const notice = queue.take('en')
    expect(notice).not.toBeNull()
    expect(notice?.length).toBeLessThanOrEqual(MAX_RECOVERY_NOTICE_CHARACTERS)
    expect(notice).not.toContain(secret)
    expect(notice).not.toContain('another-secret')
    expect(notice).toContain('[REDACTED]')
    expect(queue.take('ko')).toBeNull()
  })

  it('fails closed for malformed or oversized recovery data', () => {
    expect(
      validateRecoveryNotice({
        type: 'file-mutations-recovered',
        actionCount: 100_000,
        paths: ['README.md'],
      }),
    ).toEqual({ type: 'invalid-recovery-notice' })
    expect(
      formatRecoveryNotice('en', {
        type: 'file-mutation-recovery-failed',
        reason: 'x'.repeat(4_001),
      }),
    ).toBe('A recovery notice could not be displayed safely because it was invalid.')
  })

  it('provides locale-specific startup interruption reasons', () => {
    expect(hostMessages('ko').recovery.interruptedRunReason).toContain('작업이 중단')
    expect(hostMessages('en').recovery.interruptedRunReason).toBe(
      'The application exited before the task completed.',
    )
    expect(hostMessages('en').recovery.interruptedSubagentReason).toBe(
      'The application exited before the subtask completed.',
    )
  })
})
