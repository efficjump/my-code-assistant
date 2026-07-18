import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type McpApprovalGrant,
  type McpConfigurationSource,
  McpService,
} from '../src/main/services/mcp'

const temporaryDirectories: string[] = []
const services: McpService[] = []
const originalInheritedSecret = process.env.MCP_TEST_INHERITED_SECRET

const fixtureSource = String.raw`
import readline from 'node:readline'

const mode = process.env.FIXTURE_MODE || 'env'
const lineReader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')

function availableTools() {
  if (mode === 'many') {
    return [
      { name: 'first', description: 'First tool', inputSchema: { type: 'object', properties: {} } },
      { name: 'second', description: 'Second tool', inputSchema: { type: 'object', properties: {} } },
    ]
  }
  if (mode === 'hang') {
    return [{ name: 'hang', description: 'Never completes', inputSchema: { type: 'object', properties: {} } }]
  }
  return [{
    name: 'inspect_env',
    title: 'Inspect environment',
    description: 'Returns selected fixture environment values.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }]
}

lineReader.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture-server', title: 'Fixture Server', version: '1.0.0' },
        instructions: 'This untrusted server instruction must never be consumed by the host.',
      },
    })
    return
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: availableTools() } })
    return
  }
  if (message.method === 'tools/call' && message.params?.name === 'hang') return
  if (message.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: String(message.params?.arguments?.value || '') }],
        structuredContent: {
          inheritedSecret: process.env.MCP_TEST_INHERITED_SECRET || null,
          explicitMarker: process.env.SAFE_MARKER || null,
          fixtureMode: process.env.FIXTURE_MODE || null,
          home: process.env.HOME || null,
        },
        isError: false,
      },
    })
  }
})
`

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function fixturePath(root: string): Promise<string> {
  const path = join(root, 'mcp-fixture.mjs')
  await writeFile(path, fixtureSource)
  return path
}

function createService(
  userDataPath: string,
  options: Partial<ConstructorParameters<typeof McpService>[0]> = {},
) {
  const service = new McpService({
    userDataPath,
    startupTimeoutMs: 2_000,
    callTimeoutMs: 2_000,
    shutdownGraceMs: 25,
    ...options,
  })
  services.push(service)
  return service
}

async function configureFixture(
  service: McpService,
  fixture: string,
  mode: 'env' | 'many' | 'hang' = 'env',
): Promise<void> {
  await service.saveUserConfiguration({
    version: 1,
    servers: [
      {
        id: 'fixture',
        name: 'Fixture',
        enabled: true,
        command: process.execPath,
        args: [fixture],
        env: { FIXTURE_MODE: mode, SAFE_MARKER: 'explicit-value' },
      },
    ],
  })
}

function exactGrant(actionHash: string): McpApprovalGrant {
  return { approved: true, actionHash }
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
  if (originalInheritedSecret === undefined) delete process.env.MCP_TEST_INHERITED_SECRET
  else process.env.MCP_TEST_INHERITED_SECRET = originalInheritedSecret
})

