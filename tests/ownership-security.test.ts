import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import { AgentService } from '../src/main/services/agent'
import { ConversationRepository } from '../src/main/services/conversations'
import { McpService } from '../src/main/services/mcp'
import { type EncryptionAdapter, SettingsStore } from '../src/main/services/settings'
import { type RegisteredTool, type ToolContext, ToolRegistry } from '../src/main/services/tools'
import { TrustStore } from '../src/main/services/trust'
import { WorkspaceService } from '../src/main/services/workspace'
import type { AgentEvent, AgentRunInput } from '../src/shared/contracts'

interface ResponseCapture {
  baseUrl: string
  bodies: Array<Record<string, unknown>>
  firstRequestReceived: Promise<void>
  releaseFirstResponse: () => void
}

interface TestEnvironment {
  root: string
  settings: SettingsStore
  workspace: WorkspaceService
  trust: TrustStore
  providerId: string
}

interface PendingRun {
  runId: string
  completion: Promise<AgentEvent[]>
}

const MODEL_ID = 'ownership-model'
const temporaryDirectories: string[] = []
const servers: Server[] = []
const agents: AgentService[] = []
const repositories: ConversationRepository[] = []
const mcpServices: McpService[] = []
let messageSequence = 0

class TrackingToolRegistry extends ToolRegistry {
  mcpRegistrations = 0
  mcpUnregistrations = 0

  override register<TSchema extends ZodType, TResult>(
    tool: RegisteredTool<TSchema, TResult>,
  ): () => void {
    const unregister = super.register(tool)
    if (tool.origin !== 'mcp') return unregister
    this.mcpRegistrations += 1
    let registered = true
    return () => {
      if (registered) {
        registered = false
        this.mcpUnregistrations += 1
      }
      unregister()
    }
  }
}

const encryption: EncryptionAdapter = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
}

const mcpFixture = String.raw`
import readline from 'node:readline'

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')

input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'lifecycle-fixture', version: '1.0.0' },
      },
    })
    return
  }
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{
          name: 'lifecycle_probe',
          description: 'A deterministic lifecycle test tool.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true },
        }],
      },
    })
  }
})
`

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'code-assistant-ownership-'))
  temporaryDirectories.push(directory)
  return directory
}

