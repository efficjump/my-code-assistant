import { describe, expect, it } from 'vitest'
import { CommandError } from '../src/main/services/commands'
import {
  formatHostError,
  formatHostErrorDescriptor,
  HostError,
} from '../src/main/services/host-errors'

describe('HostError', () => {
  it('keeps a stable code while formatting the same guard for Korean and English', () => {
    const error = new HostError({ code: 'agent.concurrent_limit', limit: 4 })

    expect(error.code).toBe('agent.concurrent_limit')
    expect(error.message).toBe('동시에 실행할 수 있는 작업은 최대 4개입니다.')
    expect(formatHostError(error, 'en')).toBe('At most 4 tasks can run concurrently.')
    expect(formatHostErrorDescriptor('en', error.descriptor)).toBe(
      'At most 4 tasks can run concurrently.',
    )
  })

  it('does not reinterpret external errors as host-owned messages', () => {
    const external = new Error('Provider 자유-form error')
    expect(formatHostError(external, 'ko')).toBeNull()
    expect(formatHostError(external, 'en')).toBeNull()
  })

  it('formats typed service errors through the shared host boundary', () => {
    const error = new CommandError({
      code: 'INVALID_ARGUMENTS',
      identifier: 'unclosed-quote',
    })

    expect(formatHostError(error, 'ko')).toBe('슬래시 명령 인수의 따옴표가 닫히지 않았습니다.')
    expect(formatHostError(error, 'en')).toBe(
      'A quote in the slash-command arguments is not closed.',
    )
  })

  it('localizes run budget and context descriptors while preserving dynamic identifiers', () => {
    expect(
      formatHostErrorDescriptor('en', {
        code: 'agent.tool_call_budget_exceeded',
        requested: 5,
        remaining: 4,
      }),
    ).toBe(
      'The provider requested 5 tool calls, exceeding the 4 calls remaining in this run. No calls were executed.',
    )

    const path = 'src/화면/Chat.tsx'
    const reason = 'Provider 원문 failure'
    expect(
      formatHostErrorDescriptor('en', {
        code: 'agent.context_file_read_failed',
        path,
        reason,
      }),
    ).toBe(`Could not read the selected context file (${path}): ${reason}`)
  })
})
