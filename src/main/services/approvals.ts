import type { ApprovalRequest } from '../../shared/contracts'
import { HostError } from './host-errors'

export type ApprovalDecision = 'approved' | 'denied' | 'expired' | 'cancelled'

interface PendingApproval {
  runId: string
  request: ApprovalRequest
  settle: (decision: ApprovalDecision) => void
  timeout: NodeJS.Timeout
  abortSignal?: AbortSignal
  abortHandler?: () => void
}

export interface ApprovalBrokerOptions {
  now?: () => number
  maximumPending?: number
}

/**
 * Keeps model-proposed actions inert until the renderer that owns the run resolves the exact,
 * opaque approval ticket. Ownership is checked by IPC before resolve() reaches this broker.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly now: () => number
  private readonly maximumPending: number

  constructor(options: ApprovalBrokerOptions = {}) {
    this.now = options.now ?? Date.now
    this.maximumPending = options.maximumPending ?? 20
  }

  request(
    runId: string,
    request: ApprovalRequest,
    onRequested: (request: ApprovalRequest) => void,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (!runId || this.pending.has(request.approvalId)) {
      throw new HostError({ code: 'approval.identifier_invalid' })
    }
    if (this.pending.size >= this.maximumPending) {
      throw new HostError({ code: 'approval.pending_limit' })
    }
    if (request.expiresAt <= this.now()) return Promise.resolve('expired')
    if (signal?.aborted) return Promise.resolve('cancelled')

    return new Promise<ApprovalDecision>((resolve) => {
      let settled = false
      const settle = (decision: ApprovalDecision) => {
        if (settled) return
        settled = true
        const active = this.pending.get(request.approvalId)
        if (active) {
          clearTimeout(active.timeout)
          if (active.abortSignal && active.abortHandler) {
            active.abortSignal.removeEventListener('abort', active.abortHandler)
          }
          this.pending.delete(request.approvalId)
        }
        resolve(decision)
      }
      const timeout = setTimeout(
        () => settle('expired'),
        Math.max(1, request.expiresAt - this.now()),
      )
      timeout.unref?.()
      const abortHandler = signal ? () => settle('cancelled') : undefined
      const pending: PendingApproval = {
        runId,
        request,
        settle,
        timeout,
        ...(signal && abortHandler ? { abortSignal: signal, abortHandler } : {}),
      }
      this.pending.set(request.approvalId, pending)
      if (signal && abortHandler) signal.addEventListener('abort', abortHandler, { once: true })

      try {
        onRequested(request)
      } catch (cause) {
        settle('cancelled')
        throw cause
      }
    })
  }

  resolve(runId: string, approvalId: string, decision: 'approved' | 'denied'): void {
    const approval = this.pending.get(approvalId)
    if (!approval || approval.runId !== runId) {
      throw new HostError({ code: 'approval.not_found' })
    }
    if (approval.request.expiresAt <= this.now()) {
      approval.settle('expired')
      throw new HostError({ code: 'approval.expired' })
    }
    approval.settle(decision)
  }

  cancelRun(runId: string): void {
    for (const approval of this.pending.values()) {
      if (approval.runId === runId) approval.settle('cancelled')
    }
  }

  cancelAll(): void {
    for (const approval of [...this.pending.values()]) approval.settle('cancelled')
  }

  getPending(runId?: string): ApprovalRequest[] {
    return [...this.pending.values()]
      .filter((approval) => !runId || approval.runId === runId)
      .map((approval) => approval.request)
  }
}