function streamText(response: ServerResponse, text: string, index: number): void {
  const item = {
    id: `message-${index}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  })
  response.write(
    `data: ${JSON.stringify({
      type: 'response.output_text.delta',
      sequence_number: 1,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    })}\n\n`,
  )
  response.write(
    `data: ${JSON.stringify({
      type: 'response.completed',
      sequence_number: 2,
      response: {
        id: `response-${index}`,
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: [item],
      },
    })}\n\n`,
  )
  response.end('data: [DONE]\n\n')
}

function streamCompletionContract(response: ServerResponse, index: number): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  })
  response.write(
    `data: ${JSON.stringify({
      type: 'response.completed',
      sequence_number: 1,
      response: {
        id: `response-contract-${index}`,
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: [
          {
            id: `item-contract-${index}`,
            type: 'function_call',
            status: 'completed',
            call_id: `call-contract-${index}`,
            name: 'declare_run_completion',
            arguments: JSON.stringify({
              requirement: 'response',
              requiredEffects: [],
              candidateDisposition: 'acceptable',
              rationale: 'The lifecycle fixture only needs a response.',
            }),
          },
        ],
      },
    })}\n\n`,
  )
  response.end('data: [DONE]\n\n')
}

async function startResponseCapture(
  options: { holdFirstResponse?: boolean } = {},
): Promise<ResponseCapture> {
  const bodies: Array<Record<string, unknown>> = []
  let signalFirstRequest!: () => void
  let releaseFirstResponse!: () => void
  const firstRequestReceived = new Promise<void>((resolve) => {
    signalFirstRequest = resolve
  })
  const firstResponseGate = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve
  })
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
      const body = JSON.parse(source) as Record<string, unknown>
      bodies.push(body)
      if (bodies.length === 1) {
        signalFirstRequest()
        if (options.holdFirstResponse) await firstResponseGate
      }
      const tools = (body.tools as Array<{ name?: unknown }> | undefined) ?? []
      if (
        body.tool_choice === 'required' &&
        tools.some((tool) => tool.name === 'declare_run_completion')
      ) {
        streamCompletionContract(response, bodies.length)
      } else {
        streamText(response, `reply-${bodies.length}`, bodies.length)
      }
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    bodies,
    firstRequestReceived,
    releaseFirstResponse,
  }
}

async function createEnvironment(baseUrl: string): Promise<TestEnvironment> {
  const selectedDirectory = await temporaryDirectory()
  const workspace = new WorkspaceService()
  await workspace.openWorkspace(selectedDirectory, false)
  const root = workspace.getWorkspace()?.path
  if (!root) throw new Error('Workspace fixture was not selected.')
  const settings = new SettingsStore({
    userDataPath: await temporaryDirectory(),
    encryption,
  })
  const saved = await settings.saveProvider({ name: 'Primary', baseUrl })
  const providerId = saved.providers[0].id
  await settings.saveSettings({
    activeProviderId: providerId,
    activeModelId: MODEL_ID,
    theme: 'system',
    maxToolIterations: 4,
  })
  const trust = new TrustStore({ userDataPath: await temporaryDirectory() })
  await trust.setWorkspaceTrust(root, true)
  return { root, settings, workspace, trust, providerId }
}

function runInput(conversationId: string, marker: string): AgentRunInput {
  messageSequence += 1
  return {
    conversationId,
    userMessageId: `user-${messageSequence}`,
    assistantMessageId: `assistant-${messageSequence}`,
    message: marker,
    displayMessage: marker,
    contextPaths: [],
  }
}

function startCollectingRun(agent: AgentService, input: AgentRunInput): PendingRun {
  let runId = ''
  const completion = new Promise<AgentEvent[]>((resolve, reject) => {
    const collected: AgentEvent[] = []
    const timeout = setTimeout(() => reject(new Error('Agent run timed out.')), 10_000)
    runId = agent.startRun(input, (event) => {
      collected.push(event)
      if (event.type !== 'completed' && event.type !== 'cancelled' && event.type !== 'error') return
      clearTimeout(timeout)
      resolve(collected)
    }).runId
  })
  return { runId, completion }
}

async function collectRun(agent: AgentService, input: AgentRunInput): Promise<AgentEvent[]> {
  const events = await startCollectingRun(agent, input).completion
  await new Promise<void>((resolve) => setImmediate(resolve))
  return events
}

async function selectModel(
  settings: SettingsStore,
  providerId: string,
  modelId: string,
): Promise<void> {
  const current = await settings.getSettings()
  await settings.saveSettings({
    activeProviderId: providerId,
    activeModelId: modelId,
    theme: current.theme,
    maxToolIterations: current.maxToolIterations,
  })
}

function inputMessages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  expect(Array.isArray(body.input)).toBe(true)
  return (body.input as Array<Record<string, unknown>>).filter(
    (item) => item.role === 'user' || item.role === 'assistant',
  )
}

function toolContext(
  workspacePath: string,
  trusted: boolean,
  runId = 'inspection-run',
): ToolContext {
  return {
    runId,
    callId: 'inspection-call',
    deadlineAt: Date.now() + 60_000,
    signal: new AbortController().signal,
    workspaceTrusted: trusted,
    workspacePath,
    contextPaths: new Set(),
    emit: () => undefined,
  }
}

afterEach(async () => {
  await Promise.allSettled(agents.splice(0).map((agent) => agent.shutdown()))
  await Promise.allSettled(mcpServices.splice(0).map((service) => service.close()))
  for (const repository of repositories.splice(0)) repository.close()
  await Promise.all(
    servers.splice(0).map(
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

describe('conversation ownership and workspace capability lifecycle', () => {
  it('rejects workspace, provider, and model ownership mismatches without mutating or replaying them', async () => {
    const capture = await startResponseCapture()
    const environment = await createEnvironment(capture.baseUrl)
    const otherWorkspace = await temporaryDirectory()
    const providers = await environment.settings.saveProvider({
      name: 'Secondary',
      baseUrl: capture.baseUrl,
    })
    const otherProviderId = providers.providers.find(({ id }) => id !== environment.providerId)?.id
    if (!otherProviderId) throw new Error('Secondary provider fixture was not created.')
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = new AgentService(environment.settings, environment.workspace, {
      conversations: repository,
      trust: environment.trust,
    })
    agents.push(agent)

    const mismatches = [
      {
        name: 'workspacePath',
        reject: async () => environment.workspace.openWorkspace(otherWorkspace, false),
        restore: async () => environment.workspace.openWorkspace(environment.root, false),
      },
      {
        name: 'providerId',
        reject: async () => selectModel(environment.settings, otherProviderId, MODEL_ID),
        restore: async () => selectModel(environment.settings, environment.providerId, MODEL_ID),
      },
      {
        name: 'modelId',
        reject: async () =>
          selectModel(environment.settings, environment.providerId, 'other-model'),
        restore: async () => selectModel(environment.settings, environment.providerId, MODEL_ID),
      },
    ]

    for (const [index, mismatch] of mismatches.entries()) {
      const conversationId = `ownership-${mismatch.name}`
      const priorUser = `prior-user-${mismatch.name}`
      const priorAssistant = `prior-assistant-${mismatch.name}`
      repository.ensureConversation({
        id: conversationId,
        summary: mismatch.name,
        status: 'active',
        providerId: environment.providerId,
        providerGeneration: 1,
        modelId: MODEL_ID,
        workspacePath: environment.root,
      })
      repository.appendMessage({
        id: `${conversationId}-prior-user`,
        conversationId,
        role: 'user',
        displayContent: priorUser,
        modelContent: priorUser,
        status: 'completed',
      })
      repository.appendMessage({
        id: `${conversationId}-prior-assistant`,
        conversationId,
        role: 'assistant',
        displayContent: priorAssistant,
        modelContent: priorAssistant,
        status: 'completed',
      })
      const beforeRejectedRun = repository.getConversation(conversationId)
      const rejectedMarker = `must-not-persist-${mismatch.name}`

      await mismatch.reject()
      const rejected = await collectRun(agent, runInput(conversationId, rejectedMarker))
      expect(rejected.at(-1)).toMatchObject({
        type: 'error',
        message: '이 대화는 현재 워크스페이스, 공급자 또는 모델에 속하지 않습니다.',
      })
      expect(capture.bodies).toHaveLength(index)
      expect(repository.getConversation(conversationId)).toEqual(beforeRejectedRun)

      await mismatch.restore()
      const acceptedMarker = `accepted-${mismatch.name}`
      const accepted = await collectRun(agent, runInput(conversationId, acceptedMarker))
      expect(accepted.at(-1)?.type).toBe('completed')
      expect(capture.bodies).toHaveLength(index + 1)
      expect(inputMessages(capture.bodies[index])).toEqual([
        { role: 'user', content: priorUser },
        { role: 'assistant', content: priorAssistant },
        { role: 'user', content: acceptedMarker },
      ])
      expect(JSON.stringify(repository.getConversation(conversationId))).not.toContain(
        rejectedMarker,
      )
    }
  })

  it('fails closed when credentials change behind the same provider id', async () => {
    const capture = await startResponseCapture()
    const environment = await createEnvironment(capture.baseUrl)
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    repositories.push(repository)
    const agent = new AgentService(environment.settings, environment.workspace, {
      conversations: repository,
      trust: environment.trust,
    })
    agents.push(agent)

    const conversationId = 'provider-generation-boundary'
    repository.ensureConversation({
      id: conversationId,
      summary: 'Credential-bound conversation',
      status: 'active',
      providerId: environment.providerId,
      providerGeneration: 1,
      modelId: MODEL_ID,
      workspacePath: environment.root,
    })
    repository.appendMessage({
      id: 'provider-generation-prior-user',
      conversationId,
      role: 'user',
      displayContent: 'credential-bound history',
      modelContent: 'credential-bound history',
      status: 'completed',
    })
    const beforeRejectedRun = repository.getConversation(conversationId)

    const currentProvider = await environment.settings.getProvider(environment.providerId)
    expect(currentProvider?.generation).toBe(1)
    await environment.settings.saveProvider({
      id: environment.providerId,
      name: currentProvider?.name ?? 'Primary',
      baseUrl: capture.baseUrl,
      apiKey: 'rotated-provider-secret',
    })
    expect((await environment.settings.getProvider(environment.providerId))?.generation).toBe(2)

    const rejectedMarker = 'must-not-cross-provider-generation'
    const rejected = await collectRun(agent, runInput(conversationId, rejectedMarker))
    expect(rejected.at(-1)).toMatchObject({
      type: 'error',
      message: '이 대화는 현재 워크스페이스, 공급자 또는 모델에 속하지 않습니다.',
    })
    expect(capture.bodies).toEqual([])
    expect(repository.getConversation(conversationId)).toEqual(beforeRejectedRun)
    expect(JSON.stringify(repository.getConversation(conversationId))).not.toContain(rejectedMarker)
  })

  it('closes MCP sessions, unregisters dynamic tools, and exposes none after trust is removed', async () => {
    const capture = await startResponseCapture({ holdFirstResponse: true })
    const environment = await createEnvironment(capture.baseUrl)
    const fixture = join(await temporaryDirectory(), 'mcp-lifecycle-fixture.mjs')
    await writeFile(fixture, mcpFixture)
    const mcp = new McpService({
      userDataPath: await temporaryDirectory(),
      startupTimeoutMs: 2_000,
      callTimeoutMs: 2_000,
      shutdownGraceMs: 25,
    })
    mcpServices.push(mcp)
    await mcp.saveUserConfiguration({
      version: 1,
      servers: [
        {
          id: 'lifecycle_fixture',
          name: 'Lifecycle fixture',
          enabled: true,
          command: process.execPath,
          args: [fixture],
        },
      ],
    })
    const tools = new TrackingToolRegistry()
    const agent = new AgentService(environment.settings, environment.workspace, {
      mcp,
      tools,
      trust: environment.trust,
    })
    agents.push(agent)

    const trusted = startCollectingRun(agent, runInput('mcp-trusted', 'discover MCP'))
    await capture.firstRequestReceived
    expect(mcp.activeServerCount()).toBe(1)
    expect(tools.mcpRegistrations).toBe(1)
    expect(tools.mcpUnregistrations).toBe(0)
    const registeredMetadata = tools.metadata(toolContext(environment.root, true, trusted.runId))
    expect(registeredMetadata.filter(({ origin }) => origin === 'mcp')).toHaveLength(1)
    expect(
      (capture.bodies[0].tools as Array<{ name: string }>).some(({ name }) =>
        name.startsWith('mcp_'),
      ),
    ).toBe(true)

    await agent.suspendWorkspaceCapabilities()
    expect(mcp.activeServerCount()).toBe(0)
    expect(tools.mcpUnregistrations).toBe(1)
    expect(
      tools
        .metadata(toolContext(environment.root, true, trusted.runId))
        .filter(({ origin }) => origin === 'mcp'),
    ).toEqual([])

    capture.releaseFirstResponse()
    expect((await trusted.completion).at(-1)?.type).toBe('completed')
    await new Promise<void>((resolve) => setImmediate(resolve))

    await environment.trust.setWorkspaceTrust(environment.root, false)
    const untrusted = await collectRun(agent, runInput('mcp-untrusted', 'do not expose MCP'))
    expect(untrusted.at(-1)?.type).toBe('completed')
    expect(capture.bodies.at(-1)).not.toHaveProperty('tools')
    expect(mcp.activeServerCount()).toBe(0)
  })
})
