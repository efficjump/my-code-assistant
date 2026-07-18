import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AgentService,
  type AgentServiceOptions,
  formatToolInputValidationError,
} from '../src/main/services/agent'
import { ConversationRepository } from '../src/main/services/conversations'
import { StructuredProcessRunner } from '../src/main/services/execution'
import { GitService, GitServiceError } from '../src/main/services/git'
import { MutationError, MutationService } from '../src/main/services/mutation'
import { type EncryptionAdapter, SettingsStore } from '../src/main/services/settings'
import { ToolRegistry } from '../src/main/services/tools'
import { TrustStore } from '../src/main/services/trust'
import { WorkspaceService } from '../src/main/services/workspace'
import type { AgentEvent, AgentRunInput, AppLocale, ApprovalRequest } from '../src/shared/contracts'

type ResponseBody = Record<string, unknown>
type ResponseStepResult = unknown[] | { json: unknown; status?: number }
type ResponseStep = (body: ResponseBody) => ResponseStepResult | Promise<ResponseStepResult>

interface MockResponsesServer {
  baseUrl: string
  bodies: ResponseBody[]
  failures: Error[]
}

interface AgentEnvironment {
  root: string
  workspace: WorkspaceService
  settings: SettingsStore
  trust: TrustStore
}

const MODEL_ID = 'integration-test-model'
const temporaryDirectories: string[] = []
const openServers: Server[] = []
const agents: AgentService[] = []
const repositories: ConversationRepository[] = []
let idSequence = 0

const testEncryption: EncryptionAdapter = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'code-assistant-agent-integration-'))
  temporaryDirectories.push(directory)
  return directory
}

function writeSse(response: ServerResponse, events: unknown[]): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end('data: [DONE]\n\n')
}

function functionCallEvents(
  name: string,
  argumentsJson: string,
  callId: string,
  usage?: { input: number; output: number; reasoning: number },
): unknown[] {
  return functionCallsEvents([{ name, argumentsJson, callId }], usage)
}

function functionCallsEvents(
  calls: Array<{ name: string; argumentsJson: string; callId: string }>,
  usage?: { input: number; output: number; reasoning: number },
): unknown[] {
  return [
    {
      type: 'response.completed',
      sequence_number: 1,
      response: {
        id: `response-${calls.map((call) => call.callId).join('-')}`,
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: calls.map((call) => ({
          id: `item-${call.callId}`,
          type: 'function_call',
          status: 'completed',
          call_id: call.callId,
          name: call.name,
          arguments: call.argumentsJson,
        })),
        ...(usage
          ? {
              usage: {
                input_tokens: usage.input,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: usage.output,
                output_tokens_details: { reasoning_tokens: usage.reasoning },
                total_tokens: usage.input + usage.output,
              },
            }
          : {}),
      },
    },
  ]
}

function completionContractEvents(
  requirement: 'response' | 'action',
  options: {
    requiredEffects?: Array<'workspace-change' | 'process' | 'mcp'>
    candidateDisposition?: 'acceptable' | 'retry'
    rationale?: string
    callId?: string
    usage?: { input: number; output: number; reasoning: number }
  } = {},
): unknown[] {
  return functionCallEvents(
    'declare_run_completion',
    JSON.stringify({
      requirement,
      requiredEffects: options.requiredEffects ?? [],
      candidateDisposition: options.candidateDisposition ?? 'acceptable',
      rationale: options.rationale ?? 'Integration test completion contract.',
    }),
    options.callId ?? `completion-contract-${requirement}`,
    options.usage,
  )
}

function goalFrontierContractEvents(options: {
  items: Array<{
    itemIndex: number
    alignment?: 'required' | 'outside-objective' | 'uncertain'
    rationale?: string
  }>
  selectedItemIndex: number | null
  requirement?: 'response' | 'action'
  requiredEffects?: Array<'workspace-change' | 'process' | 'mcp'>
  rationale?: string
  callId?: string
  usage?: { input: number; output: number; reasoning: number }
}): unknown[] {
  return functionCallEvents(
    'declare_goal_frontier',
    JSON.stringify({
      itemClassifications: options.items.map((item) => ({
        itemIndex: item.itemIndex,
        alignment: item.alignment ?? 'required',
        rationale: item.rationale ?? 'This item is required by the integration-test objective.',
      })),
      selectedItemIndex: options.selectedItemIndex,
      requirement:
        options.requirement ?? (options.selectedItemIndex === null ? 'response' : 'action'),
      requiredEffects:
        options.requiredEffects ?? (options.selectedItemIndex === null ? [] : ['workspace-change']),
      candidateDisposition: 'acceptable',
      rationale: options.rationale ?? 'Integration test Goal frontier contract.',
    }),
    options.callId ?? 'goal-frontier-contract',
    options.usage,
  )
}

function goalScopeAuthorizationContractEvents(options: {
  items: Array<{
    itemIndex: number
    authorization?:
      | 'direct-objective-entailment'
      | 'strict-implementation-necessity'
      | 'outside-objective'
      | 'uncertain'
    rationale?: string
  }>
  selectedItemIndex: number | null
  requirement?: 'response' | 'action'
  requiredEffects?: Array<'workspace-change' | 'process' | 'mcp'>
  rationale?: string
  callId?: string
  usage?: { input: number; output: number; reasoning: number }
}): unknown[] {
  return functionCallEvents(
    'declare_goal_scope_authorization',
    JSON.stringify({
      itemAuthorizations: options.items.map((item) => ({
        itemIndex: item.itemIndex,
        authorization: item.authorization ?? 'direct-objective-entailment',
        rationale:
          item.rationale ??
          (item.authorization === 'outside-objective'
            ? 'The closed integration-test objective does not authorize this item.'
            : item.authorization === 'uncertain'
              ? 'The supplied integration-test evidence cannot decide this item safely.'
              : 'The closed integration-test objective directly authorizes this item.'),
      })),
      selectedItemIndex: options.selectedItemIndex,
      requirement:
        options.requirement ?? (options.selectedItemIndex === null ? 'response' : 'action'),
      requiredEffects:
        options.requiredEffects ?? (options.selectedItemIndex === null ? [] : ['workspace-change']),
      candidateDisposition: 'acceptable',
      rationale: options.rationale ?? 'Independent integration-test authorization contract.',
    }),
    options.callId ?? 'goal-scope-authorization-contract',
    options.usage,
  )
}

function goalScopeRejectionContractEvents(options: {
  items: Array<{
    itemIndex: number
    disposition?:
      | 'outside-objective'
      | 'direct-objective-entailment'
      | 'strict-implementation-necessity'
      | 'uncertain'
    rationale?: string
  }>
  rationale?: string
  callId?: string
  usage?: { input: number; output: number; reasoning: number }
}): unknown[] {
  return functionCallEvents(
    'declare_goal_scope_rejection_confirmation',
    JSON.stringify({
      itemConfirmations: options.items.map((item) => ({
        itemIndex: item.itemIndex,
        disposition: item.disposition ?? 'outside-objective',
        rationale:
          item.rationale ?? 'The closed integration-test objective does not authorize this item.',
      })),
      rationale: options.rationale ?? 'Independent integration-test cleanup confirmation.',
    }),
    options.callId ?? 'goal-scope-rejection-confirmation',
    options.usage,
  )
}

function goalJointWorkContractEvents(options: {
  itemIndex: number
  authorization?:
    | 'direct-objective-entailment'
    | 'strict-implementation-necessity'
    | 'outside-objective'
    | 'uncertain'
  requirement?: 'response' | 'action'
  requiredEffects?: Array<'workspace-change' | 'process' | 'mcp'>
  rationale?: string
  callId?: string
}): unknown[] {
  return functionCallEvents(
    'declare_goal_joint_work_contract',
    JSON.stringify({
      itemIndex: options.itemIndex,
      authorization: options.authorization ?? 'direct-objective-entailment',
      requirement: options.requirement ?? 'action',
      requiredEffects: options.requiredEffects ?? ['workspace-change'],
      candidateDisposition: 'acceptable',
      rationale: options.rationale ?? 'Fresh independent integration-test work confirmation.',
    }),
    options.callId ?? 'goal-joint-work-contract',
  )
}

function goalRecoveryPlanContractEvents(options: {
  disposition?: 'replan' | 'uncertain'
  items?: Array<{
    step: string
    purpose: 'objective-work' | 'objective-verification'
    rationale?: string
  }>
  rationale?: string
  callId?: string
}): unknown[] {
  return functionCallEvents(
    'declare_goal_recovery_plan',
    JSON.stringify({
      disposition: options.disposition ?? 'replan',
      items: (options.items ?? []).map((item) => ({
        step: item.step,
        purpose: item.purpose,
        rationale: item.rationale ?? 'This pending step is required by the test Goal objective.',
      })),
      rationale: options.rationale ?? 'The legacy plan requires objective-specific replanning.',
    }),
    options.callId ?? 'goal-recovery-plan-contract',
  )
}

function textEvents(
  text: string,
  responseId: string,
  usage?: {
    input: number
    output: number
    reasoning: number
  },
): unknown[] {
  const itemId = `message-${responseId}`
  const message = {
    id: itemId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
  }
  return [
    {
      type: 'response.output_text.delta',
      sequence_number: 1,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    {
      type: 'response.completed',
      sequence_number: 2,
      response: {
        id: responseId,
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: [message],
        ...(usage
          ? {
              usage: {
                input_tokens: usage.input,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: usage.output,
                output_tokens_details: { reasoning_tokens: usage.reasoning },
                total_tokens: usage.input + usage.output,
              },
            }
          : {}),
      },
    },
  ]
}

function groundedReportSelectionEvents(
  body: ResponseBody,
  responseId: string,
  select: (fact: {
    id: string
    section: string
    text: string
    mandatory: boolean
  }) => boolean = () => true,
): unknown[] {
  const instructions = String(body.instructions ?? '')
  const prefix = 'Host fact catalog: '
  const line = instructions.split('\n').find((candidate) => candidate.startsWith(prefix))
  expect(line).toBeDefined()
  const source = line?.slice(prefix.length).replace(/\.$/, '') ?? '[]'
  const catalog = JSON.parse(source) as Array<{
    id: string
    section: string
    text: string
    mandatory: boolean
  }>
  const factIds = catalog.filter(select).map((fact) => fact.id)
  expect(factIds.length).toBeGreaterThan(0)
  return textEvents(JSON.stringify({ factIds }), responseId)
}

function goalActionOutcomeEvents(
  body: ResponseBody,
  role: 'verifier' | 'critic',
  verdict: 'complete' | 'incomplete' | 'uncertain',
  responseId: string,
  select: (fact: Record<string, unknown>) => boolean = () => true,
): unknown[] {
  expect(body.tools).toBeUndefined()
  expect(body.tool_choice).toBe('none')
  const data = hostClassifierData(body, `goal-action-outcome-${role}`)
  const outcome = data.outcome as Record<string, unknown>
  const factCatalog = outcome.factCatalog as Array<Record<string, unknown>>
  expect(Array.isArray(factCatalog)).toBe(true)
  const supportingFactIds = factCatalog.filter(select).map((fact) => String(fact.id))
  expect(supportingFactIds.length).toBeGreaterThan(0)
  return textEvents(
    JSON.stringify({
      verdict,
      supportingFactIds,
      rationale: `${role} ${verdict} for integration test evidence.`,
    }),
    responseId,
  )
}

function incompleteJsonResponse(id: string): { json: unknown } {
  return {
    json: {
      id,
      status: 'incomplete',
      error: null,
      incomplete_details: { reason: 'provider_transport' },
      output: [],
      usage: null,
    },
  }
}

function incompleteSseEvents(
  text: string,
  id: string,
  reason: 'max_output_tokens' | 'provider_transport',
  usage?: { input: number; output: number; reasoning: number },
): unknown[] {
  return [
    {
      type: 'response.completed',
      sequence_number: 1,
      response: {
        id,
        status: 'incomplete',
        error: null,
        incomplete_details: { reason },
        output: [
          {
            id: `message-${id}`,
            type: 'message',
            status: 'incomplete',
            role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
          },
        ],
        usage: usage
          ? {
              input_tokens: usage.input,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: usage.output,
              output_tokens_details: { reasoning_tokens: usage.reasoning },
              total_tokens: usage.input + usage.output,
            }
          : null,
      },
    },
  ]
}

function failedSseEvents(id: string, code: string, message: string): unknown[] {
  return [
    {
      type: 'response.failed',
      sequence_number: 1,
      response: {
        id,
        status: 'failed',
        error: { code, message },
        incomplete_details: null,
        output: [],
        usage: null,
      },
    },
  ]
}

async function startResponsesServer(steps: ResponseStep[]): Promise<MockResponsesServer> {
  const bodies: ResponseBody[] = []
  const failures: Error[] = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end()
      return
    }

    let source = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      source += chunk
    })
    request.on('end', async () => {
      try {
        const body = JSON.parse(source) as ResponseBody
        const step = steps[bodies.length]
        bodies.push(body)
        if (!step) throw new Error(`Unexpected Responses API request #${bodies.length}`)
        const result = await step(body)
        if (Array.isArray(result)) {
          writeSse(response, result)
        } else {
          response.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(result.json))
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        failures.push(failure)
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' })
        }
        response.end(JSON.stringify({ error: { message: failure.message } }))
      }
    })
  })
  openServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { baseUrl: `http://127.0.0.1:${port}/v1`, bodies, failures }
}

async function createEnvironment(
  baseUrl: string,
  options: { trusted: boolean; locale?: AppLocale },
): Promise<AgentEnvironment> {
  const root = await temporaryDirectory()
  const workspace = new WorkspaceService()
  await workspace.openWorkspace(root, false)

  const settings = new SettingsStore({
    userDataPath: await temporaryDirectory(),
    encryption: testEncryption,
  })
  const saved = await settings.saveProvider({ name: 'Local test', baseUrl })
  const providerId = saved.providers[0].id
  await settings.saveSettings({
    activeProviderId: providerId,
    activeModelId: MODEL_ID,
    theme: 'system',
    ...(options.locale ? { locale: options.locale } : {}),
    maxToolIterations: 6,
  })

  const trust = new TrustStore({ userDataPath: await temporaryDirectory() })
  if (options.trusted) await trust.setWorkspaceTrust(root, true)
  return { root, workspace, settings, trust }
}

function createAgent(
  environment: AgentEnvironment,
  options: Omit<AgentServiceOptions, 'trust'> = {},
): AgentService {
  const agent = new AgentService(environment.settings, environment.workspace, {
    generateConversationTitles: false,
    ...options,
    trust: environment.trust,
  })
  agents.push(agent)
  return agent
}

function runInput(
  conversationId: string,
  message: string,
  contextPaths: string[] = [],
): AgentRunInput {
  idSequence += 1
  return {
    conversationId,
    userMessageId: `user-${idSequence}`,
    assistantMessageId: `assistant-${idSequence}`,
    message,
    displayMessage: message,
    contextPaths,
  }
}

async function collectRun(
  agent: AgentService,
  input: AgentRunInput,
  onEvent?: (event: AgentEvent) => void,
): Promise<{ runId: string; events: AgentEvent[] }> {
  const events: AgentEvent[] = []
  return await new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('Agent integration test timed out.'))
    }, 10_000)

    try {
      const { runId } = agent.startRun(input, (event) => {
        if (settled) return
        events.push(event)
        try {
          onEvent?.(event)
        } catch (error) {
          settled = true
          clearTimeout(timeout)
          agent.cancelRun(event.runId)
          reject(error)
          return
        }
        if (
          event.type === 'completed' ||
          event.type === 'interrupted' ||
          event.type === 'cancelled' ||
          event.type === 'error'
        ) {
          settled = true
          clearTimeout(timeout)
          resolve({ runId, events })
        }
      })
    } catch (error) {
      settled = true
      clearTimeout(timeout)
      reject(error)
    }
  })
}

function inputItems(body: ResponseBody): Array<Record<string, unknown>> {
  expect(Array.isArray(body.input)).toBe(true)
  return body.input as Array<Record<string, unknown>>
}

function hostClassifierData(
  body: ResponseBody,
  classifier:
    | 'goal-work-scope'
    | 'goal-scope-authorization'
    | 'goal-scope-rejection-confirmation'
    | 'goal-joint-work-contract'
    | 'goal-recovery-plan'
    | 'goal-response-candidate'
    | 'goal-action-outcome-verifier'
    | 'goal-action-outcome-critic',
): Record<string, unknown> {
  const items = inputItems(body)
  expect(items).toHaveLength(1)
  expect(items[0]).toEqual(
    expect.objectContaining({
      role: 'user',
      content: expect.any(String),
    }),
  )
  const envelope = JSON.parse(String(items[0]?.content)) as Record<string, unknown>
  expect(envelope).toEqual(
    expect.objectContaining({
      protocol: 'host-classifier-request.v1',
      classifier,
      dataHandling: expect.stringContaining('untrusted data'),
      data: expect.any(Object),
    }),
  )
  return envelope.data as Record<string, unknown>
}

function functionOutput(body: ResponseBody): {
  ok: boolean
  result?: Record<string, unknown>
  error?: string
} {
  const item = inputItems(body).find((candidate) => candidate.type === 'function_call_output')
  expect(item).toBeDefined()
  expect(typeof item?.output).toBe('string')
  return JSON.parse(item?.output as string) as {
    ok: boolean
    result?: Record<string, unknown>
    error?: string
  }
}

function functionOutputFor(body: ResponseBody, callId: string): Record<string, unknown> {
  const item = inputItems(body).find(
    (candidate) => candidate.type === 'function_call_output' && candidate.call_id === callId,
  )
  expect(item).toBeDefined()
  expect(typeof item?.output).toBe('string')
  return JSON.parse(item?.output as string) as Record<string, unknown>
}

function approvalRequests(events: AgentEvent[]): ApprovalRequest[] {
  return events.filter((event) => event.type === 'approval-requested').map((event) => event.request)
}

function validationFrontierTools(): ToolRegistry {
  const tools = new ToolRegistry()
  tools.register({
    definition: {
      name: 'validation_frontier_probe',
      description: 'Validate a dynamically supplied probe value.',
      strict: true,
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          enabled: { type: 'boolean' },
          label: { type: 'string' },
        },
        required: ['count', 'enabled', 'label'],
        additionalProperties: false,
      },
    },
    schema: z.object({ count: z.number(), enabled: z.boolean(), label: z.string() }).strict(),
    capability: 'read',
    risk: 'read-only',
    origin: 'workspace',
    execute: (input) => input,
  })
  return tools
}