describe('McpService', () => {
  it('rejects malformed, oversized, and over-count versioned configuration', async () => {
    const root = await temporaryDirectory('code-assistant-mcp-invalid-')
    const service = createService(root, { maximumServers: 1, maximumConfigBytes: 1024 })

    await writeFile(service.userConfigPath, JSON.stringify({ version: 2, servers: [] }))
    await expect(service.inspect()).rejects.toMatchObject({ code: 'INVALID_CONFIG' })

    await writeFile(
      service.userConfigPath,
      JSON.stringify({
        version: 1,
        servers: [
          { id: 'first', command: process.execPath },
          { id: 'second', command: process.execPath },
        ],
      }),
    )
    await expect(service.inspect()).rejects.toMatchObject({ code: 'INVALID_CONFIG' })

    await writeFile(service.userConfigPath, 'x'.repeat(1025))
    await expect(service.inspect()).rejects.toMatchObject({ code: 'CONFIG_TOO_LARGE' })
  })

  it('strips inherited secrets, uses isolated runtime directories, and requires exact approval', async () => {
    const root = await temporaryDirectory('code-assistant-mcp-env-')
    const fixture = await fixturePath(root)
    const service = createService(root)
    process.env.MCP_TEST_INHERITED_SECRET = 'must-not-leak'
    await configureFixture(service, fixture)

    const discovery = await service.discover()
    expect(discovery.errors).toEqual([])
    expect(discovery.tools).toHaveLength(1)
    const [tool] = discovery.tools
    expect(tool).toMatchObject({
      origin: 'mcp',
      metadataTrusted: false,
      risk: 'approval-required',
      capability: ['process', 'write', 'network'],
      annotations: { readOnlyHint: true },
    })
    expect(tool.registryName).toMatch(/^mcp_[A-Za-z0-9_]{1,59}$/)

    await expect(
      service.callTool({
        serverId: tool.serverId,
        toolName: tool.name,
        revision: tool.revision,
        arguments: { value: 'hello' },
      }),
    ).rejects.toMatchObject({ code: 'POLICY_APPROVAL_REQUIRED' })

    const execution = await service.callTool(
      {
        serverId: tool.serverId,
        toolName: tool.name,
        revision: tool.revision,
        arguments: { value: 'hello' },
      },
      {
        authorize: (request) => {
          expect(request.actionHash).toMatch(/^[a-f0-9]{64}$/)
          expect(request.capability).toEqual(['process', 'write', 'network'])
          request.arguments.value = 'callback-mutation-must-not-change-call'
          return exactGrant(request.actionHash)
        },
      },
    )
    const structured = execution.result.structuredContent as Record<string, unknown>
    expect(structured).toMatchObject({
      inheritedSecret: null,
      explicitMarker: 'explicit-value',
      fixtureMode: 'env',
    })
    expect(structured.home).not.toBe(process.env.HOME)
    expect(execution.untrustedContent).toBe(true)
    expect(execution.result.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('bounds discovered tool counts and closes a server that violates limits', async () => {
    const root = await temporaryDirectory('code-assistant-mcp-bounds-')
    const fixture = await fixturePath(root)
    const service = createService(root, { maximumToolsPerServer: 1 })
    await configureFixture(service, fixture, 'many')

    const discovery = await service.discover()
    expect(discovery.tools).toEqual([])
    expect(discovery.errors).toEqual([
      expect.objectContaining({ serverId: 'fixture', code: 'TOOL_LIMIT_EXCEEDED' }),
    ])
    expect(service.activeServerCount()).toBe(0)
  })

  it('revision-binds discovered metadata and action approval to every call', async () => {
    const root = await temporaryDirectory('code-assistant-mcp-revision-')
    const fixture = await fixturePath(root)
    const service = createService(root)
    await configureFixture(service, fixture)
    const [tool] = (await service.discover()).tools
    let approvalCalled = false

    await expect(
      service.callTool(
        {
          serverId: tool.serverId,
          toolName: tool.name,
          revision: '0'.repeat(64),
          arguments: {},
        },
        {
          authorize: () => {
            approvalCalled = true
            return exactGrant('0'.repeat(64))
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'REVISION_MISMATCH' })
    expect(approvalCalled).toBe(false)

    await expect(
      service.callTool(
        {
          serverId: tool.serverId,
          toolName: tool.name,
          revision: tool.revision,
          arguments: {},
        },
        { authorize: () => ({ approved: true, actionHash: '0'.repeat(64) }) },
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' })
  })

  it('trust-gates workspace configuration and revision-binds explicit spawn approval', async () => {
    const root = await temporaryDirectory('code-assistant-mcp-workspace-')
    const userData = join(root, 'user-data')
    const workspace = join(root, 'workspace')
    await Promise.all([mkdir(userData), mkdir(workspace)])
    const fixture = await fixturePath(root)
    const service = createService(userData)
    await service.saveUserConfiguration({ version: 1, servers: [] })
    await writeFile(
      join(workspace, service.workspaceConfigFileName),
      JSON.stringify({
        version: 1,
        servers: [
          {
            id: 'workspace_fixture',
            enabled: true,
            command: process.execPath,
            args: [fixture],
            env: { FIXTURE_MODE: 'env' },
          },
        ],
      }),
    )

    let untrustedCallbackCalled = false
    const untrusted = await service.discover({
      workspacePath: workspace,
      workspaceTrusted: false,
      authorizeWorkspace: () => {
        untrustedCallbackCalled = true
        return exactGrant('0'.repeat(64))
      },
    })
    expect(untrustedCallbackCalled).toBe(false)
    expect(untrusted.tools).toEqual([])
    expect(untrusted.workspaceApprovalRequired).not.toBeNull()

    const denied = await service.discover({
      workspacePath: workspace,
      workspaceTrusted: true,
      authorizeWorkspace: () => exactGrant('0'.repeat(64)),
    })
    expect(denied.tools).toEqual([])
    expect(denied.workspaceApprovalRequired).not.toBeNull()

    const approved = await service.discover({
      workspacePath: workspace,
      workspaceTrusted: true,
      authorizeWorkspace: (request) => exactGrant(request.actionHash),
    })
    expect(approved.tools).toHaveLength(1)
    expect(approved.servers[0].source satisfies McpConfigurationSource).toBe('workspace')
  })

  it('cancels a hung call and tears down its stdio session', async () => {
    const root = await temporaryDirectory('code-assistant-mcp-cancel-')
    const fixture = await fixturePath(root)
    const service = createService(root)
    await configureFixture(service, fixture, 'hang')
    const [tool] = (await service.discover()).tools
    const controller = new AbortController()
    const call = service.callTool(
      {
        serverId: tool.serverId,
        toolName: tool.name,
        revision: tool.revision,
        arguments: {},
      },
      {
        signal: controller.signal,
        authorize: (request) => exactGrant(request.actionHash),
      },
    )
    setTimeout(() => controller.abort(new Error('test cancellation')), 25)

    await expect(call).rejects.toMatchObject({ code: 'ABORTED' })
    expect(service.activeServerCount()).toBe(0)
  })

  it('writes user configuration atomically without persisting implicit defaults as secrets', async () => {
    const root = await temporaryDirectory('code-assistant-mcp-save-')
    const service = createService(root)
    await service.saveUserConfiguration({
      version: 1,
      servers: [{ id: 'disabled', enabled: false, command: process.execPath }],
    })

    const stored = JSON.parse(await readFile(service.userConfigPath, 'utf8'))
    expect(stored).toMatchObject({ version: 1, servers: [{ id: 'disabled', enabled: false }] })
    expect((await service.discover()).tools).toEqual([])
  })
})
