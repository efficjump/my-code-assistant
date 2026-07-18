import { randomUUID } from 'node:crypto'
import ProtocolClient from 'openai'
import type {
  FunctionTool,
  Response,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputItem,
  ResponseOutputItem,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from 'openai/resources/responses/responses'
import {
  type AssistantDriver,
  AssistantDriverError,
  type AssistantDriverSession,
  type CanonicalDriverEvent,
  type CanonicalDriverEventListener,
  type CanonicalRunTurnRequest,
  type CanonicalSessionHistory,
  type CanonicalToolChoice,
  type CanonicalToolDefinition,
  type CanonicalToolResult,
  type CanonicalTurnResult,
  type CanonicalUsage,
  createAssistantDriverSession,
  type DriverCapabilities,
  type DriverFailure,
  type DriverOperationOptions,
  isAssistantDriverSession,
  type ModelDescriptor,
} from '../runtime/assistant-driver'
import { normalizeJsonSchemaArguments } from '../runtime/json-schema-normalizer'

export interface ResponsesApiProfile {
  id: string
  name: string
  baseUrl: string
  apiKey: string | null
  generation: number
}

export interface ResponsesApiDriverOptions {
  modelListTimeoutMs?: number
  requestTimeoutMs?: number
  maxModelOptions?: number
  maxOutputTokens?: number
  maxStreamEvents?: number
  maxStreamTextCharacters?: number
  maxSessionCharacters?: number
}

interface ResolvedOptions {
  modelListTimeoutMs: number
  requestTimeoutMs: number
  maxModelOptions: number
  maxOutputTokens: number
  maxStreamEvents: number
  maxStreamTextCharacters: number
  maxSessionCharacters: number
}

interface ResponsesApiSessionState {
  identity: string | null
  input: ResponseInput
  successfulToolCallIds: ReadonlySet<string>
}

type ReplayableOutputItem = Extract<
  ResponseOutputItem,
  { type: 'message' | 'reasoning' | 'function_call' }
>

const DEFAULT_OPTIONS: ResolvedOptions = {
  modelListTimeoutMs: 30_000,
  requestTimeoutMs: 120_000,
  maxModelOptions: 2_000,
  maxOutputTokens: 16_000,
  maxStreamEvents: 50_000,
  maxStreamTextCharacters: 2_000_000,
  maxSessionCharacters: 1_500_000,
}

const CAPABILITIES: DriverCapabilities = Object.freeze({
  features: Object.freeze(['streaming', 'tool-calling', 'reasoning', 'opaque-session'] as const),
  limits: Object.freeze({
    maxOutputTokens: DEFAULT_OPTIONS.maxOutputTokens,
    maxStreamEvents: DEFAULT_OPTIONS.maxStreamEvents,
    maxStreamTextCharacters: DEFAULT_OPTIONS.maxStreamTextCharacters,
    maxSessionCharacters: DEFAULT_OPTIONS.maxSessionCharacters,
  }),
})

class DriverError extends AssistantDriverError {
  constructor(
    code: DriverFailure['code'],
    message: string,
    retryable = false,
    options?: ErrorOptions,
  ) {
    super({ code, message, retryable }, options)
    this.name = 'DriverError'
  }
}

class ProviderStreamEventError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderStreamEventError'
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive integer.`)
  }
  return resolved
}

function resolveOptions(options: ResponsesApiDriverOptions): ResolvedOptions {
  return {
    modelListTimeoutMs: positiveInteger(
      options.modelListTimeoutMs,
      DEFAULT_OPTIONS.modelListTimeoutMs,
      'modelListTimeoutMs',
    ),
    requestTimeoutMs: positiveInteger(
      options.requestTimeoutMs,
      DEFAULT_OPTIONS.requestTimeoutMs,
      'requestTimeoutMs',
    ),
    maxModelOptions: positiveInteger(
      options.maxModelOptions,
      DEFAULT_OPTIONS.maxModelOptions,
      'maxModelOptions',
    ),
    maxOutputTokens: positiveInteger(
      options.maxOutputTokens,
      DEFAULT_OPTIONS.maxOutputTokens,
      'maxOutputTokens',
    ),
    maxStreamEvents: positiveInteger(
      options.maxStreamEvents,
      DEFAULT_OPTIONS.maxStreamEvents,
      'maxStreamEvents',
    ),
    maxStreamTextCharacters: positiveInteger(
      options.maxStreamTextCharacters,
      DEFAULT_OPTIONS.maxStreamTextCharacters,
      'maxStreamTextCharacters',
    ),
    maxSessionCharacters: positiveInteger(
      options.maxSessionCharacters,
      DEFAULT_OPTIONS.maxSessionCharacters,
      'maxSessionCharacters',
    ),
  }
}

function parseProfile(profile: unknown): ResponsesApiProfile {
  if (!profile || typeof profile !== 'object') {
    throw new DriverError('invalid-profile', 'Responses API profile must be an object.')
  }
  const candidate = profile as Partial<ResponsesApiProfile>
  if (typeof candidate.id !== 'string' || !candidate.id.trim() || candidate.id.length > 120) {
    throw new DriverError('invalid-profile', 'Responses API profile id is invalid.')
  }
  if (typeof candidate.name !== 'string' || !candidate.name.trim() || candidate.name.length > 80) {
    throw new DriverError('invalid-profile', 'Responses API profile name is invalid.')
  }
  if (
    typeof candidate.baseUrl !== 'string' ||
    !candidate.baseUrl.trim() ||
    candidate.baseUrl.length > 2_048
  ) {
    throw new DriverError('invalid-profile', 'Responses API profile baseUrl is invalid.')
  }
  try {
    const url = new URL(candidate.baseUrl)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    const secureTransport = url.protocol === 'https:' || (url.protocol === 'http:' && loopback)
    if (!secureTransport || url.username || url.password || url.search || url.hash) {
      throw new Error('unsafe provider URL')
    }
  } catch {
    throw new DriverError('invalid-profile', 'Responses API profile baseUrl is invalid.')
  }
  if (
    candidate.apiKey !== null &&
    (typeof candidate.apiKey !== 'string' || candidate.apiKey.length > 16_384)
  ) {
    throw new DriverError('invalid-profile', 'Responses API profile apiKey is invalid.')
  }
  if (!Number.isSafeInteger(candidate.generation) || (candidate.generation as number) < 1) {
    throw new DriverError('invalid-profile', 'Responses API profile generation is invalid.')
  }
  return candidate as ResponsesApiProfile
}

function createClient(profile: ResponsesApiProfile, timeout: number): ProtocolClient {
  const hasApiKey = typeof profile.apiKey === 'string' && profile.apiKey.length > 0
  return new ProtocolClient({
    baseURL: profile.baseUrl,
    timeout,
    maxRetries: 0,
    apiKey: hasApiKey ? profile.apiKey : randomUUID(),
    ...(hasApiKey ? {} : { defaultHeaders: { Authorization: null } }),
  })
}

function profileIdentity(profile: ResponsesApiProfile, model: string): string {
  return JSON.stringify([profile.id, profile.baseUrl, profile.generation, model])
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw new DriverError(
    'cancelled',
    signal.reason instanceof Error ? signal.reason.message : 'The assistant run was cancelled.',
  )
}

function sanitizeMessage(error: unknown, profile?: ResponsesApiProfile): string {
  let message =
    error instanceof Error && error.message.trim()
      ? error.message
      : typeof error === 'string' && error.trim()
        ? error
        : 'Unknown provider error.'
  if (profile?.apiKey) message = message.split(profile.apiKey).join('[REDACTED]')
  return message
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .slice(0, 8_000)
}

function toFailure(error: unknown, profile?: ResponsesApiProfile): DriverFailure {
  if (error instanceof AssistantDriverError) {
    return {
      ...error.failure,
      message: sanitizeMessage(error.failure.message, profile),
    }
  }
  if (error instanceof ProtocolClient.APIError) {
    return {
      code: 'provider-error',
      message: sanitizeMessage(error, profile),
      retryable:
        error.status === undefined ||
        error.status === 408 ||
        error.status === 409 ||
        error.status === 429 ||
        error.status >= 500,
    }
  }
  return { code: 'provider-error', message: sanitizeMessage(error, profile), retryable: false }
}

function historyToProviderInput(history: CanonicalSessionHistory): ResponseInput {
  return history.map((message) => ({ role: message.role, content: message.content }))
}

function toolResultToProviderInput(result: CanonicalToolResult): ResponseInputItem {
  return { type: 'function_call_output', call_id: result.callId, output: result.output }
}

function toProviderTool(tool: CanonicalToolDefinition): FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    strict: tool.strict ?? true,
    parameters: { ...tool.inputSchema },
  }
}

function toProviderToolChoice(
  choice: CanonicalToolChoice | undefined,
  tools: readonly CanonicalToolDefinition[],
): ToolChoiceOptions | ToolChoiceFunction | undefined {
  if (choice === undefined || choice === 'auto' || choice === 'none') return choice
  if (choice === 'required') {
    if (tools.length === 0) {
      throw new DriverError('invalid-request', 'toolChoice "required" needs at least one tool.')
    }
    return choice
  }
  if (
    !choice ||
    typeof choice !== 'object' ||
    choice.type !== 'function' ||
    typeof choice.name !== 'string' ||
    !choice.name.trim()
  ) {
    throw new DriverError('invalid-request', 'toolChoice is invalid.')
  }
  if (!tools.some((tool) => tool.name === choice.name)) {
    throw new DriverError(
      'invalid-request',
      `toolChoice references an unavailable function: ${choice.name}`,
    )
  }
  return { type: 'function', name: choice.name }
}

function assertToolChoiceSatisfied(
  choice: CanonicalToolChoice | undefined,
  calls: readonly { name: string }[],
): void {
  if (choice === 'required' && calls.length === 0) {
    throw new DriverError(
      'stream-incomplete',
      'Provider completed the response without the required tool call.',
      true,
    )
  }
  if (choice === 'none' && calls.length > 0) {
    throw new DriverError(
      'stream-incomplete',
      'Provider returned a tool call even though toolChoice was "none".',
      true,
    )
  }
  if (choice && typeof choice === 'object') {
    if (calls.length === 0) {
      throw new DriverError(
        'stream-incomplete',
        `Provider completed the response without the required ${choice.name} function call.`,
        true,
      )
    }
    const unexpectedCall = calls.find((call) => call.name !== choice.name)
    if (unexpectedCall) {
      throw new DriverError(
        'stream-incomplete',
        `Provider returned ${unexpectedCall.name} instead of the required ${choice.name} function call.`,
        true,
      )
    }
  }
}

function isReplayableOutputItem(item: ResponseOutputItem): item is ReplayableOutputItem {
  return item.type === 'message' || item.type === 'reasoning' || item.type === 'function_call'
}

function assistantTextProjection(response: Response): {
  fullText: string
  detectionCandidates: readonly string[]
} {
  const allParts: string[] = []
  const detectionCandidates = new Set<string>()
  for (const item of response.output) {
    if (item.type !== 'message') continue
    const messageParts: string[] = []
    for (const content of item.content) {
      const part = content.type === 'output_text' ? content.text : content.refusal
      messageParts.push(part)
      allParts.push(part)
      detectionCandidates.add(part)
    }
    detectionCandidates.add(messageParts.join(''))
  }
  return { fullText: allParts.join(''), detectionCandidates: [...detectionCandidates] }
}

function assistantText(response: Response): string {
  return assistantTextProjection(response).fullText
}

function failureMessage(response: Response, fallback: string): string {
  if (response.error?.message) return response.error.message
  return response.incomplete_details?.reason
    ? `${fallback} (${response.incomplete_details.reason})`
    : fallback
}

function retryableResponseFailure(response: Response): boolean {
  const code = response.error?.code as string | undefined
  return (
    code === 'server_error' ||
    code === 'rate_limit_exceeded' ||
    code === 'vector_store_timeout' ||
    code === 'tool_choice_violation'
  )
}

function retryableIncompleteResponse(response: Response): boolean {
  const incompleteReason = (response.incomplete_details as { reason?: unknown } | null)?.reason
  return (
    retryableResponseFailure(response) ||
    incompleteReason === 'provider_transport' ||
    response.status === 'in_progress' ||
    response.status === 'queued'
  )
}

function assertCompletedResponseSnapshot(response: Response): void {
  if (response.status === 'failed') {
    throw new DriverError(
      'provider-error',
      failureMessage(response, 'Model response generation failed.'),
      retryableResponseFailure(response),
    )
  }
  if (response.status !== 'completed') {
    throw new DriverError(
      'stream-incomplete',
      failureMessage(response, 'Model response was incomplete.'),
      retryableIncompleteResponse(response),
    )
  }
}

function toolCalls(response: Response): ResponseFunctionToolCall[] {
  return response.output.filter(
    (item): item is ResponseFunctionToolCall => item.type === 'function_call',
  )
}

function textOutsideMarkdownCode(source: string): string {
  return source
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/(`+)[^\r\n]*?\1/g, '')
    .replace(/^(?: {4}|\t).*?(?:\r?\n|$)/gm, '')
}

function identifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_-]/.test(value)
}

function closingParenthesis(source: string, openingIndex: number): number {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') {
      quoted = true
      continue
    }
    if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth === 0) return index
      if (depth < 0) return -1
    }
  }
  return -1
}

function closingJsonContainer(source: string, openingIndex: number): number {
  const first = source[openingIndex]
  if (first !== '{' && first !== '[') return -1
  const expectedClosers = [first === '{' ? '}' : ']']
  let quoted = false
  let escaped = false
  for (let index = openingIndex + 1; index < source.length; index += 1) {
    const character = source[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') {
      quoted = true
      continue
    }
    if (character === '{') expectedClosers.push('}')
    else if (character === '[') expectedClosers.push(']')
    else if (character === '}' || character === ']') {
      if (expectedClosers.at(-1) !== character) return -1
      expectedClosers.pop()
      if (expectedClosers.length === 0) return index
    }
  }
  return -1
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`
}

function toolCallSignature(name: string, argumentsJson: string): string | null {
  try {
    const argumentsValue = JSON.parse(argumentsJson)
    if (!isJsonRecord(argumentsValue)) return null
    return `${name}\0${canonicalJson(argumentsValue)}`
  } catch {
    return null
  }
}

function completedToolCallSignatures(
  input: ResponseInput,
  tools: readonly CanonicalToolDefinition[],
  eligibleCallIds?: ReadonlySet<string>,
): Set<string> {
  const knownNames = new Set(tools.map((tool) => tool.name))
  let currentTurnStart = 0
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index]
    if (isConversationMessage(item) && item.role === 'user') currentTurnStart = index + 1
  }

  const calls = new Map<string, string>()
  const completedCallIds = new Set<string>()
  for (const item of input.slice(currentTurnStart)) {
    if (!('type' in item)) continue
    if (item.type === 'function_call') {
      const call = item as { call_id?: unknown; name?: unknown; arguments?: unknown }
      if (
        typeof call.call_id === 'string' &&
        typeof call.name === 'string' &&
        knownNames.has(call.name) &&
        typeof call.arguments === 'string'
      ) {
        const signature = toolCallSignature(call.name, call.arguments)
        if (signature) calls.set(call.call_id, signature)
      }
    } else if (item.type === 'function_call_output') {
      const output = item as { call_id?: unknown }
      if (typeof output.call_id === 'string') completedCallIds.add(output.call_id)
    }
  }
  return new Set(
    [...completedCallIds]
      .filter((callId) => eligibleCallIds === undefined || eligibleCallIds.has(callId))
      .map((callId) => calls.get(callId))
      .filter((signature): signature is string => signature !== undefined),
  )
}

interface TextualToolInvocation {
  name: string
  argumentsJson: string
  signature: string
  repeatsCompletedCall: boolean
}

function bracketedToolInvocation(
  source: string,
  tools: readonly CanonicalToolDefinition[],
  recentCompletedCalls: ReadonlySet<string>,
  toolCallRequired: boolean,
): TextualToolInvocation | null {
  for (const tool of tools) {
    let offset = 0
    while (offset < source.length) {
      const nameIndex = source.indexOf(tool.name, offset)
      if (nameIndex < 0) break
      offset = nameIndex + tool.name.length
      if (
        identifierCharacter(source[nameIndex - 1]) ||
        identifierCharacter(source[nameIndex + tool.name.length])
      ) {
        continue
      }
      let openingIndex = nameIndex + tool.name.length
      while (/\s/.test(source[openingIndex] ?? '')) openingIndex += 1
      if (source[openingIndex] !== '(') continue
      const closingIndex = closingParenthesis(source, openingIndex)
      if (closingIndex < 0) continue

      let argumentsStart = openingIndex + 1
      while (/\s/.test(source[argumentsStart] ?? '')) argumentsStart += 1
      const argumentsEnd = closingJsonContainer(source, argumentsStart)
      if (argumentsEnd < 0) continue
      const serializedArguments = source.slice(argumentsStart, argumentsEnd + 1)
      let argumentsValue: unknown
      try {
        argumentsValue = JSON.parse(serializedArguments)
      } catch {
        continue
      }
      if (!/^[\s\])}>.,;:!?]*$/.test(source.slice(argumentsEnd + 1, closingIndex))) continue

      const prefix = source.slice(0, nameIndex).trimEnd()
      const prefixLine = prefix.slice(prefix.lastIndexOf('\n') + 1).trim()
      const bracketStart = prefixLine.lastIndexOf('[')
      const bracketSuffix = bracketStart >= 0 ? prefixLine.slice(bracketStart) : ''
      const openBracketLabel = /^\[[^\]\r\n]{1,256}$/.test(bracketSuffix)
      const closedBracketLabel = /^\[[^\]\r\n]{1,256}\]$/.test(bracketSuffix)
      const bracketedLabel = openBracketLabel || closedBracketLabel
      const plainLabel = bracketStart < 0 && /^[^()[\]{}\r\n]{1,256}:$/.test(prefixLine)
      const suffix = source.slice(closingIndex + 1)
      const onlyEnvelopeClosersRemain = /^[\s\])}>.,;:!?]*$/.test(suffix)
      const closesOpenBracketEnvelope = /^\s*\]/.test(suffix)
      const signature = `${tool.name}\0${canonicalJson(argumentsValue)}`
      const repeatsCompletedCall = recentCompletedCalls.has(signature)
      const invocation = {
        name: tool.name,
        argumentsJson: canonicalJson(argumentsValue),
        signature,
        repeatsCompletedCall,
      }
      if (repeatsCompletedCall && (prefixLine === '' || bracketedLabel || plainLabel)) {
        return invocation
      }
      const standaloneCall = prefixLine === '' && (toolCallRequired || repeatsCompletedCall)
      const bracketEnvelope =
        (openBracketLabel && closesOpenBracketEnvelope) ||
        (closedBracketLabel && (toolCallRequired || repeatsCompletedCall))
      if ((standaloneCall || bracketEnvelope) && onlyEnvelopeClosersRemain) return invocation
    }
  }
  return null
}

function containsIncompleteBracketedToolInvocation(
  source: string,
  knownNames: ReadonlySet<string>,
): boolean {
  for (const name of knownNames) {
    let offset = 0
    while (offset < source.length) {
      const nameIndex = source.indexOf(name, offset)
      if (nameIndex < 0) break
      offset = nameIndex + name.length
      if (
        identifierCharacter(source[nameIndex - 1]) ||
        identifierCharacter(source[nameIndex + name.length])
      ) {
        continue
      }
      const lineStart = source.lastIndexOf('\n', nameIndex) + 1
      const prefixLine = source.slice(lineStart, nameIndex)
      const openingBracket = prefixLine.lastIndexOf('[')
      if (openingBracket < 0 || prefixLine.lastIndexOf(']') > openingBracket) continue
      let argumentsStart = nameIndex + name.length
      while (/\s/.test(source[argumentsStart] ?? '')) argumentsStart += 1
      if (source[argumentsStart] === '(') return true
    }
  }
  return false
}

/**
 * Some Responses-compatible providers return their model-specific tool envelope as assistant text
 * when parsing fails. Only classify a strong protocol signature whose function name exactly
 * matches a tool enabled for this request; ordinary JSON and code examples remain user content.
 */
function containsUnstructuredToolCall(
  source: string,
  tools: readonly CanonicalToolDefinition[],
  recentCompletedCalls: ReadonlySet<string>,
  toolChoice: CanonicalToolChoice | undefined,
): boolean {
  if (!source || tools.length === 0) return false
  const knownNames = new Set(tools.map((tool) => tool.name))
  const visibleText = textOutsideMarkdownCode(source)
  if (
    bracketedToolInvocation(
      visibleText,
      tools,
      recentCompletedCalls,
      toolChoice === 'required' || Boolean(toolChoice && typeof toolChoice === 'object'),
    )
  ) {
    return true
  }
  if (containsIncompleteBracketedToolInvocation(visibleText, knownNames)) return true
  const containers = [...visibleText.matchAll(/<\s*tool_call(?:\s[^>\r\n]*)?>/gi)]
  for (let index = 0; index < containers.length; index += 1) {
    const container = containers[index]
    const start = (container.index ?? 0) + container[0].length
    const end = containers[index + 1]?.index ?? visibleText.length
    const payload = visibleText.slice(start, end)
    const functionTag =
      /<\s*function\s*=\s*(?:"([^"\r\n]{1,512})"|'([^'\r\n]{1,512})'|([^\s>]{1,512}))/i.exec(
        payload,
      )
    const name = functionTag
      ?.slice(1)
      .find((candidate) => candidate !== undefined)
      ?.trim()
    if (name && knownNames.has(name)) return true

    for (const quotedValue of payload.matchAll(/"(?:\\.|[^"\\])*"/g)) {
      try {
        const candidate = JSON.parse(quotedValue[0])
        if (typeof candidate === 'string' && knownNames.has(candidate)) return true
      } catch {
        // Ignore malformed string fragments; this is only a protocol classifier.
      }
    }
  }
  return false
}

function responseBracketedToolInvocation(
  response: Response,
  tools: readonly CanonicalToolDefinition[],
  recentCompletedCalls: ReadonlySet<string>,
  toolChoice: CanonicalToolChoice | undefined,
): TextualToolInvocation | null {
  for (const source of assistantTextProjection(response).detectionCandidates) {
    const invocation = bracketedToolInvocation(
      textOutsideMarkdownCode(source),
      tools,
      recentCompletedCalls,
      toolChoice === 'required' || Boolean(toolChoice && typeof toolChoice === 'object'),
    )
    if (invocation) return invocation
  }
  return null
}

function responseContainsUnstructuredToolCall(
  response: Response,
  tools: readonly CanonicalToolDefinition[],
  recentCompletedCalls: ReadonlySet<string>,
  toolChoice: CanonicalToolChoice | undefined,
): boolean {
  return assistantTextProjection(response).detectionCandidates.some((source) =>
    containsUnstructuredToolCall(source, tools, recentCompletedCalls, toolChoice),
  )
}

function responseUsage(response: Response): CanonicalUsage | null {
  if (!response.usage) return null
  return {
    inputTokens: Math.max(0, response.usage.input_tokens ?? 0),
    outputTokens: Math.max(0, response.usage.output_tokens ?? 0),
    reasoningTokens: Math.max(0, response.usage.output_tokens_details?.reasoning_tokens ?? 0),
    totalTokens: Math.max(0, response.usage.total_tokens ?? 0),
  }
}

function sumUsage(
  left: CanonicalUsage | null,
  right: CanonicalUsage | null,
): CanonicalUsage | null {
  if (!left) return right
  if (!right) return left
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  }
}

function isConversationMessage(
  item: ResponseInputItem,
): item is ResponseInputItem & { role: 'user' | 'assistant' } {
  return 'role' in item && (item.role === 'user' || item.role === 'assistant')
}

function compactInput(input: ResponseInput, maxCharacters: number): ResponseInput {
  const turns: ResponseInput[] = []
  for (const item of input) {
    if (!isConversationMessage(item)) continue
    if ('role' in item && item.role === 'user') turns.push([item])
    else if (turns.length > 0) turns.at(-1)?.push(item)
  }

  const retained: ResponseInput[] = []
  let characters = 0
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    const turnCharacters = JSON.stringify(turn).length
    if (retained.length > 0 && characters + turnCharacters > maxCharacters) break
    retained.unshift(turn)
    characters += turnCharacters
  }
  return retained.flat()
}

function emit(
  listener: CanonicalDriverEventListener | undefined,
  event: CanonicalDriverEvent,
): void {
  try {
    listener?.(event)
  } catch {
    // A renderer or coordinator listener must not break provider stream cleanup.
  }
}

/** Responses API implementation of the canonical assistant contract. */
export class ResponsesApiDriver implements AssistantDriver {
  readonly id = 'responses-api'
  private readonly options: ResolvedOptions
  private readonly reasoningIncludeSupport = new Map<string, boolean>()
  private readonly sessions = new WeakMap<AssistantDriverSession, ResponsesApiSessionState>()

  constructor(options: ResponsesApiDriverOptions = {}) {
    this.options = resolveOptions(options)
  }

  createSession(history: CanonicalSessionHistory = []): AssistantDriverSession {
    for (const message of history) {
      if (
        message.type !== 'message' ||
        (message.role !== 'user' && message.role !== 'assistant') ||
        typeof message.content !== 'string'
      ) {
        throw new DriverError('invalid-request', 'Session history contains an invalid message.')
      }
    }
    return this.issueSession({
      identity: null,
      input: historyToProviderInput(history),
      successfulToolCallIds: new Set(),
    })
  }

  appendUserMessage(session: AssistantDriverSession, content: string): AssistantDriverSession {
    if (typeof content !== 'string' || !content.trim()) {
      throw new DriverError('invalid-request', 'User message must not be empty.')
    }
    const state = this.readSession(session)
    return this.issueSession({
      identity: state.identity,
      input: [...state.input, { role: 'user', content }],
      successfulToolCallIds: state.successfulToolCallIds,
    })
  }

  appendToolResults(
    session: AssistantDriverSession,
    results: readonly CanonicalToolResult[],
  ): AssistantDriverSession {
    const state = this.readSession(session)
    for (const result of results) {
      if (
        typeof result.callId !== 'string' ||
        !result.callId.trim() ||
        typeof result.output !== 'string'
      ) {
        throw new DriverError('invalid-request', 'Tool results contain an invalid item.')
      }
    }
    const successfulToolCallIds = new Set(state.successfulToolCallIds)
    for (const result of results) {
      if (result.isError === true) successfulToolCallIds.delete(result.callId)
      else successfulToolCallIds.add(result.callId)
    }
    return this.issueSession({
      identity: state.identity,
      input: [...state.input, ...results.map(toolResultToProviderInput)],
      successfulToolCallIds,
    })
  }

  compactSession(
    session: AssistantDriverSession,
    maxCharacters = this.options.maxSessionCharacters,
  ): AssistantDriverSession {
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
      throw new DriverError('invalid-request', 'maxCharacters must be a positive integer.')
    }
    const state = this.readSession(session)
    return this.issueSession({
      identity: state.identity,
      input: compactInput(state.input, maxCharacters),
      successfulToolCallIds: new Set(),
    })
  }

  async inspect(
    profile: unknown,
    options: DriverOperationOptions = {},
  ): Promise<DriverCapabilities> {
    parseProfile(profile)
    assertNotAborted(options.signal)
    return {
      features: [...CAPABILITIES.features],
      limits: {
        maxOutputTokens: this.options.maxOutputTokens,
        maxStreamEvents: this.options.maxStreamEvents,
        maxStreamTextCharacters: this.options.maxStreamTextCharacters,
        maxSessionCharacters: this.options.maxSessionCharacters,
      },
    }
  }

  async listModels(
    profileValue: unknown,
    options: DriverOperationOptions = {},
  ): Promise<ModelDescriptor[]> {
    const profile = parseProfile(profileValue)
    assertNotAborted(options.signal)
    const timeoutSignal = AbortSignal.timeout(this.options.modelListTimeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal

    try {
      const models = new Map<string, ModelDescriptor>()
      for await (const model of createClient(profile, this.options.requestTimeoutMs).models.list({
        signal,
      })) {
        if (model.id && model.id.length <= 512) {
          models.set(model.id, {
            id: model.id,
            ...(Number.isFinite(model.created) ? { createdAt: model.created } : {}),
          })
        }
        if (models.size >= this.options.maxModelOptions) break
      }
      return [...models.values()].sort((left, right) => left.id.localeCompare(right.id))
    } catch (error) {
      if (options.signal?.aborted) {
        throw new DriverError(
          'cancelled',
          options.signal.reason instanceof Error
            ? options.signal.reason.message
            : 'The model list request was cancelled.',
        )
      }
      if (timeoutSignal.aborted) {
        throw new DriverError(
          'provider-error',
          `${profile.name} model list request timed out.`,
          true,
          { cause: error },
        )
      }
      throw new DriverError(
        'provider-error',
        `${profile.name} model list request failed: ${sanitizeMessage(error, profile)}`,
        error instanceof ProtocolClient.APIError &&
          (error.status === undefined ||
            error.status === 408 ||
            error.status === 429 ||
            error.status >= 500),
        { cause: error },
      )
    }
  }

  async runTurn(
    request: CanonicalRunTurnRequest,
    listener?: CanonicalDriverEventListener,
  ): Promise<CanonicalTurnResult> {
    let profile: ResponsesApiProfile | undefined
    let failureUsage: CanonicalUsage | null = null
    try {
      profile = parseProfile(request.profile)
      assertNotAborted(request.signal)
      if (!request.runId.trim()) {
        throw new DriverError('invalid-request', 'runId must not be empty.')
      }
      if (!request.model.trim() || request.model.length > 512) {
        throw new DriverError('invalid-request', 'model is invalid.')
      }
      const maxOutputTokens = request.maxOutputTokens ?? this.options.maxOutputTokens
      if (
        !Number.isSafeInteger(maxOutputTokens) ||
        maxOutputTokens < 1 ||
        maxOutputTokens > this.options.maxOutputTokens
      ) {
        throw new DriverError(
          'invalid-request',
          `maxOutputTokens must be between 1 and ${this.options.maxOutputTokens.toString()}.`,
        )
      }

      const identity = profileIdentity(profile, request.model)
      const previous = this.readSession(request.session, identity)
      const input: ResponseInput = [...previous.input]
      const providerTools = request.toolChoice === 'none' ? [] : request.tools
      const toolChoice = toProviderToolChoice(request.toolChoice, providerTools)
      const client = createClient(profile, this.options.requestTimeoutMs)
      const create = (instructions: string, includeReasoning: boolean) =>
        client.responses.create(
          {
            model: request.model,
            instructions,
            input,
            ...(providerTools.length > 0 ? { tools: providerTools.map(toProviderTool) } : {}),
            ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
            store: false,
            truncation: 'auto',
            max_output_tokens: maxOutputTokens,
            ...(includeReasoning ? { include: ['reasoning.encrypted_content' as const] } : {}),
            stream: true,
          },
          { signal: request.signal },
        )
      const createNonStreaming = (instructions: string, includeReasoning: boolean) =>
        client.responses.create(
          {
            model: request.model,
            instructions,
            input,
            ...(providerTools.length > 0 ? { tools: providerTools.map(toProviderTool) } : {}),
            ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
            store: false,
            truncation: 'auto',
            max_output_tokens: maxOutputTokens,
            ...(includeReasoning ? { include: ['reasoning.encrypted_content' as const] } : {}),
            stream: false,
          },
          { signal: request.signal },
        )

      const protocolGuardTools = [
        ...new Map(
          [...request.tools, ...(request.protocolGuardTools ?? [])].map((tool) => [
            tool.name,
            tool,
          ]),
        ).values(),
      ]
      const deferTextUntilCompleted = protocolGuardTools.length > 0
      let eventCount = 0
      let streamedCharacters = 0
      const collectResponse = async (
        instructions: string,
      ): Promise<{ completed: Response; emittedText: string }> => {
        const useReasoningInclude = this.reasoningIncludeSupport.get(identity) ?? true
        let stream: Awaited<ReturnType<typeof create>>
        try {
          stream = await create(instructions, useReasoningInclude)
        } catch (error) {
          const unsupportedInclude =
            useReasoningInclude &&
            error instanceof ProtocolClient.BadRequestError &&
            /\b(?:include|reasoning|encrypted_content)\b/i.test(error.message)
          if (!unsupportedInclude) throw error
          this.reasoningIncludeSupport.set(identity, false)
          stream = await create(instructions, false)
        }

        let completed: Response | null = null
        let emittedText = ''
        try {
          for await (const event of stream) {
            assertNotAborted(request.signal)
            eventCount += 1
            if (eventCount > this.options.maxStreamEvents) {
              throw new DriverError(
                'response-limit',
                'Provider response event count exceeded the configured safety limit.',
              )
            }
            switch (event.type) {
              case 'response.output_text.delta':
              case 'response.refusal.delta':
                streamedCharacters += event.delta.length
                if (streamedCharacters > this.options.maxStreamTextCharacters) {
                  throw new DriverError(
                    'response-limit',
                    'Provider response text exceeded the configured safety limit.',
                  )
                }
                if (event.delta) {
                  emittedText += event.delta
                  if (!deferTextUntilCompleted) {
                    emit(listener, { type: 'text-delta', delta: event.delta })
                  }
                }
                break
              case 'response.completed':
                failureUsage = sumUsage(failureUsage, responseUsage(event.response))
                assertCompletedResponseSnapshot(event.response)
                completed = event.response
                break
              case 'response.failed':
                failureUsage = sumUsage(failureUsage, responseUsage(event.response))
                throw new DriverError(
                  'provider-error',
                  failureMessage(event.response, 'Model response generation failed.'),
                  retryableResponseFailure(event.response),
                )
              case 'response.incomplete':
                failureUsage = sumUsage(failureUsage, responseUsage(event.response))
                throw new DriverError(
                  'stream-incomplete',
                  failureMessage(event.response, 'Model response was incomplete.'),
                  retryableIncompleteResponse(event.response),
                )
              case 'error':
                throw new ProviderStreamEventError(
                  event.message || 'The provider returned a streaming error.',
                )
            }
          }
        } catch (error) {
          const providerStreamClosedBeforeSnapshot =
            deferTextUntilCompleted &&
            !completed &&
            !(error instanceof AssistantDriverError) &&
            request.signal?.aborted !== true
          if (!providerStreamClosedBeforeSnapshot) {
            throw error
          }
        }

        if (!completed) {
          if (!deferTextUntilCompleted && emittedText.length > 0) {
            throw new DriverError(
              'stream-incomplete',
              'Provider closed the response stream without a completion event.',
              true,
            )
          }
          let fallback: Response
          try {
            fallback = await createNonStreaming(instructions, useReasoningInclude)
          } catch (error) {
            const unsupportedInclude =
              useReasoningInclude &&
              error instanceof ProtocolClient.BadRequestError &&
              /\b(?:include|reasoning|encrypted_content)\b/i.test(error.message)
            if (!unsupportedInclude) throw error
            this.reasoningIncludeSupport.set(identity, false)
            fallback = await createNonStreaming(instructions, false)
          }
          if (!fallback || typeof fallback !== 'object' || !('status' in fallback)) {
            throw new DriverError(
              'stream-incomplete',
              'Provider returned an invalid non-streaming fallback response.',
              true,
            )
          }
          failureUsage = sumUsage(failureUsage, responseUsage(fallback))
          assertCompletedResponseSnapshot(fallback)
          completed = fallback
        }
        return { completed, emittedText }
      }

      let collected = await collectResponse(request.instructions)
      let completed = collected.completed
      let firstAttemptUsage: CanonicalUsage | null = null
      let recoveredToolProtocolAttempt = false
      const recentCompletedCalls = completedToolCallSignatures(input, providerTools)
      const recentGuardedCompletedCalls = completedToolCallSignatures(input, protocolGuardTools)
      const recentSuccessfulCalls = completedToolCallSignatures(
        input,
        providerTools,
        previous.successfulToolCallIds,
      )
      const extractCanonicalCalls = (
        response: Response,
      ): {
        calls: Array<{ callId: string; name: string; argumentsJson: string }>
        adaptedCall: ResponseFunctionToolCall | null
      } => {
        const structuredCalls = toolCalls(response).map((call) => ({
          callId: call.call_id,
          name: call.name,
          argumentsJson: (() => {
            const tool = providerTools.find((candidate) => candidate.name === call.name)
            return tool
              ? normalizeJsonSchemaArguments(call.arguments, tool.inputSchema)
              : call.arguments
          })(),
        }))
        if (request.toolChoice === 'none' && structuredCalls.length > 0) {
          return { calls: [], adaptedCall: null }
        }
        if (structuredCalls.length > 0) return { calls: structuredCalls, adaptedCall: null }

        const invocation = responseBracketedToolInvocation(
          response,
          providerTools,
          recentCompletedCalls,
          request.toolChoice,
        )
        if (!invocation || invocation.repeatsCompletedCall) {
          return { calls: [], adaptedCall: null }
        }
        const tool = providerTools.find((candidate) => candidate.name === invocation.name)
        const argumentsJson = tool
          ? normalizeJsonSchemaArguments(invocation.argumentsJson, tool.inputSchema)
          : invocation.argumentsJson
        const callId = `call_${randomUUID()}`
        const adaptedCall: ResponseFunctionToolCall = {
          type: 'function_call',
          id: `fc_${randomUUID()}`,
          call_id: callId,
          name: invocation.name,
          arguments: argumentsJson,
          status: 'completed',
        }
        return {
          calls: [
            {
              callId,
              name: invocation.name,
              argumentsJson,
            },
          ],
          adaptedCall,
        }
      }
      let providerText = assistantText(completed)
      let extractedCalls = extractCanonicalCalls(completed)
      let calls = extractedCalls.calls
      let adaptedTextualToolCall = extractedCalls.adaptedCall
      const containsForbiddenStructuredCall = (response: Response) =>
        request.toolChoice === 'none' && toolCalls(response).length > 0
      const containsGuardedToolProtocol = (response: Response) =>
        containsForbiddenStructuredCall(response) ||
        responseContainsUnstructuredToolCall(
          response,
          protocolGuardTools,
          recentGuardedCompletedCalls,
          request.toolChoice,
        )
      if (calls.length === 0 && containsGuardedToolProtocol(completed)) {
        recoveredToolProtocolAttempt = true
        firstAttemptUsage = responseUsage(completed)
        failureUsage = firstAttemptUsage
        collected = await collectResponse(
          providerTools.length > 0
            ? [
                request.instructions,
                'The previous generation attempted to serialize a registered tool call as assistant text, so the provider could not parse it.',
                'Regenerate the answer once. Use any completed tool results already present in the input and never repeat an identical completed call. If a new tool call is needed, return only a complete structured function call with every required argument through the provider tool channel. Never print tool-call markup or arguments as assistant text.',
              ].join('\n')
            : [
                request.instructions,
                'The previous generation attempted to serialize registered tool protocol as assistant text.',
                'Tool calling is disabled for this turn. Regenerate the answer once as normal final assistant text only. Do not call, name, serialize, or print any tool-call markup or tool arguments.',
              ].join('\n'),
        )
        completed = collected.completed
        failureUsage = sumUsage(firstAttemptUsage, responseUsage(completed))
        providerText = assistantText(completed)
        extractedCalls = extractCanonicalCalls(completed)
        calls = extractedCalls.calls
        adaptedTextualToolCall = extractedCalls.adaptedCall
        if (calls.length === 0 && containsGuardedToolProtocol(completed)) {
          throw new DriverError(
            'tool-protocol-invalid',
            'Provider returned forbidden or unstructured tool protocol after one automatic recovery attempt. No tool protocol output was displayed or executed.',
          )
        }
      }
      if (
        recoveredToolProtocolAttempt &&
        calls.some((call) => {
          const signature = toolCallSignature(call.name, call.argumentsJson)
          return signature !== null && recentSuccessfulCalls.has(signature)
        })
      ) {
        throw new DriverError(
          'stream-incomplete',
          'Provider attempted to repeat a completed tool call while recovering textual tool protocol output. The duplicate call was not executed.',
          true,
        )
      }
      const usage = sumUsage(firstAttemptUsage, responseUsage(completed))
      failureUsage = usage
      assertToolChoiceSatisfied(request.toolChoice, calls)
      const finalText = calls.length > 0 ? '' : providerText
      if (finalText.length > this.options.maxStreamTextCharacters) {
        throw new DriverError(
          'response-limit',
          'Provider response text exceeded the configured safety limit.',
        )
      }
      if (deferTextUntilCompleted) {
        if (finalText) emit(listener, { type: 'text-delta', delta: finalText })
      } else if (finalText.startsWith(collected.emittedText)) {
        const missingDelta = finalText.slice(collected.emittedText.length)
        if (missingDelta) emit(listener, { type: 'text-delta', delta: missingDelta })
      }

      for (const call of calls) emit(listener, { type: 'tool-call', call })
      if (usage) emit(listener, { type: 'usage', usage })
      failureUsage = null

      const session = this.issueSession({
        identity,
        successfulToolCallIds: previous.successfulToolCallIds,
        input: [
          ...input,
          ...(adaptedTextualToolCall
            ? [adaptedTextualToolCall]
            : completed.output
                .filter(isReplayableOutputItem)
                .filter((item) => calls.length === 0 || item.type !== 'message')),
        ],
      })
      emit(listener, { type: 'checkpoint', session })
      const finishReason = calls.length > 0 ? 'tool-calls' : 'stop'
      emit(listener, { type: 'completed', responseId: completed.id, finishReason })
      return {
        session,
        toolCalls: calls,
        usage,
        responseId: completed.id,
        finalText,
        finishReason,
      }
    } catch (error) {
      if (failureUsage) emit(listener, { type: 'usage', usage: failureUsage })
      const failure = toFailure(error, profile)
      emit(listener, { type: 'failed', failure })
      throw new AssistantDriverError(failure, { cause: error })
    }
  }

  private issueSession(state: ResponsesApiSessionState): AssistantDriverSession {
    const session = createAssistantDriverSession(this.id, randomUUID())
    this.sessions.set(session, state)
    return session
  }

  private readSession(
    session: AssistantDriverSession,
    identity?: string,
  ): ResponsesApiSessionState {
    if (!isAssistantDriverSession(session, this.id)) {
      throw new DriverError('invalid-request', `Session does not belong to the ${this.id} driver.`)
    }
    const state = this.sessions.get(session)
    if (!state) {
      throw new DriverError(
        'invalid-request',
        'Session is unknown or belongs to another driver instance.',
      )
    }
    if (identity !== undefined && state.identity !== null && state.identity !== identity) {
      throw new DriverError(
        'invalid-request',
        'Session profile or model does not match this request.',
      )
    }
    return state
  }
}
