import { describe, expect, it, vi } from 'vitest'
import { ApprovalBroker } from '../src/main/services/approvals'
import { formatHostError } from '../src/main/services/host-errors'
import type { ApprovalRequest } from '../src/shared/contracts'

const request = (id: string, expiresAt = Date.now() + 60_000): ApprovalRequest => ({
  kind: 'command',
  approvalId: id,
  actionHash: 'a'.repeat(64),
  summary: 'Run tests',
  argv: ['pnpm', 'test'],
  cwd: '.',
  timeoutMs: 60_000,
  isolation: 'structured-process',
  network: 'host',
  expiresAt,
})

describe('ApprovalBroker', () => {
  it('formats all broker guards in English through their stable host descriptors', async () => {
    const capture = (operation: () => unknown): unknown => {
      try {
        operation()
        return null
      } catch (error) {
        return error
      }
    }

    const invalidBroker = new ApprovalBroker()
    expect(
      formatHostError(
        capture(() => invalidBroker.request('', request('approval-invalid'), () => undefined)),
        'en',
      ),
    ).toBe('The approval request identifier is invalid or already in use.')

    const limitedBroker = new ApprovalBroker({ maximumPending: 1 })
    const pending = limitedBroker.request('run-a', request('approval-a'), () => undefined)
    expect(
      formatHostError(
        capture(() => limitedBroker.request('run-b', request('approval-b'), () => undefined)),
        'en',
      ),
    ).toBe('The number of pending approval requests exceeded the safe limit.')
    limitedBroker.cancelAll()
    await expect(pending).resolves.toBe('cancelled')

    const missingBroker = new ApprovalBroker()
    expect(
      formatHostError(
        capture(() => missingBroker.resolve('run-a', 'approval-missing', 'approved')),
        'en',
      ),
    ).toBe('The approval request for this task could not be found.')

    let now = 1_000
    const expiredBroker = new ApprovalBroker({ now: () => now })
    const expiring = expiredBroker.request(
      'run-a',
      request('approval-expired', 2_000),
      () => undefined,
    )
    now = 2_000
    expect(
      formatHostError(
        capture(() => expiredBroker.resolve('run-a', 'approval-expired', 'approved')),
        'en',
      ),
    ).toBe('The approval request has expired.')
    await expect(expiring).resolves.toBe('expired')
  })

  it('binds a one-time decision to the owning run', async () => {
    const broker = new ApprovalBroker()
    const pending = broker.request('run-a', request('approval-a'), () => undefined)

    expect(() => broker.resolve('run-b', 'approval-a', 'approved')).toThrow()
    broker.resolve('run-a', 'approval-a', 'approved')
    await expect(pending).resolves.toBe('approved')
    expect(() => broker.resolve('run-a', 'approval-a', 'approved')).toThrow()
  })

  it('cancels approvals with the run abort signal', async () => {
    const broker = new ApprovalBroker()
    const controller = new AbortController()
    const pending = broker.request(
      'run-a',
      request('approval-a'),
      () => undefined,
      controller.signal,
    )
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(broker.getPending()).toEqual([])
  })

  it('expires tickets and enforces the pending limit', async () => {
    vi.useFakeTimers()
    try {
      let now = 1_000
      const broker = new ApprovalBroker({ now: () => now, maximumPending: 1 })
      const pending = broker.request('run-a', request('approval-a', 1_010), () => undefined)
      expect(() => broker.request('run-b', request('approval-b', 2_000), () => undefined)).toThrow(
        '안전 한도',
      )
      now = 1_010
      await vi.advanceTimersByTimeAsync(10)
      await expect(pending).resolves.toBe('expired')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a late approval even before the timeout callback gets a turn', async () => {
    let now = 1_000
    const broker = new ApprovalBroker({ now: () => now })
    const pending = broker.request('run-a', request('approval-a', 1_010), () => undefined)

    now = 1_010
    expect(() => broker.resolve('run-a', 'approval-a', 'approved')).toThrow('만료')
    await expect(pending).resolves.toBe('expired')
  })
})
