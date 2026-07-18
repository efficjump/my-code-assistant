import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type AssistantDriver,
  AssistantDriverError,
  createAssistantDriverSession,
} from '../src/main/runtime/assistant-driver'
import { AssistantDriverRegistry } from '../src/main/runtime/assistant-driver-registry'
import { AgentService } from '../src/main/services/agent'
import { ConversationRepository } from '../src/main/services/conversations'
import { type EncryptionAdapter, SettingsStore } from '../src/main/services/settings'
import { WorkspaceService } from '../src/main/services/workspace'
import type { AgentEvent } from '../src/shared/contracts'

const temporaryDirectories: string[] = []
const testEncryption: EncryptionAdapter = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'code-assistant-agent-'))
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('AgentService', () => {
  it('reserves a Goal against new runs for the full mutation boundary', async () => {
    const settings = new SettingsStore({
      userDataPath: await temporaryDirectory(),
      encryption: testEncryption,
    })
    const workspace = new WorkspaceService()
    await workspace.openWorkspace(await temporaryDirectory(), false)
    const agent = new AgentService(settings, workspace)
    let releaseMutation!: () => void
    const mutation = agent.withGoalMutation(
      'reserved-goal',
      () => undefined,
      () =>
        new Promise<void>((resolve) => {
          releaseMutation = resolve
        }),
    )

    expect(() =>
      agent.startRun(
        {
          conversationId: 'reserved-conversation',
          userMessageId: 'reserved-user',
          assistantMessageId: 'reserved-assistant',
          message: '경합 실행',
          displayMessage: '경합 실행',
          contextPaths: [],
          goalId: 'reserved-goal',
        },
        () => undefined,
      ),
    ).toThrow('Goal 상태 변경이 진행 중')

    await Promise.resolve()
    releaseMutation()
    await mutation
    await agent.shutdown()
  })

  it('serializes concurrent mutations for the same Goal until the first operation settles', async () => {
    const settings = new SettingsStore({
      userDataPath: await temporaryDirectory(),
      encryption: testEncryption,
    })
    const workspace = new WorkspaceService()
    await workspace.openWorkspace(await temporaryDirectory(), false)
    const agent = new AgentService(settings, workspace)
    let releaseFirstMutation!: () => void
    let markFirstMutationStarted!: () => void
    const firstMutationStarted = new Promise<void>((resolve) => {
      markFirstMutationStarted = resolve
    })
    const firstMutation = agent.withGoalMutation(
      'serialized-goal',
      () => undefined,
      () =>
        new Promise<void>((resolve) => {
          releaseFirstMutation = resolve
          markFirstMutationStarted()
        }),
    )
    await firstMutationStarted
    const competingPreflight = vi.fn()

    await expect(
      agent.withGoalMutation('serialized-goal', competingPreflight, () => undefined),
    ).rejects.toThrow('같은 Goal의 다른 상태 변경이 진행 중')
    expect(competingPreflight).not.toHaveBeenCalled()

    releaseFirstMutation()
    await firstMutation
    await expect(
      agent.withGoalMutation(
        'serialized-goal',
        () => undefined,
        () => 'released',
      ),
    ).resolves.toBe('released')
    await agent.shutdown()
  })

  it('emits and persists final text from a driver that does not stream deltas', async () => {
    let sessionSequence = 0
    const driver: AssistantDriver = {
      id: 'non-streaming-test',
      inspect: async () => ({ features: ['tool-calling'], limits: {} }),
      listModels: async () => [{ id: 'non-streaming-model' }],
      createSession: () =>
        createAssistantDriverSession('non-streaming-test', `session-${++sessionSequence}`),
      appendUserMessage: (session) => session,
      appendToolResults: (session) => session,
      compactSession: () => {
        throw new Error('cache compaction failed')
      },
      runTurn: async (request) => ({
        session: request.session,
        toolCalls: [],
        usage: null,
        responseId: 'non-streaming-response',
        finalText: '스트리밍 없이 생성된 최종 답변',
        finishReason: 'stop',
      }),
    }
    const settings = new SettingsStore({
      userDataPath: await temporaryDirectory(),
      encryption: testEncryption,
    })
    const saved = await settings.saveProvider({
      name: 'Non-streaming test',
      baseUrl: 'https://provider.example/v1',
      driverId: driver.id,
    })
    await settings.saveSettings({
      activeProviderId: saved.providers[0].id,
      activeModelId: 'non-streaming-model',
      theme: 'system',
      maxToolIterations: 2,
    })
    const root = await temporaryDirectory()
    const workspace = new WorkspaceService()
    await workspace.openWorkspace(root, false)
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    const agent = new AgentService(settings, workspace, {
      conversations: repository,
      generateConversationTitles: false,
      drivers: new AssistantDriverRegistry([driver]),
    })
    const events: AgentEvent[] = []

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('non-streaming agent test timed out')),
        5_000,
      )
      agent.startRun(
        {
          conversationId: 'non-streaming-conversation',
          userMessageId: 'non-streaming-user',
          assistantMessageId: 'non-streaming-assistant',
          message: '최종 답변을 생성해줘',
          displayMessage: '최종 답변을 생성해줘',
          contextPaths: [],
        },
        (event) => {
          events.push(event)
          if (event.type === 'error') {
            clearTimeout(timeout)
            reject(new Error(event.message))
          } else if (event.type === 'completed') {
            clearTimeout(timeout)
            resolve()
          }
        },
      )
    })

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text-delta',
          delta: '스트리밍 없이 생성된 최종 답변',
        }),
      ]),
    )
    expect(repository.getConversation('non-streaming-conversation')?.messages.at(-1)).toMatchObject(
      {
        role: 'assistant',
        displayContent: '스트리밍 없이 생성된 최종 답변',
        status: 'completed',
      },
    )
    await agent.shutdown()
    repository.close()
  })

  it('retries a retryable provider turn without exposing provisional buffered text', async () => {
    let sessionSequence = 0
    let attempt = 0
    const driver: AssistantDriver = {
      id: 'retryable-turn-test',
      inspect: async () => ({ features: ['tool-calling'], limits: {} }),
      listModels: async () => [{ id: 'retryable-turn-model' }],
      createSession: () =>
        createAssistantDriverSession('retryable-turn-test', `session-${++sessionSequence}`),
      appendUserMessage: (session) => session,
      appendToolResults: (session) => session,
      compactSession: (session) => session,
      runTurn: async (request, listener) => {
        attempt += 1
        if (attempt === 1) {
          listener?.({ type: 'text-delta', delta: '노출되면 안 되는 첫 시도' })
          throw new AssistantDriverError({
            code: 'provider-error',
            message: 'temporary provider failure',
            retryable: true,
          })
        }
        return {
          session: request.session,
          toolCalls: [],
          usage: null,
          responseId: 'retry-success',
          finalText: '재시도 후 확정된 답변',
          finishReason: 'stop',
        }
      },
    }
    const settings = new SettingsStore({
      userDataPath: await temporaryDirectory(),
      encryption: testEncryption,
    })
    const saved = await settings.saveProvider({
      name: 'Retryable turn test',
      baseUrl: 'https://provider.example/v1',
      driverId: driver.id,
    })
    await settings.saveSettings({
      activeProviderId: saved.providers[0].id,
      activeModelId: 'retryable-turn-model',
      theme: 'system',
      maxToolIterations: 2,
    })
    const workspace = new WorkspaceService()
    await workspace.openWorkspace(await temporaryDirectory(), false)
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    const agent = new AgentService(settings, workspace, {
      conversations: repository,
      generateConversationTitles: false,
      drivers: new AssistantDriverRegistry([driver]),
      trust: { isTrusted: async () => true },
    })
    const events: AgentEvent[] = []

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('retryable turn test timed out')), 5_000)
      agent.startRun(
        {
          conversationId: 'retryable-turn-conversation',
          userMessageId: 'retryable-turn-user',
          assistantMessageId: 'retryable-turn-assistant',
          message: '현재 상태를 설명해줘',
          displayMessage: '현재 상태를 설명해줘',
          contextPaths: [],
          intent: 'answer',
        },
        (event) => {
          events.push(event)
          if (event.type === 'error') {
            clearTimeout(timeout)
            reject(new Error(event.message))
          } else if (event.type === 'completed') {
            clearTimeout(timeout)
            resolve()
          }
        },
      )
    })

    expect(attempt).toBe(2)
    const visibleText = events
      .filter(
        (event): event is Extract<AgentEvent, { type: 'text-delta' }> =>
          event.type === 'text-delta',
      )
      .map((event) => event.delta)
      .join('')
    expect(visibleText).toBe('재시도 후 확정된 답변')
    expect(visibleText).not.toContain('첫 시도')
    await agent.shutdown()
    repository.close()
  })

  it('does not expose provisional text from a turn that resolves to structured tool calls', async () => {
    const rawToolText =
      '<tool_call><function=list_files><parameter=path>null</parameter></function></tool_call>'
    const finalText = 'README.md 파일이 있습니다.'
    let turnCount = 0
    let sessionSequence = 0
    const driver: AssistantDriver = {
      id: 'provisional-tool-text-test',
      inspect: async () => ({ features: ['tool-calling', 'streaming'], limits: {} }),
      listModels: async () => [{ id: 'tool-model' }],
      createSession: () =>
        createAssistantDriverSession('provisional-tool-text-test', `session-${++sessionSequence}`),
      appendUserMessage: (session) => session,
      appendToolResults: (session) => session,
      compactSession: (session) => session,
      runTurn: async (request, listener) => {
        turnCount += 1
        if (turnCount === 1) {
          listener?.({ type: 'text-delta', delta: rawToolText })
          return {
            session: request.session,
            toolCalls: [
              {
                callId: 'call-list-files',
                name: 'list_files',
                argumentsJson: '{"path":null}',
              },
            ],
            usage: null,
            responseId: 'tool-response',
            finalText: rawToolText,
            finishReason: 'tool-calls',
          }
        }
        listener?.({ type: 'text-delta', delta: finalText })
        return {
          session: request.session,
          toolCalls: [],
          usage: null,
          responseId: 'final-response',
          finalText,
          finishReason: 'stop',
        }
      },
    }
    const settings = new SettingsStore({
      userDataPath: await temporaryDirectory(),
      encryption: testEncryption,
    })
    const saved = await settings.saveProvider({
      name: 'Provisional tool text test',
      baseUrl: 'https://provider.example/v1',
      driverId: driver.id,
    })
    await settings.saveSettings({
      activeProviderId: saved.providers[0].id,
      activeModelId: 'tool-model',
      theme: 'system',
      maxToolIterations: 2,
    })
    const root = await temporaryDirectory()
    await writeFile(join(root, 'README.md'), '# Test\n')
    const workspace = new WorkspaceService()
    await workspace.openWorkspace(root, false)
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    const agent = new AgentService(settings, workspace, {
      conversations: repository,
      generateConversationTitles: false,
      drivers: new AssistantDriverRegistry([driver]),
      trust: { isTrusted: async () => true },
    })
    const events: AgentEvent[] = []

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('tool text test timed out')), 5_000)
      agent.startRun(
        {
          conversationId: 'tool-text-conversation',
          userMessageId: 'tool-text-user',
          assistantMessageId: 'tool-text-assistant',
          message: '파일 목록을 확인해줘',
          displayMessage: '파일 목록을 확인해줘',
          contextPaths: [],
        },
        (event) => {
          events.push(event)
          if (event.type === 'error') {
            clearTimeout(timeout)
            reject(new Error(event.message))
          } else if (event.type === 'completed') {
            clearTimeout(timeout)
            resolve()
          }
        },
      )
    })

    expect(events.filter((event) => event.type === 'text-delta')).toEqual([
      expect.objectContaining({ delta: finalText }),
    ])
    expect(JSON.stringify(events)).not.toContain(rawToolText)
    expect(repository.getConversation('tool-text-conversation')?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      displayContent: finalText,
      modelContent: finalText,
      status: 'completed',
      toolActivities: [expect.objectContaining({ tool: 'list_files', status: 'completed' })],
    })
    await agent.shutdown()
    repository.close()
  })

  it('summarizes validation issues and stops an immediately repeated unresolved frontier', async () => {
    let turnCount = 0
    let sessionSequence = 0
    const toolResultOutputs: string[] = []
    const driver: AssistantDriver = {
      id: 'tool-validation-error-test',
      inspect: async () => ({ features: ['tool-calling'], limits: {} }),
      listModels: async () => [{ id: 'tool-model' }],
      createSession: () =>
        createAssistantDriverSession('tool-validation-error-test', `session-${++sessionSequence}`),
      appendUserMessage: (session) => session,
      appendToolResults: (session, results) => {
        toolResultOutputs.push(results[0]?.output ?? '')
        return session
      },
      compactSession: (session) => session,
      runTurn: async (request) => {
        turnCount += 1
        if (turnCount <= 2) {
          return {
            session: request.session,
            toolCalls: [
              {
                callId:
                  turnCount === 1 ? 'invalid-list-files-call' : 'repeated-invalid-list-files-call',
                name: 'list_files',
                argumentsJson: '{"path":42}',
              },
            ],
            usage: null,
            responseId: 'invalid-tool-response',
            finalText: '',
            finishReason: 'tool-calls',
          }
        }
        return {
          session: request.session,
          toolCalls: [],
          usage: null,
          responseId: 'final-response',
          finalText: '도구 입력을 확인했습니다.',
          finishReason: 'stop',
        }
      },
    }
    const settings = new SettingsStore({
      userDataPath: await temporaryDirectory(),
      encryption: testEncryption,
    })
    const saved = await settings.saveProvider({
      name: 'Tool validation error test',
      baseUrl: 'https://provider.example/v1',
      driverId: driver.id,
    })
    await settings.saveSettings({
      activeProviderId: saved.providers[0].id,
      activeModelId: 'tool-model',
      theme: 'system',
      maxToolIterations: 2,
    })
    const workspace = new WorkspaceService()
    await workspace.openWorkspace(await temporaryDirectory(), false)
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    const agent = new AgentService(settings, workspace, {
      conversations: repository,
      generateConversationTitles: false,
      drivers: new AssistantDriverRegistry([driver]),
      trust: { isTrusted: async () => true },
    })
    const events: AgentEvent[] = []

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('tool validation test timed out')), 5_000)
      agent.startRun(
        {
          conversationId: 'tool-validation-conversation',
          userMessageId: 'tool-validation-user',
          assistantMessageId: 'tool-validation-assistant',
          message: '잘못된 도구 입력을 처리해줘',
          displayMessage: '잘못된 도구 입력을 처리해줘',
          contextPaths: [],
        },
        (event) => {
          events.push(event)
          if (event.type === 'error' || event.type === 'completed') {
            clearTimeout(timeout)
            resolve()
          }
        },
      )
    })

    const toolEvent = events.find(
      (event) => event.type === 'tool-completed' && event.callId === 'invalid-list-files-call',
    )
    expect(toolEvent).toMatchObject({
      type: 'tool-completed',
      ok: false,
    })
    expect(toolEvent && 'summary' in toolEvent ? toolEvent.summary : '').toContain(
      '도구 입력 검증 실패: path:',
    )
    const validationSummary = toolEvent && 'summary' in toolEvent ? toolEvent.summary : ''
    expect(validationSummary).toContain('문자열 형식이어야 합니다.')
    expect(validationSummary).not.toContain('expected string')
    expect(validationSummary).not.toContain('Invalid input')
    expect(toolResultOutputs).toHaveLength(1)
    expect(toolResultOutputs[0]).toContain('도구 입력 검증 실패: path:')
    expect(JSON.stringify({ toolEvent, toolResultOutputs })).not.toContain('"code":"invalid_type"')
    expect(JSON.stringify({ toolEvent, toolResultOutputs })).not.toContain('"origin":"')
    expect(events.filter((event) => event.type === 'tool-started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'tool-completed')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('실패한 도구 호출을 수정하지 않고 반복'),
    })
    expect(
      repository.getConversation('tool-validation-conversation')?.messages.at(-1)?.toolActivities,
    ).toEqual([
      expect.objectContaining({
        callId: 'invalid-list-files-call',
        status: 'error',
        summary: expect.stringContaining('도구 입력 검증 실패: path:'),
      }),
    ])
    await agent.shutdown()
    repository.close()
  })

  it('uses each dynamic driver cancel hook when cancelling all active runs', async () => {
    let sessionSequence = 0
    let releaseTurn: ((error: Error) => void) | null = null
    let signalTurnStarted: (() => void) | null = null
    const turnStarted = new Promise<void>((resolve) => {
      signalTurnStarted = resolve
    })
    const cancelledRunIds: string[] = []
    const driver: AssistantDriver = {
      id: 'cancel-hook-test',
      inspect: async () => ({ features: ['tool-calling'], limits: {} }),
      listModels: async () => [{ id: 'cancel-model' }],
      createSession: () =>
        createAssistantDriverSession('cancel-hook-test', `session-${++sessionSequence}`),
      appendUserMessage: (session) => session,
      appendToolResults: (session) => session,
      compactSession: (session) => session,
      runTurn: async () => {
        signalTurnStarted?.()
        return await new Promise<never>((_resolve, reject) => {
          releaseTurn = reject
        })
      },
      cancel: async (runId) => {
        cancelledRunIds.push(runId)
        releaseTurn?.(new Error('cancelled through driver hook'))
      },
    }
    const settings = new SettingsStore({
      userDataPath: await temporaryDirectory(),
      encryption: testEncryption,
    })
    const saved = await settings.saveProvider({
      name: 'Cancel hook test',
      baseUrl: 'https://provider.example/v1',
      driverId: driver.id,
    })
    await settings.saveSettings({
      activeProviderId: saved.providers[0].id,
      activeModelId: 'cancel-model',
      theme: 'system',
      maxToolIterations: 2,
    })
    const workspace = new WorkspaceService()
    await workspace.openWorkspace(await temporaryDirectory(), false)
    const agent = new AgentService(settings, workspace, {
      drivers: new AssistantDriverRegistry([driver]),
    })
    let terminalEvent: AgentEvent | null = null
    let resolveTerminal: (() => void) | null = null
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve
    })
    const { runId } = agent.startRun(
      {
        conversationId: 'cancel-conversation',
        userMessageId: 'cancel-user',
        assistantMessageId: 'cancel-assistant',
        message: '취소 대기',
        displayMessage: '취소 대기',
        contextPaths: [],
      },
      (event) => {
        if (event.type === 'cancelled' || event.type === 'error' || event.type === 'completed') {
          terminalEvent = event
          resolveTerminal?.()
        }
      },
    )

    await turnStarted
    agent.cancelAllRuns()
    await terminal
    expect(cancelledRunIds).toEqual([runId])
    expect(terminalEvent).toMatchObject({ runId, type: 'cancelled' })
    await agent.shutdown()
  })

  it('persists usage emitted before a driver failure without charging it twice', async () => {
    let sessionSequence = 0
    const usage = { inputTokens: 8, outputTokens: 4, reasoningTokens: 1, totalTokens: 12 }
    const driver: AssistantDriver = {
      id: 'failing-usage-test',
      inspect: async () => ({ features: ['tool-calling'], limits: {} }),
      listModels: async () => [{ id: 'usage-model' }],
      createSession: () =>
        createAssistantDriverSession('failing-usage-test', `session-${++sessionSequence}`),
      appendUserMessage: (session) => session,
      appendToolResults: (session) => session,
      compactSession: (session) => session,
      runTurn: async (_request, listener) => {
        listener?.({ type: 'usage', usage })
        throw new Error('provider failed after reporting usage')
      },
    }
    const settings = new SettingsStore({
      userDataPath: await temporaryDirectory(),
      encryption: testEncryption,
    })
    const saved = await settings.saveProvider({
      name: 'Failing usage test',
      baseUrl: 'https://provider.example/v1',
      driverId: driver.id,
    })
    await settings.saveSettings({
      activeProviderId: saved.providers[0].id,
      activeModelId: 'usage-model',
      theme: 'system',
      maxToolIterations: 2,
    })
    const workspace = new WorkspaceService()
    await workspace.openWorkspace(await temporaryDirectory(), false)
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    const goal = repository.createGoal({
      workspacePath: workspace.getWorkspace()?.path as string,
      objective: '실패 전 사용량을 보존한다.',
    })
    const agent = new AgentService(settings, workspace, {
      conversations: repository,
      generateConversationTitles: false,
      drivers: new AssistantDriverRegistry([driver]),
      trust: { isTrusted: async () => true },
    })
    let terminalEvent: AgentEvent | null = null
    await new Promise<void>((resolve) => {
      agent.startRun(
        {
          conversationId: 'usage-conversation',
          userMessageId: 'usage-user',
          assistantMessageId: 'usage-assistant',
          message: '사용량을 기록해줘',
          displayMessage: '사용량을 기록해줘',
          contextPaths: [],
          goalId: goal.id,
        },
        (event) => {
          if (event.type === 'error' || event.type === 'cancelled' || event.type === 'completed') {
            terminalEvent = event
            resolve()
          }
        },
      )
    })

    expect(terminalEvent).toMatchObject({ type: 'error' })
    expect(repository.getGoal(goal.id)).toMatchObject({ usedTokens: 12, revision: 2 })
    expect(repository.listGoalCheckpoints(goal.id)).toEqual([
      expect.objectContaining({ runId: expect.any(String), goalRevision: 2, usedTokens: 12 }),
    ])
    expect(repository.getConversation('usage-conversation')?.runs).toEqual([
      expect.objectContaining({ status: 'error', usage }),
    ])
    await agent.shutdown()
    repository.close()
  })

  it('persists result-only usage even when a fatal streamed-text boundary rejects the turn', async () => {
    let sessionSequence = 0
    const usage = { inputTokens: 9, outputTokens: 3, reasoningTokens: 1, totalTokens: 12 }
    const oversizedText = 'x'.repeat(1_500_001)
    const driver: AssistantDriver = {
      id: 'fatal-text-usage-test',
      inspect: async () => ({ features: ['tool-calling'], limits: {} }),
      listModels: async () => [{ id: 'fatal-text-model' }],
      createSession: () =>
        createAssistantDriverSession('fatal-text-usage-test', `session-${++sessionSequence}`),
      appendUserMessage: (session) => session,
      appendToolResults: (session) => session,
      compactSession: (session) => session,
      runTurn: async (request, listener) => {
        listener?.({ type: 'text-delta', delta: oversizedText })
        return {
          session: request.session,
          toolCalls: [],
          usage,
          responseId: 'fatal-text-response',
          finalText: oversizedText,
          finishReason: 'stop',
        }
      },
    }
    const settings = new SettingsStore({
      userDataPath: await temporaryDirectory(),
      encryption: testEncryption,
    })
    const saved = await settings.saveProvider({
      name: 'Fatal text usage test',
      baseUrl: 'https://provider.example/v1',
      driverId: driver.id,
    })
    await settings.saveSettings({
      activeProviderId: saved.providers[0].id,
      activeModelId: 'fatal-text-model',
      theme: 'system',
      maxToolIterations: 2,
    })
    const workspace = new WorkspaceService()
    await workspace.openWorkspace(await temporaryDirectory(), false)
    const repository = new ConversationRepository({ userDataPath: await temporaryDirectory() })
    const goal = repository.createGoal({
      workspacePath: workspace.getWorkspace()?.path as string,
      objective: 'fatal turn의 결과 사용량을 보존한다.',
    })
    const agent = new AgentService(settings, workspace, {
      conversations: repository,
      generateConversationTitles: false,
      drivers: new AssistantDriverRegistry([driver]),
      trust: { isTrusted: async () => true },
    })

    await new Promise<void>((resolve) => {
      agent.startRun(
        {
          conversationId: 'fatal-text-conversation',
          userMessageId: 'fatal-text-user',
          assistantMessageId: 'fatal-text-assistant',
          message: '경계를 검증해줘',
          displayMessage: '경계를 검증해줘',
          contextPaths: [],
          goalId: goal.id,
        },
        (event) => {
          if (event.type === 'error') resolve()
        },
      )
    })

    expect(repository.getGoal(goal.id)).toMatchObject({ usedTokens: 12, revision: 2 })
    expect(repository.listGoalCheckpoints(goal.id)).toEqual([
      expect.objectContaining({ runId: expect.any(String), goalRevision: 2, usedTokens: 12 }),
    ])
    expect(repository.getConversation('fatal-text-conversation')?.runs).toEqual([
      expect.objectContaining({ status: 'error', usage }),
    ])
    expect(repository.getConversation('fatal-text-conversation')?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      displayContent: '',
      status: 'error',
    })
    await agent.shutdown()
    repository.close()
  })

  it('discovers models and completes a streamed read-file tool round trip', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const server = createServer((request, response) => {
      if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'dynamic-test-model', object: 'model', created: 1, owned_by: 'test' }],
            has_more: false,
          }),
        )
        return
      }

      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end()
        return
      }

      let source = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => {
        source += chunk
      })
      request.on('end', () => {
        requestBodies.push(JSON.parse(source) as Record<string, unknown>)
        if (requestBodies.length === 1) {
          writeSse(response, [
            {
              type: 'response.completed',
              sequence_number: 1,
              response: {
                id: 'response-tool-call',
                status: 'completed',
                error: null,
                incomplete_details: null,
                output: [
                  {
                    id: 'function-call-item',
                    type: 'function_call',
                    status: 'completed',
                    call_id: 'call-read-file',
                    name: 'read_file',
                    arguments: '{"path":"src/value.ts"}',
                  },
                ],
              },
            },
          ])
          return
        }

        const text = '파일을 확인했습니다.'
        const message = {
          id: 'message-item',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
        }
        writeSse(response, [
          {
            type: 'response.output_text.delta',
            sequence_number: 1,
            item_id: 'message-item',
            output_index: 0,
            content_index: 0,
            delta: text,
            logprobs: [],
          },
          {
            type: 'response.completed',
            sequence_number: 2,
            response: {
              id: 'response-final',
              status: 'completed',
              error: null,
              incomplete_details: null,
              output: [message],
            },
          },
        ])
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const root = await temporaryDirectory()
      await mkdir(join(root, 'src'))
      await writeFile(join(root, 'src', 'value.ts'), 'export const value = 42\n')

      const settings = new SettingsStore({
        userDataPath: await temporaryDirectory(),
        encryption: testEncryption,
      })
      const saved = await settings.saveProvider({
        name: 'Local test',
        baseUrl: `http://127.0.0.1:${port}/v1`,
      })
      const providerId = saved.providers[0].id
      await settings.saveSettings({
        activeProviderId: providerId,
        activeModelId: 'dynamic-test-model',
        theme: 'system',
        maxToolIterations: 4,
      })

      const workspace = new WorkspaceService()
      await workspace.openWorkspace(root, false)
      const agent = new AgentService(settings, workspace, {
        trust: { isTrusted: async () => true },
      })

      await expect(agent.listModels(providerId)).resolves.toEqual([
        { id: 'dynamic-test-model', createdAt: 1 },
      ])

      const events: AgentEvent[] = []
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('agent test timed out')), 5_000)
        agent.startRun(
          {
            conversationId: 'conversation-test',
            userMessageId: 'user-message-test',
            assistantMessageId: 'assistant-message-test',
            message: '값을 확인해줘',
            displayMessage: '값을 확인해줘',
            contextPaths: [],
          },
          (event) => {
            events.push(event)
            if (event.type === 'error') {
              clearTimeout(timeout)
              reject(new Error(event.message))
            }
            if (event.type === 'completed') {
              clearTimeout(timeout)
              resolve()
            }
          },
        )
      })

      expect(events.map((event) => event.type)).toEqual([
        'started',
        'tool-started',
        'tool-completed',
        'text-delta',
        'completed',
      ])
      expect(requestBodies).toHaveLength(2)
      expect(requestBodies[0]).toMatchObject({
        model: 'dynamic-test-model',
        store: false,
        truncation: 'auto',
      })
      const secondInput = requestBodies[1].input as Array<Record<string, unknown>>
      const toolOutput = secondInput.find((item) => item.type === 'function_call_output')
      expect(toolOutput?.output).toContain('export const value = 42')
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
})
