/**
 * Provider-neutral contracts for one assistant inference step.
 *
 * A coordinator owns the tool loop. Drivers only translate canonical input to a provider,
 * stream canonical events back, and retain provider-specific replay state behind an opaque
 * session handle.
 */

const assistantDriverSessionBrand = Symbol('AssistantDriverSession')

/** Well-known feature IDs. Drivers may advertise additional namespaced string IDs. */
export const ASSISTANT_DRIVER_FEATURE = Object.freeze({
  streaming: 'streaming',
  toolCalling: 'tool-calling',
  reasoning: 'reasoning',
  opaqueSession: 'opaque-session',
  persistentResume: 'persistent-resume',
})

export type AssistantDriverFeature = string

export interface DriverCapabilities {
  features: readonly AssistantDriverFeature[]
  limits: Readonly<Record<string, number>>
}

export interface ModelDescriptor {
  id: string
  createdAt?: number
  displayName?: string
  contextWindowTokens?: number
}

/** A JSON Schema object. Runtime validation remains the ToolCatalog's responsibility. */
export type CanonicalJsonSchema = Readonly<Record<string, unknown>>

export interface CanonicalToolDefinition {
  name: string
  description: string
  inputSchema: CanonicalJsonSchema
  strict?: boolean
}

export interface CanonicalToolCall {
  callId: string
  name: string
  argumentsJson: string
}

export interface CanonicalToolResult {
  callId: string
  output: string
  isError?: boolean
}

/** Provider-neutral control over whether, or which, registered tool the model must call. */
export type CanonicalToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | Readonly<{ type: 'function'; name: string }>

export interface CanonicalMessageInput {
  type: 'message'
  role: 'user' | 'assistant'
  content: string
}

export interface CanonicalToolResultInput {
  type: 'tool-result'
  result: CanonicalToolResult
}

export type CanonicalTurnInput = CanonicalMessageInput | CanonicalToolResultInput

export type CanonicalSessionHistory = readonly CanonicalMessageInput[]

export interface CanonicalUsage {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
}

/**
 * A capability token. Provider state is deliberately not serializable or observable by the
 * coordinator. A driver must reject a handle that it did not issue.
 */
export interface AssistantDriverSession {
  readonly driverId: string
  readonly sessionId: string
  readonly [assistantDriverSessionBrand]: true
}

export interface CanonicalRunTurnRequest {
  runId: string
  profile: unknown
  model: string
  instructions: string
  tools: readonly CanonicalToolDefinition[]
  /**
   * Registered tools used only to recognize leaked textual tool protocol. These definitions are
   * never advertised to the provider and cannot produce executable structured calls.
   */
  protocolGuardTools?: readonly CanonicalToolDefinition[]
  toolChoice?: CanonicalToolChoice
  session: AssistantDriverSession
  signal?: AbortSignal
  maxOutputTokens?: number
}

export type DriverFailureCode =
  | 'cancelled'
  | 'invalid-profile'
  | 'invalid-request'
  | 'provider-error'
  | 'response-limit'
  | 'stream-incomplete'
  | 'tool-protocol-invalid'

export interface DriverFailure {
  code: DriverFailureCode
  message: string
  retryable: boolean
}

export class AssistantDriverError extends Error {
  readonly failure: DriverFailure

  constructor(failure: DriverFailure, options?: ErrorOptions) {
    super(failure.message, options)
    this.name = 'AssistantDriverError'
    this.failure = failure
  }
}

export type CanonicalDriverEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; call: CanonicalToolCall }
  | { type: 'usage'; usage: CanonicalUsage }
  | { type: 'checkpoint'; session: AssistantDriverSession }
  | {
      type: 'completed'
      responseId: string
      finishReason: 'stop' | 'tool-calls'
    }
  | { type: 'failed'; failure: DriverFailure }

export interface CanonicalTurnResult {
  session: AssistantDriverSession
  toolCalls: readonly CanonicalToolCall[]
  usage: CanonicalUsage | null
  responseId: string
  finalText: string
  finishReason: 'stop' | 'tool-calls'
}

export type CanonicalDriverEventListener = (event: CanonicalDriverEvent) => void

export interface DriverOperationOptions {
  signal?: AbortSignal
}

export interface AssistantDriver {
  readonly id: string
  inspect(profile: unknown, options?: DriverOperationOptions): Promise<DriverCapabilities>
  listModels(profile: unknown, options?: DriverOperationOptions): Promise<ModelDescriptor[]>
  createSession(history?: CanonicalSessionHistory): AssistantDriverSession
  appendUserMessage(session: AssistantDriverSession, content: string): AssistantDriverSession
  appendToolResults(
    session: AssistantDriverSession,
    results: readonly CanonicalToolResult[],
  ): AssistantDriverSession
  compactSession(session: AssistantDriverSession, maxCharacters?: number): AssistantDriverSession
  runTurn(
    request: CanonicalRunTurnRequest,
    listener?: CanonicalDriverEventListener,
  ): Promise<CanonicalTurnResult>
  cancel?(runId: string): Promise<void>
}

/** Intended for driver implementations; the token contains no provider state. */
export function createAssistantDriverSession(
  driverId: string,
  sessionId: string,
): AssistantDriverSession {
  if (!driverId.trim()) throw new TypeError('driverId must not be empty.')
  if (!sessionId.trim()) throw new TypeError('sessionId must not be empty.')
  return Object.freeze({
    driverId,
    sessionId,
    [assistantDriverSessionBrand]: true as const,
  })
}

export function isAssistantDriverSession(
  value: unknown,
  driverId?: string,
): value is AssistantDriverSession {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AssistantDriverSession>
  return (
    candidate[assistantDriverSessionBrand] === true &&
    typeof candidate.driverId === 'string' &&
    typeof candidate.sessionId === 'string' &&
    (driverId === undefined || candidate.driverId === driverId)
  )
}