function executionFailureFrontierTools(): ToolRegistry {
  const tools = new ToolRegistry()
  tools.register({
    definition: {
      name: 'typed_failure_probe',
      description: 'Return the same typed service failure for a logical resource.',
      strict: true,
      inputSchema: {
        type: 'object',
        properties: { variant: { type: 'string' } },
        required: ['variant'],
        additionalProperties: false,
      },
    },
    schema: z.object({ variant: z.string() }).strict(),
    capability: 'write',
    risk: 'host-managed',
    origin: 'workspace',
    execute: () => {
      throw new MutationError({
        code: 'INVALID_PATH',
        identifier: 'path-value',
        path: 'logical/resource.txt',
      })
    },
  })
  tools.register({
    definition: {
      name: 'applied_recovery_probe',
      description: 'Apply a host-observed recovery effect.',
      strict: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    schema: z.object({}).strict(),
    capability: 'write',
    risk: 'host-managed',
    origin: 'workspace',
    execute: () => ({ recovered: true }),
    resolveEffectReceipt: () => ({ effectAttempted: true, executed: true, applied: true }),
  })
  return tools
}

function transientExecutionFailureTools(): ToolRegistry {
  const tools = new ToolRegistry()
  tools.register({
    definition: {
      name: 'transient_failure_probe',
      description: 'Return a typed transient service failure.',
      strict: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    schema: z.object({}).strict(),
    capability: 'read',
    risk: 'read-only',
    origin: 'workspace',
    execute: () => {
      throw new GitServiceError({ code: 'GIT_TIMEOUT', operation: 'status' })
    },
  })
  return tools
}

afterEach(async () => {
  await Promise.allSettled(agents.splice(0).map((agent) => agent.shutdown()))
  for (const repository of repositories.splice(0)) repository.close()
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('AgentService integration boundaries', () => {
  it('bounds and sanitizes structured tool validation details', () => {
    const hostileKey = `bad\u0000\n${'x'.repeat(5_000)}`
    const result = z
      .object({ changes: z.array(z.string()).max(1) })
      .strict()
      .safeParse({ changes: 'not-an-array', [hostileKey]: true })
    expect(result.success).toBe(false)
    if (result.success) return

    const message = formatToolInputValidationError(result.error, 'ko')
    expect(message).not.toBeNull()
    expect(message?.length).toBeLessThanOrEqual(2_000)
    expect(
      [...(message ?? '')].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0
        return codePoint > 0x1f && codePoint !== 0x7f
      }),
    ).toBe(true)
    expect(message).toContain('changes: 배열 형식이어야 합니다.')
    expect(message).not.toContain('Invalid input')
  })

  it('stops raw argument variants that preserve the same validation issue frontier', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 'bad-one', enabled: true, label: 'first summary' }),
          'frontier-same-first',
        ),
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 'bad-two', enabled: true, label: 'changed summary' }),
          'frontier-same-second',
        ),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, { tools: validationFrontierTools() })

    const result = await collectRun(
      agent,
      runInput('same-validation-frontier', '서로 다른 값으로 검증 복구를 시도해줘'),
    )

    expect(result.events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('실패한 도구 호출을 수정하지 않고 반복'),
    })
    expect(
      result.events.filter(
        (event) => event.type === 'tool-completed' && event.tool === 'validation_frontier_probe',
      ),
    ).toEqual([expect.objectContaining({ callId: 'frontier-same-first', ok: false })])
    expect(mock.bodies).toHaveLength(2)
    expect(mock.failures).toEqual([])
  })

  it('allows a valid corrected call after a validation failure', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 'bad', enabled: true, label: 'invalid' }),
          'frontier-corrected-invalid',
        ),
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 5, enabled: true, label: 'corrected' }),
          'frontier-corrected-valid',
        ),
      () => textEvents('검증 문제를 수정한 호출이 실행됐습니다.', 'frontier-corrected-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, { tools: validationFrontierTools() })

    const result = await collectRun(
      agent,
      runInput('corrected-validation-frontier', '검증 오류를 수정해서 다시 실행해줘'),
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        callId: 'frontier-corrected-invalid',
        ok: false,
      }),
    )
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        callId: 'frontier-corrected-valid',
        ok: true,
      }),
    )
    expect(mock.failures).toEqual([])
  })

  it('allows a strictly reduced validation frontier before a valid call', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 'bad', enabled: 'bad', label: 'two issues' }),
          'frontier-reduced-two',
        ),
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 7, enabled: 'bad', label: 'one issue' }),
          'frontier-reduced-one',
        ),
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 7, enabled: false, label: 'valid' }),
          'frontier-reduced-valid',
        ),
      () => textEvents('검증 문제를 단계적으로 모두 수정했습니다.', 'frontier-reduced-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, { tools: validationFrontierTools() })

    const result = await collectRun(
      agent,
      runInput('reduced-validation-frontier', '남은 검증 문제를 단계적으로 수정해줘'),
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(
      result.events
        .filter(
          (event): event is Extract<AgentEvent, { type: 'tool-completed' }> =>
            event.type === 'tool-completed' && event.tool === 'validation_frontier_probe',
        )
        .map((event) => event.ok),
    ).toEqual([false, false, true])
    expect(mock.failures).toEqual([])
  })

  it('blocks a previously removed issue from being reintroduced after frontier reduction', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 'bad', enabled: 'bad', label: 'issues A and B' }),
          'frontier-reintroduced-two',
        ),
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 1, enabled: 'bad', label: 'issue B remains' }),
          'frontier-reintroduced-one',
        ),
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 'bad-again', enabled: true, label: 'issue A returned' }),
          'frontier-reintroduced-old',
        ),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, { tools: validationFrontierTools() })

    const result = await collectRun(
      agent,
      runInput('reintroduced-validation-frontier', '검증 문제를 줄여서 수정해줘'),
    )

    expect(result.events.at(-1)?.type).toBe('error')
    expect(
      result.events.filter(
        (event) => event.type === 'tool-completed' && event.tool === 'validation_frontier_probe',
      ),
    ).toHaveLength(2)
    expect(mock.bodies).toHaveLength(3)
    expect(mock.failures).toEqual([])
  })

  it('blocks a partial-overlap frontier that swaps a fixed issue for a new issue', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 'bad', enabled: 'bad', label: 'issues A and B' }),
          'frontier-overlap-first',
        ),
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 1, enabled: 'bad', label: 3 }),
          'frontier-overlap-swap',
        ),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, { tools: validationFrontierTools() })

    const result = await collectRun(
      agent,
      runInput('overlap-validation-frontier', '일부 검증 문제를 다른 문제로 바꿔봐'),
    )

    expect(result.events.at(-1)?.type).toBe('error')
    expect(
      result.events.filter(
        (event) => event.type === 'tool-completed' && event.tool === 'validation_frontier_probe',
      ),
    ).toHaveLength(1)
    expect(mock.bodies).toHaveLength(2)
    expect(mock.failures).toEqual([])
  })

  it('allows only one completely new disjoint validation diagnosis before reset', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 'bad', enabled: true, label: 'issue A' }),
          'frontier-disjoint-a',
        ),
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 1, enabled: 'bad', label: 'issue B' }),
          'frontier-disjoint-b',
        ),
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 1, enabled: true, label: 3 }),
          'frontier-disjoint-c',
        ),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, { tools: validationFrontierTools() })

    const result = await collectRun(
      agent,
      runInput('bounded-disjoint-validation-frontier', '새 진단으로 계속 바꿔봐'),
    )

    expect(result.events.at(-1)?.type).toBe('error')
    expect(
      result.events.filter(
        (event) => event.type === 'tool-completed' && event.tool === 'validation_frontier_probe',
      ),
    ).toHaveLength(2)
    expect(mock.bodies).toHaveLength(3)
    expect(mock.failures).toEqual([])
  })

  it('resets validation frontier history after a valid call', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 'bad', enabled: true, label: 'first invalid' }),
          'frontier-reset-first-invalid',
        ),
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 1, enabled: true, label: 'first valid' }),
          'frontier-reset-first-valid',
        ),
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 'bad-again', enabled: true, label: 'second invalid' }),
          'frontier-reset-second-invalid',
        ),
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 2, enabled: true, label: 'second valid' }),
          'frontier-reset-second-valid',
        ),
      () => textEvents('유효 호출마다 검증 상태를 초기화했습니다.', 'frontier-reset-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, { tools: validationFrontierTools() })

    const result = await collectRun(
      agent,
      runInput('reset-validation-frontier', '유효 호출 뒤 다른 검증 시도를 계속해줘'),
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(
      result.events
        .filter(
          (event): event is Extract<AgentEvent, { type: 'tool-completed' }> =>
            event.type === 'tool-completed' && event.tool === 'validation_frontier_probe',
        )
        .map((event) => event.ok),
    ).toEqual([false, true, false, true])
    expect(mock.failures).toEqual([])
  })

  it('stops a validation frontier cycle after allowing a new diagnosis', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 'bad', enabled: true, label: 'frontier A' }),
          'frontier-cycle-a-first',
        ),
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 1, enabled: 'bad', label: 'frontier B' }),
          'frontier-cycle-b',
        ),
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 'changed-bad', enabled: true, label: 'frontier A again' }),
          'frontier-cycle-a-second',
        ),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, { tools: validationFrontierTools() })

    const result = await collectRun(
      agent,
      runInput('cycled-validation-frontier', '검증 오류를 고쳐서 실행해줘'),
    )

    expect(result.events.at(-1)?.type).toBe('error')
    expect(
      result.events.filter(
        (event) => event.type === 'tool-completed' && event.tool === 'validation_frontier_probe',
      ),
    ).toHaveLength(2)
    expect(mock.bodies).toHaveLength(3)
    expect(mock.failures).toEqual([])
  })

  it('counts matching validation issues in one assistant batch as one frontier', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallsEvents([
          {
            name: 'validation_frontier_probe',
            argumentsJson: JSON.stringify({ count: 'bad-one', enabled: true, label: 'first' }),
            callId: 'frontier-batch-first',
          },
          {
            name: 'validation_frontier_probe',
            argumentsJson: JSON.stringify({ count: 'bad-two', enabled: true, label: 'second' }),
            callId: 'frontier-batch-second',
          },
        ]),
      () =>
        functionCallEvents(
          'validation_frontier_probe',
          JSON.stringify({ count: 11, enabled: true, label: 'corrected' }),
          'frontier-batch-valid',
        ),
      () => textEvents('같은 배치의 진단을 한 번에 수정했습니다.', 'frontier-batch-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, { tools: validationFrontierTools() })

    const result = await collectRun(
      agent,
      runInput('batched-validation-frontier', '배치 검증 오류를 수정해줘'),
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(
      result.events
        .filter(
          (event): event is Extract<AgentEvent, { type: 'tool-completed' }> =>
            event.type === 'tool-completed' && event.tool === 'validation_frontier_probe',
        )
        .map((event) => event.ok),
    ).toEqual([false, false, true])
    expect(mock.failures).toEqual([])
  })

  it('stops repeated typed execution failures when no effect changed state', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'typed_failure_probe',
          JSON.stringify({ variant: 'first raw proposal' }),
          'typed-failure-first',
        ),
      () =>
        functionCallEvents(
          'typed_failure_probe',
          JSON.stringify({ variant: 'changed raw proposal' }),
          'typed-failure-second',
        ),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, { tools: executionFailureFrontierTools() })

    const result = await collectRun(
      agent,
      runInput('typed-execution-frontier', '같은 리소스 변경을 시도해줘'),
    )

    expect(result.events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('실패한 도구 호출을 수정하지 않고 반복'),
    })
    expect(
      result.events.filter(
        (event) => event.type === 'tool-completed' && event.tool === 'typed_failure_probe',
      ),
    ).toHaveLength(2)
    expect(mock.bodies).toHaveLength(2)
    expect(mock.failures).toEqual([])
  })

  it('does not suppress repeated typed transient execution failures', async () => {
    const mock = await startResponsesServer([
      () => functionCallEvents('transient_failure_probe', '{}', 'transient-failure-first'),
      () => functionCallEvents('transient_failure_probe', '{}', 'transient-failure-second'),
      () => textEvents('일시적 실패 두 건을 관찰하고 종료했습니다.', 'transient-failure-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, { tools: transientExecutionFailureTools() })

    const result = await collectRun(
      agent,
      runInput('transient-execution-frontier', '일시적 오류를 다시 확인해줘'),
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(
      result.events.filter(
        (event) => event.type === 'tool-completed' && event.tool === 'transient_failure_probe',
      ),
    ).toEqual([
      expect.objectContaining({ callId: 'transient-failure-first', ok: false }),
      expect.objectContaining({ callId: 'transient-failure-second', ok: false }),
    ])
    expect(mock.failures).toEqual([])
  })

  it('allows the same typed execution failure after an applied recovery effect', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'typed_failure_probe',
          JSON.stringify({ variant: 'before recovery' }),
          'typed-failure-before-recovery',
        ),
      () => functionCallEvents('applied_recovery_probe', '{}', 'typed-failure-recovery'),
      () =>
        functionCallEvents(
          'typed_failure_probe',
          JSON.stringify({ variant: 'after recovery' }),
          'typed-failure-after-recovery',
        ),
      () => textEvents('복구 효과 뒤 재시도를 관찰했습니다.', 'typed-failure-recovery-final'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          callId: 'typed-failure-recovery-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, { tools: executionFailureFrontierTools() })

    const result = await collectRun(
      agent,
      runInput('typed-execution-recovery', '복구 효과 뒤 같은 리소스를 다시 확인해줘'),
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        callId: 'typed-failure-recovery',
        ok: true,
      }),
    )
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        callId: 'typed-failure-after-recovery',
        ok: false,
      }),
    )
    expect(mock.failures).toEqual([])
  })

  it('generates and persists a new conversation title with the active model', async () => {
    const generatedTitle = '모델 기반 대화 제목 생성'
    const mock = await startResponsesServer([
      () => textEvents('요청한 내용을 설명했습니다.', 'title-main-response'),
      () => textEvents(`제목: "${generatedTitle}"`, 'title-generation-response'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: false })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      generateConversationTitles: true,
    })

    const result = await collectRun(
      agent,
      runInput('model-title-conversation', '대화 제목을 모델로 생성하도록 개선해줘'),
    )
    await agent.shutdown()

    expect(repository.getConversationMetadata('model-title-conversation')?.summary).toBe(
      generatedTitle,
    )
    expect(mock.bodies[1]).toMatchObject({
      tool_choice: 'none',
      max_output_tokens: 64,
    })
    expect(mock.failures).toEqual([])
    expect(result.events.at(-1)?.type).toBe('completed')
  })

  it('keeps the agent response successful when title generation is invalid', async () => {
    const mock = await startResponsesServer([
      () => textEvents('작업 응답은 정상입니다.', 'invalid-title-main-response'),
      () => textEvents('   ', 'invalid-title-generation-response'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: false })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      generateConversationTitles: true,
    })

    const result = await collectRun(
      agent,
      runInput('invalid-model-title', '제목 생성 실패가 본 작업을 중단하면 안 돼'),
    )
    await agent.shutdown()

    expect(result.events.some((event) => event.type === 'conversation-title')).toBe(false)
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(repository.getConversationMetadata('invalid-model-title')?.summary).toBe('')
    expect(mock.failures).toEqual([])
  })

  it('emits English host-owned tool summaries while preserving model text verbatim', async () => {
    const modelText = '모델이 생성한 원문 답변'
    const mock = await startResponsesServer([
      () => functionCallEvents('list_files', '{"path":null}', 'localized-list'),
      () => textEvents(modelText, 'localized-final'),
      () => completionContractEvents('response', { callId: 'localized-contract' }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true, locale: 'en' })
    const agent = createAgent(environment)

    const result = await collectRun(
      agent,
      runInput('english-host-messages', '워크스페이스를 확인해줘'),
    )

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-started',
        callId: 'localized-list',
        summary: 'List workspace files',
      }),
    )
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        callId: 'localized-list',
        summary: 'List workspace files completed',
        ok: true,
      }),
    )
    expect(
      result.events
        .filter((event) => event.type === 'text-delta')
        .map((event) => event.delta)
        .join(''),
    ).toBe(modelText)
    expect(mock.failures).toEqual([])
    expect(result.events.at(-1)?.type).toBe('completed')
  })

  it('reports a non-repository workspace as a successful Git status result', async () => {
    const mock = await startResponsesServer([
      () => functionCallEvents('git_status', '{}', 'plain-directory-status'),
      () => textEvents('Git 저장소가 아닌 작업 공간입니다.', 'plain-directory-final'),
      () => completionContractEvents('response', { callId: 'plain-directory-contract' }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, { git: new GitService(environment.workspace) })

    const result = await collectRun(
      agent,
      runInput('plain-directory-git-status', '현재 작업 공간 상태를 확인해줘'),
    )

    expect(functionOutput(mock.bodies[1])).toEqual({
      ok: true,
      result: {
        repository: false,
        head: null,
        branch: null,
        detached: false,
        entries: [],
        truncated: false,
      },
    })
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        callId: 'plain-directory-status',
        ok: true,
      }),
    )
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(mock.failures).toEqual([])
  })

  it('keeps the locale snapshot captured at run start when settings change mid-run', async () => {
    let signalFirstRequest!: () => void
    let releaseFirstResponse!: () => void
    const firstRequest = new Promise<void>((resolve) => {
      signalFirstRequest = resolve
    })
    const responseGate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve
    })
    const mock = await startResponsesServer([
      async () => {
        signalFirstRequest()
        await responseGate
        return functionCallEvents('list_files', '{"path":null}', 'snapshot-list')
      },
      () => textEvents('snapshot complete', 'snapshot-final'),
      () => completionContractEvents('response', { callId: 'snapshot-contract' }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true, locale: 'en' })
    const agent = createAgent(environment)
    const run = collectRun(agent, runInput('locale-snapshot', 'inspect the workspace'))
    await firstRequest
    const current = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: current.activeProviderId,
      activeModelId: current.activeModelId,
      theme: current.theme,
      locale: 'ko',
      maxToolIterations: current.maxToolIterations,
    })
    releaseFirstResponse()

    const result = await run
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        callId: 'snapshot-list',
        summary: 'List workspace files completed',
      }),
    )
    expect(mock.failures).toEqual([])
  })

  it('emits a host-owned run setup error in the selected English locale', async () => {
    const mock = await startResponsesServer([])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true, locale: 'en' })
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: null,
      activeModelId: null,
      theme: currentSettings.theme,
      locale: 'en',
      maxToolIterations: currentSettings.maxToolIterations,
    })
    const agent = createAgent(environment)

    const result = await collectRun(
      agent,
      runInput('english-run-error', '이 요청은 공급자 없이 실패해야 합니다'),
    )

    expect(result.events.at(-1)).toMatchObject({
      type: 'error',
      message: 'Select an active provider first.',
    })
    expect(mock.bodies).toHaveLength(0)
    expect(mock.failures).toEqual([])
  })

  it('localizes structured tool validation diagnostics without exposing Zod prose', async () => {
    const mock = await startResponsesServer([
      () => functionCallEvents('custom_probe', '{"value":42}', 'invalid-custom-probe'),
      () => textEvents('validation observed', 'custom-validation-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true, locale: 'en' })
    const tools = new ToolRegistry()
    tools.register({
      definition: {
        name: 'custom_probe',
        description: 'Validate a custom string value.',
        strict: true,
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
      schema: z.object({ value: z.string() }).strict(),
      capability: 'read',
      risk: 'read-only',
      origin: 'workspace',
      execute: ({ value }) => value,
    })
    const agent = createAgent(environment, { tools })

    const result = await collectRun(
      agent,
      runInput('english-custom-validation', 'validate the custom tool input'),
    )
    const failure = result.events.find(
      (event) => event.type === 'tool-completed' && event.callId === 'invalid-custom-probe',
    )

    expect(failure).toMatchObject({
      type: 'tool-completed',
      ok: false,
      summary: expect.stringContaining('Tool input validation failed: value:'),
    })
    expect(failure && 'summary' in failure ? failure.summary : '').toContain('Expected string.')
    expect(failure && 'summary' in failure ? failure.summary : '').not.toContain('received number')
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(mock.failures).toEqual([])
  })

  it('forces an exact file refresh after a create conflict before allowing another mutation', async () => {
    const before = 'export const state = "existing"\n'
    const after = 'export const state = "updated"\n'
    const beforeHash = createHash('sha256').update(before).digest('hex')
    const staleCreate = (summary: string, content: string) =>
      JSON.stringify({
        summary,
        changes: [{ path: 'src/Chat.jsx', baseSha256: null, newContent: content }],
      })
    const correctedUpdate = JSON.stringify({
      summary: '현재 파일을 읽은 뒤 수정',
      changes: [{ path: 'src/Chat.jsx', baseSha256: beforeHash, newContent: after }],
    })
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'propose_file_changes',
          staleCreate('기존 파일을 잘못 신규 생성', 'first stale attempt\n'),
          'stale-create-first',
        ),
      () =>
        functionCallEvents(
          'propose_file_changes',
          staleCreate('읽지 않고 다시 신규 생성', 'second stale attempt\n'),
          'stale-create-second',
        ),
      () => functionCallEvents('read_file', '{"path":"src/./Chat.jsx"}', 'refresh-chat'),
      () => functionCallEvents('propose_file_changes', correctedUpdate, 'corrected-chat-update'),
      () => textEvents('현재 파일을 다시 읽고 안전하게 수정했습니다.', 'refresh-final'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          callId: 'refresh-final-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await mkdir(join(environment.root, 'src'))
    await writeFile(join(environment.root, 'src', 'Chat.jsx'), before)
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('forced-file-refresh', '기존 Chat.jsx를 수정해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, 'src', 'Chat.jsx'), 'utf8')).toBe(after)
    expect(approvalRequests(result.events)).toHaveLength(1)
    expect(functionOutputFor(mock.bodies[1], 'stale-create-first')).toMatchObject({
      ok: false,
      failure: {
        code: 'HASH_CONFLICT',
        path: 'src/Chat.jsx',
        currentSha256: beforeHash,
        expectedSha256: null,
      },
    })
    expect(functionOutputFor(mock.bodies[2], 'stale-create-second')).toMatchObject({
      ok: false,
      error: expect.stringContaining('read_file'),
    })
    expect(functionOutputFor(mock.bodies[3], 'refresh-chat')).toMatchObject({ ok: true })
    expect(result.events.filter((event) => event.type === 'files-changed')).toHaveLength(1)
    expect(mock.failures).toEqual([])
  })

  it('restores an unresolved file conflict in the next run and clears it only after an exact read', async () => {
    const before = 'export const state = "before"\n'
    const after = 'export const state = "after"\n'
    const beforeHash = createHash('sha256').update(before).digest('hex')
    const staleCreate = JSON.stringify({
      summary: '기존 파일을 잘못 신규 생성',
      changes: [{ path: 'src/Chat.jsx', baseSha256: null, newContent: 'stale replacement\n' }],
    })
    const correctedUpdate = JSON.stringify({
      summary: '현재 파일을 다시 읽은 뒤 수정',
      changes: [{ path: 'src/Chat.jsx', baseSha256: beforeHash, newContent: after }],
    })
    const mock = await startResponsesServer([
      () => functionCallEvents('propose_file_changes', staleCreate, 'durable-conflict-first'),
      () => functionCallEvents('propose_file_changes', staleCreate, 'durable-conflict-retry'),
      () => functionCallEvents('read_file', '{"path":"src/Chat.jsx"}', 'durable-refresh-read'),
      () => functionCallEvents('propose_file_changes', correctedUpdate, 'durable-refresh-update'),
      () => textEvents('충돌 파일을 다시 읽고 안전하게 수정했습니다.', 'durable-refresh-final'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          callId: 'durable-refresh-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await mkdir(join(environment.root, 'src'))
    await writeFile(join(environment.root, 'src', 'Chat.jsx'), before)
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const first = await collectRun(
      agent,
      runInput('durable-file-refresh', '기존 Chat.jsx를 수정해줘'),
      (event) => {
        if (event.type === 'tool-completed' && event.tool === 'propose_file_changes' && !event.ok) {
          agent.cancelRun(event.runId)
        }
      },
    )
    expect(first.events.at(-1)?.type).toBe('cancelled')
    expect(repository.pendingMutationRefreshes('durable-file-refresh')).toEqual([
      {
        path: 'src/Chat.jsx',
        failureCode: 'HASH_CONFLICT',
        currentSha256: beforeHash,
      },
    ])

    const second = await collectRun(
      agent,
      runInput('durable-file-refresh', '이어서 수정해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(second.events.at(-1)?.type).toBe('completed')
    expect(String(mock.bodies[1].instructions)).toContain('src/Chat.jsx')
    expect(String(mock.bodies[1].instructions)).toContain('read_file')
    expect(functionOutputFor(mock.bodies[2], 'durable-conflict-retry')).toMatchObject({
      ok: false,
      error: expect.stringContaining('read_file'),
    })
    expect(await readFile(join(environment.root, 'src', 'Chat.jsx'), 'utf8')).toBe(after)
    expect(repository.pendingMutationRefreshes('durable-file-refresh')).toEqual([])
    const auditEvents = repository.getConversation('durable-file-refresh')?.auditEvents ?? []
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'mutation.refresh_required',
          metadata: {
            failureCode: 'HASH_CONFLICT',
            path: 'src/Chat.jsx',
            currentSha256: beforeHash,
          },
        }),
        expect.objectContaining({ type: 'mutation.refresh_restored' }),
        expect.objectContaining({
          type: 'mutation.refresh_completed',
          metadata: { path: 'src/Chat.jsx' },
        }),
      ]),
    )
    expect(mock.failures).toEqual([])
  })

  it('treats an exact PATH_NOT_FOUND read as a refreshed missing state after a mutation conflict', async () => {
    const original = 'export const state = "existing"\n'
    const staleCreate = JSON.stringify({
      summary: '기존 파일에 대한 충돌 유도',
      changes: [
        {
          path: 'src/Chat.jsx',
          baseSha256: null,
          newContent: 'stale replacement\n',
        },
      ],
    })
    const recreated = 'export const state = "recreated"\n'
    const recreate = JSON.stringify({
      summary: '삭제가 확인된 파일 재생성',
      changes: [
        {
          path: 'src/Chat.jsx',
          baseSha256: null,
          newContent: recreated,
        },
      ],
    })
    let conflictedFilePath = ''
    const mock = await startResponsesServer([
      () => functionCallEvents('propose_file_changes', staleCreate, 'missing-refresh-conflict'),
      async () => {
        expect(conflictedFilePath).not.toBe('')
        await rm(conflictedFilePath)
        return functionCallEvents('read_file', '{"path":"src/Chat.jsx"}', 'missing-refresh-read')
      },
      () => functionCallEvents('propose_file_changes', recreate, 'missing-refresh-recreate'),
      () =>
        textEvents(
          '삭제된 현재 상태를 확인하고 파일을 다시 생성했습니다.',
          'missing-refresh-final',
        ),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          callId: 'missing-refresh-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await mkdir(join(environment.root, 'src'))
    conflictedFilePath = join(environment.root, 'src', 'Chat.jsx')
    await writeFile(conflictedFilePath, original)
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const input = runInput('missing-file-refresh', '충돌 여부를 확인하고 Chat.jsx를 생성해줘')
    const result = await collectRun(agent, input, (event) => {
      if (event.type === 'approval-requested') {
        agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
      }
    })

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(functionOutputFor(mock.bodies[1], 'missing-refresh-conflict')).toMatchObject({
      ok: false,
      failure: {
        code: 'HASH_CONFLICT',
        path: 'src/Chat.jsx',
      },
    })
    expect(functionOutputFor(mock.bodies[2], 'missing-refresh-read')).toMatchObject({ ok: false })
    expect(functionOutputFor(mock.bodies[3], 'missing-refresh-recreate')).toMatchObject({
      ok: true,
    })
    expect(await readFile(conflictedFilePath, 'utf8')).toBe(recreated)
    expect(repository.pendingMutationRefreshes(input.conversationId)).toEqual([])
    expect(repository.getConversation(input.conversationId)?.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'mutation.refresh_completed',
          metadata: expect.objectContaining({
            path: 'src/Chat.jsx',
            observation: 'missing',
          }),
        }),
      ]),
    )
    expect(mock.failures).toEqual([])
  })

  it('recovers a final report without tools after a file change and repeated stream EOFs', async () => {
    const changeArguments = JSON.stringify({
      summary: '스트림 복구 파일 생성',
      changes: [
        {
          path: 'RECOVERED_AFTER_EOF.md',
          baseSha256: null,
          newContent: '# Applied once\n',
        },
      ],
    })
    const rawRecoveryDraft =
      'The recovery draft claims every test passed even though the host did not run any test.'
    const followUpText = '후속 요청은 오염되지 않은 대화 이력에서 처리했습니다.'
    let groundedRecoveryText = ''
    const mock = await startResponsesServer([
      () => functionCallEvents('propose_file_changes', changeArguments, 'eof-change'),
      () => [],
      () => incompleteJsonResponse('eof-fallback-1'),
      () => [],
      () => incompleteJsonResponse('eof-fallback-2'),
      () => [],
      () => incompleteJsonResponse('eof-fallback-3'),
      () => textEvents(rawRecoveryDraft, 'eof-recovered-final'),
      (body) => {
        const serializedInput = JSON.stringify(body.input)
        expect(serializedInput).not.toContain(rawRecoveryDraft)
        expect(serializedInput).not.toContain('"factIds"')
        expect(
          inputItems(body).some(
            (item) => item.role === 'assistant' && item.content === groundedRecoveryText,
          ),
        ).toBe(true)
        return textEvents(followUpText, 'eof-recovery-follow-up')
      },
      () => completionContractEvents('response', { callId: 'eof-recovery-follow-up-contract' }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      providerRetry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    })

    const result = await collectRun(
      agent,
      runInput('post-effect-recovery', '파일을 만들고 결과를 알려줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, 'RECOVERED_AFTER_EOF.md'), 'utf8')).toBe(
      '# Applied once\n',
    )
    expect(approvalRequests(result.events)).toHaveLength(1)
    expect(result.events.filter((event) => event.type === 'files-changed')).toHaveLength(1)
    expect(
      result.events.filter(
        (event) => event.type === 'tool-started' && event.callId === 'eof-change',
      ),
    ).toHaveLength(1)
    expect(mock.bodies).toHaveLength(8)
    expect(mock.bodies.slice(1, 7).map((body) => body.stream)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
    ])
    expect(mock.bodies[7]).toMatchObject({ stream: true, tool_choice: 'none' })
    expect(mock.bodies[7]).not.toHaveProperty('tools')
    groundedRecoveryText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(groundedRecoveryText).toContain('RECOVERED_AFTER_EOF.md')
    expect(groundedRecoveryText).not.toContain(rawRecoveryDraft)
    expect(JSON.stringify(repository.getConversation('post-effect-recovery'))).not.toContain(
      rawRecoveryDraft,
    )

    const followUp = await collectRun(
      agent,
      runInput('post-effect-recovery', '다음 요청을 독립적으로 답해줘'),
    )
    expect(followUp.events.at(-1)?.type).toBe('completed')
    expect(
      followUp.events
        .filter((event) => event.type === 'text-delta')
        .map((event) => event.delta)
        .join(''),
    ).toBe(followUpText)
    expect(
      mock.bodies.slice(8).every((body) => !JSON.stringify(body.input).includes(rawRecoveryDraft)),
    ).toBe(true)
    expect(mock.failures).toEqual([])
  })

  it('switches directly to a clean tools-free report when the final tool round is consumed', async () => {
    const changeArguments = JSON.stringify({
      summary: '마지막 도구 라운드 파일 생성',
      changes: [
        {
          path: 'FINAL_TOOL_ROUND.md',
          baseSha256: null,
          newContent: '# Applied on the final tool round\n',
        },
      ],
    })
    const finalText = '마지막 도구 라운드에서 확인된 파일 변경을 적용했습니다.'
    const secondTurnText = '두 번째 요청은 별도 응답으로 처리했습니다.'
    let groundedReportText = ''
    const mock = await startResponsesServer([
      () => functionCallEvents('propose_file_changes', changeArguments, 'final-round-change'),
      () => textEvents(finalText, 'final-round-clean-report'),
      (body) => {
        const serializedInput = JSON.stringify(body.input)
        expect(serializedInput).not.toContain(finalText)
        expect(serializedInput).not.toContain('"factIds"')
        expect(
          inputItems(body).some(
            (item) => item.role === 'assistant' && item.content === groundedReportText,
          ),
        ).toBe(true)
        return textEvents(secondTurnText, 'final-round-follow-up')
      },
      () => completionContractEvents('response', { callId: 'final-round-follow-up-contract' }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 1,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('final-tool-round-report', '파일을 만들고 결과를 알려줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, 'FINAL_TOOL_ROUND.md'), 'utf8')).toBe(
      '# Applied on the final tool round\n',
    )
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    groundedReportText = visibleText
    expect(visibleText).toContain('FINAL_TOOL_ROUND.md')
    expect(visibleText).toContain('파일 변경 적용')
    expect(visibleText).not.toContain(finalText)
    expect(mock.bodies).toHaveLength(2)
    expect(mock.bodies[1]).toMatchObject({ stream: true, tool_choice: 'none' })
    expect(mock.bodies[1]).not.toHaveProperty('tools')
    expect(JSON.stringify(mock.bodies[1].input)).not.toContain('function_call_output')
    expect(repository.getConversation('final-tool-round-report')?.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'provider.post_effect_recovery_started',
          metadata: expect.objectContaining({ trigger: 'tool-budget-exhausted' }),
        }),
        expect.objectContaining({ type: 'provider.post_effect_recovery_succeeded' }),
      ]),
    )
    const followUp = await collectRun(
      agent,
      runInput('final-tool-round-report', '이전 보고와 분리해서 현재 상태만 알려줘'),
    )
    expect(followUp.events.at(-1)?.type).toBe('completed')
    expect(
      followUp.events
        .filter((event) => event.type === 'text-delta')
        .map((event) => event.delta)
        .join(''),
    ).toBe(secondTurnText)
    expect(
      mock.bodies.slice(2).every((body) => !JSON.stringify(body.input).includes(finalText)),
    ).toBe(true)
    expect(mock.failures).toEqual([])
  })

  it('never exposes an unsupported clean-report implementation or compilation claim', async () => {
    const webSocketPath = 'backend/src/WebSocketConfig.java'
    const chatPath = 'backend/src/ChatController.java'
    const webSocketSource =
      'import org.springframework.web.socket.config.annotation.StompEndpoint;\nclass WebSocketConfig {}\n'
    const chatBefore = 'record ChatMessage(String sender, String content) {}\n'
    const chatAfter =
      'record ChatMessage(String sender, String content) {}\n// immutable record is reconstructed before dispatch\n'
    const unsupportedDraft =
      'Implemented @MessageMapping("/chat.sendMessage") and verified WebSocketConfig; no compilation errors are visible.'
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'read_file',
          JSON.stringify({ path: webSocketPath }),
          'grounded-live-read-websocket',
        ),
      () =>
        functionCallEvents(
          'read_file',
          JSON.stringify({ path: chatPath }),
          'grounded-live-read-chat',
        ),
      () =>
        functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: 'Reconstruct the immutable record instead of mutating it.',
            changes: [
              {
                path: chatPath,
                baseSha256: createHash('sha256').update(chatBefore).digest('hex'),
                newContent: chatAfter,
              },
            ],
          }),
          'grounded-live-chat-change',
        ),
      () =>
        functionCallEvents(
          'run_command',
          JSON.stringify({
            summary: 'Compile the backend',
            argv: ['./mvnw', 'test'],
            cwd: 'backend',
            timeoutMs: 5_000,
          }),
          'grounded-live-missing-maven',
        ),
      () => textEvents(unsupportedDraft, 'grounded-live-unsupported-draft'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await mkdir(join(environment.root, 'backend/src'), { recursive: true })
    await writeFile(join(environment.root, webSocketPath), webSocketSource)
    await writeFile(join(environment.root, chatPath), chatBefore)
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 4,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('grounded-live-regression', '백엔드를 수정하고 컴파일까지 검증해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(mock.failures).toEqual([])
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, chatPath), 'utf8')).toBe(chatAfter)
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toContain(chatPath)
    expect(visibleText).toContain('./mvnw')
    expect(visibleText).toContain(
      '파일 읽기는 구현 정확성, 컴파일 성공 또는 런타임 동작 검증을 의미하지 않습니다',
    )
    expect(visibleText).not.toContain('/chat.sendMessage')
    expect(visibleText).not.toContain('no compilation errors')
    const conversation = repository.getConversation('grounded-live-regression')
    expect(conversation?.runs.at(-1)?.outcomeSummary).toBe(visibleText)
    expect(conversation?.messages.at(-1)?.displayContent).toBe(visibleText)
    expect(JSON.stringify(conversation)).not.toContain(unsupportedDraft)
    expect(conversation?.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'run.final_report_selection_received',
          metadata: expect.objectContaining({ candidateLength: unsupportedDraft.length }),
        }),
        expect.objectContaining({
          type: 'run.final_report_grounded_fallback',
          metadata: expect.objectContaining({ reason: 'invalid-json' }),
        }),
      ]),
    )
    expect(
      JSON.stringify(
        conversation?.auditEvents.filter((event) => event.type.startsWith('run.final_report_')),
      ),
    ).not.toContain(unsupportedDraft)
  })

  it('renders canonical process receipts with bounded redacted success and failure evidence', async () => {
    const scenarios = ['success', 'failure', 'timeout', 'spawn'] as const
    const mock = await startResponsesServer([
      () =>
        functionCallsEvents(
          scenarios.map((scenario) => ({
            name: 'run_command',
            argumentsJson: JSON.stringify({
              summary: `Run ${scenario}`,
              argv: [`requested-${scenario}`, 'requested-only'],
              cwd: 'requested-cwd',
              timeoutMs: 5_000,
            }),
            callId: `process-${scenario}`,
          })),
        ),
      (body) => groundedReportSelectionEvents(body, 'process-receipts-report'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 1,
    })
    const canonicalCwd = join(environment.root, 'canonical-cwd')
    const secret = ['sk', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'].join('-')
    const execution = {
      preview: async (request: { argv: string[]; timeoutMs?: number }) => ({
        argv: [`/preview/${request.argv[0]}`],
        cwd: join(environment.root, 'preview-cwd'),
        timeoutMs: request.timeoutMs ?? 5_000,
        isolation: 'structured-process' as const,
        network: 'host' as const,
      }),
      run: async (request: { argv: string[] }) => {
        const scenario = request.argv[0]?.replace('/preview/requested-', '')
        const base = {
          argv: [`/canonical/${scenario}`, 'actual-only'],
          cwd: canonicalCwd,
          exitCode: scenario === 'success' ? 0 : scenario === 'failure' ? 7 : null,
          signal: null,
          stdout:
            scenario === 'success' ? `credential=${secret} ${'bounded-output '.repeat(100)}` : '',
          stderr: scenario === 'failure' ? 'canonical failure output' : '',
          totalOutputBytes: 2_000,
          outputTruncated: scenario === 'success',
          timedOut: scenario === 'timeout',
          cancelled: false,
          durationMs: 10,
          isolation: 'structured-process' as const,
          network: 'host' as const,
        }
        return scenario === 'spawn' ? { ...base, spawnError: 'canonical spawn failure' } : base
      },
    } as unknown as StructuredProcessRunner
    const agent = createAgent(environment, { execution })

    const result = await collectRun(
      agent,
      runInput('grounded-process-receipts', '서로 다른 명령 결과를 실행하고 보고해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toContain('/canonical/success')
    expect(visibleText).toContain('/canonical/failure')
    expect(visibleText).toContain('/canonical/timeout')
    expect(visibleText).toContain('/canonical/spawn')
    expect(visibleText).toContain('actual-only')
    expect(visibleText).toContain('[workspace]')
    expect(visibleText).not.toContain(environment.root)
    expect(visibleText).not.toContain(JSON.stringify(environment.root).slice(1, -1))
    expect(visibleText).toContain('명령 실행 성공(exit 0)')
    expect(visibleText).toContain('명령 실행 실패 (exit 7)')
    expect(visibleText).toContain('명령 실행 시간 초과')
    expect(visibleText).toContain('명령 실행 시작 실패')
    expect(visibleText).toContain('[REDACTED]')
    expect(visibleText).toContain('…')
    expect(visibleText).not.toContain(secret)
    expect(visibleText).not.toContain('requested-success')
    expect(visibleText).not.toContain('/preview/')
    expect(mock.failures).toEqual([])
  })

  it('distinguishes applied, denied, and failed file mutation receipts in the host report', async () => {
    const appliedPath = 'mutation-applied.txt'
    const deniedPath = 'mutation-denied.txt'
    const mutationCall = (
      summary: string,
      path: string,
      newContent: string,
      callId: string,
    ): unknown[] =>
      functionCallEvents(
        'propose_file_changes',
        JSON.stringify({
          summary,
          changes: [{ path, baseSha256: null, newContent }],
        }),
        callId,
      )
    const mock = await startResponsesServer([
      () => mutationCall('apply mutation', appliedPath, 'applied\n', 'mutation-applied'),
      () => mutationCall('deny mutation', deniedPath, 'denied\n', 'mutation-denied'),
      () => mutationCall('fail mutation', appliedPath, 'conflicting\n', 'mutation-failed'),
      (body) => groundedReportSelectionEvents(body, 'mutation-status-report'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 3,
    })
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('grounded-mutation-statuses', '파일 변경의 적용 여부를 각각 확인해줘'),
      (event) => {
        if (event.type !== 'approval-requested') return
        agent.resolveApproval(
          event.runId,
          event.request.approvalId,
          event.request.summary === 'deny mutation' ? 'denied' : 'approved',
        )
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, appliedPath), 'utf8')).toBe('applied\n')
    await expect(readFile(join(environment.root, deniedPath), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toContain(`호스트가 파일 변경 적용을 확인했습니다: "${appliedPath}"`)
    expect(visibleText).toContain(`파일 변경이 적용되지 않음: "${deniedPath}"`)
    expect(visibleText).toContain(`파일 변경이 실패: "${appliedPath}"`)
    expect(mock.failures).toEqual([])
  })

  it('fails closed when an applied mutation receipt omits requested paths', async () => {
    const paths = ['receipt-first.txt', 'receipt-second.txt']
    class PartialReceiptMutationService extends MutationService {
      override async apply(...args: Parameters<MutationService['apply']>) {
        const applied = await super.apply(...args)
        return { ...applied, changedPaths: applied.changedPaths.slice(0, 1) }
      }
    }
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: 'apply two files with a partial receipt',
            changes: paths.map((path, index) => ({
              path,
              baseSha256: null,
              newContent: `content-${String(index)}\n`,
            })),
          }),
          'partial-mutation-receipt',
        ),
      (body) => groundedReportSelectionEvents(body, 'partial-mutation-report'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 1,
    })
    const agent = createAgent(environment, {
      mutations: new PartialReceiptMutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('partial-mutation-receipt', '두 파일을 적용하고 정확한 범위만 보고해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, paths[0]), 'utf8')).toBe('content-0\n')
    expect(await readFile(join(environment.root, paths[1]), 'utf8')).toBe('content-1\n')
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toContain(
      '파일 변경 영수증을 안전하게 확인할 수 없어 적용 범위를 보고하지 않습니다',
    )
    expect(visibleText).toContain('host-receipt-path-mismatch')
    expect(visibleText).not.toContain(paths[0])
    expect(visibleText).not.toContain(paths[1])
    expect(mock.failures).toEqual([])
  })

  it('retains an applied effect after read failures fill the bounded evidence ledger', async () => {
    const effectPath = 'effect-after-read-fanout.txt'
    const readCalls = Array.from({ length: 200 }, (_, index) => ({
      name: 'read_file',
      argumentsJson: JSON.stringify({ path: `missing/read-${String(index)}.txt` }),
      callId: `bounded-read-${String(index)}`,
    }))
    const mock = await startResponsesServer([
      () => functionCallsEvents(readCalls),
      () =>
        functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: 'apply after bounded read fanout',
            changes: [{ path: effectPath, baseSha256: null, newContent: 'retained effect\n' }],
          }),
          'effect-after-read-fanout',
        ),
      (body) => groundedReportSelectionEvents(body, 'bounded-read-effect-report'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 2,
      maxTotalToolCalls: 201,
    })
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('bounded-read-effect-ledger', '많은 읽기 뒤 파일 변경을 적용해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, effectPath), 'utf8')).toBe('retained effect\n')
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toContain(`호스트가 파일 변경 적용을 확인했습니다: "${effectPath}" (생성).`)
    expect(mock.failures).toEqual([])
  })

  it('falls back to mandatory host facts when a report selects an unknown fact id', async () => {
    const path = 'unknown-selection-effect.txt'
    const unknownSelection = JSON.stringify({ factIds: ['fact_0_0000000000000000'] })
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: 'apply before an invalid report selection',
            changes: [{ path, baseSha256: null, newContent: 'host fact\n' }],
          }),
          'unknown-selection-effect',
        ),
      () => textEvents(unknownSelection, 'unknown-selection-report'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 1,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('unknown-grounded-selection', '파일을 적용하고 근거만 보고해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toContain(path)
    expect(visibleText).not.toContain(unknownSelection)
    expect(JSON.stringify(repository.getConversation('unknown-grounded-selection'))).not.toContain(
      unknownSelection,
    )
    expect(repository.getConversation('unknown-grounded-selection')?.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'run.final_report_grounded_fallback',
          metadata: expect.objectContaining({ reason: 'unknown-fact' }),
        }),
      ]),
    )
    expect(mock.failures).toEqual([])
  })

  it('recovers post-effect tool markup without exposing protocol text', async () => {
    const changeArguments = JSON.stringify({
      summary: '도구 문법 누출 복구 파일 생성',
      changes: [
        {
          path: 'RECOVERED_WITHOUT_MARKUP.md',
          baseSha256: null,
          newContent: '# Applied safely\n',
        },
      ],
    })
    const rawToolMarkup =
      '<tool_call><function=read_file><parameter=path>RECOVERED_WITHOUT_MARKUP.md</parameter></function></tool_call>'
    const finalText = '파일 변경은 적용됐고 최종 결과만 안전하게 보고합니다.'
    const mock = await startResponsesServer([
      () => functionCallEvents('propose_file_changes', changeArguments, 'markup-recovery-change'),
      () => [],
      () => incompleteJsonResponse('markup-fallback-1'),
      () => [],
      () => incompleteJsonResponse('markup-fallback-2'),
      () => [],
      () => incompleteJsonResponse('markup-fallback-3'),
      () => textEvents(rawToolMarkup, 'markup-recovery-protocol-text'),
      () => textEvents(finalText, 'markup-recovery-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      providerRetry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    })

    const result = await collectRun(
      agent,
      runInput('post-effect-markup-recovery', '파일을 만들고 결과를 알려줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, 'RECOVERED_WITHOUT_MARKUP.md'), 'utf8')).toBe(
      '# Applied safely\n',
    )
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toContain('RECOVERED_WITHOUT_MARKUP.md')
    expect(visibleText).not.toContain(finalText)
    expect(visibleText).not.toContain('<tool_call>')
    expect(mock.bodies).toHaveLength(9)
    expect(mock.bodies[7]).toMatchObject({ tool_choice: 'none' })
    expect(mock.bodies[8]).toMatchObject({ tool_choice: 'none' })
    expect(mock.bodies[7]).not.toHaveProperty('tools')
    expect(mock.bodies[8]).not.toHaveProperty('tools')
    expect(mock.failures).toEqual([])
  })

  it('uses one compact tools-free final report after repeated post-effect tool protocol text', async () => {
    const changeArguments = JSON.stringify({
      summary: '도구 프로토콜 복구 파일 생성',
      changes: [
        {
          path: 'COMPACT_PROTOCOL_RECOVERY.md',
          baseSha256: null,
          newContent: '# Applied before protocol recovery\n',
        },
      ],
    })
    const malformedToolTexts = [
      '<tool_call><function=read_file><parameter=path>"COMPACT_PROTOCOL_RECOVERY.md"',
      '[Calling tool=read_file({})',
    ]
    const finalText = '확인된 파일 변경을 적용했고 이번 실행 결과를 안전하게 보고합니다.'
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'propose_file_changes',
          changeArguments,
          'compact-protocol-recovery-change',
        ),
      () => textEvents(malformedToolTexts[0], 'compact-protocol-malformed-first'),
      () => textEvents(malformedToolTexts[1], 'compact-protocol-malformed-second'),
      () => textEvents(finalText, 'compact-protocol-recovered-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      providerRetry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    })

    const result = await collectRun(
      agent,
      runInput('compact-post-effect-protocol-recovery', '파일을 만들고 결과를 알려줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, 'COMPACT_PROTOCOL_RECOVERY.md'), 'utf8')).toBe(
      '# Applied before protocol recovery\n',
    )
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toContain('COMPACT_PROTOCOL_RECOVERY.md')
    expect(visibleText).not.toContain(finalText)
    for (const malformed of malformedToolTexts) expect(visibleText).not.toContain(malformed)
    expect(mock.bodies).toHaveLength(4)
    expect(mock.bodies[3]).toMatchObject({ stream: true, tool_choice: 'none' })
    expect(mock.bodies[3]).not.toHaveProperty('tools')
    expect(inputItems(mock.bodies[3]).length).toBeLessThan(inputItems(mock.bodies[1]).length)
    expect(
      repository.getConversation('compact-post-effect-protocol-recovery')?.auditEvents,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'provider.post_effect_recovery_succeeded' }),
      ]),
    )
    expect(mock.failures).toEqual([])
  })

  it('preserves applied changes as interrupted instead of reporting a false full failure', async () => {
    const changeArguments = JSON.stringify({
      summary: '부분 적용 파일 생성',
      changes: [
        {
          path: 'INTERRUPTED_AFTER_EFFECT.md',
          baseSha256: null,
          newContent: '# Still applied\n',
        },
      ],
    })
    const mock = await startResponsesServer([
      () => functionCallEvents('propose_file_changes', changeArguments, 'interrupted-change'),
      () => [],
      () => incompleteJsonResponse('interrupted-fallback-1'),
      () => [],
      () => incompleteJsonResponse('interrupted-fallback-2'),
      () => [],
      () => incompleteJsonResponse('interrupted-fallback-3'),
      () => [],
      () => incompleteJsonResponse('interrupted-final-fallback'),
      () => textEvents('중단된 작업 상태를 확인했습니다.', 'interrupted-followup'),
      () => completionContractEvents('response', { callId: 'interrupted-followup-contract' }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      providerRetry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    })

    const input = runInput('post-effect-interrupted', '파일을 만들고 결과를 알려줘')
    const result = await collectRun(agent, input, (event) => {
      if (event.type === 'approval-requested') {
        agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
      }
    })

    expect(result.events.at(-1)).toMatchObject({
      type: 'interrupted',
      message: expect.stringContaining('일부 작업은 적용'),
    })
    expect(result.events.some((event) => event.type === 'error')).toBe(false)
    expect(await readFile(join(environment.root, 'INTERRUPTED_AFTER_EFFECT.md'), 'utf8')).toBe(
      '# Still applied\n',
    )
    expect(result.events.filter((event) => event.type === 'files-changed')).toHaveLength(1)
    expect(
      result.events
        .filter((event) => event.type === 'text-delta')
        .map((event) => event.delta)
        .join(''),
    ).toContain('공급자 연결이 최종 답변 전에 종료')
    expect(repository.getConversation(input.conversationId)?.messages.at(-1)).toMatchObject({
      status: 'interrupted',
      displayContent: expect.stringContaining('확인된 작업 결과'),
    })
    expect(repository.modelHistory(input.conversationId).at(-1)).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('확인된 작업 결과'),
    })
    const followup = await collectRun(
      agent,
      runInput(input.conversationId, '중단된 작업 상태를 다시 확인해줘'),
    )
    expect(followup.events.at(-1)?.type).toBe('completed')
    expect(JSON.stringify(mock.bodies[9])).toContain('확인된 작업 결과')
    expect(mock.bodies).toHaveLength(11)
    expect(mock.failures).toEqual([])
  })

  it('recovers completion classification through a strict tools-disabled JSON fallback after an applied change', async () => {
    const changeArguments = JSON.stringify({
      summary: '완료 분류 복구 전 파일 생성',
      changes: [
        {
          path: 'APPLIED_BEFORE_CLASSIFIER_RECOVERY.md',
          baseSha256: null,
          newContent: '# Applied before classifier recovery\n',
        },
      ],
    })
    const finalText = '요청한 파일을 생성했습니다.'
    const recoveredContract = JSON.stringify({
      requirement: 'action',
      requiredEffects: ['workspace-change'],
      candidateDisposition: 'acceptable',
      rationale: 'The host observed the requested workspace change.',
    })
    const mock = await startResponsesServer([
      () =>
        functionCallEvents('propose_file_changes', changeArguments, 'classifier-recovery-change'),
      () => textEvents(finalText, 'classifier-recovery-candidate'),
      () => textEvents('구조화되지 않은 완료 분류 결과', 'malformed-completion-classifier'),
      () => textEvents(recoveredContract, 'completion-classifier-json-fallback'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const input = runInput('classifier-json-recovery', '파일을 만들고 완료 결과를 알려줘')
    const result = await collectRun(agent, input, (event) => {
      if (event.type === 'approval-requested') {
        agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
      }
    })

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(
      await readFile(join(environment.root, 'APPLIED_BEFORE_CLASSIFIER_RECOVERY.md'), 'utf8'),
    ).toBe('# Applied before classifier recovery\n')
    expect(
      result.events
        .filter((event) => event.type === 'text-delta')
        .map((event) => event.delta)
        .join(''),
    ).toBe(finalText)
    expect(mock.bodies).toHaveLength(4)
    expect(mock.bodies[2].tool_choice).toBe('required')
    expect((mock.bodies[2].tools as Array<{ name?: string }>).map((tool) => tool.name)).toEqual([
      'declare_run_completion',
    ])
    expect(mock.bodies[3].tool_choice).toBe('none')
    expect(mock.bodies[3].tools).toBeUndefined()
    expect(repository.getConversation(input.conversationId)?.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'run.completion_contract_recovered' }),
      ]),
    )
    expect(mock.failures).toEqual([])
  })

  it('retries one transient HTTP failure from the structured completion classifier', async () => {
    const finalText = '현재 상태를 설명했습니다.'
    const mock = await startResponsesServer([
      () => textEvents(finalText, 'classifier-primary-retry-candidate'),
      () => ({
        status: 503,
        json: {
          error: {
            message: 'temporary classifier outage',
            type: 'server_error',
            code: 'server_error',
          },
        },
      }),
      () =>
        completionContractEvents('response', {
          rationale: 'The current request is satisfied by the concrete textual response.',
          callId: 'classifier-primary-retry-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      providerRetry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    })

    const input = runInput('classifier-primary-transient-retry', '현재 상태를 설명해줘')
    const result = await collectRun(agent, input)

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(
      result.events
        .filter((event) => event.type === 'text-delta')
        .map((event) => event.delta)
        .join(''),
    ).toBe(finalText)
    expect(mock.bodies).toHaveLength(3)
    for (const body of mock.bodies.slice(1)) {
      expect(body.tool_choice).toBe('required')
      expect((body.tools as Array<{ name?: string }>).map((tool) => tool.name)).toEqual([
        'declare_run_completion',
      ])
    }
    expect(repository.getConversation(input.conversationId)?.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'run.completion_contract',
          metadata: expect.objectContaining({
            requirement: 'response',
            candidateDisposition: 'acceptable',
          }),
        }),
      ]),
    )
    expect(mock.failures).toEqual([])
  })

  it('does not permanently bypass completion classification after a transient classifier outage', async () => {
    const firstFinal = '일시 장애 뒤 직접 재평가한 답변입니다.'
    const secondFinal = '다음 요청도 정상적으로 분류했습니다.'
    const mock = await startResponsesServer([
      () => textEvents('첫 번째 응답 초안', 'transient-circuit-first-candidate'),
      () => ({
        status: 503,
        json: {
          error: {
            message: 'temporary classifier outage',
            type: 'server_error',
            code: 'server_error',
          },
        },
      }),
      () => textEvents(firstFinal, 'transient-circuit-first-final'),
      () => textEvents(secondFinal, 'transient-circuit-second-candidate'),
      () =>
        completionContractEvents('response', {
          rationale: 'The second request is fulfilled by its response.',
          callId: 'transient-circuit-second-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      providerRetry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    })

    const firstInput = runInput('transient-circuit-first', '첫 번째 상태를 설명해줘')
    const secondInput = runInput('transient-circuit-second', '두 번째 상태를 설명해줘')
    const first = await collectRun(agent, firstInput)
    const second = await collectRun(agent, secondInput)

    expect(first.events.at(-1)?.type).toBe('completed')
    expect(second.events.at(-1)?.type).toBe('completed')
    expect(
      first.events
        .filter((event) => event.type === 'text-delta')
        .map((event) => event.delta)
        .join(''),
    ).toBe(firstFinal)
    expect(
      second.events
        .filter((event) => event.type === 'text-delta')
        .map((event) => event.delta)
        .join(''),
    ).toBe(secondFinal)
    expect(mock.bodies).toHaveLength(5)
    expect(mock.bodies[1].tool_choice).toBe('required')
    expect(mock.bodies[2]).not.toHaveProperty('tool_choice')
    expect(mock.bodies[4].tool_choice).toBe('required')
    expect(repository.getConversation(firstInput.conversationId)?.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'run.completion_contract_degraded',
          metadata: expect.objectContaining({ openCircuit: false }),
        }),
        expect.objectContaining({ type: 'run.completion_contract_bypassed' }),
      ]),
    )
    const secondAudit = repository.getConversation(secondInput.conversationId)?.auditEvents
    expect(secondAudit).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'run.completion_contract' })]),
    )
    expect(secondAudit).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'run.completion_contract_circuit_open' }),
      ]),
    )
    expect(mock.failures).toEqual([])
  })

  it('retries a transient HTTP failure from the tools-disabled classifier JSON fallback', async () => {
    const finalText = '요청 범위에 대한 설명을 완료했습니다.'
    const recoveredContract = JSON.stringify({
      requirement: 'response',
      requiredEffects: [],
      candidateDisposition: 'acceptable',
      rationale: 'The candidate directly answers the current request.',
    })
    const mock = await startResponsesServer([
      () => textEvents(finalText, 'classifier-fallback-retry-candidate'),
      () => textEvents('구조화 도구 호출을 지원하지 않는 응답', 'classifier-fallback-trigger'),
      () => ({
        status: 503,
        json: {
          error: {
            message: 'temporary JSON fallback outage',
            type: 'server_error',
            code: 'server_error',
          },
        },
      }),
      () => textEvents(recoveredContract, 'classifier-fallback-retry-contract'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      providerRetry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    })

    const input = runInput('classifier-fallback-transient-retry', '요청 범위를 설명해줘')
    const result = await collectRun(agent, input)

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(mock.bodies).toHaveLength(4)
    expect(mock.bodies[1].tool_choice).toBe('required')
    for (const body of mock.bodies.slice(2)) {
      expect(body.tool_choice).toBe('none')
      expect(body.tools).toBeUndefined()
    }
    expect(repository.getConversation(input.conversationId)?.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'run.completion_contract_recovered',
          metadata: expect.objectContaining({
            strategy: 'json-fallback',
            trigger: 'tool-protocol',
          }),
        }),
      ]),
    )
    expect(mock.failures).toEqual([])
  })

  it('counts classifier usage and performs one direct final-response retry when classification degrades', async () => {
    const expectedUsage = {
      inputTokens: 36,
      outputTokens: 12,
      reasoningTokens: 4,
      totalTokens: 48,
    }
    const discardedCandidate = '분류가 필요한 답변입니다.'
    const malformedFallback = '유효한 JSON 계약이 아닙니다.'
    const finalText = '현재 확인된 상태를 구체적으로 설명했습니다.'
    const mock = await startResponsesServer([
      () =>
        textEvents(discardedCandidate, 'classifier-failure-usage-candidate', {
          input: 5,
          output: 2,
          reasoning: 1,
        }),
      () =>
        functionCallEvents(
          'declare_run_completion',
          JSON.stringify({
            requirement: 'response',
            requiredEffects: ['workspace-change'],
            candidateDisposition: 'acceptable',
            rationale: 'Invalid response contract with a forbidden required effect.',
          }),
          'classifier-failure-usage-invalid-primary',
          { input: 11, output: 3, reasoning: 2 },
        ),
      () =>
        textEvents(malformedFallback, 'classifier-failure-usage-invalid-fallback', {
          input: 13,
          output: 4,
          reasoning: 1,
        }),
      () =>
        textEvents(finalText, 'classifier-degraded-direct-response', {
          input: 7,
          output: 3,
          reasoning: 0,
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const input = runInput('classifier-failure-usage-accounting', '현재 상태를 설명해줘')
    const result = await collectRun(agent, input)

    expect(result.events.at(-1)?.type).toBe('completed')
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toBe(finalText)
    expect(visibleText).not.toContain(discardedCandidate)
    expect(visibleText).not.toContain(malformedFallback)
    expect(
      result.events
        .filter((event) => event.type === 'usage')
        .map((event) => event.usage)
        .at(-1),
    ).toEqual(expectedUsage)
    expect(repository.getConversation(input.conversationId)?.runs).toEqual([
      expect.objectContaining({
        id: result.runId,
        status: 'completed',
        usage: expectedUsage,
      }),
    ])
    const conversation = repository.getConversation(input.conversationId)
    expect(conversation?.messages.at(-1)).toMatchObject({
      status: 'completed',
      displayContent: finalText,
    })
    expect(conversation?.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'run.completion_contract_degraded',
          metadata: expect.objectContaining({
            failureKind: 'invalid-contract',
            failureCode: 'agent.completion_contract_invalid',
            candidateAvailable: true,
            observedEffects: [],
          }),
        }),
        expect.objectContaining({ type: 'run.completion_contract_bypassed' }),
      ]),
    )
    expect(conversation?.auditEvents).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'run.completion_contract' })]),
    )
    expect(mock.bodies).toHaveLength(4)
    expect(mock.bodies[1].tool_choice).toBe('required')
    expect(mock.bodies[2].tool_choice).toBe('none')
    expect(mock.bodies[2].tools).toBeUndefined()
    expect(mock.bodies[3]).not.toHaveProperty('tool_choice')
    expect((mock.bodies[3].tools as Array<{ name?: string }>).map((tool) => tool.name)).toContain(
      'propose_file_changes',
    )
    expect(mock.bodies[3].instructions).toContain(
      'The auxiliary completion classifier is unavailable.',
    )
    expect(mock.failures).toEqual([])
  })

  it('allows exactly one direct action-or-response retry to choose a tool action after classification degrades', async () => {
    const expectedUsage = {
      inputTokens: 36,
      outputTokens: 14,
      reasoningTokens: 7,
      totalTokens: 50,
    }
    const discardedCandidate = '이제 파일을 만들겠습니다.'
    const incompleteClassifierOutput = '완료 판정이 토큰 제한으로 잘렸습니다.'
    const finalText = '요청한 파일을 생성했습니다.'
    const changeArguments = JSON.stringify({
      summary: '완료 판정 우회 뒤 파일 생성',
      changes: [
        {
          path: 'ACTION_AFTER_CLASSIFIER_DEGRADED.md',
          baseSha256: null,
          newContent: '# Action after degraded classifier\n',
        },
      ],
    })
    const mock = await startResponsesServer([
      () =>
        textEvents(discardedCandidate, 'classifier-degraded-action-candidate', {
          input: 5,
          output: 2,
          reasoning: 1,
        }),
      () =>
        incompleteSseEvents(
          incompleteClassifierOutput,
          'classifier-degraded-action-primary',
          'max_output_tokens',
          { input: 11, output: 4, reasoning: 3 },
        ),
      () =>
        functionCallEvents(
          'propose_file_changes',
          changeArguments,
          'classifier-degraded-direct-action',
          { input: 7, output: 3, reasoning: 1 },
        ),
      () =>
        textEvents(finalText, 'classifier-degraded-action-final', {
          input: 13,
          output: 5,
          reasoning: 2,
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const input = runInput(
      'classifier-degraded-direct-action',
      '워크스페이스에 파일을 실제로 만들어줘',
    )
    const result = await collectRun(agent, input, (event) => {
      if (event.type === 'approval-requested') {
        agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
      }
    })

    expect(result.events.at(-1)?.type).toBe('completed')
    await expect(
      readFile(join(environment.root, 'ACTION_AFTER_CLASSIFIER_DEGRADED.md'), 'utf8'),
    ).resolves.toBe('# Action after degraded classifier\n')
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toBe(finalText)
    expect(visibleText).not.toContain(discardedCandidate)
    expect(visibleText).not.toContain(incompleteClassifierOutput)
    expect(
      result.events
        .filter((event) => event.type === 'usage')
        .map((event) => event.usage)
        .at(-1),
    ).toEqual(expectedUsage)
    expect(approvalRequests(result.events)).toHaveLength(1)
    expect(result.events.filter((event) => event.type === 'files-changed')).toHaveLength(1)
    expect(
      result.events.filter(
        (event) =>
          event.type === 'tool-started' && event.callId === 'classifier-degraded-direct-action',
      ),
    ).toHaveLength(1)
    const auditEvents = repository.getConversation(input.conversationId)?.auditEvents
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'run.completion_contract_degraded',
          metadata: expect.objectContaining({
            failureKind: 'provider',
            failureCode: 'stream-incomplete',
          }),
        }),
        expect.objectContaining({ type: 'run.completion_contract_bypassed' }),
      ]),
    )
    expect(
      auditEvents?.filter((event) => event.type === 'run.completion_contract_bypassed'),
    ).toHaveLength(1)
    expect(repository.getConversation(input.conversationId)?.runs).toEqual([
      expect.objectContaining({ status: 'completed', usage: expectedUsage }),
    ])
    expect(mock.bodies).toHaveLength(4)
    expect(mock.bodies[1].tool_choice).toBe('required')
    expect(mock.bodies.some((body) => body.tool_choice === 'none')).toBe(false)
    expect(mock.bodies[2]).not.toHaveProperty('tool_choice')
    expect((mock.bodies[2].tools as Array<{ name?: string }>).map((tool) => tool.name)).toContain(
      'propose_file_changes',
    )
    expect(mock.bodies[3]).not.toHaveProperty('tool_choice')
    expect(mock.failures).toEqual([])
  })

  it('completes an applied-effect candidate without repeating the mutation when classification degrades', async () => {
    const changeArguments = JSON.stringify({
      summary: '완료 분류 실패 전 파일 생성',
      changes: [
        {
          path: 'APPLIED_BEFORE_CLASSIFIER_FAILURE.md',
          baseSha256: null,
          newContent: '# Applied before classifier failure\n',
        },
      ],
    })
    const finalText = '요청한 파일을 생성했습니다.'
    const malformedPrimary = '구조화되지 않은 완료 분류 결과'
    const malformedFallback = '이 결과도 유효한 JSON 계약이 아닙니다.'
    const mock = await startResponsesServer([
      () =>
        functionCallEvents('propose_file_changes', changeArguments, 'classifier-failure-change'),
      () => textEvents(finalText, 'classifier-failure-candidate'),
      () => textEvents(malformedPrimary, 'malformed-completion-classifier'),
      () => textEvents(malformedFallback, 'invalid-classifier-json-fallback'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const input = runInput('classifier-failure-after-effect', '파일을 만들고 완료 결과를 알려줘')
    const result = await collectRun(agent, input, (event) => {
      if (event.type === 'approval-requested') {
        agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
      }
    })

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(result.events.some((event) => event.type === 'error')).toBe(false)
    expect(result.events.some((event) => event.type === 'interrupted')).toBe(false)
    expect(
      await readFile(join(environment.root, 'APPLIED_BEFORE_CLASSIFIER_FAILURE.md'), 'utf8'),
    ).toBe('# Applied before classifier failure\n')
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toBe(finalText)
    expect(visibleText).not.toContain(malformedPrimary)
    expect(visibleText).not.toContain(malformedFallback)
    expect(approvalRequests(result.events)).toHaveLength(1)
    expect(result.events.filter((event) => event.type === 'files-changed')).toHaveLength(1)
    expect(
      result.events.filter(
        (event) => event.type === 'tool-started' && event.callId === 'classifier-failure-change',
      ),
    ).toHaveLength(1)

    const conversation = repository.getConversation(input.conversationId)
    expect(conversation?.messages.at(-1)).toMatchObject({
      status: 'completed',
      displayContent: finalText,
    })
    expect(conversation?.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'run.completion_contract_degraded',
          metadata: expect.objectContaining({
            failureKind: 'invalid-contract',
            candidateAvailable: true,
            observedEffects: ['workspace-change'],
          }),
        }),
      ]),
    )
    expect(conversation?.auditEvents).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'run.applied_effect_interrupted' })]),
    )
    expect(repository.modelHistory(input.conversationId).at(-1)).toEqual({
      role: 'assistant',
      content: finalText,
    })
    expect(mock.bodies).toHaveLength(4)
    expect(mock.bodies[1]).not.toHaveProperty('tool_choice')
    expect(mock.bodies[2].tool_choice).toBe('required')
    expect(mock.bodies[3].tool_choice).toBe('none')
    expect(mock.bodies[3].tools).toBeUndefined()
    expect(mock.failures).toEqual([])
  })

  it('retains a known action contract and accepts only the observed blocker when its later classifier is unavailable', async () => {
    const discardedDraft = '곧 파일을 생성하겠습니다.'
    const unsupportedCompletionClaim = '요청한 파일 생성을 완료했습니다.'
    const blockerText = '파일 변경 승인이 거절되어 요청을 적용하지 못했습니다.'
    const malformedPrimary = '구조화되지 않은 후속 완료 판정'
    const malformedFallback = '후속 완료 판정도 JSON이 아닙니다.'
    const changeArguments = JSON.stringify({
      summary: '거절되는 파일 변경',
      changes: [
        {
          path: 'DENIED_BEFORE_CLASSIFIER_DEGRADED.md',
          baseSha256: null,
          newContent: '# Must not be applied\n',
        },
      ],
    })
    const mock = await startResponsesServer([
      () => textEvents(discardedDraft, 'known-action-contract-draft'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          candidateDisposition: 'retry',
          rationale: 'The user requires an observable workspace change.',
          callId: 'known-action-contract',
        }),
      () =>
        functionCallEvents('propose_file_changes', changeArguments, 'known-action-denied-change'),
      () => textEvents(unsupportedCompletionClaim, 'known-action-unsupported-completion'),
      () => textEvents(malformedPrimary, 'known-action-malformed-primary'),
      () => textEvents(malformedFallback, 'known-action-malformed-fallback'),
      () => textEvents(blockerText, 'known-action-blocker'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const input = runInput(
      'known-action-contract-classifier-degraded',
      '워크스페이스에 파일을 실제로 만들어줘',
    )
    const result = await collectRun(agent, input, (event) => {
      if (event.type === 'approval-requested') {
        agent.resolveApproval(event.runId, event.request.approvalId, 'denied')
      }
    })

    expect(result.events.at(-1)?.type).toBe('completed')
    await expect(
      readFile(join(environment.root, 'DENIED_BEFORE_CLASSIFIER_DEGRADED.md'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        callId: 'known-action-denied-change',
        ok: true,
      }),
    )
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'approval-resolved', decision: 'denied' }),
    )
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toBe(blockerText)
    expect(visibleText).not.toContain(discardedDraft)
    expect(visibleText).not.toContain(unsupportedCompletionClaim)
    expect(visibleText).not.toContain(malformedPrimary)
    expect(visibleText).not.toContain(malformedFallback)

    const auditEvents = repository.getConversation(input.conversationId)?.auditEvents
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'run.completion_contract',
          metadata: expect.objectContaining({
            requirement: 'action',
            requiredEffects: ['workspace-change'],
            candidateDisposition: 'retry',
          }),
        }),
        expect.objectContaining({
          type: 'run.completion_contract_degraded',
          metadata: expect.objectContaining({
            failureKind: 'invalid-contract',
            candidateAvailable: true,
            observedEffects: [],
          }),
        }),
      ]),
    )
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'run.completion_contract_bypassed' }),
      ]),
    )
    expect(mock.bodies).toHaveLength(7)
    expect(mock.bodies[1].tool_choice).toBe('required')
    expect(mock.bodies[2].tool_choice).toBe('required')
    expect(mock.bodies[3]).not.toHaveProperty('tool_choice')
    expect(mock.bodies[3].instructions).toContain(
      'An action was attempted but did not apply or failed.',
    )
    expect(mock.bodies[4].tool_choice).toBe('required')
    expect(mock.bodies[5].tool_choice).toBe('none')
    expect(mock.bodies[5].tools).toBeUndefined()
    expect(mock.bodies[6]).not.toHaveProperty('tool_choice')
    expect(mock.bodies[6].instructions).toContain('the required action did not apply')
    expect(mock.failures).toEqual([])
  })

  it('executes five same-turn file reads without treating normal batching as an error', async () => {
    const paths = ['package.json', 'src/main.tsx', 'src/App.tsx', 'src/index.css', 'vite.config.ts']
    const mock = await startResponsesServer([
      () =>
        functionCallsEvents(
          paths.map((path, index) => ({
            name: 'read_file',
            argumentsJson: JSON.stringify({ path }),
            callId: `five-read-${index.toString()}`,
          })),
        ),
      () => textEvents('요청한 다섯 파일을 모두 확인했습니다.', 'five-read-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    for (const path of paths) {
      await mkdir(join(environment.root, path, '..'), { recursive: true })
      await writeFile(join(environment.root, path), `${path}\n`)
    }
    const agent = createAgent(environment)

    const result = await collectRun(agent, {
      ...runInput('five-read-batch', '프로젝트의 주요 파일을 모두 확인해줘'),
      intent: 'answer',
    })

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(
      result.events.filter((event) => event.type === 'tool-completed').map((event) => event.callId),
    ).toEqual(paths.map((_, index) => `five-read-${index.toString()}`))
    const outputs = inputItems(mock.bodies[1]).filter(
      (item) => item.type === 'function_call_output',
    )
    expect(outputs).toHaveLength(paths.length)
    for (const path of paths) expect(JSON.stringify(outputs)).toContain(path)
    expect(mock.failures).toEqual([])
  })

  it('rejects an over-budget tool batch before executing any prefix', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallsEvents(
          Array.from({ length: 5 }, (_, index) => ({
            name: 'list_files',
            argumentsJson: '{"path":null}',
            callId: `over-budget-${index.toString()}`,
          })),
        ),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true, locale: 'en' })
    const current = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: current.activeProviderId,
      activeModelId: current.activeModelId,
      theme: current.theme,
      maxToolIterations: current.maxToolIterations,
      maxTotalToolCalls: 4,
    })
    const agent = createAgent(environment)

    const result = await collectRun(agent, {
      ...runInput('over-budget-batch', '파일을 확인해줘'),
      intent: 'answer',
    })

    expect(result.events.at(-1)).toMatchObject({
      type: 'error',
      message:
        'The provider requested 5 tool calls, exceeding the 4 calls remaining in this run. No calls were executed.',
    })
    expect(result.events.some((event) => event.type === 'tool-started')).toBe(false)
    expect(mock.failures).toEqual([])
  })

  it('stops immediately when completion classification requires a missing effect after tool budget exhaustion', async () => {
    const mock = await startResponsesServer([
      () => functionCallEvents('read_file', '{"path":"evidence.txt"}', 'exhaust-budget-read'),
      () => textEvents('이제 파일을 수정하겠습니다.', 'exhaust-budget-candidate'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          candidateDisposition: 'retry',
          rationale: 'The requested workspace change has not been applied.',
          callId: 'exhaust-budget-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'evidence.txt'), 'verified\n')
    const current = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: current.activeProviderId,
      activeModelId: current.activeModelId,
      theme: current.theme,
      maxToolIterations: current.maxToolIterations,
      maxTotalToolCalls: 1,
    })
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('completion-after-exhausted-budget', 'evidence.txt를 읽고 실제로 수정해줘'),
    )

    expect(result.events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('도구 실행 예산이 소진'),
    })
    expect(mock.bodies).toHaveLength(3)
    expect(mock.bodies[1].tool_choice).toBe('none')
    expect(mock.bodies[1].tools).toBeUndefined()
    expect(mock.bodies[2].tool_choice).toBe('required')
    expect(mock.failures).toEqual([])
  })

  it('fails closed for an untrusted workspace while including explicitly selected context', async () => {
    const mock = await startResponsesServer([
      () => functionCallEvents('read_file', '{"path":"private.txt"}', 'untrusted-read'),
      () => textEvents('선택한 컨텍스트만 사용했습니다.', 'untrusted-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: false })
    await writeFile(join(environment.root, 'selected.txt'), 'EXPLICIT_CONTEXT_MARKER\n')
    await writeFile(join(environment.root, 'private.txt'), 'PRIVATE_TOOL_MARKER\n')
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('untrusted-conversation', '선택한 파일만 확인해줘', ['selected.txt']),
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(mock.failures).toEqual([])
    expect(mock.bodies).toHaveLength(2)
    expect(mock.bodies[0]).not.toHaveProperty('tools')
    expect(mock.bodies[0].instructions).toContain('The workspace is not trusted.')
    expect(JSON.stringify(inputItems(mock.bodies[0]))).toContain('EXPLICIT_CONTEXT_MARKER')
    const rejectedOutput = functionOutput(mock.bodies[1])
    expect(rejectedOutput.ok).toBe(false)
    expect(rejectedOutput.error).toContain('read_file')
    expect(JSON.stringify(rejectedOutput)).not.toContain('PRIVATE_TOOL_MARKER')
  })

  it('derives mutating tool availability from intent instead of the request source', async () => {
    const mock = await startResponsesServer([
      () => textEvents('계획 완료', 'intent-plan'),
      () => textEvents('설명 완료', 'intent-answer'),
      () => textEvents('실행 준비 완료', 'intent-act'),
      () =>
        functionCallEvents(
          'declare_run_completion',
          JSON.stringify({
            requirement: 'response',
            requiredEffects: [],
            candidateDisposition: 'acceptable',
            rationale: '이 테스트 요청은 도구 가용성 확인만 필요합니다.',
          }),
          'intent-contract',
        ),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    })

    for (const intent of ['plan', 'answer', 'act'] as const) {
      await collectRun(agent, { ...runInput(`intent-${intent}`, `${intent} 요청`), intent })
    }

    const toolNames = (body: ResponseBody): string[] =>
      ((body.tools as Array<{ name?: unknown }> | undefined) ?? [])
        .map((tool) => tool.name)
        .filter((name): name is string => typeof name === 'string')
    for (const body of mock.bodies.slice(0, 2)) {
      expect(toolNames(body)).toContain('read_file')
      expect(toolNames(body)).not.toContain('propose_file_changes')
      expect(toolNames(body)).not.toContain('run_command')
    }
    expect(toolNames(mock.bodies[2])).toEqual(
      expect.arrayContaining(['read_file', 'propose_file_changes', 'run_command']),
    )
    expect(mock.bodies[2].instructions).toContain(
      'File mutation requires every parent directory to exist already.',
    )
    const actionTools = mock.bodies[2].tools as Array<{
      name?: string
      parameters?: Record<string, unknown>
    }>
    const proposeTool = actionTools.find((tool) => tool.name === 'propose_file_changes')
    expect(proposeTool?.parameters).toMatchObject({
      properties: {
        summary: { maxLength: 1_000 },
        changes: {
          maxItems: 50,
          items: {
            properties: {
              path: { maxLength: 4_096 },
              newContent: { anyOf: [{ type: 'string', maxLength: 1_000_000 }, { type: 'null' }] },
            },
          },
        },
      },
    })
    expect(mock.bodies[3].tool_choice).toBe('required')
    expect(toolNames(mock.bodies[3])).toEqual(['declare_run_completion'])
  })

  it('discards a promise-only draft and requires an observable action before completion', async () => {
    const discardedDraft = '곧 구현하겠습니다. 다시 진행해도 될까요?'
    const finalText = '요청한 파일을 생성했습니다.'
    const mock = await startResponsesServer([
      () => textEvents(discardedDraft, 'promise-only-draft'),
      () =>
        functionCallEvents(
          'declare_run_completion',
          JSON.stringify({
            requirement: 'action',
            requiredEffects: ['workspace-change'],
            candidateDisposition: 'retry',
            rationale:
              '사용자가 앞서 설계한 기능을 현재 워크스페이스에 구현해 달라고 요청했습니다.',
          }),
          'completion-contract-action',
        ),
      () =>
        functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: '실행 계약 회귀 테스트 파일 생성',
            changes: [
              {
                path: 'IMPLEMENTED.md',
                baseSha256: null,
                newContent: '# Implemented\n',
              },
            ],
          }),
          'apply-required-action',
        ),
      () => textEvents(finalText, 'action-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('promise-recovery', '앞에서 정한 내용대로 실제 구현을 진행해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, 'IMPLEMENTED.md'), 'utf8')).toBe('# Implemented\n')
    const visibleText = result.events
      .filter(
        (event): event is Extract<AgentEvent, { type: 'text-delta' }> =>
          event.type === 'text-delta',
      )
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toBe(finalText)
    expect(visibleText).not.toContain(discardedDraft)
    expect(mock.bodies).toHaveLength(4)
    expect(mock.bodies[1].tool_choice).toBe('required')
    expect(mock.bodies[2].tool_choice).toBe('required')
    expect(JSON.stringify(inputItems(mock.bodies[2]))).not.toContain(discardedDraft)
    expect(mock.bodies[3]).not.toHaveProperty('tool_choice')
    expect(mock.failures).toEqual([])

    const stored = repository.getConversation('promise-recovery')
    const assistant = stored?.messages.find((message) => message.role === 'assistant')
    expect(assistant?.displayContent).toBe(finalText)
    expect(assistant?.displayContent).not.toContain(discardedDraft)
  })

  it('revalidates every replacement draft until a response candidate is acceptable', async () => {
    const repeatedDraft = '확인한 뒤 나중에 결과를 알려드리겠습니다.'
    const finalText = '현재 증거만으로는 원인을 확정할 수 없어 추가 로그가 필요합니다.'
    const mock = await startResponsesServer([
      () => textEvents(repeatedDraft, 'response-retry-first'),
      () =>
        completionContractEvents('response', {
          candidateDisposition: 'retry',
          rationale: 'The draft promises a future answer instead of reporting the current result.',
          callId: 'response-retry-first-contract',
        }),
      () => textEvents(repeatedDraft, 'response-retry-second'),
      () =>
        completionContractEvents('response', {
          candidateDisposition: 'retry',
          rationale: 'The replacement repeats the same unsupported future promise.',
          callId: 'response-retry-second-contract',
        }),
      () => textEvents(finalText, 'response-retry-final'),
      () =>
        completionContractEvents('response', {
          candidateDisposition: 'acceptable',
          rationale: 'The candidate truthfully states the evidence boundary and concrete blocker.',
          callId: 'response-retry-final-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('response-candidate-revalidation', '현재 증거를 바탕으로 원인을 진단해줘'),
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    const visibleText = result.events
      .filter(
        (event): event is Extract<AgentEvent, { type: 'text-delta' }> =>
          event.type === 'text-delta',
      )
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toBe(finalText)
    expect(visibleText).not.toContain(repeatedDraft)
    expect(mock.bodies).toHaveLength(6)
    expect(mock.bodies[1].tool_choice).toBe('required')
    expect(mock.bodies[3].tool_choice).toBe('required')
    expect(mock.bodies[5].tool_choice).toBe('required')
    expect(mock.failures).toEqual([])
  })

  it('preflights every parallel call before allowing any batch side effect', async () => {
    const changeArguments = JSON.stringify({
      summary: 'batch preflight 회귀 파일 생성',
      changes: [
        {
          path: 'BATCH_PREFLIGHT.md',
          baseSha256: null,
          newContent: '# Applied after valid retry\n',
        },
      ],
    })
    const mock = await startResponsesServer([
      () =>
        functionCallsEvents([
          {
            name: 'propose_file_changes',
            argumentsJson: changeArguments,
            callId: 'batch-valid-change',
          },
          {
            name: 'run_command',
            argumentsJson: JSON.stringify({
              summary: 'invalid parallel command',
              argv: 'not-an-array',
              cwd: null,
              timeoutMs: null,
            }),
            callId: 'batch-invalid-command',
          },
        ]),
      () => functionCallEvents('propose_file_changes', changeArguments, 'batch-corrected-change'),
      () => textEvents('검증된 단일 변경 호출로 파일을 생성했습니다.', 'batch-preflight-final'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          candidateDisposition: 'acceptable',
          rationale: 'The corrected standalone change was applied before the final answer.',
          callId: 'batch-preflight-final-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('batch-preflight', '파일을 만들고 검증 명령을 함께 실행해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, 'BATCH_PREFLIGHT.md'), 'utf8')).toBe(
      '# Applied after valid retry\n',
    )
    expect(result.events.filter((event) => event.type === 'approval-requested')).toHaveLength(1)
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        callId: 'batch-valid-change',
        ok: false,
      }),
    )
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        callId: 'batch-invalid-command',
        ok: false,
      }),
    )
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        callId: 'batch-corrected-change',
        ok: true,
      }),
    )
    const rejectedBatchInput = JSON.stringify(inputItems(mock.bodies[1]))
    expect(rejectedBatchInput).toContain('다른 도구 호출이 입력 검증에 실패')
    expect(rejectedBatchInput).toContain('배열 형식이어야 합니다')
    expect(rejectedBatchInput).not.toContain('expected array')
    expect(mock.failures).toEqual([])
  })

  it('does not let a same-batch duplicate side effect poison the corrected identical single call', async () => {
    const changeArguments = JSON.stringify({
      summary: '중복 호출 정정 뒤 파일 생성',
      changes: [
        {
          path: 'DUPLICATE_RETRY.md',
          baseSha256: null,
          newContent: '# Applied once after duplicate correction\n',
        },
      ],
    })
    const mock = await startResponsesServer([
      () =>
        functionCallsEvents([
          {
            name: 'propose_file_changes',
            argumentsJson: changeArguments,
            callId: 'same-batch-duplicate-first',
          },
          {
            name: 'propose_file_changes',
            argumentsJson: changeArguments,
            callId: 'same-batch-duplicate-second',
          },
        ]),
      () =>
        functionCallEvents('propose_file_changes', changeArguments, 'same-batch-corrected-single'),
      () => textEvents('정정된 단일 변경 호출로 파일을 생성했습니다.', 'duplicate-retry-final'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          callId: 'duplicate-retry-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('same-batch-duplicate-retry', '파일을 한 번만 생성해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        callId: 'same-batch-duplicate-first',
        ok: false,
      }),
    )
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        callId: 'same-batch-duplicate-second',
        ok: false,
      }),
    )
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        callId: 'same-batch-corrected-single',
        ok: true,
      }),
    )
    expect(approvalRequests(result.events)).toHaveLength(1)
    expect(result.events.filter((event) => event.type === 'files-changed')).toHaveLength(1)
    expect(await readFile(join(environment.root, 'DUPLICATE_RETRY.md'), 'utf8')).toBe(
      '# Applied once after duplicate correction\n',
    )
    expect(mock.failures).toEqual([])
  })

  it('applies a small exact patch through the existing approval and journal boundary', async () => {
    const nameExpression = ['$', '{name}'].join('')
    const oldGreeting = `\`Hello ${nameExpression}\``
    const newGreeting = `\`Welcome, ${nameExpression}!\``
    const before = [
      'export function greet(name: string) {',
      `  return ${oldGreeting}`,
      '}',
      '',
    ].join('\n')
    const after = before.replace(oldGreeting, newGreeting)
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'propose_file_patches',
          JSON.stringify({
            summary: 'Update the greeting with an exact patch',
            patches: [
              {
                path: 'greet.ts',
                baseSha256: createHash('sha256').update(before).digest('hex'),
                hunks: [{ oldText: oldGreeting, newText: newGreeting }],
              },
            ],
          }),
          'exact-patch-call',
        ),
      () => textEvents('기존 파일에 작은 patch를 적용했습니다.', 'exact-patch-final'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          candidateDisposition: 'acceptable',
          rationale: 'The approved patch was applied before the final answer.',
          callId: 'exact-patch-final-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'greet.ts'), before)
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    })
    const approvals: ApprovalRequest[] = []

    const result = await collectRun(
      agent,
      runInput('exact-patch', '기존 인사말 구현을 작은 patch로 수정해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          approvals.push(event.request)
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    await expect(readFile(join(environment.root, 'greet.ts'), 'utf8')).resolves.toBe(after)
    expect(approvals).toEqual([
      expect.objectContaining({
        kind: 'file-change',
        changes: [expect.objectContaining({ path: 'greet.ts', kind: 'update' })],
      }),
    ])
    expect(mock.bodies[0].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'propose_file_patches' }),
        expect.objectContaining({ name: 'propose_file_changes' }),
      ]),
    )
    expect(mock.failures).toEqual([])
  })

  it('resolves a terse confirmation from prior conversation and continues the promised action', async () => {
    const priorProposal = '구현할 파일 구조를 정리했습니다. 이 설계대로 실제 구현을 진행할까요?'
    const repeatedDraft = '네, 구현을 진행하겠습니다.'
    const mock = await startResponsesServer([
      () => textEvents(priorProposal, 'terse-prior-proposal'),
      () => textEvents(repeatedDraft, 'terse-repeated-draft'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          candidateDisposition: 'retry',
          rationale: 'The short confirmation authorizes the implementation proposed earlier.',
          callId: 'terse-confirmation-contract',
        }),
      () =>
        functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: '짧은 확인 뒤 실제 구현',
            changes: [
              {
                path: 'CONFIRMED.md',
                baseSha256: null,
                newContent: '# Confirmed implementation\n',
              },
            ],
          }),
          'terse-confirmed-change',
        ),
      () => textEvents('앞서 합의한 파일을 구현했습니다.', 'terse-confirmed-final'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          candidateDisposition: 'acceptable',
          rationale: 'The required file change was observed and the final answer reports it.',
          callId: 'terse-final-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    })

    const first = await collectRun(agent, {
      ...runInput('terse-confirmation', '로컬 AI 웹 구현 구조를 설계해줘'),
      intent: 'plan',
    })
    expect(first.events.at(-1)?.type).toBe('completed')

    const second = await collectRun(agent, runInput('terse-confirmation', '네'), (event) => {
      if (event.type === 'approval-requested') {
        agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
      }
    })

    expect(second.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, 'CONFIRMED.md'), 'utf8')).toBe(
      '# Confirmed implementation\n',
    )
    const visibleText = second.events
      .filter(
        (event): event is Extract<AgentEvent, { type: 'text-delta' }> =>
          event.type === 'text-delta',
      )
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toBe('앞서 합의한 파일을 구현했습니다.')
    expect(visibleText).not.toContain(repeatedDraft)
    expect(mock.bodies[2].tool_choice).toBe('required')
    const classifierInput = JSON.stringify(inputItems(mock.bodies[2]))
    expect(classifierInput).toContain(priorProposal)
    expect(classifierInput).toContain('네')
    expect(classifierInput).not.toContain(repeatedDraft)
    expect(mock.bodies[3].tool_choice).toBe('required')
    expect(mock.failures).toEqual([])
  })

  it('does not let an unrelated process effect satisfy a workspace-change contract', async () => {
    const mock = await startResponsesServer([
      () => textEvents('구현을 시작하겠습니다.', 'effect-kind-draft'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          candidateDisposition: 'retry',
          rationale: 'The user requires an actual workspace file change.',
          callId: 'effect-kind-contract',
        }),
      () =>
        functionCallEvents(
          'run_command',
          JSON.stringify({
            summary: '관련 없는 성공 명령',
            argv: [process.execPath, '-e', 'process.exit(0)'],
            cwd: null,
            timeoutMs: 5_000,
          }),
          'unrelated-process-effect',
        ),
      () =>
        functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: '요청한 워크스페이스 변경',
            changes: [
              {
                path: 'EFFECT_BOUND.md',
                baseSha256: null,
                newContent: '# Correct effect\n',
              },
            ],
          }),
          'required-workspace-effect',
        ),
      () => textEvents('요청한 워크스페이스 변경을 적용했습니다.', 'effect-kind-final'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          candidateDisposition: 'acceptable',
          rationale: 'The required workspace effect was observed before the final answer.',
          callId: 'effect-kind-final-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('effect-kind-binding', '실제 파일을 만들어 구현해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(mock.bodies[2].tool_choice).toBe('required')
    expect(mock.bodies[3].tool_choice).toBe('required')
    expect(await readFile(join(environment.root, 'EFFECT_BOUND.md'), 'utf8')).toBe(
      '# Correct effect\n',
    )
    expect(mock.failures).toEqual([])
  })

  it('records a failed MCP action attempt and does not force a repeated call', async () => {
    const mock = await startResponsesServer([
      () => textEvents('MCP 처리를 시작하겠습니다.', 'mcp-attempt-draft'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['mcp'],
          candidateDisposition: 'retry',
          rationale: 'The user requested an MCP operation.',
          callId: 'mcp-attempt-contract',
        }),
      () => functionCallEvents('mcp_test_action', '{}', 'mcp-denied-action'),
      () => textEvents('MCP 작업이 거절되어 완료하지 못했습니다.', 'mcp-denied-final'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['mcp'],
          candidateDisposition: 'acceptable',
          rationale: 'The final answer truthfully reports the observed MCP blocker.',
          callId: 'mcp-denied-final-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const tools = new ToolRegistry()
    tools.register({
      definition: {
        name: 'mcp_test_action',
        description: 'Test an MCP action failure.',
        strict: true,
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      schema: z.object({}).strict(),
      capability: 'network',
      risk: 'approval-required',
      origin: 'mcp',
      allowedIntents: ['act'],
      execute: async () => {
        throw new Error('MCP action was denied')
      },
    })
    const agent = createAgent(environment, { tools })

    const result = await collectRun(
      agent,
      runInput('mcp-failed-attempt', 'MCP를 통해 요청을 완료해줘'),
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        tool: 'mcp_test_action',
        ok: false,
      }),
    )
    expect(mock.bodies).toHaveLength(5)
    expect(mock.bodies[2].tool_choice).toBe('required')
    expect(mock.bodies[3]).not.toHaveProperty('tool_choice')
    expect(mock.bodies[4].tool_choice).toBe('required')
    expect(mock.failures).toEqual([])
  })

  it('reports host-known MCP success and failure identities from execution receipts', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallsEvents([
          { name: 'mcp_receipt_success', argumentsJson: '{}', callId: 'mcp-receipt-success' },
          { name: 'mcp_receipt_failure', argumentsJson: '{}', callId: 'mcp-receipt-failure' },
        ]),
      (body) => groundedReportSelectionEvents(body, 'mcp-receipts-report'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 1,
    })
    const tools = new ToolRegistry()
    for (const name of ['mcp_receipt_success', 'mcp_receipt_failure'] as const) {
      tools.register({
        definition: {
          name,
          description: `Exercise ${name}.`,
          strict: true,
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
        schema: z.object({}).strict(),
        capability: 'network',
        risk: 'approval-required',
        origin: 'mcp',
        allowedIntents: ['act'],
        execute: async () => {
          if (name === 'mcp_receipt_failure') throw new Error('canonical MCP failure')
          return { accepted: true }
        },
        resolveEffectReceipt: () => ({ effectAttempted: true, executed: true, applied: true }),
      })
    }
    const agent = createAgent(environment, { tools })

    const result = await collectRun(
      agent,
      runInput('grounded-mcp-receipts', 'MCP 성공과 실패를 실행하고 정확히 보고해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toContain('호스트가 MCP 도구 적용을 확인했습니다')
    expect(visibleText).toContain('MCP 도구가 실패')
    expect(visibleText).toContain('"serverId":"registered-mcp"')
    expect(visibleText).toContain('"toolName":"mcp_receipt_success"')
    expect(visibleText).toContain('"toolName":"mcp_receipt_failure"')
    expect(visibleText).toContain('canonical MCP failure')
    expect(mock.failures).toEqual([])
  })

  it('fails boundedly when a provider ignores a required action tool choice', async () => {
    const mock = await startResponsesServer([
      () => textEvents('구현하겠습니다.', 'ignored-action-draft'),
      () =>
        functionCallEvents(
          'declare_run_completion',
          JSON.stringify({
            requirement: 'action',
            requiredEffects: ['workspace-change'],
            candidateDisposition: 'retry',
            rationale: '현재 요청은 파일 변경을 요구합니다.',
          }),
          'completion-contract-required',
        ),
      () => textEvents('다음 응답에서 구현하겠습니다.', 'ignored-required-choice'),
      () => textEvents('다음 응답에서 구현하겠습니다.', 'ignored-required-choice-retry-2'),
      () => textEvents('다음 응답에서 구현하겠습니다.', 'ignored-required-choice-retry-3'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('required-action-failure', '워크스페이스에 기능을 실제로 구현해줘'),
    )

    expect(result.events.at(-1)?.type).toBe('error')
    expect(result.events.filter((event) => event.type === 'text-delta')).toEqual([])
    expect(result.events.filter((event) => event.type === 'tool-started')).toEqual([])
    expect(mock.bodies).toHaveLength(5)
    expect(mock.bodies[2].tool_choice).toBe('required')
    expect(mock.bodies[3].tool_choice).toBe('required')
    expect(mock.bodies[4].tool_choice).toBe('required')
    expect(mock.failures).toEqual([])
  })

  it('retries a structured required-tool violation and applies the recovered action', async () => {
    const mock = await startResponsesServer([
      () => textEvents('파일을 만들겠습니다.', 'required-tool-retry-draft'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          candidateDisposition: 'retry',
          rationale: 'The request requires a file change.',
          callId: 'required-tool-retry-contract',
        }),
      () =>
        failedSseEvents(
          'required-tool-choice-violation',
          'tool_choice_violation',
          'Structured provider contract violation.',
        ),
      () =>
        functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: '재시도 후 파일 생성',
            changes: [
              {
                path: 'RECOVERED_AFTER_TOOL_CHOICE.md',
                baseSha256: null,
                newContent: '# Recovered\n',
              },
            ],
          }),
          'required-tool-retry-change',
        ),
      () => textEvents('요청한 파일을 생성했습니다.', 'required-tool-retry-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('required-tool-retry', '워크스페이스에 파일을 실제로 만들어줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, 'RECOVERED_AFTER_TOOL_CHOICE.md'), 'utf8')).toBe(
      '# Recovered\n',
    )
    expect(mock.bodies).toHaveLength(5)
    expect(mock.bodies[2].tool_choice).toBe('required')
    expect(mock.bodies[3].tool_choice).toBe('required')
    expect(repository.getConversation('required-tool-retry')?.auditEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'provider.turn.retry_succeeded' })]),
    )
    expect(mock.failures).toEqual([])
  })

  it('keeps response-only requests working in the default interactive intent', async () => {
    const answer = '이 프로젝트는 React와 Vite로 구성되어 있습니다.'
    const contextMarker = 'UNTRUSTED_CONTEXT_MUST_NOT_CLASSIFY'
    const mock = await startResponsesServer([
      () => textEvents(answer, 'response-only-draft'),
      () =>
        functionCallEvents(
          'declare_run_completion',
          JSON.stringify({
            requirement: 'response',
            requiredEffects: [],
            candidateDisposition: 'acceptable',
            rationale: '사용자가 설명만 요청했으므로 텍스트 답변으로 충분합니다.',
          }),
          'completion-contract-response',
        ),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'context.txt'), `${contextMarker}\n`)
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('response-only-contract', '현재 프로젝트 구성을 설명해줘', ['context.txt']),
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(
      result.events
        .filter(
          (event): event is Extract<AgentEvent, { type: 'text-delta' }> =>
            event.type === 'text-delta',
        )
        .map((event) => event.delta)
        .join(''),
    ).toBe(answer)
    expect(mock.bodies).toHaveLength(2)
    expect(mock.bodies[1].tool_choice).toBe('required')
    expect(JSON.stringify(inputItems(mock.bodies[0]))).toContain(contextMarker)
    expect(JSON.stringify(inputItems(mock.bodies[1]))).not.toContain(contextMarker)
    expect(mock.failures).toEqual([])
  })

  it('persists completed messages, runs and usage, then resumes plain message history', async () => {
    const mock = await startResponsesServer([
      () => textEvents('첫 번째 답변', 'history-first', { input: 11, output: 7, reasoning: 3 }),
      () => textEvents('두 번째 답변', 'history-second', { input: 17, output: 5, reasoning: 1 }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)

    const firstAgent = createAgent(environment, { conversations: repository })
    const first = await collectRun(firstAgent, runInput('persistent-conversation', '첫 번째 질문'))
    expect(first.events.find((event) => event.type === 'usage')).toMatchObject({
      type: 'usage',
      usage: { inputTokens: 11, outputTokens: 7, reasoningTokens: 3, totalTokens: 18 },
    })

    // A new service has no in-memory Responses API state and must reconstruct plain history.
    const resumedAgent = createAgent(environment, { conversations: repository })
    const second = await collectRun(
      resumedAgent,
      runInput('persistent-conversation', '두 번째 질문'),
    )
    expect(second.events.at(-1)?.type).toBe('completed')

    const resumedInput = inputItems(mock.bodies[1]).filter(
      (item) => item.role === 'user' || item.role === 'assistant',
    )
    expect(resumedInput).toEqual([
      { role: 'user', content: '첫 번째 질문' },
      { role: 'assistant', content: '첫 번째 답변' },
      { role: 'user', content: '두 번째 질문' },
    ])

    const detail = repository.getConversation('persistent-conversation')
    expect(detail?.runs.map((run) => run.status)).toEqual(['completed', 'completed'])
    expect(
      detail?.messages.map((message) => [message.role, message.status, message.modelContent]),
    ).toEqual([
      ['user', 'completed', '첫 번째 질문'],
      ['assistant', 'completed', '첫 번째 답변'],
      ['user', 'completed', '두 번째 질문'],
      ['assistant', 'completed', '두 번째 답변'],
    ])
    expect(
      detail?.auditEvents
        .filter((event) => event.type === 'run.usage')
        .map((event) => event.metadata),
    ).toEqual([
      { inputTokens: 11, outputTokens: 7, reasoningTokens: 3, totalTokens: 18 },
      { inputTokens: 17, outputTokens: 5, reasoningTokens: 1, totalTokens: 22 },
    ])
  })

  it('does not reuse a deleted conversation driver session when its id is recreated', async () => {
    const mock = await startResponsesServer([
      () => textEvents('삭제되어야 할 비밀 답변', 'deleted-session-first'),
      () => textEvents('새 대화 답변', 'deleted-session-second'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, { conversations: repository })

    await collectRun(agent, runInput('reused-conversation-id', '삭제 전 비밀 질문'))
    expect(repository.delete('reused-conversation-id')).toBe(true)
    const second = await collectRun(
      agent,
      runInput('reused-conversation-id', '삭제 후 완전히 새로운 질문'),
    )

    expect(second.events.at(-1)?.type).toBe('completed')
    const secondInput = JSON.stringify(inputItems(mock.bodies[1]))
    expect(secondInput).toContain('삭제 후 완전히 새로운 질문')
    expect(secondInput).not.toContain('삭제 전 비밀 질문')
    expect(secondInput).not.toContain('삭제되어야 할 비밀 답변')

    repository.archive('reused-conversation-id')
    const archived = await collectRun(
      agent,
      runInput('reused-conversation-id', '보관된 대화에서 실행 시도'),
    )
    expect(archived.events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('보관된 대화'),
    })
    expect(mock.bodies).toHaveLength(2)
  })

  it('advances a workspace-bound Goal through plan, checkpoint, completion, and usage', async () => {
    const mock = await startResponsesServer([
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['process'],
          callId: 'goal-frontier',
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['process'],
          callId: 'goal-authorization',
        }),
      () =>
        functionCallEvents(
          'read_file',
          JSON.stringify({ path: 'goal-evidence.txt' }),
          'goal-evidence-read',
        ),
      () =>
        functionCallEvents(
          'run_command',
          JSON.stringify({
            summary: 'Goal evidence verification',
            argv: [process.execPath, '-e', "process.stdout.write('verified')"],
            cwd: null,
            timeoutMs: 5_000,
          }),
          'goal-evidence-verify',
        ),
      (body) => goalActionOutcomeEvents(body, 'verifier', 'complete', 'goal-outcome-verifier'),
      (body) => goalActionOutcomeEvents(body, 'critic', 'complete', 'goal-outcome-critic'),
      () =>
        functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 2,
            explanation: '현재 저장소 근거를 확인했습니다.',
            items: [{ step: '검증 가능한 작업 완료', status: 'completed' }],
          }),
          'goal-plan',
        ),
      () =>
        functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({
            expectedRevision: 3,
            summary: '현재 run에서 계획 항목과 검증 결과를 확인했습니다.',
          }),
          'goal-checkpoint',
        ),
      () =>
        functionCallEvents(
          'finish_goal',
          JSON.stringify({
            expectedRevision: 4,
            status: 'completed',
            summary: '계획과 현재 run checkpoint를 근거로 완료했습니다.',
          }),
          'goal-complete',
        ),
      () =>
        textEvents('Goal을 완료했습니다.', 'goal-final', { input: 23, output: 11, reasoning: 2 }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'goal-evidence.txt'), 'verified Goal evidence\n')
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 5,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const workspacePath = environment.workspace.getWorkspace()?.path
    expect(workspacePath).toBeTruthy()
    repository.createGoal({
      id: 'durable-goal',
      workspacePath: workspacePath as string,
      objective: '검증 가능한 Goal 실행을 완료한다.',
    })
    repository.appendGoalPlan({
      goalId: 'durable-goal',
      expectedGoalRevision: 1,
      explanation: '검증 가능한 frontier를 먼저 수행합니다.',
      items: [{ step: '검증 가능한 작업 완료', status: 'in_progress' }],
    })
    const agent = createAgent(environment, {
      conversations: repository,
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      {
        ...runInput('goal-conversation', 'Goal을 계속 진행해줘'),
        goalId: 'durable-goal',
        intent: 'act',
        trigger: {
          providerId: 'builtin:user-message',
          type: 'goal-manual-continue',
          dedupeKey: 'goal-test-request',
        },
      },
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(mock.failures).toEqual([])
    expect(mock.bodies).toHaveLength(10)
    expect(JSON.stringify(mock.bodies[2])).not.toContain(workspacePath as string)
    expect((mock.bodies[2].tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['read_goal', 'read_file', 'run_command']),
    )
    expect(JSON.stringify(mock.bodies[2].tools)).not.toContain('update_goal_plan')
    expect(JSON.stringify(mock.bodies[2].tools)).not.toContain('checkpoint_goal')
    expect(JSON.stringify(mock.bodies[2].tools)).not.toContain('finish_goal')
    expect(repository.getGoal('durable-goal')).toMatchObject({
      status: 'completed',
      revision: 5,
      planRevision: 2,
      usedTokens: 34,
      completionSummary: expect.stringContaining('호스트 근거 요약:'),
    })
    expect(repository.getGoal('durable-goal')?.completionSummary).toContain('goal-evidence.txt')
    expect(repository.getGoal('durable-goal')?.completionSummary).toContain('명령 실행 성공')
    expect(repository.getCurrentGoalPlan('durable-goal')?.items).toEqual([
      { step: '검증 가능한 작업 완료', status: 'completed' },
    ])
    expect(repository.listGoalCheckpoints('durable-goal')).toEqual([
      expect.objectContaining({ runId: result.runId, goalRevision: 4 }),
    ])
    expect(repository.getConversation('goal-conversation')?.runs).toEqual([
      expect.objectContaining({
        id: result.runId,
        goalId: 'durable-goal',
        intent: 'act',
        trigger: {
          providerId: 'builtin:user-message',
          type: 'goal-manual-continue',
          dedupeKey: 'goal-test-request',
        },
        policyId: 'builtin:interactive',
        attempt: 1,
        usage: { inputTokens: 23, outputTokens: 11, reasoningTokens: 2, totalTokens: 34 },
        outcomeSummary: expect.stringContaining('명령 실행 성공'),
        status: 'completed',
      }),
    ])
  })

  it('reserves Goal lifecycle rounds after ordinary reads and finishes with a clean report', async () => {
    const rawProtocol =
      '<tool_call><function=update_goal_plan><parameter=expectedRevision>3</parameter></function></tool_call>'
    const finalText = '두 파일을 확인하고 다음 실행을 위한 Goal checkpoint를 저장했습니다.'
    const toolNames = (body: ResponseBody) =>
      ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name)
    const mock = await startResponsesServer([
      (body) => {
        expect(toolNames(body)).toContain('read_file')
        for (const name of ['update_goal_plan', 'checkpoint_goal', 'finish_goal']) {
          expect(toolNames(body)).not.toContain(name)
        }
        expect(body).not.toHaveProperty('tool_choice')
        return functionCallEvents(
          'read_file',
          JSON.stringify({ path: 'src/first.ts' }),
          'reserved-read-first',
        )
      },
      (body) => {
        expect(functionOutputFor(body, 'reserved-read-first')).toMatchObject({ ok: true })
        expect(toolNames(body)).toContain('read_file')
        for (const name of ['update_goal_plan', 'checkpoint_goal', 'finish_goal']) {
          expect(toolNames(body)).not.toContain(name)
        }
        expect(body).not.toHaveProperty('tool_choice')
        return functionCallEvents(
          'read_file',
          JSON.stringify({ path: 'src/second.ts' }),
          'reserved-read-second',
        )
      },
      (body) => {
        expect(
          inputItems(body).some(
            (item) => item.type === 'function_call' || item.type === 'function_call_output',
          ),
        ).toBe(false)
        expect(toolNames(body)).toEqual(['update_goal_plan'])
        expect(body.tool_choice).toEqual({ type: 'function', name: 'update_goal_plan' })
        expect(body.instructions).toContain('The host is closing the work phase')
        expect(body.instructions).toContain('"name":"update_goal_plan"')
        expect(body.instructions).not.toContain('read_file')
        expect(body.instructions).not.toContain('Batch independent reads')
        expect(body.instructions).toContain(
          '"objective":"소스 구조를 확인하고 기능을 단계적으로 구현한다."',
        )
        expect(body.instructions).toContain('"inspectedPaths":["src/first.ts","src/second.ts"]')
        expect(body.instructions).toContain('clean session without earlier tool-call transcripts')
        return functionCallEvents(
          'read_file',
          JSON.stringify({ path: 'src/first.ts' }),
          'reserved-stale-read',
        )
      },
      (body) => {
        expect(
          inputItems(body).some(
            (item) => item.type === 'function_call' || item.type === 'function_call_output',
          ),
        ).toBe(false)
        expect(toolNames(body)).toEqual(['update_goal_plan'])
        expect(body.tool_choice).toEqual({ type: 'function', name: 'update_goal_plan' })
        expect(body.instructions).toContain('The previous provider attempt did not produce')
        expect(body.instructions).not.toContain('read_file')
        return functionCallEvents('update_goal_plan', '[', 'reserved-malformed-plan')
      },
      (body) => {
        expect(
          inputItems(body).some(
            (item) => item.type === 'function_call' || item.type === 'function_call_output',
          ),
        ).toBe(false)
        expect(toolNames(body)).toEqual(['update_goal_plan'])
        expect(body.tool_choice).toEqual({ type: 'function', name: 'update_goal_plan' })
        return functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '현재 run에서 두 소스 파일을 확인했고 구현 작업은 다음 run에 이어갑니다.',
            items: [{ step: '확인한 구조를 바탕으로 기능 구현', status: 'in_progress' }],
          }),
          'reserved-plan',
        )
      },
      (body) => {
        expect(
          inputItems(body).some(
            (item) => item.type === 'function_call' || item.type === 'function_call_output',
          ),
        ).toBe(false)
        expect(toolNames(body)).toEqual(['checkpoint_goal'])
        expect(body.tool_choice).toEqual({ type: 'function', name: 'checkpoint_goal' })
        expect(body.instructions).toContain('"name":"checkpoint_goal"')
        expect(body.instructions).not.toContain('read_file')
        expect(body.instructions).not.toContain('update_goal_plan')
        expect(body.instructions).not.toContain('Batch independent reads')
        expect(body.instructions).toContain('"revision":1,"goalRevision":2')
        expect(body.instructions).toContain('"status":"in_progress"')
        return functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({
            expectedRevision: 999,
            summary: 'src/first.ts와 src/second.ts를 확인했고 기능 구현은 아직 진행 중입니다.',
          }),
          'reserved-checkpoint',
        )
      },
      (body) => {
        expect(body.tools).toBeUndefined()
        expect(body.tool_choice).toBe('none')
        expect(
          inputItems(body).some(
            (item) =>
              item.type === 'function_call_output' && item.call_id === 'reserved-checkpoint',
          ),
        ).toBe(false)
        return textEvents(rawProtocol, 'reserved-clean-report-raw')
      },
      (body) => {
        expect(body.tools).toBeUndefined()
        expect(body.tool_choice).toBe('none')
        expect(body.instructions).toContain('Tool calling is disabled')
        expect(body.instructions).toContain('normal final assistant text only')
        expect(body.instructions).toContain(
          'Tools are intentionally disabled only for this reporting turn',
        )
        expect(body.instructions).toContain(
          'Do not infer or claim that work-phase tools or explicit user authorization were unavailable',
        )
        return textEvents(finalText, 'reserved-clean-report-final')
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await mkdir(join(environment.root, 'src'))
    await writeFile(join(environment.root, 'src/first.ts'), 'export const first = true\n')
    await writeFile(join(environment.root, 'src/second.ts'), 'export const second = true\n')
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 8,
      maxTotalToolCalls: currentSettings.maxTotalToolCalls,
    })
    expect(await environment.settings.getSettings()).toMatchObject({
      maxToolIterations: 8,
      maxTotalToolCalls: 100,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'reserved-lifecycle-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '소스 구조를 확인하고 기능을 단계적으로 구현한다.',
    })
    const agent = createAgent(environment, { conversations: repository })
    const input = {
      ...runInput('reserved-lifecycle-conversation', 'Goal 작업을 가능한 만큼 진행해줘'),
      goalId: 'reserved-lifecycle-goal',
      intent: 'act' as const,
    }

    const result = await collectRun(agent, input)

    expect(mock.failures).toEqual([])
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(mock.bodies).toHaveLength(8)
    expect(
      result.events.filter((event) => event.type === 'tool-completed').map((event) => event.tool),
    ).toEqual(['read_file', 'read_file', 'update_goal_plan', 'update_goal_plan', 'checkpoint_goal'])
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toContain('src/first.ts')
    expect(visibleText).toContain('src/second.ts')
    expect(visibleText).toContain('durable checkpoint')
    expect(visibleText).not.toContain(finalText)
    expect(visibleText).not.toContain(rawProtocol)
    expect(repository.getGoal('reserved-lifecycle-goal')).toMatchObject({
      status: 'active',
      revision: 3,
      planRevision: 1,
    })
    expect(repository.getCurrentGoalPlan('reserved-lifecycle-goal')).toMatchObject({
      runId: result.runId,
      items: [{ step: '확인한 구조를 바탕으로 기능 구현', status: 'in_progress' }],
    })
    expect(repository.listGoalCheckpoints('reserved-lifecycle-goal')).toEqual([
      expect.objectContaining({
        runId: result.runId,
        goalRevision: 3,
        planRevision: 1,
      }),
    ])
    const conversation = repository.getConversation(input.conversationId)
    expect(
      conversation?.auditEvents.filter((event) => event.type === 'goal.lifecycle_revision_bound'),
    ).toHaveLength(2)
    expect(conversation?.runs).toEqual([
      expect.objectContaining({ id: result.runId, goalId: input.goalId, status: 'completed' }),
    ])
    expect(conversation?.messages.at(-1)).toMatchObject({
      status: 'completed',
      displayContent: visibleText,
      toolActivities: [
        expect.objectContaining({ tool: 'read_file', status: 'completed' }),
        expect.objectContaining({ tool: 'read_file', status: 'completed' }),
        expect.objectContaining({ tool: 'update_goal_plan', status: 'error' }),
        expect.objectContaining({ tool: 'update_goal_plan', status: 'completed' }),
        expect.objectContaining({ tool: 'checkpoint_goal', status: 'completed' }),
      ],
    })
    expect(conversation?.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'provider.turn.retry_succeeded',
          metadata: expect.objectContaining({ attempt: 2 }),
        }),
        expect.objectContaining({
          type: 'goal.lifecycle_revision_bound',
          metadata: expect.objectContaining({
            tool: 'update_goal_plan',
            boundRevision: 1,
            modelExpectedRevision: 999,
            modelRevisionMatched: false,
          }),
        }),
        expect.objectContaining({
          type: 'goal.lifecycle_revision_bound',
          metadata: expect.objectContaining({
            tool: 'checkpoint_goal',
            boundRevision: 2,
            modelExpectedRevision: 999,
            modelRevisionMatched: false,
          }),
        }),
      ]),
    )
  })

  it('records a host fallback Goal checkpoint with read evidence after a nonretryable failure', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'read_file',
          JSON.stringify({ path: 'evidence.txt' }),
          'fallback-checkpoint-read',
        ),
      (body) => {
        expect(
          inputItems(body).some(
            (item) => item.type === 'function_call' || item.type === 'function_call_output',
          ),
        ).toBe(false)
        expect(
          ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name),
        ).toEqual(['update_goal_plan'])
        expect(body.instructions).toContain('"inspectedPaths":["evidence.txt"]')
        return failedSseEvents(
          'fallback-checkpoint-failure',
          'invalid_request_error',
          'Nonretryable provider failure before checkpoint.',
        )
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'evidence.txt'), 'host-observed-read\n')
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'fallback-checkpoint-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '읽은 근거를 잃지 않고 다음 실행으로 이어간다.',
    })
    const agent = createAgent(environment, {
      conversations: repository,
      providerRetry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    })
    const input = {
      ...runInput('fallback-checkpoint-conversation', '근거를 읽고 Goal을 계속해줘'),
      goalId: 'fallback-checkpoint-goal',
      intent: 'act' as const,
    }

    const result = await collectRun(agent, input)

    expect(result.events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('Nonretryable provider failure before checkpoint.'),
    })
    expect(mock.bodies).toHaveLength(2)
    expect(mock.failures).toEqual([])
    expect(repository.getGoal('fallback-checkpoint-goal')).toMatchObject({
      status: 'active',
      revision: 2,
      planRevision: 0,
    })
    const checkpoints = repository.listGoalCheckpoints('fallback-checkpoint-goal')
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({
      runId: result.runId,
      goalRevision: 2,
      planRevision: 0,
    })
    expect(checkpoints[0]?.summary).toContain('"reason":"error"')
    expect(checkpoints[0]?.summary).toContain('"inspectedPaths":["evidence.txt"]')
    expect(repository.getConversation(input.conversationId)?.runs).toEqual([
      expect.objectContaining({ id: result.runId, status: 'error' }),
    ])
    expect(repository.getConversation(input.conversationId)?.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'goal.checkpoint.host_fallback',
          metadata: expect.objectContaining({
            goalId: 'fallback-checkpoint-goal',
            reason: 'error',
            inspectedPathCount: 1,
          }),
        }),
      ]),
    )
  })

  it('rejects duplicate forced Goal plan calls before either can mutate durable state', async () => {
    const duplicatePlanArguments = JSON.stringify({
      expectedRevision: 1,
      explanation: '중복 호출은 적용되면 안 됩니다.',
      items: [{ step: '중복 호출 방지 검증', status: 'in_progress' }],
    })
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'read_file',
          JSON.stringify({ path: 'duplicate-plan-evidence.txt' }),
          'duplicate-plan-read',
        ),
      (body) => {
        expect(
          inputItems(body).some(
            (item) => item.type === 'function_call' || item.type === 'function_call_output',
          ),
        ).toBe(false)
        expect(body.tool_choice).toEqual({ type: 'function', name: 'update_goal_plan' })
        expect(body.instructions).not.toContain('read_file')
        expect(body.instructions).not.toContain('required update_goal_plan')
        return functionCallsEvents([
          {
            name: 'update_goal_plan',
            argumentsJson: duplicatePlanArguments,
            callId: 'duplicate-plan-first',
          },
          {
            name: 'update_goal_plan',
            argumentsJson: duplicatePlanArguments,
            callId: 'duplicate-plan-second',
          },
        ])
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'duplicate-plan-evidence.txt'), 'evidence\n')
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'duplicate-plan-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: 'Goal 수명주기 호출을 원자적으로 처리한다.',
      progressSummary:
        "The model called ['read_file'] instead of the required update_goal_plan function.",
    })
    const agent = createAgent(environment, { conversations: repository })
    const input = {
      ...runInput('duplicate-plan-conversation', '근거를 확인하고 진행 상태를 저장해줘'),
      goalId: 'duplicate-plan-goal',
      intent: 'act' as const,
    }

    const result = await collectRun(agent, input)

    expect(mock.failures).toEqual([])
    expect(mock.bodies).toHaveLength(2)
    expect(result.events.at(-1)?.type).toBe('error')
    expect(
      result.events.filter((event) => event.type === 'tool-completed').map((event) => event.tool),
    ).toEqual(['read_file'])
    expect(repository.getCurrentGoalPlan('duplicate-plan-goal')).toBeNull()
    expect(repository.getGoal('duplicate-plan-goal')).toMatchObject({
      status: 'active',
      revision: 2,
      planRevision: 0,
    })
    expect(repository.listGoalCheckpoints('duplicate-plan-goal')).toEqual([
      expect.objectContaining({ runId: result.runId, goalRevision: 2, planRevision: 0 }),
    ])
  })

  it('binds forced lifecycle calls to the pre-turn Goal snapshot and refreshes after a race', async () => {
    let repository: ConversationRepository | null = null
    const planArguments = JSON.stringify({
      expectedRevision: 999,
      explanation: '동시 편집 뒤 최신 snapshot에서 계획을 저장합니다.',
      items: [{ step: '동시 편집 이후 작업 계속', status: 'in_progress' }],
    })
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'read_file',
          JSON.stringify({ path: 'revision-race-evidence.txt' }),
          'revision-race-read',
        ),
      (body) => {
        expect(body.instructions).toContain('Goal snapshot revision 1')
        repository?.updateGoal('revision-race-goal', {
          expectedRevision: 1,
          tokenBudget: 1_000,
        })
        return functionCallEvents('update_goal_plan', planArguments, 'revision-race-stale-plan')
      },
      (body) => {
        expect(body.instructions).toContain('Goal snapshot revision 2')
        return functionCallEvents('update_goal_plan', planArguments, 'revision-race-fresh-plan')
      },
      (body) => {
        expect(body.instructions).toContain('Goal snapshot revision 3')
        return functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({ expectedRevision: 999, summary: '동시 편집 이후 계획을 저장했습니다.' }),
          'revision-race-checkpoint',
        )
      },
      (body) => {
        expect(body.tools).toBeUndefined()
        expect(body.tool_choice).toBe('none')
        return textEvents(
          '동시 편집을 덮어쓰지 않고 최신 revision에서 계획과 checkpoint를 저장했습니다.',
          'revision-race-final',
        )
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'revision-race-evidence.txt'), 'evidence\n')
    repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'revision-race-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '동시 사용자 편집을 보존하면서 lifecycle 상태를 저장한다.',
    })
    const agent = createAgent(environment, { conversations: repository })

    const result = await collectRun(agent, {
      ...runInput('revision-race-conversation', '근거를 확인하고 진행 상태를 저장해줘'),
      goalId: 'revision-race-goal',
      intent: 'act',
    })

    expect(mock.failures).toEqual([])
    expect(mock.bodies).toHaveLength(5)
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(
      result.events
        .filter(
          (event): event is Extract<AgentEvent, { type: 'tool-completed' }> =>
            event.type === 'tool-completed' && event.tool === 'update_goal_plan',
        )
        .map((event) => event.ok),
    ).toEqual([false, true])
    expect(repository.getGoal('revision-race-goal')).toMatchObject({
      status: 'active',
      revision: 4,
      planRevision: 1,
      tokenBudget: 1_000,
    })
    expect(repository.getCurrentGoalPlan('revision-race-goal')).toMatchObject({
      goalRevision: 3,
      items: [{ step: '동시 편집 이후 작업 계속', status: 'in_progress' }],
    })
    expect(repository.listGoalCheckpoints('revision-race-goal')).toEqual([
      expect.objectContaining({ goalRevision: 4, planRevision: 1, runId: result.runId }),
    ])
  })

  it('rejects Goal lifecycle mutation calls outside a host-forced lifecycle turn', async () => {
    const mock = await startResponsesServer([
      (body) => {
        const names = ((body.tools as Array<{ name?: string }> | undefined) ?? []).map(
          (tool) => tool.name,
        )
        for (const name of ['update_goal_plan', 'checkpoint_goal', 'finish_goal']) {
          expect(names).not.toContain(name)
        }
        return functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 1,
            explanation: '노출되지 않은 lifecycle 호출은 실행되면 안 됩니다.',
            items: [{ step: '적용되면 안 되는 계획', status: 'in_progress' }],
          }),
          'unforced-plan',
        )
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 12,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'unforced-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '강제 lifecycle turn에서만 Goal 상태를 변경한다.',
    })
    const agent = createAgent(environment, { conversations: repository })
    const input = {
      ...runInput('unforced-conversation', 'Goal 상태를 검토해줘'),
      goalId: 'unforced-goal',
      intent: 'act' as const,
    }

    const result = await collectRun(agent, input)

    expect(mock.failures).toEqual([])
    expect(mock.bodies).toHaveLength(1)
    expect(result.events.at(-1)?.type).toBe('error')
    expect(result.events.filter((event) => event.type === 'tool-completed')).toEqual([])
    expect(repository.getCurrentGoalPlan('unforced-goal')).toBeNull()
    expect(repository.getGoal('unforced-goal')).toMatchObject({ status: 'active', revision: 2 })
    expect(
      repository
        .getConversation(input.conversationId)
        ?.auditEvents.some((event) => event.type === 'goal.lifecycle_revision_bound'),
    ).toBe(false)
  })

  it('allows forced Goal lifecycle calls after crossing the token budget but blocks mutation', async () => {
    const blockedPath = 'must-not-be-created.txt'
    const mock = await startResponsesServer([
      () =>
        functionCallsEvents(
          [
            {
              name: 'read_file',
              argumentsJson: JSON.stringify({ path: 'budget-evidence.txt' }),
              callId: 'budget-crossing-read',
            },
            {
              name: 'propose_file_changes',
              argumentsJson: JSON.stringify({
                summary: '예산 초과 뒤 금지될 변경',
                changes: [{ path: blockedPath, baseSha256: null, newContent: 'must not exist\n' }],
              }),
              callId: 'budget-crossing-mutation',
            },
          ],
          { input: 4, output: 2, reasoning: 1 },
        ),
      (body) => {
        expect(
          inputItems(body).some(
            (item) => item.type === 'function_call' || item.type === 'function_call_output',
          ),
        ).toBe(false)
        expect(body.instructions).toContain('"inspectedPaths":["budget-evidence.txt"]')
        expect(body.instructions).toContain('"usedTokens":6')
        expect(body.instructions).not.toContain('read_file')
        expect(body.instructions).not.toContain('propose_file_changes')
        expect(
          ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name),
        ).toEqual(['update_goal_plan'])
        expect(body.tool_choice).toEqual({ type: 'function', name: 'update_goal_plan' })
        return functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 1,
            explanation:
              '읽기 근거는 확인했지만 토큰 예산 경계에서 외부 변경은 적용하지 않았습니다.',
            items: [{ step: '추가 예산에서 변경 작업 재개', status: 'pending' }],
          }),
          'budget-crossing-plan',
        )
      },
      (body) => {
        expect(
          inputItems(body).some(
            (item) => item.type === 'function_call' || item.type === 'function_call_output',
          ),
        ).toBe(false)
        expect(
          ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name),
        ).toEqual(['checkpoint_goal'])
        expect(body.tool_choice).toEqual({ type: 'function', name: 'checkpoint_goal' })
        return functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({
            expectedRevision: 2,
            summary: 'budget-evidence.txt를 읽었고 예산 초과로 변경은 적용하지 않았습니다.',
          }),
          'budget-crossing-checkpoint',
        )
      },
      (body) => {
        expect(body.tools).toBeUndefined()
        expect(body.tool_choice).toBe('none')
        return textEvents(
          '읽기 진행 상황을 checkpoint로 보존했고 파일 변경은 적용하지 않았습니다.',
          'budget-crossing-final',
        )
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'budget-evidence.txt'), 'evidence\n')
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'budget-crossing-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '토큰 예산 경계에서도 진행 상태를 안전하게 보존한다.',
      tokenBudget: 5,
    })
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })
    const input = {
      ...runInput('budget-crossing-conversation', '근거를 읽고 파일을 변경해줘'),
      goalId: 'budget-crossing-goal',
      intent: 'act' as const,
    }

    const result = await collectRun(agent, input)

    expect(mock.failures).toEqual([])
    expect(mock.bodies).toHaveLength(4)
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(approvalRequests(result.events)).toEqual([])
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        callId: 'budget-crossing-read',
        ok: true,
      }),
    )
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        callId: 'budget-crossing-mutation',
        ok: false,
      }),
    )
    await expect(readFile(join(environment.root, blockedPath), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(repository.getGoal('budget-crossing-goal')).toMatchObject({
      status: 'active',
      revision: 3,
      planRevision: 1,
      usedTokens: 6,
    })
    expect(repository.getCurrentGoalPlan('budget-crossing-goal')?.items).toEqual([
      { step: '추가 예산에서 변경 작업 재개', status: 'pending' },
    ])
    expect(repository.listGoalCheckpoints('budget-crossing-goal')).toEqual([
      expect.objectContaining({ runId: result.runId, goalRevision: 3, planRevision: 1 }),
    ])
  })

  it('resumes a multi-phase React and Spring Boot Goal after AgentService restart', async () => {
    const perTurnUsage = { input: 4, output: 2, reasoning: 1 }
    const frontendPackage = `${JSON.stringify(
      {
        name: 'goal-react-sample',
        private: true,
        type: 'module',
        scripts: { build: 'vite build' },
        dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
        devDependencies: { '@vitejs/plugin-react': '^4.0.0', vite: '^6.0.0' },
      },
      null,
      2,
    )}\n`
    const frontendApp = `export function App() {\n  return <main><h1>Service status</h1></main>\n}\n`
    const backendPom = `<project xmlns="http://maven.apache.org/POM/4.0.0">\n  <modelVersion>4.0.0</modelVersion>\n  <parent>\n    <groupId>org.springframework.boot</groupId>\n    <artifactId>spring-boot-starter-parent</artifactId>\n    <version>3.5.0</version>\n  </parent>\n  <groupId>com.example</groupId>\n  <artifactId>goal-sample</artifactId>\n  <version>0.0.1-SNAPSHOT</version>\n  <dependencies>\n    <dependency>\n      <groupId>org.springframework.boot</groupId>\n      <artifactId>spring-boot-starter-web</artifactId>\n    </dependency>\n  </dependencies>\n</project>\n`
    const backendApplication = `package com.example.demo;\n\nimport org.springframework.boot.SpringApplication;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n\n@SpringBootApplication\npublic class DemoApplication {\n  public static void main(String[] args) {\n    SpringApplication.run(DemoApplication.class, args);\n  }\n}\n`
    const backendController = `package com.example.demo;\n\nimport java.util.Map;\nimport org.springframework.web.bind.annotation.GetMapping;\nimport org.springframework.web.bind.annotation.RestController;\n\n@RestController\npublic class StatusController {\n  @GetMapping("/api/status")\n  public Map<String, String> status() {\n    return Map.of("status", "ok");\n  }\n}\n`
    const frontendPaths = ['frontend/package.json', 'frontend/src/App.jsx']
    const backendPaths = [
      'backend/pom.xml',
      'backend/src/main/java/com/example/demo/DemoApplication.java',
      'backend/src/main/java/com/example/demo/StatusController.java',
    ]
    const frontendDirectoryScript =
      "require('node:fs').mkdirSync('frontend/src', { recursive: true })"
    const backendDirectoryScript =
      "require('node:fs').mkdirSync('backend/src/main/java/com/example/demo', { recursive: true })"
    const frontendVerificationScript = `const fs=require('node:fs');const pkg=JSON.parse(fs.readFileSync('frontend/package.json','utf8'));const app=fs.readFileSync('frontend/src/App.jsx','utf8');if(pkg.scripts?.build!=='vite build'||!app.includes('Service status'))process.exit(1);process.stdout.write('frontend-verified')`
    const backendVerificationScript = `const fs=require('node:fs');const pom=fs.readFileSync('backend/pom.xml','utf8');const app=fs.readFileSync('backend/src/main/java/com/example/demo/DemoApplication.java','utf8');const controller=fs.readFileSync('backend/src/main/java/com/example/demo/StatusController.java','utf8');if(!pom.includes('spring-boot-starter-web')||!app.includes('@SpringBootApplication')||!controller.includes('/api/status'))process.exit(1);process.stdout.write('backend-verified')`
    const commandArguments = (summary: string, script: string) =>
      JSON.stringify({
        summary,
        argv: [process.execPath, '-e', script],
        cwd: null,
        timeoutMs: 5_000,
      })
    const mock = await startResponsesServer([
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change', 'process'],
          callId: 'long-goal-initial-work-contract',
          usage: perTurnUsage,
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [
            { itemIndex: 0, authorization: 'direct-objective-entailment' },
            { itemIndex: 1, authorization: 'direct-objective-entailment' },
          ],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change', 'process'],
          callId: 'long-goal-initial-scope-authorization',
          usage: perTurnUsage,
        }),
      () => functionCallEvents('read_goal', '{}', 'long-goal-read-initial', perTurnUsage),
      (body) => {
        expect(functionOutputFor(body, 'long-goal-read-initial')).toMatchObject({
          ok: true,
          result: {
            goal: { revision: 2, status: 'active', planRevision: 1 },
            plan: {
              revision: 1,
              items: [
                { step: 'React 프런트엔드 구현과 구조 검증', status: 'in_progress' },
                { step: 'Spring Boot 백엔드 구현과 구조 검증', status: 'pending' },
              ],
            },
            checkpoints: [],
          },
        })
        return functionCallEvents(
          'run_command',
          commandArguments('React 소스 디렉터리 준비', frontendDirectoryScript),
          'long-goal-frontend-directory',
          perTurnUsage,
        )
      },
      (body) => {
        expect(functionOutputFor(body, 'long-goal-frontend-directory')).toMatchObject({
          ok: true,
          result: { executed: true, exitCode: 0 },
        })
        return functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: 'React 샘플 구현',
            changes: [
              { path: frontendPaths[0], baseSha256: null, newContent: frontendPackage },
              { path: frontendPaths[1], baseSha256: null, newContent: frontendApp },
            ],
          }),
          'long-goal-frontend-files',
          perTurnUsage,
        )
      },
      (body) => {
        expect(functionOutputFor(body, 'long-goal-frontend-files')).toMatchObject({
          ok: true,
          result: { applied: true, changedPaths: frontendPaths },
        })
        return functionCallEvents(
          'run_command',
          commandArguments('React 구조 검증', frontendVerificationScript),
          'long-goal-frontend-verify',
          perTurnUsage,
        )
      },
      (body) =>
        goalActionOutcomeEvents(
          body,
          'verifier',
          'complete',
          'long-goal-frontend-outcome-verifier',
        ),
      (body) =>
        goalActionOutcomeEvents(body, 'critic', 'complete', 'long-goal-frontend-outcome-critic'),
      (body) => {
        expect(body.tool_choice).toEqual({ type: 'function', name: 'update_goal_plan' })
        expect(body.instructions).toContain('"appliedEffects":["process","workspace-change"]')
        return functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 1,
            explanation: 'React 구현과 검증을 완료했고 Spring Boot 단계가 남았습니다.',
            items: [
              { step: 'React 프런트엔드 구현과 구조 검증', status: 'completed' },
              { step: 'Spring Boot 백엔드 구현과 구조 검증', status: 'pending' },
            ],
          }),
          'long-goal-plan-initial',
          perTurnUsage,
        )
      },
      () =>
        functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({
            expectedRevision: 2,
            summary: 'React 파일 생성과 구조 검증을 완료했고 Spring Boot 단계가 남았습니다.',
          }),
          'long-goal-frontend-checkpoint',
          perTurnUsage,
        ),
      (body) => {
        expect(body.tool_choice).toBe('none')
        expect(body.tools).toBeUndefined()
        expect(
          inputItems(body).some(
            (item) =>
              item.type === 'function_call_output' &&
              item.call_id === 'long-goal-frontend-checkpoint',
          ),
        ).toBe(false)
        return textEvents(
          'React 단계를 검증하고 checkpoint를 저장했습니다. 다음 실행에서 백엔드를 이어갑니다.',
          'long-goal-frontend-final',
          perTurnUsage,
        )
      },
      (body) => {
        expect(
          ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name),
        ).toEqual(['declare_goal_frontier'])
        const classifierInput = JSON.stringify(hostClassifierData(body, 'goal-work-scope'))
        expect(classifierInput).toContain('"index":1')
        expect(classifierInput).toContain('Spring Boot 백엔드 구현과 구조 검증')
        expect(body.instructions).not.toContain('Spring Boot 백엔드 구현과 구조 검증')
        expect(body.instructions).toContain('candidateDisposition to acceptable')
        return goalFrontierContractEvents({
          items: [{ itemIndex: 1 }],
          selectedItemIndex: 1,
          requirement: 'action',
          requiredEffects: ['workspace-change', 'process'],
          callId: 'long-goal-work-contract',
          usage: perTurnUsage,
        })
      },
      (body) => {
        expect(
          ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name),
        ).toEqual(['declare_goal_scope_authorization'])
        const authorizationInput = JSON.stringify(
          hostClassifierData(body, 'goal-scope-authorization'),
        )
        expect(authorizationInput).toContain('Spring Boot 백엔드 구현과 구조 검증')
        expect(body.instructions).not.toContain('Spring Boot 백엔드 구현과 구조 검증')
        return goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 1, authorization: 'direct-objective-entailment' }],
          selectedItemIndex: 1,
          requirement: 'action',
          requiredEffects: ['workspace-change', 'process'],
          callId: 'long-goal-scope-authorization',
          usage: perTurnUsage,
        })
      },
      () => functionCallEvents('read_goal', '{}', 'long-goal-read-resumed', perTurnUsage),
      (body) => {
        expect(functionOutputFor(body, 'long-goal-read-resumed')).toMatchObject({
          ok: true,
          result: {
            goal: { revision: 4, status: 'active', planRevision: 2 },
            plan: {
              revision: 2,
              items: [
                { step: 'React 프런트엔드 구현과 구조 검증', status: 'completed' },
                { step: 'Spring Boot 백엔드 구현과 구조 검증', status: 'pending' },
              ],
            },
            checkpoints: [
              expect.objectContaining({
                goalRevision: 4,
                planRevision: 2,
                summary: expect.stringContaining('호스트 근거 요약:'),
              }),
            ],
          },
        })
        return functionCallEvents(
          'run_command',
          commandArguments('Spring Boot 소스 디렉터리 준비', backendDirectoryScript),
          'long-goal-backend-directory',
          perTurnUsage,
        )
      },
      (body) => {
        expect(functionOutputFor(body, 'long-goal-backend-directory')).toMatchObject({
          ok: true,
          result: { executed: true, exitCode: 0 },
        })
        return functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: 'Spring Boot 샘플 구현',
            changes: [
              { path: backendPaths[0], baseSha256: null, newContent: backendPom },
              { path: backendPaths[1], baseSha256: null, newContent: backendApplication },
              { path: backendPaths[2], baseSha256: null, newContent: backendController },
            ],
          }),
          'long-goal-backend-files',
          perTurnUsage,
        )
      },
      (body) => {
        expect(functionOutputFor(body, 'long-goal-backend-files')).toMatchObject({
          ok: true,
          result: { applied: true, changedPaths: backendPaths },
        })
        return functionCallEvents(
          'run_command',
          commandArguments('Spring Boot 구조 검증', backendVerificationScript),
          'long-goal-backend-verify',
          perTurnUsage,
        )
      },
      (body) =>
        goalActionOutcomeEvents(body, 'verifier', 'complete', 'long-goal-backend-outcome-verifier'),
      (body) =>
        goalActionOutcomeEvents(body, 'critic', 'complete', 'long-goal-backend-outcome-critic'),
      (body) => {
        expect(body.tool_choice).toEqual({ type: 'function', name: 'update_goal_plan' })
        expect(body.instructions).toContain('"appliedEffects":["process","workspace-change"]')
        return functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 3,
            explanation: '재시작 후 저장된 checkpoint를 읽고 두 구현 단계의 검증을 완료했습니다.',
            items: [
              { step: 'React 프런트엔드 구현과 구조 검증', status: 'completed' },
              { step: 'Spring Boot 백엔드 구현과 구조 검증', status: 'completed' },
            ],
          }),
          'long-goal-plan-completed',
          perTurnUsage,
        )
      },
      () =>
        functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({
            expectedRevision: 4,
            summary: 'React와 Spring Boot 소스가 모두 존재하고 검증 명령이 성공했습니다.',
          }),
          'long-goal-final-checkpoint',
          perTurnUsage,
        ),
      (body) => {
        expect(
          inputItems(body).some(
            (item) => item.type === 'function_call' || item.type === 'function_call_output',
          ),
        ).toBe(false)
        expect(body.instructions).toContain(
          '"currentRunCheckpoint":{"recorded":true,"goalRevision":6',
        )
        expect(body.instructions).not.toContain(
          'React와 Spring Boot 소스가 모두 존재하고 검증 명령이 성공했습니다.',
        )
        return functionCallEvents(
          'finish_goal',
          JSON.stringify({
            expectedRevision: 5,
            status: 'completed',
            summary: '재시작을 거친 두 단계 구현과 최종 검증을 근거로 Goal을 완료했습니다.',
          }),
          'long-goal-finish',
          perTurnUsage,
        )
      },
      (body) => {
        expect(body.tools).toBeUndefined()
        expect(body.tool_choice).toBe('none')
        expect(
          inputItems(body).some(
            (item) => item.type === 'function_call_output' && item.call_id === 'long-goal-finish',
          ),
        ).toBe(false)
        return textEvents(
          'React와 Spring Boot 샘플 구현 및 검증을 완료했습니다.',
          'long-goal-completed-final',
          perTurnUsage,
        )
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 7,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'long-running-sample-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: 'React 프런트엔드와 Spring Boot 백엔드를 단계적으로 구현하고 검증한다.',
      tokenBudget: 1_000,
    })
    repository.appendGoalPlan({
      goalId: 'long-running-sample-goal',
      expectedGoalRevision: 1,
      explanation: '프런트엔드 구현을 먼저 완료한 뒤 백엔드 구현을 이어갑니다.',
      items: [
        { step: 'React 프런트엔드 구현과 구조 검증', status: 'in_progress' },
        { step: 'Spring Boot 백엔드 구현과 구조 검증', status: 'pending' },
      ],
    })
    const serviceOptions = {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    }
    const approve = (agent: AgentService) => (event: AgentEvent) => {
      if (event.type === 'approval-requested') {
        agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
      }
    }
    const initialAgent = createAgent(environment, serviceOptions)
    const initial = await collectRun(
      initialAgent,
      {
        ...runInput('long-running-goal-conversation', 'Goal의 React 단계를 진행해줘'),
        goalId: 'long-running-sample-goal',
        intent: 'act',
        trigger: {
          providerId: 'builtin:user-message',
          type: 'goal-manual-continue',
          dedupeKey: 'long-goal-react-phase',
        },
      },
      approve(initialAgent),
    )

    expect(mock.failures).toEqual([])
    expect(initial.events.at(-1)).toMatchObject({ type: 'completed' })
    expect(repository.getGoal('long-running-sample-goal')).toMatchObject({
      status: 'active',
      revision: 4,
      planRevision: 2,
      usedTokens: 54,
    })
    expect(await readFile(join(environment.root, frontendPaths[0]), 'utf8')).toBe(frontendPackage)
    expect(await readFile(join(environment.root, frontendPaths[1]), 'utf8')).toBe(frontendApp)

    await initialAgent.shutdown()
    const resumedSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: resumedSettings.activeProviderId,
      activeModelId: resumedSettings.activeModelId,
      theme: resumedSettings.theme,
      maxToolIterations: 7,
    })
    const resumedAgent = createAgent(environment, serviceOptions)
    const resumed = await collectRun(
      resumedAgent,
      {
        ...runInput('long-running-goal-conversation', '저장된 checkpoint부터 Goal을 계속해줘'),
        goalId: 'long-running-sample-goal',
        intent: 'act',
        trigger: {
          providerId: 'builtin:user-message',
          type: 'goal-manual-continue',
          dedupeKey: 'long-goal-spring-phase',
        },
      },
      approve(resumedAgent),
    )

    expect(mock.failures).toEqual([])
    expect(resumed.events.at(-1)?.type).toBe('completed')
    expect(mock.bodies).toHaveLength(23)
    expect(
      [...initial.events, ...resumed.events].filter(
        (event) => event.type === 'tool-completed' && event.ok,
      ),
    ).toHaveLength(13)
    expect([...approvalRequests(initial.events), ...approvalRequests(resumed.events)]).toHaveLength(
      6,
    )
    expect(await readFile(join(environment.root, backendPaths[0]), 'utf8')).toBe(backendPom)
    expect(await readFile(join(environment.root, backendPaths[1]), 'utf8')).toBe(backendApplication)
    expect(await readFile(join(environment.root, backendPaths[2]), 'utf8')).toBe(backendController)
    expect(repository.getGoal('long-running-sample-goal')).toMatchObject({
      status: 'completed',
      revision: 7,
      planRevision: 3,
      usedTokens: 114,
      completionSummary: expect.stringContaining('호스트 근거 요약:'),
    })
    expect(repository.getGoal('long-running-sample-goal')?.completionSummary).toContain(
      '명령 실행 성공',
    )
    expect(repository.getCurrentGoalPlan('long-running-sample-goal')?.items).toEqual([
      { step: 'React 프런트엔드 구현과 구조 검증', status: 'completed' },
      { step: 'Spring Boot 백엔드 구현과 구조 검증', status: 'completed' },
    ])
    expect(repository.listGoalCheckpoints('long-running-sample-goal')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: initial.runId,
          goalRevision: 4,
          planRevision: 2,
        }),
        expect.objectContaining({
          runId: resumed.runId,
          goalRevision: 6,
          planRevision: 3,
        }),
      ]),
    )
    expect(repository.getConversation('long-running-goal-conversation')?.runs).toEqual([
      expect.objectContaining({
        id: initial.runId,
        goalId: 'long-running-sample-goal',
        status: 'completed',
        usage: { inputTokens: 36, outputTokens: 18, reasoningTokens: 9, totalTokens: 54 },
      }),
      expect.objectContaining({
        id: resumed.runId,
        goalId: 'long-running-sample-goal',
        status: 'completed',
        usage: { inputTokens: 40, outputTokens: 20, reasoningTokens: 10, totalTokens: 60 },
      }),
    ])
  })

  it('corrects read-only Goal churn with one effect-only recovery before lifecycle', async () => {
    const implementedPath = 'focused-implementation.txt'
    const toolNames = (body: ResponseBody) =>
      ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name)
    const mock = await startResponsesServer([
      (body) => {
        expect(toolNames(body)).toEqual(['declare_goal_frontier'])
        const classifierInput = JSON.stringify(hostClassifierData(body, 'goal-work-scope'))
        expect(classifierInput).toContain('"index":1')
        expect(classifierInput).toContain('현재 기능 구현')
        expect(classifierInput).toContain('"unfinishedItems"')
        expect(body.instructions).not.toContain('현재 기능 구현')
        return goalFrontierContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }, { itemIndex: 2 }],
          selectedItemIndex: 1,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'focus-contract',
        })
      },
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }, { itemIndex: 2 }],
          selectedItemIndex: 1,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'focus-authorization',
        }),
      (body) => {
        for (const name of ['update_goal_plan', 'checkpoint_goal', 'finish_goal']) {
          expect(toolNames(body)).not.toContain(name)
        }
        expect(body.tool_choice).toBe('required')
        return functionCallEvents(
          'read_file',
          JSON.stringify({ path: 'focus-a.txt' }),
          'focus-read-a',
        )
      },
      (body) => {
        expect(body.instructions).toContain('read-only churn')
        expect(body.instructions).toContain('explicit user authorization')
        for (const name of ['update_goal_plan', 'checkpoint_goal', 'finish_goal']) {
          expect(toolNames(body)).not.toContain(name)
        }
        return functionCallEvents(
          'read_file',
          JSON.stringify({ path: 'focus-b.txt' }),
          'focus-read-b',
        )
      },
      (body) => {
        expect(body.tool_choice).toBe('required')
        expect(body.instructions).toContain('effect-only work-recovery phase')
        expect(toolNames(body)).toEqual(
          expect.arrayContaining(['propose_file_changes', 'propose_file_patches']),
        )
        for (const name of [
          'list_files',
          'read_file',
          'search_text',
          'run_command',
          'update_goal_plan',
          'checkpoint_goal',
          'finish_goal',
        ]) {
          expect(toolNames(body)).not.toContain(name)
        }
        return functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: '현재 Goal frontier 구현',
            changes: [{ path: implementedPath, baseSha256: null, newContent: 'implemented\n' }],
          }),
          'focus-effect',
        )
      },
      (body) => goalActionOutcomeEvents(body, 'verifier', 'complete', 'focus-outcome-verifier'),
      (body) => goalActionOutcomeEvents(body, 'critic', 'complete', 'focus-outcome-critic'),
      (body) => {
        expect(body.tool_choice).toEqual({ type: 'function', name: 'update_goal_plan' })
        expect(inputItems(body)).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ type: 'function_call_output' })]),
        )
        return functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '현재 frontier를 구현했고 남은 계획을 검토했습니다.',
            items: [
              { step: '선행 검토', status: 'pending' },
              { step: '현재 기능 구현', status: 'completed' },
              { step: '후속 정리', status: 'pending' },
            ],
          }),
          'focus-plan-completed',
        )
      },
      () =>
        functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({ expectedRevision: 999, summary: '현재 frontier 구현을 검증했습니다.' }),
          'focus-checkpoint',
        ),
      (body) => {
        expect(body.tools).toBeUndefined()
        expect(body.tool_choice).toBe('none')
        expect(body.instructions).toContain(
          'Tools are intentionally disabled only for this reporting turn',
        )
        expect(body.instructions).toContain('"workEffectToolsAvailable":true')
        return textEvents('현재 frontier 구현과 검증을 완료했습니다.', 'focus-final')
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'focus-a.txt'), 'a\n')
    await writeFile(join(environment.root, 'focus-b.txt'), 'b\n')
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 5,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'focus-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '현재 계획의 첫 진행 항목을 구현하고 검증한다.',
    })
    repository.appendGoalPlan({
      goalId: 'focus-goal',
      expectedGoalRevision: 1,
      explanation: '진행 중인 항목을 우선합니다.',
      items: [
        { step: '선행 검토', status: 'pending' },
        { step: '현재 기능 구현', status: 'in_progress' },
        { step: '후속 정리', status: 'pending' },
      ],
    })
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      {
        ...runInput('focus-conversation', '저장된 Goal을 계속해줘'),
        goalId: 'focus-goal',
      },
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(mock.failures).toEqual([])
    expect(mock.bodies).toHaveLength(10)
    expect(await readFile(join(environment.root, implementedPath), 'utf8')).toBe('implemented\n')
    expect(repository.getGoal('focus-goal')).toMatchObject({ status: 'active' })
    expect(repository.getCurrentGoalPlan('focus-goal')?.items).toEqual([
      { step: '선행 검토', status: 'pending' },
      { step: '현재 기능 구현', status: 'completed' },
      { step: '후속 정리', status: 'pending' },
    ])
    const auditEvents = repository.getConversation('focus-conversation')?.auditEvents ?? []
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'goal.work_contract',
          metadata: expect.objectContaining({
            contract: expect.objectContaining({ candidateDisposition: 'acceptable' }),
          }),
        }),
        expect.objectContaining({ type: 'goal.work_focus_stalled' }),
        expect.objectContaining({ type: 'goal.work_effect_recovery_started' }),
      ]),
    )
  })

  it('starts effect-only Goal recovery after one correction round without waiting for lifecycle pressure', async () => {
    const conversationId = 'early-effect-recovery-conversation'
    const refreshPath = 'refresh-before-recovery.txt'
    const implementedPath = 'early-effect-recovery.txt'
    const evidencePaths = Array.from(
      { length: 6 },
      (_, index) => `early-recovery-evidence-${String(index + 1)}.txt`,
    )
    const toolNames = (body: ResponseBody) =>
      ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name)
    const mock = await startResponsesServer([
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change', 'process'],
          callId: 'early-recovery-contract',
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change', 'process'],
          callId: 'early-recovery-authorization',
        }),
      (body) => {
        expect(body.tool_choice).toBe('required')
        expect(toolNames(body)).toEqual(['read_file'])
        expect(body.instructions).toContain('preserving a required file-mutation refresh')
        expect(body.instructions).toContain(refreshPath)
        return functionCallEvents(
          'read_file',
          JSON.stringify({ path: refreshPath }),
          'early-recovery-refresh',
        )
      },
      ...evidencePaths.map((path, index) => (body: ResponseBody) => {
        if (index < evidencePaths.length - 1) {
          expect(body.instructions).not.toContain('effect-only work-recovery phase')
        } else {
          expect(body.instructions).toContain('read-only churn')
          expect(body.instructions).not.toContain('effect-only work-recovery phase')
        }
        expect(toolNames(body)).toContain('read_file')
        return functionCallEvents(
          'read_file',
          JSON.stringify({ path }),
          `early-recovery-read-${String(index + 1)}`,
        )
      }),
      (body) => {
        expect(body.tool_choice).toBe('required')
        expect(body.instructions).toContain('effect-only work-recovery phase')
        expect(body.instructions).toContain('"rounds":13')
        expect(toolNames(body)).toEqual(
          expect.arrayContaining(['propose_file_changes', 'propose_file_patches']),
        )
        for (const name of ['list_files', 'read_file', 'search_text']) {
          expect(toolNames(body)).not.toContain(name)
        }
        return functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: '충분한 증거 수집 후 현재 frontier 구현',
            changes: [
              { path: implementedPath, baseSha256: null, newContent: 'implemented early\n' },
            ],
          }),
          'early-recovery-effect',
        )
      },
      (body) => {
        expect(body.tool_choice).toBe('required')
        expect(body.instructions).toContain('effect-only work-recovery phase')
        expect(body.instructions).toContain('["process"]')
        expect(toolNames(body)).toEqual(['run_command'])
        return functionCallEvents(
          'run_command',
          JSON.stringify({
            summary: '통합 검증 실패 증거 수집',
            argv: [process.execPath, '-e', 'process.exit(9)'],
            cwd: null,
            timeoutMs: 5_000,
          }),
          'early-recovery-process-failure',
        )
      },
      (body) => {
        expect(body.tool_choice).toEqual({ type: 'function', name: 'update_goal_plan' })
        expect(body.instructions).toContain('"appliedEffects":["workspace-change"]')
        expect(body.instructions).toContain('"unsuccessfulEffects":["process"]')
        return functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '현재 frontier 변경을 적용했고 후속 검증은 남았습니다.',
            items: [
              { step: '현재 기능 변경 적용', status: 'in_progress' },
              { step: '후속 통합 검증', status: 'pending' },
            ],
          }),
          'early-recovery-plan',
        )
      },
      () =>
        functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({
            expectedRevision: 999,
            summary: '현재 기능 변경을 적용했고 후속 통합 검증이 남았습니다.',
          }),
          'early-recovery-checkpoint',
        ),
      (body) => {
        expect(body.tools).toBeUndefined()
        expect(body.tool_choice).toBe('none')
        return textEvents('현재 기능 변경을 적용하고 checkpoint를 저장했습니다.', 'early-final')
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const refreshContent = 'refresh me\n'
    await writeFile(join(environment.root, refreshPath), refreshContent)
    for (const path of evidencePaths) await writeFile(join(environment.root, path), `${path}\n`)
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 20,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'early-effect-recovery-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '충분한 증거를 확인한 뒤 현재 기능 변경을 적용하고 검증한다.',
    })
    repository.appendGoalPlan({
      goalId: 'early-effect-recovery-goal',
      expectedGoalRevision: 1,
      explanation: '현재 변경을 먼저 적용합니다.',
      items: [
        { step: '현재 기능 변경 적용', status: 'in_progress' },
        { step: '후속 통합 검증', status: 'pending' },
      ],
    })
    repository.ensureConversation({
      id: conversationId,
      providerId: currentSettings.activeProviderId,
      providerGeneration: currentSettings.activeProviderId
        ? (await environment.settings.getProvider(currentSettings.activeProviderId))?.generation
        : null,
      modelId: currentSettings.activeModelId,
      workspacePath: environment.workspace.getWorkspace()?.path as string,
    })
    repository.appendAuditEvent({
      conversationId,
      type: 'mutation.refresh_required',
      summary: 'A prior file conflict requires an exact refresh.',
      metadata: {
        failureCode: 'HASH_CONFLICT',
        path: refreshPath,
        currentSha256: createHash('sha256').update(refreshContent).digest('hex'),
      },
    })
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      {
        ...runInput(conversationId, '저장된 Goal을 계속해줘'),
        goalId: 'early-effect-recovery-goal',
      },
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(mock.failures).toEqual([])
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(mock.bodies).toHaveLength(14)
    expect(await readFile(join(environment.root, implementedPath), 'utf8')).toBe(
      'implemented early\n',
    )
    expect(repository.pendingMutationRefreshes(conversationId)).toEqual([])
    expect(repository.getCurrentGoalPlan('early-effect-recovery-goal')?.items).toEqual([
      { step: '현재 기능 변경 적용', status: 'in_progress' },
      { step: '후속 통합 검증', status: 'pending' },
    ])
    const auditEvents = repository.getConversation(conversationId)?.auditEvents ?? []
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'mutation.refresh_completed' }),
        expect.objectContaining({
          type: 'goal.work_effect_recovery_started',
          metadata: expect.objectContaining({
            workToolIterations: 7,
            correctionRound: 6,
            recoveryRound: 7,
            remainingToolRounds: 13,
          }),
        }),
      ]),
    )
  })

  it('treats an oversized read-only batch as the dynamic Goal allowance and recovers next round', async () => {
    const evidencePaths = Array.from(
      { length: 25 },
      (_, index) => `fanout-evidence-${String(index + 1)}.txt`,
    )
    const implementedPath = 'fanout-recovery-implementation.txt'
    const toolNames = (body: ResponseBody) =>
      ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name)
    const mock = await startResponsesServer([
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'fanout-recovery-contract',
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'fanout-recovery-authorization',
        }),
      (body) => {
        expect(body.tool_choice).toBe('required')
        expect(toolNames(body)).toContain('read_file')
        return functionCallsEvents(
          evidencePaths.map((path, index) => ({
            name: 'read_file',
            argumentsJson: JSON.stringify({ path }),
            callId: `fanout-read-${String(index + 1)}`,
          })),
        )
      },
      (body) => {
        expect(body.tool_choice).toBe('required')
        expect(body.instructions).toContain('effect-only work-recovery phase')
        expect(body.instructions).toContain('"rounds":19')
        expect(toolNames(body)).toEqual(
          expect.arrayContaining(['propose_file_changes', 'propose_file_patches']),
        )
        for (const name of ['list_files', 'read_file', 'search_text', 'run_command']) {
          expect(toolNames(body)).not.toContain(name)
        }
        return functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: '과도한 읽기 fan-out 이후 현재 frontier 구현',
            changes: [
              { path: implementedPath, baseSha256: null, newContent: 'fanout recovered\n' },
            ],
          }),
          'fanout-recovery-effect',
        )
      },
      (body) => goalActionOutcomeEvents(body, 'verifier', 'complete', 'fanout-outcome-verifier'),
      (body) => goalActionOutcomeEvents(body, 'critic', 'complete', 'fanout-outcome-critic'),
      (body) => {
        expect(body.tool_choice).toEqual({ type: 'function', name: 'update_goal_plan' })
        return functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '현재 frontier 구현을 적용했고 후속 검증은 남았습니다.',
            items: [
              { step: '현재 기능 구현', status: 'completed' },
              { step: '후속 통합 검증', status: 'pending' },
            ],
          }),
          'fanout-recovery-plan',
        )
      },
      () =>
        functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({
            expectedRevision: 999,
            summary: 'fan-out 이후 현재 기능을 구현했고 후속 검증이 남았습니다.',
          }),
          'fanout-recovery-checkpoint',
        ),
      (body) => {
        expect(body.tools).toBeUndefined()
        expect(body.tool_choice).toBe('none')
        return textEvents('현재 기능 구현과 checkpoint 저장을 완료했습니다.', 'fanout-final')
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    for (const path of evidencePaths) await writeFile(join(environment.root, path), `${path}\n`)
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 20,
      maxTotalToolCalls: 100,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'fanout-recovery-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '필요한 근거를 확인하고 현재 기능을 구현한 뒤 검증한다.',
    })
    repository.appendGoalPlan({
      goalId: 'fanout-recovery-goal',
      expectedGoalRevision: 1,
      explanation: '현재 기능 구현을 우선합니다.',
      items: [
        { step: '현재 기능 구현', status: 'in_progress' },
        { step: '후속 통합 검증', status: 'pending' },
      ],
    })
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      {
        ...runInput('fanout-recovery-conversation', '저장된 Goal을 계속해줘'),
        goalId: 'fanout-recovery-goal',
      },
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(mock.failures).toEqual([])
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(mock.bodies).toHaveLength(9)
    expect(await readFile(join(environment.root, implementedPath), 'utf8')).toBe(
      'fanout recovered\n',
    )
    const auditEvents =
      repository.getConversation('fanout-recovery-conversation')?.auditEvents ?? []
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'goal.work_focus_stalled',
          metadata: expect.objectContaining({
            trigger: 'read-fanout',
            workToolIterations: 1,
            readOnlyFanoutAllowance: 5,
            maxReadOnlyToolCallsInRound: 25,
            maxDistinctReadPathsInRound: 25,
            recoveryRound: 1,
          }),
        }),
        expect.objectContaining({
          type: 'goal.work_effect_recovery_started',
          metadata: expect.objectContaining({
            workToolIterations: 1,
            remainingToolRounds: 19,
          }),
        }),
      ]),
    )
  })

  it('cleans stale Goal scope before exposing work effects and selects evidence-backed fixes', async () => {
    const staleAuthentication = '사용자 인증과 권한 부여 구현'
    const staleDeployment = '운영 환경 배포'
    const compileFix = '백엔드 컴파일 오류 수정'
    const verification = '백엔드 테스트와 프런트엔드 빌드 검증'
    const fixedPath = 'backend-compile-fix.txt'
    const names = (body: ResponseBody) =>
      ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name)
    const mock = await startResponsesServer([
      (body) => {
        expect(names(body)).toEqual(['declare_goal_frontier'])
        const classifierInput = JSON.stringify(hostClassifierData(body, 'goal-work-scope'))
        expect(classifierInput).toContain('기존 React + Spring Boot 빌드 오류를 수정')
        expect(classifierInput).toContain(staleAuthentication)
        expect(classifierInput).toContain(staleDeployment)
        expect(classifierInput).toContain(compileFix)
        expect(classifierInput).toContain('Java 컴파일 오류와 npm 의존성 해석 오류')
        expect(body.instructions).not.toContain(staleAuthentication)
        return goalFrontierContractEvents({
          items: [
            { itemIndex: 0 },
            { itemIndex: 1, alignment: 'outside-objective' },
            { itemIndex: 2 },
            { itemIndex: 3 },
          ],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'scope-selection-before-cleanup',
        })
      },
      (body) => {
        expect(names(body)).toEqual(['declare_goal_scope_authorization'])
        const criticInput = JSON.stringify(hostClassifierData(body, 'goal-scope-authorization'))
        expect(criticInput).toContain(staleAuthentication)
        expect(criticInput).not.toContain(staleDeployment)
        expect(criticInput).toContain(compileFix)
        expect(criticInput).toContain(verification)
        expect(criticInput).toContain('Java 컴파일 오류와 npm 의존성 해석 오류')
        expect(body.instructions).not.toContain(staleAuthentication)
        return goalScopeAuthorizationContractEvents({
          items: [
            { itemIndex: 0, authorization: 'outside-objective' },
            { itemIndex: 2, authorization: 'strict-implementation-necessity' },
            { itemIndex: 3, authorization: 'strict-implementation-necessity' },
          ],
          selectedItemIndex: 2,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'scope-critic-before-cleanup',
        })
      },
      (body) => {
        expect(names(body)).toEqual(['declare_goal_scope_rejection_confirmation'])
        const arbiterData = hostClassifierData(body, 'goal-scope-rejection-confirmation')
        const arbiterInput = JSON.stringify(arbiterData)
        expect(arbiterInput).toContain(staleAuthentication)
        expect(arbiterInput).toContain(staleDeployment)
        expect(arbiterInput).toContain('Java 컴파일 오류와 npm 의존성 해석 오류')
        expect(arbiterInput).toContain('proposedCleanupItems')
        expect(arbiterInput).not.toContain('itemAuthorizations')
        expect(arbiterInput).not.toContain('alignment')
        expect(body.instructions).not.toContain(staleAuthentication)
        expect(body.instructions).not.toContain(staleDeployment)
        return goalScopeRejectionContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }],
          callId: 'scope-arbiter-before-cleanup',
        })
      },
      (body) => {
        expect(names(body)).toEqual(['update_goal_plan'])
        expect(body.tool_choice).toEqual({ type: 'function', name: 'update_goal_plan' })
        expect(body.instructions).toContain('pre-work Goal plan-scope cleanup')
        expect(body.instructions).toContain(staleAuthentication)
        expect(body.instructions).toContain(staleDeployment)
        expect(body.instructions).toContain(compileFix)
        return functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '모델이 임의 대체 항목을 제안했지만 호스트 projection이 적용됩니다.',
            items: [
              { step: '모델이 임의로 만든 대체 작업', status: 'in_progress' },
              { step: compileFix, status: 'completed' },
            ],
          }),
          'scope-cleanup-plan',
        )
      },
      (body) => {
        expect(names(body)).toEqual(['declare_goal_frontier'])
        const classifierInput = JSON.stringify(hostClassifierData(body, 'goal-work-scope'))
        expect(classifierInput).not.toContain(staleAuthentication)
        expect(classifierInput).not.toContain(staleDeployment)
        return goalFrontierContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'scope-selection-after-cleanup',
        })
      },
      () =>
        goalScopeAuthorizationContractEvents({
          items: [
            { itemIndex: 0, authorization: 'strict-implementation-necessity' },
            { itemIndex: 1, authorization: 'strict-implementation-necessity' },
          ],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'scope-critic-after-cleanup',
        }),
      (body) => {
        expect(names(body)).toContain('propose_file_changes')
        expect(body.instructions).toContain(compileFix)
        expect(body.instructions).toContain('Host-selected current work frontier')
        expect(body.instructions).not.toContain(staleAuthentication)
        return functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: '컴파일 오류 수정 근거 생성',
            changes: [{ path: fixedPath, baseSha256: null, newContent: 'fixed\n' }],
          }),
          'scope-aligned-effect',
        )
      },
      (body) => goalActionOutcomeEvents(body, 'verifier', 'complete', 'scope-outcome-verifier'),
      (body) => goalActionOutcomeEvents(body, 'critic', 'complete', 'scope-outcome-critic'),
      (body) => {
        expect(body.tool_choice).toEqual({ type: 'function', name: 'update_goal_plan' })
        return functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '컴파일 오류 수정을 적용했고 검증 단계가 남았습니다.',
            items: [
              { step: compileFix, status: 'completed' },
              { step: verification, status: 'pending' },
            ],
          }),
          'scope-aligned-work-plan',
        )
      },
      () =>
        functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({
            expectedRevision: 999,
            summary: '목표 밖 범위를 제거하고 컴파일 오류 수정을 적용했습니다.',
          }),
          'scope-aligned-checkpoint',
        ),
      (body) => {
        expect(body.tools).toBeUndefined()
        expect(body.tool_choice).toBe('none')
        return textEvents('범위를 정리하고 컴파일 오류 수정 단계를 완료했습니다.', 'scope-final')
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 1,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'scope-cleanup-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective:
        '기존 React + Spring Boot 빌드 오류를 수정하고 백엔드 테스트와 프런트엔드 빌드를 통과시킨다.',
    })
    repository.appendGoalPlan({
      goalId: 'scope-cleanup-goal',
      expectedGoalRevision: 1,
      explanation: '이전 모델이 선택 기능과 배포 범위를 과도하게 추가했습니다.',
      items: [
        { step: staleAuthentication, status: 'in_progress' },
        { step: staleDeployment, status: 'pending' },
        { step: compileFix, status: 'pending' },
        { step: verification, status: 'pending' },
      ],
    })
    repository.appendGoalCheckpoint({
      goalId: 'scope-cleanup-goal',
      expectedGoalRevision: 2,
      summary: 'Java 컴파일 오류와 npm 의존성 해석 오류가 현재 완료를 막고 있습니다.',
    })
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      {
        ...runInput('scope-cleanup-conversation', '저장된 Goal을 계속해줘'),
        goalId: 'scope-cleanup-goal',
      },
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(mock.failures).toEqual([])
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, fixedPath), 'utf8')).toBe('fixed\n')
    expect(repository.getCurrentGoalPlan('scope-cleanup-goal')?.items).toEqual([
      { step: compileFix, status: 'completed' },
      { step: verification, status: 'pending' },
    ])
    expect(
      repository
        .listGoalPlanRevisions('scope-cleanup-goal')
        .some((revision) => revision.items.some((item) => item.step === staleAuthentication)),
    ).toBe(true)
    const scopeAudits =
      repository
        .getConversation('scope-cleanup-conversation')
        ?.auditEvents.filter((event) => event.type === 'goal.work_scope_selected') ?? []
    expect(scopeAudits[0]?.metadata).toEqual(
      expect.objectContaining({
        decision: expect.objectContaining({ outOfScopeItemIndices: [0, 1] }),
        focus: expect.objectContaining({
          itemIndex: 2,
          status: 'pending',
        }),
      }),
    )
    expect(
      repository
        .getConversation('scope-cleanup-conversation')
        ?.auditEvents.some((event) => event.type === 'goal.work_scope_cleaned'),
    ).toBe(true)
    expect(
      repository
        .getConversation('scope-cleanup-conversation')
        ?.auditEvents.some(
          (event) =>
            event.type === 'goal.work_scope_rejection_confirmed' &&
            JSON.stringify(event.metadata).includes('"confirmedOutsideItemIndices":[0,1]'),
        ),
    ).toBe(true)
  })

  it('partially cleans confirmed scope, preserves vetoed items, and confirms a later joint frontier before work', async () => {
    const contested = '이전 계획이 추론한 선택 기능'
    const removable = '목표와 무관한 운영 확장'
    const required = '명시된 결과의 구현 오류 수정'
    const changedPath = 'joint-frontier-confirmed.txt'
    const names = (body: ResponseBody) =>
      ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name)
    const mock = await startResponsesServer([
      () =>
        goalFrontierContractEvents({
          items: [
            { itemIndex: 0 },
            { itemIndex: 1, alignment: 'outside-objective' },
            { itemIndex: 2 },
          ],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'partial-cleanup-primary-before',
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [
            { itemIndex: 0, authorization: 'outside-objective' },
            { itemIndex: 2, authorization: 'strict-implementation-necessity' },
          ],
          selectedItemIndex: 2,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'partial-cleanup-critic-before',
        }),
      () =>
        goalScopeRejectionContractEvents({
          items: [
            { itemIndex: 0, disposition: 'direct-objective-entailment' },
            { itemIndex: 1, disposition: 'outside-objective' },
          ],
          callId: 'partial-cleanup-arbiter-before',
        }),
      (body) => {
        expect(names(body)).toEqual(['update_goal_plan'])
        return functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '호스트 projection이 확정된 항목만 제거합니다.',
            items: [],
          }),
          'partial-cleanup-plan',
        )
      },
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'partial-cleanup-primary-after',
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [
            { itemIndex: 0, authorization: 'outside-objective' },
            { itemIndex: 1, authorization: 'strict-implementation-necessity' },
          ],
          selectedItemIndex: 1,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'partial-cleanup-critic-after',
        }),
      () =>
        goalScopeRejectionContractEvents({
          items: [{ itemIndex: 0, disposition: 'direct-objective-entailment' }],
          callId: 'partial-cleanup-arbiter-after',
        }),
      (body) => {
        expect(names(body)).toEqual(['declare_goal_joint_work_contract'])
        const input = JSON.stringify(hostClassifierData(body, 'goal-joint-work-contract'))
        expect(input).toContain(required)
        expect(input).not.toContain(contested)
        return goalJointWorkContractEvents({
          itemIndex: 1,
          authorization: 'strict-implementation-necessity',
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'partial-cleanup-joint-confirmation',
        })
      },
      (body) => {
        expect(names(body)).toContain('propose_file_changes')
        expect(body.instructions).toContain(required)
        return functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: '공동 승인된 항목만 구현',
            changes: [{ path: changedPath, baseSha256: null, newContent: 'confirmed\n' }],
          }),
          'partial-cleanup-work',
        )
      },
      (body) => goalActionOutcomeEvents(body, 'verifier', 'complete', 'partial-outcome-verifier'),
      (body) => goalActionOutcomeEvents(body, 'critic', 'complete', 'partial-outcome-critic'),
      () =>
        functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '공동 승인된 뒤 항목만 완료합니다.',
            items: [
              { step: contested, status: 'in_progress' },
              { step: required, status: 'completed' },
            ],
          }),
          'partial-cleanup-work-plan',
        ),
      () =>
        functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({
            expectedRevision: 999,
            summary: '공동 승인된 오류 수정을 적용했습니다.',
          }),
          'partial-cleanup-checkpoint',
        ),
      () =>
        textEvents(
          '확정된 범위만 정리하고 공동 승인된 항목을 적용했습니다.',
          'partial-cleanup-final',
        ),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const settings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: settings.activeProviderId,
      activeModelId: settings.activeModelId,
      theme: settings.theme,
      maxToolIterations: 1,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'partial-cleanup-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '명시된 결과의 구현 오류를 수정하고 검증한다.',
    })
    repository.appendGoalPlan({
      goalId: 'partial-cleanup-goal',
      expectedGoalRevision: 1,
      explanation: '이전 계획의 혼합 범위를 재검증합니다.',
      items: [
        { step: contested, status: 'in_progress' },
        { step: removable, status: 'pending' },
        { step: required, status: 'pending' },
      ],
    })
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      {
        ...runInput('partial-cleanup-conversation', '저장된 Goal을 계속해줘'),
        goalId: 'partial-cleanup-goal',
      },
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(mock.failures).toEqual([])
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, changedPath), 'utf8')).toBe('confirmed\n')
    expect(repository.getCurrentGoalPlan('partial-cleanup-goal')?.items).toEqual([
      { step: contested, status: 'in_progress' },
      { step: required, status: 'completed' },
    ])
    const audits = repository.getConversation('partial-cleanup-conversation')?.auditEvents ?? []
    expect(audits.some((event) => event.type === 'goal.work_scope_cleanup_vetoed')).toBe(true)
    expect(
      audits.some((event) => event.type === 'goal.work_contract_independently_confirmed'),
    ).toBe(true)
    expect(
      audits.some(
        (event) =>
          event.type === 'goal.work_scope_cleaned' &&
          JSON.stringify(event.metadata).includes('"removedItemIndices":[1]'),
      ),
    ).toBe(true)
  })

  it('validates a response-only Goal candidate before host-projected plan progression', async () => {
    const step = '현재 소스 구조를 분석해 설명한다.'
    const candidate = '현재 소스는 단일 진입점과 분리된 서비스 계층으로 구성되어 있습니다.'
    const finalText = `${candidate} 응답을 검증하고 Goal을 완료했습니다.`
    const names = (body: ResponseBody) =>
      ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name)
    const mock = await startResponsesServer([
      (body) => {
        expect(names(body)).toEqual(['declare_goal_frontier'])
        const classifierInput = JSON.stringify(hostClassifierData(body, 'goal-work-scope'))
        expect(classifierInput).toContain(step)
        expect(classifierInput).not.toContain('저장된 Goal을 계속해줘')
        return goalFrontierContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'response',
          requiredEffects: [],
          callId: 'response-goal-frontier',
        })
      },
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'response',
          requiredEffects: [],
          callId: 'response-goal-scope-authorization',
        }),
      (body) => {
        expect(names(body)).toContain('read_file')
        expect(body.instructions).toContain(step)
        return textEvents(candidate, 'response-goal-candidate')
      },
      (body) => {
        expect(names(body)).toEqual(['declare_run_completion'])
        const classifierInput = JSON.stringify(hostClassifierData(body, 'goal-response-candidate'))
        expect(classifierInput).toContain(candidate)
        expect(classifierInput).toContain(step)
        expect(classifierInput).not.toContain('저장된 Goal을 계속해줘')
        expect(body.instructions).not.toContain(candidate)
        expect(body.instructions).toContain('response-only durable Goal frontier')
        return completionContractEvents('response', {
          candidateDisposition: 'acceptable',
          rationale: 'The candidate directly supplies the requested source-structure analysis.',
          callId: 'response-goal-candidate-contract',
        })
      },
      (body) => {
        expect(names(body)).toEqual(['update_goal_plan'])
        expect(body.instructions).toContain('response-frontier plan projection')
        return functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '모델이 상태를 유지하려 해도 호스트 projection이 적용됩니다.',
            items: [{ step, status: 'pending' }],
          }),
          'response-goal-plan',
        )
      },
      () =>
        functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({
            expectedRevision: 999,
            summary: '검증된 응답 frontier를 완료했습니다.',
          }),
          'response-goal-checkpoint',
        ),
      () =>
        functionCallEvents(
          'finish_goal',
          JSON.stringify({
            expectedRevision: 999,
            status: 'completed',
            summary: '검증된 응답과 최신 checkpoint로 Goal을 완료했습니다.',
          }),
          'response-goal-finish',
        ),
      (body) => {
        expect(body.tools).toBeUndefined()
        expect(body.instructions).toContain(candidate)
        return textEvents(finalText, 'response-goal-final')
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'response-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '현재 소스 구조를 분석해 사용자에게 설명한다.',
    })
    repository.appendGoalPlan({
      goalId: 'response-goal',
      expectedGoalRevision: 1,
      explanation: '분석 응답을 준비합니다.',
      items: [{ step, status: 'pending' }],
    })
    const agent = createAgent(environment, { conversations: repository })

    const result = await collectRun(agent, {
      ...runInput('response-goal-conversation', '저장된 Goal을 계속해줘'),
      goalId: 'response-goal',
    })

    expect(mock.failures).toEqual([])
    expect(result.events.at(-1)?.type).toBe('completed')
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toContain(candidate)
    expect(visibleText).toContain('durable checkpoint')
    expect(visibleText).not.toContain(finalText)
    expect(repository.getCurrentGoalPlan('response-goal')?.items).toEqual([
      { step, status: 'completed' },
    ])
    expect(repository.getGoal('response-goal')).toMatchObject({ status: 'completed' })
    expect(
      repository
        .getConversation('response-goal-conversation')
        ?.auditEvents.map((event) => event.type),
    ).toEqual(
      expect.arrayContaining([
        'goal.response_candidate_accepted',
        'goal.response_candidate_transitioned',
      ]),
    )
  })

  it('discards a rejected response-only Goal draft and retries without displaying it', async () => {
    const step = '실패 원인을 근거와 함께 설명한다.'
    const rejectedDraft = '나중에 원인을 확인하겠습니다.'
    const acceptedDraft = '설정 파일의 잘못된 포트 값이 연결 실패의 직접 원인입니다.'
    const finalText = `${acceptedDraft} 검증 결과를 checkpoint에 저장했습니다.`
    const names = (body: ResponseBody) =>
      ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name)
    const mock = await startResponsesServer([
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'response',
          requiredEffects: [],
          callId: 'retry-response-frontier',
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'response',
          requiredEffects: [],
          callId: 'retry-response-authorization',
        }),
      () => textEvents(rejectedDraft, 'retry-response-rejected-draft'),
      () =>
        completionContractEvents('response', {
          candidateDisposition: 'retry',
          rationale: 'The draft only promises future investigation.',
          callId: 'retry-response-rejected-contract',
        }),
      (body) => {
        expect(body.instructions).toContain('The draft only promises future investigation.')
        return textEvents(acceptedDraft, 'retry-response-accepted-draft')
      },
      () =>
        completionContractEvents('response', {
          candidateDisposition: 'acceptable',
          rationale: 'The candidate gives a concrete evidence-grounded cause.',
          callId: 'retry-response-accepted-contract',
        }),
      (body) => {
        expect(names(body)).toEqual(['update_goal_plan'])
        return functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '검증된 원인 분석을 반영했습니다.',
            items: [{ step, status: 'completed' }],
          }),
          'retry-response-plan',
        )
      },
      () =>
        functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({ expectedRevision: 999, summary: '검증된 원인 분석을 저장했습니다.' }),
          'retry-response-checkpoint',
        ),
      () =>
        functionCallEvents(
          'finish_goal',
          JSON.stringify({
            expectedRevision: 999,
            status: 'completed',
            summary: '검증된 응답으로 Goal을 완료했습니다.',
          }),
          'retry-response-finish',
        ),
      () => textEvents(finalText, 'retry-response-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'retry-response-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '연결 실패 원인을 근거와 함께 설명한다.',
    })
    repository.appendGoalPlan({
      goalId: 'retry-response-goal',
      expectedGoalRevision: 1,
      explanation: '원인 분석 단계입니다.',
      items: [{ step, status: 'in_progress' }],
    })
    const agent = createAgent(environment, { conversations: repository })

    const result = await collectRun(agent, {
      ...runInput('retry-response-conversation', 'Goal을 계속해줘'),
      goalId: 'retry-response-goal',
    })

    expect(mock.failures).toEqual([])
    expect(result.events.at(-1)?.type).toBe('completed')
    const visibleText = result.events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toContain(acceptedDraft)
    expect(visibleText).toContain('durable checkpoint')
    expect(visibleText).not.toContain(finalText)
    expect(visibleText).not.toContain(rejectedDraft)
    expect(repository.listGoalPlanRevisions('retry-response-goal')).toHaveLength(2)
    expect(
      repository
        .getConversation('retry-response-conversation')
        ?.auditEvents.map((event) => event.type),
    ).toEqual(
      expect.arrayContaining([
        'goal.response_candidate_rejected',
        'goal.response_candidate_accepted',
      ]),
    )
  })

  it.each([
    { label: 'empty', legacyItems: [] as Array<{ step: string; status: 'completed' }> },
    {
      label: 'all-completed',
      legacyItems: [{ step: '과거 모델이 완료로 표시한 항목', status: 'completed' as const }],
    },
  ])('replans a $label legacy Goal into an objective-specific pending verification frontier', async ({
    label,
    legacyItems,
  }) => {
    const recoveryStep = `${label} 계획의 목표 결과를 현재 워크스페이스에서 검증한다.`
    const candidate = `${label} 계획의 목표 결과를 현재 상태에서 검증했습니다.`
    const names = (body: ResponseBody) =>
      ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name)
    const mock = await startResponsesServer([
      (body) => {
        expect(names(body)).toEqual(['declare_goal_recovery_plan'])
        const classifierInput = JSON.stringify(hostClassifierData(body, 'goal-recovery-plan'))
        expect(classifierInput).toContain(`${label} 저장 계획의 실제 목표 결과를 검증한다.`)
        expect(classifierInput).not.toContain('저장된 Goal을 계속해줘')
        expect(body.instructions).toContain('stored plan has no unfinished frontier')
        return goalRecoveryPlanContractEvents({
          items: [
            {
              step: recoveryStep,
              purpose: 'objective-verification',
            },
          ],
          callId: `legacy-recovery-contract-${label}`,
        })
      },
      (body) => {
        expect(names(body)).toEqual(['update_goal_plan'])
        expect(body.instructions).toContain('pre-work Goal recovery-plan transition')
        expect(body.instructions).toContain(recoveryStep)
        return functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '모델이 빈 계획을 제안해도 호스트 projection을 사용합니다.',
            items: [],
          }),
          `legacy-recovery-plan-${label}`,
        )
      },
      (body) => {
        expect(names(body)).toEqual(['declare_goal_frontier'])
        const classifierInput = JSON.stringify(hostClassifierData(body, 'goal-work-scope'))
        expect(classifierInput).toContain(recoveryStep)
        expect(classifierInput).not.toContain('저장된 Goal을 계속해줘')
        expect(body.instructions).not.toContain(recoveryStep)
        return goalFrontierContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'response',
          requiredEffects: [],
          callId: `legacy-recovery-frontier-${label}`,
        })
      },
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0, authorization: 'strict-implementation-necessity' }],
          selectedItemIndex: 0,
          requirement: 'response',
          requiredEffects: [],
          callId: `legacy-recovery-authorization-${label}`,
        }),
      () => textEvents(candidate, `legacy-recovery-candidate-${label}`),
      (body) => {
        const classifierInput = JSON.stringify(hostClassifierData(body, 'goal-response-candidate'))
        expect(classifierInput).toContain(candidate)
        expect(classifierInput).toContain(recoveryStep)
        expect(classifierInput).not.toContain('저장된 Goal을 계속해줘')
        return completionContractEvents('response', {
          candidateDisposition: 'acceptable',
          rationale: 'The candidate supplies the objective-verification result.',
          callId: `legacy-recovery-candidate-contract-${label}`,
        })
      },
      () =>
        functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '검증된 recovery frontier를 완료합니다.',
            items: [{ step: recoveryStep, status: 'pending' }],
          }),
          `legacy-recovery-complete-plan-${label}`,
        ),
      () =>
        functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({ expectedRevision: 999, summary: candidate }),
          `legacy-recovery-checkpoint-${label}`,
        ),
      () =>
        functionCallEvents(
          'finish_goal',
          JSON.stringify({
            expectedRevision: 999,
            status: 'completed',
            summary: `${label} legacy 계획을 재검증해 Goal을 완료했습니다.`,
          }),
          `legacy-recovery-finish-${label}`,
        ),
      () =>
        textEvents(
          `${candidate} recovery plan과 checkpoint를 반영했습니다.`,
          `legacy-recovery-final-${label}`,
        ),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const goalId = `legacy-recovery-goal-${label}`
    repository.createGoal({
      id: goalId,
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: `${label} 저장 계획의 실제 목표 결과를 검증한다.`,
    })
    repository.appendGoalPlan({
      goalId,
      expectedGoalRevision: 1,
      explanation: '검증되지 않은 legacy 계획입니다.',
      items: legacyItems,
    })
    const agent = createAgent(environment, { conversations: repository })

    const result = await collectRun(agent, {
      ...runInput(`legacy-recovery-conversation-${label}`, '저장된 Goal을 계속해줘'),
      goalId,
    })

    expect(mock.failures).toEqual([])
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(mock.bodies).toHaveLength(10)
    expect(repository.getCurrentGoalPlan(goalId)?.items).toEqual([
      { step: recoveryStep, status: 'completed' },
    ])
    expect(repository.listGoalPlanRevisions(goalId)).toHaveLength(3)
    expect(repository.getGoal(goalId)).toMatchObject({ status: 'completed' })
    expect(
      repository
        .getConversation(`legacy-recovery-conversation-${label}`)
        ?.auditEvents.map((event) => event.type),
    ).toEqual(
      expect.arrayContaining([
        'goal.recovery_plan_selected',
        'goal.recovery_plan_persisted',
        'goal.work_scope_selected',
      ]),
    )
  })

  it.each([
    'uncertain',
    'invalid',
  ] as const)('fails closed when a legacy Goal recovery plan is %s', async (mode) => {
    const invalidContract = {
      disposition: 'replan',
      items: [
        {
          step: '검증 없는 작업 항목',
          purpose: 'objective-work',
          rationale: 'This deliberately omits an objective-verification item.',
        },
      ],
      rationale: 'Invalid recovery contract for the integration test.',
    }
    const mock = await startResponsesServer(
      mode === 'uncertain'
        ? [
            () =>
              goalRecoveryPlanContractEvents({
                disposition: 'uncertain',
                items: [],
                rationale: 'The objective cannot determine a safe verification plan.',
                callId: 'uncertain-recovery-contract',
              }),
          ]
        : [
            () =>
              functionCallEvents(
                'declare_goal_recovery_plan',
                JSON.stringify(invalidContract),
                'invalid-recovery-primary',
              ),
            (body) => {
              expect(body.tools).toBeUndefined()
              return textEvents(JSON.stringify(invalidContract), 'invalid-recovery-fallback')
            },
          ],
    )
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const goalId = `closed-recovery-goal-${mode}`
    repository.createGoal({
      id: goalId,
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '기존 결과가 실제로 완료되었는지 검증한다.',
    })
    repository.appendGoalPlan({
      goalId,
      expectedGoalRevision: 1,
      explanation: '완료 표시만 남은 legacy 계획입니다.',
      items: [{ step: '검증되지 않은 완료 항목', status: 'completed' }],
    })
    const agent = createAgent(environment, { conversations: repository })

    const result = await collectRun(agent, {
      ...runInput(`closed-recovery-conversation-${mode}`, 'Goal을 계속해줘'),
      goalId,
    })

    expect(mock.failures).toEqual([])
    expect(result.events.at(-1)?.type).toBe('error')
    expect(mock.bodies).toHaveLength(mode === 'uncertain' ? 1 : 2)
    expect(repository.getGoal(goalId)).toMatchObject({ status: 'active' })
    expect(repository.getCurrentGoalPlan(goalId)?.items).toEqual([
      { step: '검증되지 않은 완료 항목', status: 'completed' },
    ])
    expect(
      result.events.some(
        (event) => event.type === 'tool-started' || event.type === 'approval-requested',
      ),
    ).toBe(false)
    expect(
      repository
        .getConversation(`closed-recovery-conversation-${mode}`)
        ?.auditEvents.some((event) => event.type === 'goal.recovery_plan_degraded'),
    ).toBe(true)
  })

  it('fails closed before work when Goal scope remains semantically uncertain', async () => {
    const uncertainContract = {
      itemClassifications: [
        {
          itemIndex: 0,
          alignment: 'uncertain',
          rationale:
            'The objective and checkpoint do not establish whether this feature is required.',
        },
      ],
      selectedItemIndex: null,
      requirement: 'response',
      requiredEffects: [],
      candidateDisposition: 'acceptable',
      rationale: 'No work frontier can be selected safely.',
    }
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'declare_goal_frontier',
          JSON.stringify(uncertainContract),
          'uncertain-goal-scope-primary',
        ),
      (body) => {
        expect(
          ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name),
        ).toEqual(['finish_goal'])
        return functionCallEvents(
          'finish_goal',
          JSON.stringify({
            expectedRevision: 999,
            status: 'completed',
            summary: 'This model-controlled completion must be replaced by the host.',
            untrustedExtra: true,
          }),
          'uncertain-goal-host-block',
        )
      },
      () => textEvents('범위 충돌을 기록하고 Goal을 차단했습니다.', 'uncertain-goal-final'),
      (body) => {
        expect(
          ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name),
        ).toEqual(['declare_goal_frontier'])
        return goalFrontierContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }],
          selectedItemIndex: 0,
          requirement: 'response',
          requiredEffects: [],
          callId: 'scope-after-uncertain-run',
        })
      },
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }],
          selectedItemIndex: 0,
          requirement: 'response',
          requiredEffects: [],
          callId: 'scope-after-uncertain-authorization',
        }),
      (body) => {
        const names = ((body.tools as Array<{ name?: string }> | undefined) ?? []).map(
          (tool) => tool.name,
        )
        expect(names).toContain('read_file')
        expect(names).not.toContain('propose_file_changes')
        expect(names).not.toContain('run_command')
        return textEvents('두 번째 Goal의 범위는 정상적으로 분류되었습니다.', 'scope-recovered')
      },
      () =>
        completionContractEvents('response', {
          candidateDisposition: 'acceptable',
          rationale: 'The second Goal response directly completes the selected review frontier.',
          callId: 'scope-recovered-candidate-contract',
        }),
      () =>
        functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '첫 번째 검토 응답을 완료했습니다.',
            items: [
              { step: '파일 구조 검토', status: 'completed' },
              { step: '검토 결과 후속 확인', status: 'pending' },
            ],
          }),
          'scope-recovered-plan',
        ),
      () =>
        functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({ expectedRevision: 999, summary: '첫 번째 검토 응답을 저장했습니다.' }),
          'scope-recovered-checkpoint',
        ),
      () =>
        textEvents(
          '두 번째 Goal 분류와 checkpoint가 정상 처리되었습니다.',
          'scope-recovered-final',
        ),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'uncertain-scope-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '사용자가 명시한 핵심 기능만 구현한다.',
    })
    repository.appendGoalPlan({
      goalId: 'uncertain-scope-goal',
      expectedGoalRevision: 1,
      explanation: '이전 계획의 범위를 다시 확인해야 합니다.',
      items: [{ step: '추가 선택 기능 구현', status: 'in_progress' }],
    })
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(agent, {
      ...runInput('uncertain-scope-conversation', 'Goal을 계속해줘'),
      goalId: 'uncertain-scope-goal',
    })

    expect(mock.failures).toEqual([])
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(mock.bodies).toHaveLength(3)
    expect(repository.getGoal('uncertain-scope-goal')).toMatchObject({
      status: 'blocked',
      blockedSummary: expect.stringContaining('보류 항목 인덱스: 0'),
    })
    expect(repository.listGoalCheckpoints('uncertain-scope-goal')).toEqual([])
    expect(
      repository
        .getConversation('uncertain-scope-conversation')
        ?.auditEvents.some((event) => event.type === 'goal.work_scope_conflict_bound'),
    ).toBe(true)

    repository.createGoal({
      id: 'scope-after-uncertain-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '저장된 파일 구조를 검토한다.',
    })
    repository.appendGoalPlan({
      goalId: 'scope-after-uncertain-goal',
      expectedGoalRevision: 1,
      explanation: '파일 구조를 검토합니다.',
      items: [
        { step: '파일 구조 검토', status: 'in_progress' },
        { step: '검토 결과 후속 확인', status: 'pending' },
      ],
    })
    const recovered = await collectRun(agent, {
      ...runInput('scope-after-uncertain-conversation', '다음 Goal을 계속해줘'),
      goalId: 'scope-after-uncertain-goal',
    })

    expect(recovered.events.at(-1)?.type).toBe('completed')
    expect(mock.failures).toEqual([])
    expect(mock.bodies).toHaveLength(10)
  })

  it.each([
    'uncertain',
    'invalid-coverage',
  ] as const)('blocks all effects when the independent Goal scope critic is %s', async (mode) => {
    const step = '폐쇄된 목표 결과를 구현하고 검증한다.'
    const criticStep: ResponseStep = () => {
      if (mode === 'uncertain') {
        return goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0, authorization: 'uncertain' }],
          selectedItemIndex: null,
          requirement: 'response',
          requiredEffects: [],
          callId: 'critic-uncertain-contract',
        })
      }
      if (mode === 'invalid-coverage') {
        return goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 1 }],
          selectedItemIndex: 1,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'critic-invalid-coverage-contract',
        })
      }
      throw new Error(`Unhandled critic guard mode: ${mode satisfies never}`)
    }
    const steps: ResponseStep[] = [
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: `critic-guard-primary-${mode}`,
        }),
      criticStep,
    ]
    if (mode !== 'invalid-coverage') {
      steps.push(
        (body) => {
          expect(
            ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name),
          ).toEqual(['finish_goal'])
          return functionCallEvents(
            'finish_goal',
            JSON.stringify({ expectedRevision: 999, status: 'completed', summary: 'ignore' }),
            `critic-guard-block-${mode}`,
          )
        },
        () =>
          textEvents('독립 범위 판정 충돌로 Goal을 차단했습니다.', `critic-guard-final-${mode}`),
      )
    }
    const mock = await startResponsesServer(steps)
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const goalId = `critic-guard-goal-${mode}`
    repository.createGoal({
      id: goalId,
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '명시된 결과만 구현하고 실제 동작을 검증한다.',
    })
    repository.appendGoalPlan({
      goalId,
      expectedGoalRevision: 1,
      explanation: '현재 목표 결과를 진행합니다.',
      items: [{ step, status: 'in_progress' }],
    })
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(agent, {
      ...runInput(`critic-guard-conversation-${mode}`, '저장된 Goal을 계속해줘'),
      goalId,
    })

    expect(mock.failures).toEqual([])
    expect(mock.bodies).toHaveLength(mode === 'invalid-coverage' ? 2 : 4)
    expect(result.events.at(-1)?.type).toBe(mode === 'invalid-coverage' ? 'error' : 'completed')
    expect(approvalRequests(result.events)).toEqual([])
    expect(
      result.events.some(
        (event) =>
          event.type === 'files-changed' ||
          (event.type === 'tool-started' && event.tool !== 'finish_goal'),
      ),
    ).toBe(false)
    expect(repository.listGoalPlanRevisions(goalId)).toHaveLength(1)
    expect(repository.getCurrentGoalPlan(goalId)?.items).toEqual([{ step, status: 'in_progress' }])
    expect(repository.getGoal(goalId)?.status).toBe(
      mode === 'invalid-coverage' ? 'active' : 'blocked',
    )
    expect(
      repository
        .getConversation(`critic-guard-conversation-${mode}`)
        ?.auditEvents.some((event) =>
          mode === 'invalid-coverage'
            ? event.type === 'goal.work_scope_degraded'
            : event.type === 'goal.work_scope_conflict_bound',
        ),
    ).toBe(true)
  })

  it('uses critic and confirmer agreement to resolve a same-frontier effect mismatch', async () => {
    const step = '명시된 결과를 구현하고 실행 검증한다.'
    const names = (body: ResponseBody) =>
      ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name)
    const mock = await startResponsesServer([
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'same-frontier-resolution-primary',
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0, authorization: 'strict-implementation-necessity' }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['process'],
          callId: 'same-frontier-resolution-critic',
        }),
      (body) => {
        expect(names(body)).toEqual(['declare_goal_joint_work_contract'])
        const input = JSON.stringify(hostClassifierData(body, 'goal-joint-work-contract'))
        expect(input).toContain(step)
        return goalJointWorkContractEvents({
          itemIndex: 0,
          authorization: 'strict-implementation-necessity',
          requirement: 'action',
          requiredEffects: ['process'],
          callId: 'same-frontier-resolution-confirmer',
        })
      },
      (body) => {
        expect(names(body)).toContain('run_command')
        expect(names(body)).not.toContain('propose_file_changes')
        return functionCallEvents(
          'run_command',
          JSON.stringify({
            summary: '공동 합의된 실행 검증',
            argv: [process.execPath, '-e', 'process.exit(0)'],
            cwd: null,
            timeoutMs: 5_000,
          }),
          'same-frontier-resolution-work',
        )
      },
      (body) =>
        goalActionOutcomeEvents(
          body,
          'verifier',
          'incomplete',
          'same-frontier-resolution-outcome-verifier',
        ),
      (body) =>
        goalActionOutcomeEvents(
          body,
          'critic',
          'incomplete',
          'same-frontier-resolution-outcome-critic',
        ),
      () =>
        functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '실행 검증 근거를 기록하고 항목을 유지합니다.',
            items: [{ step, status: 'in_progress' }],
          }),
          'same-frontier-resolution-plan',
        ),
      () =>
        functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({ expectedRevision: 999, summary: '실행 검증 효과를 확인했습니다.' }),
          'same-frontier-resolution-checkpoint',
        ),
      () =>
        textEvents(
          '공동 합의된 실행 계약으로 검증을 진행했습니다.',
          'same-frontier-resolution-final',
        ),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const settings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: settings.activeProviderId,
      activeModelId: settings.activeModelId,
      theme: settings.theme,
      maxToolIterations: 1,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'same-frontier-resolution-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '명시된 결과를 구현하고 실제 실행으로 검증한다.',
    })
    repository.appendGoalPlan({
      goalId: 'same-frontier-resolution-goal',
      expectedGoalRevision: 1,
      explanation: '현재 구현 결과를 실행 검증합니다.',
      items: [{ step, status: 'in_progress' }],
    })
    const agent = createAgent(environment, {
      conversations: repository,
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      {
        ...runInput('same-frontier-resolution-conversation', 'Goal을 계속해줘'),
        goalId: 'same-frontier-resolution-goal',
      },
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(mock.failures).toEqual([])
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(
      result.events.some((event) => event.type === 'tool-started' && event.tool === 'run_command'),
    ).toBe(true)
    expect(repository.getGoal('same-frontier-resolution-goal')?.status).toBe('active')
    expect(
      repository
        .getConversation('same-frontier-resolution-conversation')
        ?.auditEvents.some((event) => event.type === 'goal.work_contract_independently_confirmed'),
    ).toBe(true)
  })

  it('blocks a same-frontier confirmer disagreement without exposing work effects', async () => {
    const step = '명시된 결과를 구현하고 검증한다.'
    const mock = await startResponsesServer([
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'same-frontier-block-primary',
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0, authorization: 'strict-implementation-necessity' }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['process'],
          callId: 'same-frontier-block-critic',
        }),
      () =>
        goalJointWorkContractEvents({
          itemIndex: 0,
          authorization: 'strict-implementation-necessity',
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'same-frontier-block-confirmer',
        }),
      (body) => {
        expect(
          ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name),
        ).toEqual(['finish_goal'])
        return functionCallEvents(
          'finish_goal',
          JSON.stringify({ expectedRevision: 999, status: 'completed', summary: 'ignore' }),
          'same-frontier-block-finish',
        )
      },
      () => textEvents('작업 계약 충돌로 Goal을 차단했습니다.', 'same-frontier-block-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'same-frontier-block-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '명시된 결과를 구현하고 검증한다.',
    })
    repository.appendGoalPlan({
      goalId: 'same-frontier-block-goal',
      expectedGoalRevision: 1,
      explanation: '작업 계약을 독립적으로 검증합니다.',
      items: [{ step, status: 'in_progress' }],
    })
    const agent = createAgent(environment, { conversations: repository })

    const result = await collectRun(agent, {
      ...runInput('same-frontier-block-conversation', 'Goal을 계속해줘'),
      goalId: 'same-frontier-block-goal',
    })

    expect(mock.failures).toEqual([])
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(repository.getGoal('same-frontier-block-goal')?.status).toBe('blocked')
    expect(repository.getCurrentGoalPlan('same-frontier-block-goal')?.items).toEqual([
      { step, status: 'in_progress' },
    ])
    expect(approvalRequests(result.events)).toEqual([])
    expect(
      result.events.some(
        (event) =>
          event.type === 'files-changed' ||
          (event.type === 'tool-started' && event.tool !== 'finish_goal'),
      ),
    ).toBe(false)
    const audits = repository.getConversation('same-frontier-block-conversation')?.auditEvents ?? []
    expect(audits.some((event) => event.type === 'goal.work_contract_confirmation_disagreed')).toBe(
      true,
    )
    expect(
      audits.some((event) => event.type === 'goal.work_contract_independently_confirmed'),
    ).toBe(false)
  })

  it('blocks the Goal without effects when the later-frontier confirmer disagrees', async () => {
    const contested = '범위가 충돌한 선행 항목'
    const later = '공동 승인된 후속 구현 항목'
    const mock = await startResponsesServer([
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'confirmer-disagreement-primary',
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [
            { itemIndex: 0, authorization: 'outside-objective' },
            { itemIndex: 1, authorization: 'strict-implementation-necessity' },
          ],
          selectedItemIndex: 1,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'confirmer-disagreement-critic',
        }),
      () =>
        goalScopeRejectionContractEvents({
          items: [{ itemIndex: 0, disposition: 'direct-objective-entailment' }],
          callId: 'confirmer-disagreement-arbiter',
        }),
      () =>
        goalJointWorkContractEvents({
          itemIndex: 1,
          authorization: 'strict-implementation-necessity',
          requirement: 'action',
          requiredEffects: ['process'],
          callId: 'confirmer-disagreement-contract',
        }),
      (body) => {
        expect(
          ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name),
        ).toEqual(['finish_goal'])
        return functionCallEvents(
          'finish_goal',
          JSON.stringify({ expectedRevision: 1, status: 'completed', summary: 'ignore' }),
          'confirmer-disagreement-block',
        )
      },
      () => textEvents('작업 계약 충돌로 Goal을 차단했습니다.', 'confirmer-disagreement-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'confirmer-disagreement-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '명시된 구현 결과를 완성하고 검증한다.',
    })
    repository.appendGoalPlan({
      goalId: 'confirmer-disagreement-goal',
      expectedGoalRevision: 1,
      explanation: '범위 계약을 독립적으로 확인합니다.',
      items: [
        { step: contested, status: 'in_progress' },
        { step: later, status: 'pending' },
      ],
    })
    const agent = createAgent(environment, { conversations: repository })

    const result = await collectRun(agent, {
      ...runInput('confirmer-disagreement-conversation', 'Goal을 계속해줘'),
      goalId: 'confirmer-disagreement-goal',
    })

    expect(mock.failures).toEqual([])
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(repository.getGoal('confirmer-disagreement-goal')).toMatchObject({
      status: 'blocked',
    })
    expect(repository.getCurrentGoalPlan('confirmer-disagreement-goal')?.items).toEqual([
      { step: contested, status: 'in_progress' },
      { step: later, status: 'pending' },
    ])
    expect(approvalRequests(result.events)).toEqual([])
    expect(
      result.events.some(
        (event) =>
          event.type === 'files-changed' ||
          (event.type === 'tool-started' && event.tool !== 'finish_goal'),
      ),
    ).toBe(false)
    expect(
      repository
        .getConversation('confirmer-disagreement-conversation')
        ?.auditEvents.some(
          (event) =>
            event.type === 'goal.work_scope_conflict' &&
            JSON.stringify(event.metadata).includes('"kind":"work-contract-disagreement"'),
        ),
    ).toBe(true)
  })

  it.each([
    'direct-objective-entailment',
    'strict-implementation-necessity',
    'uncertain',
    'invalid-coverage',
    'invalid-json',
  ] as const)('preserves the plan and blocks effects when the cleanup arbiter returns %s', async (mode) => {
    const objective = '명시된 사용자 결과만 구현하고 검증한다.'
    const disputedStep = '이전 계획이 추론한 추가 사용자 기능'
    const checkpoint = '현재 목표 결과의 검증은 아직 완료되지 않았습니다.'
    const arbiterStep: ResponseStep = (body) => {
      const names = ((body.tools as Array<{ name?: string }> | undefined) ?? []).map(
        (tool) => tool.name,
      )
      expect(names).toEqual(['declare_goal_scope_rejection_confirmation'])
      const arbiterInput = JSON.stringify(
        hostClassifierData(body, 'goal-scope-rejection-confirmation'),
      )
      expect(arbiterInput).toContain(objective)
      expect(arbiterInput).toContain(disputedStep)
      expect(arbiterInput).toContain(checkpoint)
      expect(arbiterInput).toContain('proposedCleanupItems')
      expect(arbiterInput).not.toContain('itemAuthorizations')
      expect(arbiterInput).not.toContain('outside-objective rejection')
      expect(body.instructions).not.toContain(disputedStep)
      if (mode === 'invalid-json') {
        return functionCallEvents(
          'declare_goal_scope_rejection_confirmation',
          '{',
          'arbiter-invalid-json-primary',
        )
      }
      if (mode === 'invalid-coverage') {
        return goalScopeRejectionContractEvents({
          items: [{ itemIndex: 1 }],
          callId: 'arbiter-invalid-coverage',
        })
      }
      return goalScopeRejectionContractEvents({
        items: [{ itemIndex: 0, disposition: mode }],
        callId: `arbiter-${mode}`,
      })
    }
    const steps: ResponseStep[] = [
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: `arbiter-guard-primary-${mode}`,
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0, authorization: 'outside-objective' }],
          selectedItemIndex: null,
          requirement: 'response',
          requiredEffects: [],
          callId: `arbiter-guard-critic-${mode}`,
        }),
      arbiterStep,
    ]
    if (mode === 'invalid-json') {
      steps.push((body) => {
        expect(body.tools).toBeUndefined()
        expect(body.tool_choice).toBe('none')
        return textEvents('not a valid contract', 'arbiter-invalid-json-fallback')
      })
    } else if (mode !== 'invalid-coverage') {
      steps.push(
        (body) => {
          expect(
            ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name),
          ).toEqual(['finish_goal'])
          return functionCallEvents(
            'finish_goal',
            JSON.stringify({ expectedRevision: 999, status: 'completed', summary: 'ignore' }),
            `arbiter-veto-block-${mode}`,
          )
        },
        () => textEvents('정리 veto를 보존하고 Goal을 차단했습니다.', `arbiter-veto-final-${mode}`),
      )
    }
    const mock = await startResponsesServer(steps)
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const goalId = `arbiter-guard-goal-${mode}`
    repository.createGoal({
      id: goalId,
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective,
    })
    repository.appendGoalPlan({
      goalId,
      expectedGoalRevision: 1,
      explanation: '이전 계획의 추가 범위를 재검증합니다.',
      items: [{ step: disputedStep, status: 'in_progress' }],
    })
    repository.appendGoalCheckpoint({
      goalId,
      expectedGoalRevision: 2,
      summary: checkpoint,
    })
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(agent, {
      ...runInput(`arbiter-guard-conversation-${mode}`, '저장된 Goal을 계속해줘'),
      goalId,
    })

    expect(mock.failures).toEqual([])
    const semanticVeto =
      mode === 'direct-objective-entailment' ||
      mode === 'strict-implementation-necessity' ||
      mode === 'uncertain'
    expect(mock.bodies).toHaveLength(mode === 'invalid-json' ? 4 : semanticVeto ? 5 : 3)
    expect(result.events.at(-1)?.type).toBe(semanticVeto ? 'completed' : 'error')
    expect(approvalRequests(result.events)).toEqual([])
    expect(
      result.events.some(
        (event) =>
          event.type === 'files-changed' ||
          (event.type === 'tool-started' && event.tool !== 'finish_goal'),
      ),
    ).toBe(false)
    expect(repository.listGoalPlanRevisions(goalId)).toHaveLength(1)
    expect(repository.getCurrentGoalPlan(goalId)?.items).toEqual([
      { step: disputedStep, status: 'in_progress' },
    ])
    expect(repository.getGoal(goalId)?.status).toBe(semanticVeto ? 'blocked' : 'active')
    if (semanticVeto) {
      expect(
        repository
          .getConversation(`arbiter-guard-conversation-${mode}`)
          ?.auditEvents.some((event) => event.type === 'goal.work_scope_cleanup_vetoed'),
      ).toBe(true)
    }
  })

  it('rejects a scope snapshot changed while the cleanup arbiter is in flight', async () => {
    let repository: ConversationRepository | null = null
    const initialStep = '초기 정리 후보'
    const externalStep = '외부에서 갱신된 계획 항목'
    const mock = await startResponsesServer([
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'stale-arbiter-primary',
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0, authorization: 'outside-objective' }],
          selectedItemIndex: null,
          requirement: 'response',
          requiredEffects: [],
          callId: 'stale-arbiter-critic',
        }),
      (body) => {
        expect(
          ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name),
        ).toEqual(['declare_goal_scope_rejection_confirmation'])
        repository?.appendGoalPlan({
          goalId: 'stale-arbiter-goal',
          expectedGoalRevision: 2,
          explanation: 'arbiter 실행 중 외부 계획 변경',
          items: [{ step: externalStep, status: 'in_progress' }],
        })
        return goalScopeRejectionContractEvents({
          items: [{ itemIndex: 0 }],
          callId: 'stale-arbiter-confirmation',
        })
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'stale-arbiter-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '현재 목표에 포함된 항목만 유지한다.',
    })
    repository.appendGoalPlan({
      goalId: 'stale-arbiter-goal',
      expectedGoalRevision: 1,
      explanation: '초기 계획',
      items: [{ step: initialStep, status: 'in_progress' }],
    })
    const agent = createAgent(environment, { conversations: repository })

    const result = await collectRun(agent, {
      ...runInput('stale-arbiter-conversation', '저장된 Goal을 계속해줘'),
      goalId: 'stale-arbiter-goal',
    })

    expect(mock.failures).toEqual([])
    expect(mock.bodies).toHaveLength(3)
    expect(result.events.at(-1)?.type).toBe('error')
    expect(approvalRequests(result.events)).toEqual([])
    expect(result.events.some((event) => event.type === 'tool-started')).toBe(false)
    expect(repository.listGoalPlanRevisions('stale-arbiter-goal')).toHaveLength(2)
    expect(repository.getCurrentGoalPlan('stale-arbiter-goal')?.items).toEqual([
      { step: externalStep, status: 'in_progress' },
    ])
    expect(
      repository
        .getConversation('stale-arbiter-conversation')
        ?.auditEvents.some(
          (event) =>
            event.type === 'goal.work_scope_stale' &&
            JSON.stringify(event.metadata).includes('"phase":"between-classifiers"'),
        ),
    ).toBe(true)
  })

  it('does not complete a retained Goal frontier after an unapplied required effect', async () => {
    const currentStep = '승인이 필요한 현재 구현'
    const nextStep = '후속 검증'
    const mock = await startResponsesServer([
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'denied-focus-contract',
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'denied-focus-authorization',
        }),
      () =>
        functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: '승인이 필요한 변경',
            changes: [{ path: 'must-not-apply.txt', baseSha256: null, newContent: 'denied\n' }],
          }),
          'denied-focus-effect',
        ),
      (body) => {
        expect(body.tool_choice).toEqual({ type: 'function', name: 'update_goal_plan' })
        return functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '실패한 현재 항목을 완료로 위장합니다.',
            items: [
              { step: currentStep, status: 'completed' },
              { step: nextStep, status: 'pending' },
            ],
          }),
          'denied-false-plan',
        )
      },
      (body) => {
        expect(body.tool_choice).toEqual({ type: 'function', name: 'update_goal_plan' })
        expect(body.instructions).toContain(
          'did not observe completion of the current work contract',
        )
        return functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '실패한 현재 항목을 진행 중으로 보존합니다.',
            items: [
              { step: currentStep, status: 'in_progress' },
              { step: nextStep, status: 'pending' },
            ],
          }),
          'denied-preserved-plan',
        )
      },
      () =>
        functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({
            expectedRevision: 999,
            summary: '변경 승인이 거부되어 현재 항목을 진행 중으로 보존했습니다.',
          }),
          'denied-checkpoint',
        ),
      (body) => {
        expect(body.tools).toBeUndefined()
        expect(body.tool_choice).toBe('none')
        expect(body.instructions).toContain('"unmetContract":["workspace-change"]')
        return textEvents('변경이 승인되지 않아 Goal은 진행 중입니다.', 'denied-final')
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 1,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'denied-focus-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '승인된 변경만 적용하며 현재 구현을 완료한다.',
    })
    repository.appendGoalPlan({
      goalId: 'denied-focus-goal',
      expectedGoalRevision: 1,
      explanation: '현재 구현 후 검증합니다.',
      items: [
        { step: currentStep, status: 'in_progress' },
        { step: nextStep, status: 'pending' },
      ],
    })
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      {
        ...runInput('denied-focus-conversation', '현재 Goal 항목을 구현해줘'),
        goalId: 'denied-focus-goal',
      },
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'denied')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(mock.failures).toEqual([])
    expect(mock.bodies).toHaveLength(7)
    expect(
      result.events
        .filter(
          (event): event is Extract<AgentEvent, { type: 'tool-completed' }> =>
            event.type === 'tool-completed' && event.tool === 'update_goal_plan',
        )
        .map((event) => event.ok),
    ).toEqual([false, true])
    expect(repository.getGoal('denied-focus-goal')).toMatchObject({ status: 'active' })
    expect(repository.getCurrentGoalPlan('denied-focus-goal')?.items).toEqual([
      { step: currentStep, status: 'in_progress' },
      { step: nextStep, status: 'pending' },
    ])
    expect(
      result.events.some((event) => event.type === 'tool-started' && event.tool === 'finish_goal'),
    ).toBe(false)
    await expect(
      readFile(join(environment.root, 'must-not-apply.txt'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects deleting, advancing, or inserting plan items outside the selected Goal frontier', async () => {
    const currentStep = '현재 선택된 구현'
    const nextStep = '다음 실행에서 수행할 검증'
    const changedPath = 'frontier-only-change.txt'
    const mock = await startResponsesServer([
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'strict-plan-frontier-contract',
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0 }, { itemIndex: 1 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'strict-plan-frontier-authorization',
        }),
      () =>
        functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: '현재 frontier만 구현',
            changes: [{ path: changedPath, baseSha256: null, newContent: 'changed\n' }],
          }),
          'strict-plan-effect',
        ),
      (body) =>
        goalActionOutcomeEvents(body, 'verifier', 'complete', 'strict-plan-outcome-verifier'),
      (body) => goalActionOutcomeEvents(body, 'critic', 'complete', 'strict-plan-outcome-critic'),
      () =>
        functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '기존 항목을 삭제하고 순서를 바꾸려는 잘못된 전이',
            items: [{ step: nextStep, status: 'pending' }],
          }),
          'strict-plan-delete-reorder',
        ),
      () =>
        functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '선택되지 않은 항목까지 완료하려는 잘못된 전이',
            items: [
              { step: currentStep, status: 'completed' },
              { step: nextStep, status: 'completed' },
            ],
          }),
          'strict-plan-advance-other',
        ),
      () =>
        functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 999,
            explanation: '새 항목을 진행 중으로 삽입하려는 잘못된 전이',
            items: [
              { step: currentStep, status: 'completed' },
              { step: nextStep, status: 'pending' },
              { step: '새 후속 작업', status: 'in_progress' },
            ],
          }),
          'strict-plan-nonpending-addition',
        ),
      (body) => {
        expect(body.tools).toBeUndefined()
        expect(body.tool_choice).toBe('none')
        return textEvents(
          '현재 frontier 변경은 적용했지만 잘못된 계획 전이는 거부되었습니다.',
          'strict-plan-final',
        )
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const settings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: settings.activeProviderId,
      activeModelId: settings.activeModelId,
      theme: settings.theme,
      maxToolIterations: 1,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'strict-plan-frontier-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '현재 선택된 구현만 완료하고 다음 검증은 이후 실행에 남긴다.',
    })
    repository.appendGoalPlan({
      goalId: 'strict-plan-frontier-goal',
      expectedGoalRevision: 1,
      explanation: '한 실행에는 현재 frontier만 진행합니다.',
      items: [
        { step: currentStep, status: 'in_progress' },
        { step: nextStep, status: 'pending' },
      ],
    })
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      {
        ...runInput('strict-plan-frontier-conversation', '현재 Goal frontier를 구현해줘'),
        goalId: 'strict-plan-frontier-goal',
      },
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(mock.failures).toEqual([])
    expect(await readFile(join(environment.root, changedPath), 'utf8')).toBe('changed\n')
    expect(
      result.events
        .filter(
          (event): event is Extract<AgentEvent, { type: 'tool-completed' }> =>
            event.type === 'tool-completed' && event.tool === 'update_goal_plan',
        )
        .map((event) => event.ok),
    ).toEqual([false, false, false])
    expect(repository.getCurrentGoalPlan('strict-plan-frontier-goal')?.items).toEqual([
      { step: currentStep, status: 'in_progress' },
      { step: nextStep, status: 'pending' },
    ])
  })

  it('exposes and executes only effect tools authorized by the Goal frontier contract', async () => {
    const forbiddenPath = 'must-not-run-from-wrong-effect.txt'
    const toolNames = (body: ResponseBody) =>
      ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((tool) => tool.name)
    const mock = await startResponsesServer([
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'authorized-workspace-effect-contract',
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'authorized-workspace-effect-authorization',
        }),
      (body) => {
        expect(toolNames(body)).toContain('read_file')
        expect(toolNames(body)).toContain('propose_file_changes')
        expect(toolNames(body)).not.toContain('run_command')
        return functionCallEvents(
          'run_command',
          JSON.stringify({
            summary: '계약에 없는 process effect 호출',
            argv: ['touch', forbiddenPath],
            cwd: null,
            timeoutMs: null,
          }),
          'forbidden-process-effect',
        )
      },
      (body) => {
        expect(body.tool_choice).toBe('none')
        return textEvents('계약 밖 process 호출은 실행되지 않았습니다.', 'forbidden-effect-final')
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const settings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: settings.activeProviderId,
      activeModelId: settings.activeModelId,
      theme: settings.theme,
      maxToolIterations: 1,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'authorized-effect-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '파일 변경만 수행하고 명령은 실행하지 않는다.',
    })
    repository.appendGoalPlan({
      goalId: 'authorized-effect-goal',
      expectedGoalRevision: 1,
      explanation: '파일 변경 frontier입니다.',
      items: [{ step: '파일 변경 적용', status: 'in_progress' }],
    })
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(agent, {
      ...runInput('authorized-effect-conversation', 'Goal 파일 변경을 계속해줘'),
      goalId: 'authorized-effect-goal',
    })

    expect(result.events.at(-1)?.type).toBe('error')
    expect(mock.failures).toEqual([])
    expect(approvalRequests(result.events)).toEqual([])
    expect(
      result.events.find(
        (event) => event.type === 'tool-completed' && event.tool === 'run_command',
      ),
    ).toMatchObject({ ok: false })
    await expect(readFile(join(environment.root, forbiddenPath), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects a Goal scope snapshot that changes while classification is in flight', async () => {
    let repository: ConversationRepository | null = null
    const mock = await startResponsesServer([
      () => {
        repository?.appendGoalPlan({
          goalId: 'stale-before-work-goal',
          expectedGoalRevision: 2,
          explanation: '분류 도중 외부에서 계획이 변경되었습니다.',
          items: [{ step: '외부에서 갱신된 작업', status: 'in_progress' }],
        })
        return goalFrontierContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'stale-before-work-contract',
        })
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'stale-before-work-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '현재 계획 snapshot에 맞는 작업만 수행한다.',
    })
    repository.appendGoalPlan({
      goalId: 'stale-before-work-goal',
      expectedGoalRevision: 1,
      explanation: '초기 계획입니다.',
      items: [{ step: '초기 작업', status: 'in_progress' }],
    })
    const agent = createAgent(environment, { conversations: repository })

    const result = await collectRun(agent, {
      ...runInput('stale-before-work-conversation', 'Goal을 계속해줘'),
      goalId: 'stale-before-work-goal',
    })

    expect(result.events.at(-1)?.type).toBe('error')
    expect(mock.failures).toEqual([])
    expect(mock.bodies).toHaveLength(1)
    expect(
      repository
        .getConversation('stale-before-work-conversation')
        ?.auditEvents.some(
          (event) =>
            event.type === 'goal.work_scope_stale' &&
            JSON.stringify(event.metadata).includes('"phase":"between-classifiers"'),
        ),
    ).toBe(true)
  })

  it('rechecks the classified Goal scope immediately before executing a returned effect', async () => {
    let repository: ConversationRepository | null = null
    const forbiddenPath = 'stale-scope-effect.txt'
    const mock = await startResponsesServer([
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'stale-before-effect-contract',
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'action',
          requiredEffects: ['workspace-change'],
          callId: 'stale-before-effect-authorization',
        }),
      () => {
        repository?.appendGoalPlan({
          goalId: 'stale-before-effect-goal',
          expectedGoalRevision: 2,
          explanation: 'work turn 중 외부에서 계획이 변경되었습니다.',
          items: [{ step: '외부에서 대체된 작업', status: 'in_progress' }],
        })
        return functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: 'stale snapshot 기반 변경',
            changes: [{ path: forbiddenPath, baseSha256: null, newContent: 'must not exist\n' }],
          }),
          'stale-before-effect-call',
        )
      },
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'stale-before-effect-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '분류된 현재 계획 snapshot의 파일 변경만 적용한다.',
    })
    repository.appendGoalPlan({
      goalId: 'stale-before-effect-goal',
      expectedGoalRevision: 1,
      explanation: '초기 계획입니다.',
      items: [{ step: '초기 파일 변경', status: 'in_progress' }],
    })
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(agent, {
      ...runInput('stale-before-effect-conversation', 'Goal 파일 변경을 계속해줘'),
      goalId: 'stale-before-effect-goal',
    })

    expect(result.events.at(-1)?.type).toBe('error')
    expect(mock.failures).toEqual([])
    expect(mock.bodies).toHaveLength(3)
    expect(approvalRequests(result.events)).toEqual([])
    await expect(readFile(join(environment.root, forbiddenPath), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(
      repository
        .getConversation('stale-before-effect-conversation')
        ?.auditEvents.some(
          (event) =>
            event.type === 'goal.work_scope_stale' &&
            JSON.stringify(event.metadata).includes('"phase":"before-effect"'),
        ),
    ).toBe(true)
  })

  it('finalizes a verified run slice before exposing any post-checkpoint workspace mutation', async () => {
    const original = 'before\n'
    const mock = await startResponsesServer([
      () => functionCallEvents('list_files', JSON.stringify({ path: null }), 'stale-list'),
      () =>
        functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 1,
            explanation: '완료 계획',
            items: [{ step: '검증된 작업', status: 'in_progress' }],
          }),
          'stale-plan',
        ),
      () =>
        functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({ expectedRevision: 2, summary: '변경 전 검증 checkpoint' }),
          'stale-checkpoint',
        ),
      () => textEvents('checkpoint까지 검증된 현재 run 결과를 정리했습니다.', 'verified-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'value.txt'), original)
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'stale-evidence-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '마지막 부수효과 이후에만 완료한다.',
    })
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      {
        ...runInput('stale-evidence-conversation', 'Goal을 진행해줘'),
        goalId: 'stale-evidence-goal',
      },
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, 'value.txt'), 'utf8')).toBe(original)
    expect(approvalRequests(result.events)).toEqual([])
    expect(result.events.some((event) => event.type === 'files-changed')).toBe(false)
    expect(mock.failures).toEqual([])
    expect(mock.bodies).toHaveLength(4)
    expect(mock.bodies[3].tools).toBeUndefined()
    expect(mock.bodies[3].tool_choice).toBe('none')
    expect(repository.getGoal('stale-evidence-goal')).toMatchObject({
      status: 'active',
      revision: 3,
      completionSummary: null,
    })
  })

  it('rolls back a stale atomic Goal finish and does not reuse its failed driver session', async () => {
    let repository: ConversationRepository | null = null
    const mock = await startResponsesServer([
      () =>
        goalFrontierContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'response',
          requiredEffects: [],
          callId: 'atomic-goal-frontier',
        }),
      () =>
        goalScopeAuthorizationContractEvents({
          items: [{ itemIndex: 0 }],
          selectedItemIndex: 0,
          requirement: 'response',
          requiredEffects: [],
          callId: 'atomic-goal-authorization',
        }),
      () =>
        functionCallEvents(
          'read_file',
          JSON.stringify({ path: 'atomic-evidence.txt' }),
          'atomic-evidence-read',
        ),
      () => textEvents('원자 완료 근거를 확인했습니다.', 'atomic-response-candidate'),
      () =>
        completionContractEvents('response', {
          candidateDisposition: 'acceptable',
          rationale: 'The candidate reports the inspected atomic completion evidence.',
          callId: 'atomic-response-candidate-contract',
        }),
      () =>
        functionCallEvents(
          'update_goal_plan',
          JSON.stringify({
            expectedRevision: 2,
            explanation: '완료 계획',
            items: [{ step: '원자적으로 완료', status: 'completed' }],
          }),
          'atomic-plan',
        ),
      () =>
        functionCallEvents(
          'checkpoint_goal',
          JSON.stringify({ expectedRevision: 3, summary: '원자 완료 검증' }),
          'atomic-checkpoint',
        ),
      () =>
        functionCallEvents(
          'finish_goal',
          JSON.stringify({
            expectedRevision: 999,
            status: 'completed',
            summary: '원자 완료 요청',
          }),
          'atomic-finish',
        ),
      () => {
        repository?.updateGoal('atomic-goal', { expectedRevision: 4, tokenBudget: 1_000 })
        return textEvents('이 응답은 revision 충돌로 커밋되면 안 됩니다.', 'atomic-stale-final')
      },
      () => textEvents('깨끗한 세션에서 다시 시작했습니다.', 'atomic-retry-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'atomic-evidence.txt'), 'atomic evidence\n')
    repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'atomic-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: 'run과 Goal을 원자적으로 완료한다.',
    })
    repository.appendGoalPlan({
      goalId: 'atomic-goal',
      expectedGoalRevision: 1,
      explanation: '원자 완료 검증을 위한 기존 계획',
      items: [{ step: '원자적으로 완료', status: 'in_progress' }],
    })
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 4,
    })
    const agent = createAgent(environment, { conversations: repository })

    const failed = await collectRun(agent, {
      ...runInput('atomic-conversation', '첫 번째 원자 완료 시도'),
      goalId: 'atomic-goal',
    })
    expect(failed.events.at(-1)).toMatchObject({ type: 'error' })
    expect(repository.getGoal('atomic-goal')).toMatchObject({
      status: 'active',
      revision: 5,
      completionSummary: null,
    })
    expect(repository.getConversation('atomic-conversation')?.runs).toEqual([
      expect.objectContaining({ id: failed.runId, status: 'error' }),
    ])

    const retry = await collectRun(agent, {
      ...runInput('atomic-conversation', '두 번째 깨끗한 시도'),
      intent: 'answer',
    })
    expect(retry.events.at(-1)?.type).toBe('completed')
    const retryInput = JSON.stringify(inputItems(mock.bodies[9]))
    expect(retryInput).toContain('두 번째 깨끗한 시도')
    expect(retryInput).not.toContain('첫 번째 원자 완료 시도')
    expect(retryInput).not.toContain('atomic-finish')
  })

  it('allows only one active run per Goal across conversations and releases the claim', async () => {
    const mock = await startResponsesServer([() => textEvents('완료', 'single-goal-run')])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'single-active-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '동시에 하나의 run만 실행한다.',
    })
    const agent = createAgent(environment, { conversations: repository })
    let resolveTerminal: (() => void) | undefined
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve
    })
    const first = agent.startRun(
      {
        ...runInput('goal-claim-first', '첫 번째 실행'),
        goalId: 'single-active-goal',
      },
      (event) => {
        if (event.type === 'completed' || event.type === 'cancelled' || event.type === 'error') {
          resolveTerminal?.()
        }
      },
    )

    expect(() =>
      agent.startRun(
        {
          ...runInput('goal-claim-second', '두 번째 실행'),
          goalId: 'single-active-goal',
        },
        () => undefined,
      ),
    ).toThrow('같은 Goal에서 이미 작업을 실행하고 있습니다.')

    agent.cancelRun(first.runId)
    await terminal
    const retry = agent.startRun(
      {
        ...runInput('goal-claim-retry', 'claim 해제 뒤 재실행'),
        goalId: 'single-active-goal',
      },
      () => undefined,
    )
    agent.cancelRun(retry.runId)
  })

  it('charges completed provider turns to a Goal budget even when the run fails later', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallEvents('read_file', '{"path":"evidence.txt"}', 'budget-read-1', {
          input: 10,
          output: 5,
          reasoning: 1,
        }),
      () =>
        functionCallEvents('read_file', '{"path":"evidence.txt"}', 'budget-read-2', {
          input: 7,
          output: 3,
          reasoning: 0,
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'evidence.txt'), 'verified\n')
    const currentSettings = await environment.settings.getSettings()
    await environment.settings.saveSettings({
      activeProviderId: currentSettings.activeProviderId,
      activeModelId: currentSettings.activeModelId,
      theme: currentSettings.theme,
      maxToolIterations: 1,
    })
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    repository.createGoal({
      id: 'failed-run-budget-goal',
      workspacePath: environment.workspace.getWorkspace()?.path as string,
      objective: '실패한 run의 소비량도 기록한다.',
      tokenBudget: 100,
    })
    const agent = createAgent(environment, { conversations: repository })

    const result = await collectRun(agent, {
      ...runInput('failed-run-budget-conversation', '두 번 읽어줘'),
      goalId: 'failed-run-budget-goal',
    })

    expect(result.events.at(-1)).toMatchObject({ type: 'error' })
    expect(repository.getGoal('failed-run-budget-goal')).toMatchObject({
      status: 'active',
      usedTokens: 25,
    })
    expect(repository.getConversation('failed-run-budget-conversation')?.runs).toEqual([
      expect.objectContaining({
        id: result.runId,
        status: 'error',
        usage: { inputTokens: 17, outputTokens: 8, reasoningTokens: 1, totalTokens: 25 },
      }),
    ])
  })

  it('binds file changes to exact approvals, keeps denials inert, applies approval, and supports undo', async () => {
    const original = 'before\n'
    const originalHash = createHash('sha256').update(original).digest('hex')
    const deniedArguments = JSON.stringify({
      summary: '거절할 변경',
      changes: [{ path: 'value.txt', baseSha256: originalHash, newContent: 'denied\n' }],
    })
    const approvedArguments = JSON.stringify({
      summary: '승인할 변경',
      changes: [{ path: 'value.txt', baseSha256: originalHash, newContent: 'approved\n' }],
    })
    const mock = await startResponsesServer([
      () => functionCallEvents('propose_file_changes', deniedArguments, 'change-denied'),
      () => textEvents('변경하지 않았습니다.', 'change-denied-final'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          rationale: 'The requested file change was denied and the candidate reports that blocker.',
          callId: 'change-denied-contract',
        }),
      () => functionCallEvents('propose_file_changes', approvedArguments, 'change-approved'),
      () => textEvents('승인된 변경을 적용했습니다.', 'change-approved-final'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          rationale: 'The requested file change was applied and the candidate reports it.',
          callId: 'change-approved-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'value.txt'), original)
    const mutations = new MutationService(environment.workspace, {
      journalDirectory: await temporaryDirectory(),
    })
    const agent = createAgent(environment, { mutations })

    const denied = await collectRun(
      agent,
      runInput('denied-mutation', '변경을 제안해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'denied')
        }
      },
    )
    const deniedApproval = approvalRequests(denied.events)[0]
    expect(deniedApproval).toMatchObject({
      kind: 'file-change',
      summary: '거절할 변경',
      changes: [
        {
          path: 'value.txt',
          kind: 'update',
          beforeHash: originalHash,
        },
      ],
    })
    expect(deniedApproval.actionHash).toMatch(/^[a-f0-9]{64}$/)
    expect(functionOutput(mock.bodies[1])).toMatchObject({
      ok: true,
      result: {
        applied: false,
        decision: 'denied',
        actionHash: deniedApproval.actionHash,
      },
    })
    expect(await readFile(join(environment.root, 'value.txt'), 'utf8')).toBe(original)
    expect(denied.events.some((event) => event.type === 'files-changed')).toBe(false)

    const approved = await collectRun(
      agent,
      runInput('approved-mutation', '이번 변경은 적용해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )
    const approvedApproval = approvalRequests(approved.events)[0]
    expect(approvedApproval).toMatchObject({
      kind: 'file-change',
      summary: '승인할 변경',
      changes: [{ path: 'value.txt', beforeHash: originalHash }],
    })
    expect(functionOutput(mock.bodies[4])).toMatchObject({
      ok: true,
      result: {
        applied: true,
        actionHash: approvedApproval.actionHash,
        changedPaths: ['value.txt'],
        undoAvailable: true,
      },
    })
    expect(approved.events).toContainEqual({
      runId: approved.runId,
      type: 'files-changed',
      paths: ['value.txt'],
      undoAvailable: true,
    })
    expect(await readFile(join(environment.root, 'value.txt'), 'utf8')).toBe('approved\n')

    await expect(mutations.undoLast()).resolves.toMatchObject({ restoredPaths: ['value.txt'] })
    expect(await readFile(join(environment.root, 'value.txt'), 'utf8')).toBe(original)
  })

  it('executes same-turn approval-required tool calls sequentially in provider order', async () => {
    const originalA = 'a-before\n'
    const originalB = 'b-before\n'
    const argumentsA = JSON.stringify({
      summary: 'first approved change',
      changes: [
        {
          path: 'a.txt',
          baseSha256: createHash('sha256').update(originalA).digest('hex'),
          newContent: 'a-after\n',
        },
      ],
    })
    const argumentsB = JSON.stringify({
      summary: 'second approved change',
      changes: [
        {
          path: 'b.txt',
          baseSha256: createHash('sha256').update(originalB).digest('hex'),
          newContent: 'b-after\n',
        },
      ],
    })
    const mock = await startResponsesServer([
      () =>
        functionCallsEvents([
          {
            name: 'propose_file_changes',
            argumentsJson: argumentsA,
            callId: 'ordered-change-a',
          },
          {
            name: 'propose_file_changes',
            argumentsJson: argumentsB,
            callId: 'ordered-change-b',
          },
        ]),
      () => textEvents('두 변경을 순서대로 적용했습니다.', 'ordered-changes-final'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          rationale: 'Both requested file changes were applied.',
          callId: 'ordered-changes-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'a.txt'), originalA)
    await writeFile(join(environment.root, 'b.txt'), originalB)
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })
    let firstToolCompleted = false
    let secondApprovalOverlapped = false

    const result = await collectRun(
      agent,
      runInput('ordered-side-effects', '두 파일을 변경해줘'),
      (event) => {
        if (event.type === 'tool-completed' && event.callId === 'ordered-change-a') {
          firstToolCompleted = true
        }
        if (event.type !== 'approval-requested') return
        if (event.request.summary === 'first approved change') {
          setTimeout(() => {
            agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
          }, 40)
          return
        }
        if (event.request.summary === 'second approved change') {
          secondApprovalOverlapped = !firstToolCompleted
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(secondApprovalOverlapped).toBe(false)
    expect(approvalRequests(result.events).map((request) => request.summary)).toEqual([
      'first approved change',
      'second approved change',
    ])
    expect(
      result.events
        .filter((event) => event.type === 'tool-started' || event.type === 'tool-completed')
        .map((event) => [event.type, event.callId]),
    ).toEqual([
      ['tool-started', 'ordered-change-a'],
      ['tool-completed', 'ordered-change-a'],
      ['tool-started', 'ordered-change-b'],
      ['tool-completed', 'ordered-change-b'],
    ])
    expect(await readFile(join(environment.root, 'a.txt'), 'utf8')).toBe('a-after\n')
    expect(await readFile(join(environment.root, 'b.txt'), 'utf8')).toBe('b-after\n')
    expect(result.events.at(-1)?.type).toBe('completed')
    expect(mock.failures).toEqual([])
  })

  it('serializes approval-required side effects across concurrent runs', async () => {
    const originalA = 'run-a-before\n'
    const originalB = 'run-b-before\n'
    const toolResponse = (body: ResponseBody): unknown[] => {
      const serializedInput = JSON.stringify(inputItems(body))
      const isRunA = serializedInput.includes('concurrent run A')
      const original = isRunA ? originalA : originalB
      return functionCallEvents(
        'propose_file_changes',
        JSON.stringify({
          summary: isRunA ? 'concurrent change A' : 'concurrent change B',
          changes: [
            {
              path: isRunA ? 'run-a.txt' : 'run-b.txt',
              baseSha256: createHash('sha256').update(original).digest('hex'),
              newContent: isRunA ? 'run-a-after\n' : 'run-b-after\n',
            },
          ],
        }),
        isRunA ? 'concurrent-change-a' : 'concurrent-change-b',
      )
    }
    const concurrentResponse = (body: ResponseBody): unknown[] => {
      const serializedInput = JSON.stringify(inputItems(body))
      const isRunA = serializedInput.includes('concurrent run A')
      const toolNames = ((body.tools as Array<{ name?: unknown }> | undefined) ?? []).map(
        (tool) => tool.name,
      )
      if (toolNames.includes('declare_run_completion')) {
        return completionContractEvents('action', {
          requiredEffects: ['workspace-change'],
          rationale: 'The requested concurrent file change was applied.',
          callId: isRunA ? 'concurrent-contract-a' : 'concurrent-contract-b',
        })
      }
      if (serializedInput.includes('function_call_output')) {
        return textEvents(
          '변경을 적용했습니다.',
          isRunA ? 'concurrent-final-a' : 'concurrent-final-b',
        )
      }
      return toolResponse(body)
    }
    const mock = await startResponsesServer(Array.from({ length: 6 }, () => concurrentResponse))
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'run-a.txt'), originalA)
    await writeFile(join(environment.root, 'run-b.txt'), originalB)
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })
    let pendingApprovalCount = 0
    let maximumPendingApprovalCount = 0
    const handleEvent = (event: AgentEvent): void => {
      if (event.type === 'approval-requested') {
        pendingApprovalCount += 1
        maximumPendingApprovalCount = Math.max(maximumPendingApprovalCount, pendingApprovalCount)
        void (async () => {
          const deadline = Date.now() + 2_000
          while (mock.bodies.length < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        })()
      } else if (event.type === 'approval-resolved') {
        pendingApprovalCount -= 1
      }
    }

    const [runA, runB] = await Promise.all([
      collectRun(agent, runInput('concurrent-a', 'concurrent run A'), handleEvent),
      collectRun(agent, runInput('concurrent-b', 'concurrent run B'), handleEvent),
    ])

    expect(maximumPendingApprovalCount).toBe(1)
    expect(pendingApprovalCount).toBe(0)
    expect(mock.failures).toEqual([])
    expect(runA.events.at(-1)?.type).toBe('completed')
    expect(runB.events.at(-1)?.type).toBe('completed')
    expect(await readFile(join(environment.root, 'run-a.txt'), 'utf8')).toBe('run-a-after\n')
    expect(await readFile(join(environment.root, 'run-b.txt'), 'utf8')).toBe('run-b-after\n')
  })

  it('auto-approves a bounded workspace file policy without creating a manual ticket', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: '자동 파일 생성',
            changes: [{ path: 'src/auto.txt', baseSha256: null, newContent: 'created\n' }],
          }),
          'auto-file-change',
        ),
      () => textEvents('자동 변경을 적용했습니다.', 'auto-file-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await mkdir(join(environment.root, 'src'))
    await environment.settings.saveWorkspaceApprovalPolicy(
      environment.workspace.getWorkspace()?.path as string,
      {
        fileChanges: {
          mode: 'auto',
          scope: 'all-act-runs',
          rules: [{ pathPrefix: 'src', operations: ['create', 'update'] }],
          maxFilesPerRequest: 5,
          maxChangedLinesPerRequest: 100,
          maxChangedBytesPerRequest: 10_000,
        },
        commands: { mode: 'manual' },
      },
    )
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = createAgent(environment, {
      conversations: repository,
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('auto-file-conversation', '허용된 파일을 생성해줘'),
    )

    expect(approvalRequests(result.events)).toEqual([])
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'approval-resolved',
        decision: 'approved',
        automatic: true,
        ruleId: 'file:0',
      }),
    )
    expect(await readFile(join(environment.root, 'src', 'auto.txt'), 'utf8')).toBe('created\n')
    expect(repository.getConversation('auto-file-conversation')?.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'approval.policy_evaluated' }),
        expect.objectContaining({ type: 'approval.auto_approved' }),
      ]),
    )
    expect(repository.getConversation('auto-file-conversation')?.runs[0]?.policyId).toMatch(
      /^workspace-approval:[a-f0-9]{64}$/,
    )
  })

  it('falls back to exact manual approval when a file request exceeds its path grant', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: '범위 밖 파일 생성',
            changes: [{ path: 'docs/manual.txt', baseSha256: null, newContent: 'reviewed\n' }],
          }),
          'manual-file-change',
        ),
      () => textEvents('검토 후 변경했습니다.', 'manual-file-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await mkdir(join(environment.root, 'docs'))
    await environment.settings.saveWorkspaceApprovalPolicy(
      environment.workspace.getWorkspace()?.path as string,
      {
        fileChanges: {
          mode: 'auto',
          scope: 'all-act-runs',
          rules: [{ pathPrefix: 'src', operations: ['create', 'update'] }],
          maxFilesPerRequest: 5,
          maxChangedLinesPerRequest: 100,
          maxChangedBytesPerRequest: 10_000,
        },
        commands: { mode: 'manual' },
      },
    )
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('manual-fallback-conversation', '범위 밖 파일을 생성해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(approvalRequests(result.events)).toHaveLength(1)
    expect(
      result.events.some((event) => event.type === 'approval-resolved' && event.automatic === true),
    ).toBe(false)
    expect(await readFile(join(environment.root, 'docs', 'manual.txt'), 'utf8')).toBe('reviewed\n')
  })

  it('auto-approves only the canonical command identity and exact argv policy', async () => {
    const script = 'process.stdout.write("auto-command")'
    const executable = await realpath(process.execPath)
    const argv = [executable, '-e', script]
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'run_command',
          JSON.stringify({
            summary: '자동 명령 검증',
            argv,
            cwd: null,
            timeoutMs: 5_000,
          }),
          'auto-command',
        ),
      () => textEvents('자동 명령을 확인했습니다.', 'auto-command-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await environment.settings.saveWorkspaceApprovalPolicy(
      environment.workspace.getWorkspace()?.path as string,
      {
        fileChanges: { mode: 'manual' },
        commands: {
          mode: 'auto',
          scope: 'all-act-runs',
          rules: [
            {
              executable,
              argumentPrefix: ['-e', script],
              allowAdditionalArguments: false,
              workingDirectoryPrefix: '.',
              maxTimeoutMs: 5_000,
              allowHostNetwork: true,
            },
          ],
        },
      },
    )
    const agent = createAgent(environment, {
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('auto-command-conversation', '허용한 명령을 실행해줘'),
    )

    expect(approvalRequests(result.events)).toEqual([])
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'approval-resolved',
        decision: 'approved',
        automatic: true,
        ruleId: 'command:0',
      }),
    )
    expect(functionOutput(mock.bodies[1])).toMatchObject({
      ok: true,
      result: { executed: true, argv, stdout: 'auto-command' },
    })
  })

  it('shows exact command boundaries and streams only bounded process output after approval', async () => {
    const script = 'process.stdout.write("o".repeat(64));process.stderr.write("e".repeat(64))'
    const argv = [process.execPath, '-e', script]
    const commandArguments = JSON.stringify({
      summary: '출력 경계 확인',
      argv,
      cwd: 'subdir',
      timeoutMs: 5_000,
    })
    const mock = await startResponsesServer([
      () => functionCallEvents('run_command', commandArguments, 'bounded-command'),
      () => textEvents('명령 실행 결과를 확인했습니다.', 'bounded-command-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await mkdir(join(environment.root, 'subdir'))
    const canonicalCwd = await realpath(join(environment.root, 'subdir'))
    const maximumOutputBytes = 16
    const execution = new StructuredProcessRunner(environment.workspace, {
      maxOutputBytes: maximumOutputBytes,
      tempDirectory: await temporaryDirectory(),
    })
    const agent = createAgent(environment, { execution })

    const result = await collectRun(
      agent,
      runInput('command-conversation', '명령을 실행해줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    const approval = approvalRequests(result.events)[0]
    expect(approval).toMatchObject({
      kind: 'command',
      summary: '출력 경계 확인',
      argv,
      cwd: canonicalCwd,
      timeoutMs: 5_000,
      isolation: 'structured-process',
      network: 'host',
    })
    expect(approval.actionHash).toMatch(/^[a-f0-9]{64}$/)
    const streamed = result.events
      .filter((event) => event.type === 'command-output')
      .map((event) => event.delta)
      .join('')
    expect(streamed.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(streamed)).toBeLessThanOrEqual(maximumOutputBytes)

    const output = functionOutput(mock.bodies[1])
    expect(output).toMatchObject({
      ok: true,
      result: {
        executed: true,
        actionHash: approval.actionHash,
        argv,
        cwd: canonicalCwd,
        totalOutputBytes: 128,
        outputTruncated: true,
        isolation: 'structured-process',
        network: 'host',
      },
    })
    const capturedOutput = `${String(output.result?.stdout)}${String(output.result?.stderr)}`
    expect(Buffer.byteLength(capturedOutput)).toBeLessThanOrEqual(maximumOutputBytes)
  })

  it('does not record a non-zero command exit as a successful process effect', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'run_command',
          JSON.stringify({
            summary: '실패 명령 검증',
            argv: [process.execPath, '-e', 'process.exit(7)'],
            cwd: null,
            timeoutMs: 5_000,
          }),
          'failed-command-effect',
        ),
      () => textEvents('명령이 종료 코드 7로 실패했습니다.', 'failed-command-final'),
      () =>
        completionContractEvents('action', {
          requiredEffects: ['process'],
          candidateDisposition: 'acceptable',
          rationale: 'The assistant truthfully reports the failed process attempt.',
          callId: 'failed-command-contract',
        }),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    const agent = createAgent(environment, {
      execution: new StructuredProcessRunner(environment.workspace, {
        tempDirectory: await temporaryDirectory(),
      }),
    })

    const result = await collectRun(
      agent,
      runInput('failed-command-effect', '실패하는 명령을 실행하고 결과를 알려줘'),
      (event) => {
        if (event.type === 'approval-requested') {
          agent.resolveApproval(event.runId, event.request.approvalId, 'approved')
        }
      },
    )

    expect(result.events.at(-1)?.type).toBe('completed')
    expect(functionOutput(mock.bodies[1])).toMatchObject({
      ok: true,
      result: { executed: true, exitCode: 7 },
    })
    const classifierInput = String(mock.bodies[2].instructions)
    expect(classifierInput).toContain('Host-observed applied effect categories: []')
    expect(classifierInput).toContain(
      'Host-observed attempted but unapplied effect categories: ["process"]',
    )
    expect(mock.failures).toEqual([])
  })

  it('resolves a pending approval as cancelled when its run is cancelled', async () => {
    const original = 'unchanged\n'
    const hash = createHash('sha256').update(original).digest('hex')
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'propose_file_changes',
          JSON.stringify({
            summary: '취소될 변경',
            changes: [{ path: 'cancel.txt', baseSha256: hash, newContent: 'changed\n' }],
          }),
          'cancelled-approval',
        ),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'cancel.txt'), original)
    const agent = createAgent(environment, {
      mutations: new MutationService(environment.workspace, {
        journalDirectory: await temporaryDirectory(),
      }),
      approvalTtlMs: 5_000,
    })

    const result = await collectRun(
      agent,
      runInput('cancelled-approval-conversation', '변경을 준비해줘'),
      (event) => {
        if (event.type === 'approval-requested') agent.cancelRun(event.runId)
      },
    )

    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'approval-requested', runId: result.runId }),
    )
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'approval-resolved',
        runId: result.runId,
        decision: 'cancelled',
      }),
    )
    expect(result.events.at(-1)).toEqual({ runId: result.runId, type: 'cancelled' })
    expect(await readFile(join(environment.root, 'cancel.txt'), 'utf8')).toBe(original)
    expect(mock.bodies).toHaveLength(1)
  })

  it('rejects unknown strict tool arguments as a safe tool failure', async () => {
    const mock = await startResponsesServer([
      () =>
        functionCallEvents(
          'read_file',
          JSON.stringify({ path: 'safe.txt', unexpected: 'must-be-rejected' }),
          'strict-arguments',
        ),
      () => textEvents('잘못된 도구 요청을 사용하지 않았습니다.', 'strict-arguments-final'),
    ])
    const environment = await createEnvironment(mock.baseUrl, { trusted: true })
    await writeFile(join(environment.root, 'safe.txt'), 'DO_NOT_READ_MARKER\n')
    const agent = createAgent(environment)

    const result = await collectRun(
      agent,
      runInput('strict-arguments-conversation', '파일을 확인해줘'),
    )

    const readDefinition = (mock.bodies[0].tools as Array<Record<string, unknown>>).find(
      (tool) => tool.name === 'read_file',
    )
    expect(readDefinition).toMatchObject({
      type: 'function',
      name: 'read_file',
      strict: true,
      parameters: { additionalProperties: false },
    })
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-completed',
        tool: 'read_file',
        ok: false,
      }),
    )
    const rejected = functionOutput(mock.bodies[1])
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toContain('unexpected')
    expect(JSON.stringify(rejected)).not.toContain('DO_NOT_READ_MARKER')
    expect(JSON.stringify(rejected)).not.toContain(environment.root)
    expect(result.events.at(-1)?.type).toBe('completed')
  })
})
