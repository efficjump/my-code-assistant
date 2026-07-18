import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostError } from '../src/main/services/host-errors'
import { IPC_CHANNELS } from '../src/shared/ipc-channels'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
}))

vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      electronMock.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => electronMock.handlers.delete(channel),
  },
}))

import { registerIpc } from '../src/main/ipc'

function appSettings(locale: 'ko' | 'en') {
  return {
    providers: [],
    activeProviderId: null,
    activeModelId: null,
    theme: 'system' as const,
    locale,
    maxToolIterations: 8,
    maxTotalToolCalls: 100,
    runTimeoutMinutes: 15,
  }
}

function rendererEvent() {
  const frame = { url: 'app://renderer/index.html' }
  const sender = {
    id: 1,
    mainFrame: frame,
    isDestroyed: () => false,
    getURL: () => frame.url,
    send: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  }
  return {
    event: { sender, senderFrame: frame },
    window: { isDestroyed: () => false, webContents: sender },
    sender,
  }
}

function dependencies(
  agent: Record<string, unknown>,
  locale: 'ko' | 'en',
  surface = rendererEvent(),
  overrides: Record<string, unknown> = {},
) {
  return {
    getWindow: () => surface.window,
    isTrustedRendererUrl: () => true,
    settings: { getSettings: async () => appSettings(locale) },
    startupReady: Promise.resolve(),
    workspace: {},
    agent: { cancelAllRuns: () => undefined, ...agent },
    commands: {},
    conversations: {},
    git: {},
    mutations: {},
    recoverWorkspaceMutations: async () => undefined,
    takeRecoveryNotice: () => null,
    skills: {},
    trust: {},
    ...overrides,
  } as unknown as Parameters<typeof registerIpc>[0]
}

afterEach(() => {
  electronMock.handlers.clear()
})

describe('IPC localization boundary', () => {
  it('holds renderer requests behind the startup credential-migration barrier', async () => {
    const surface = rendererEvent()
    let releaseStartup: (() => void) | undefined
    const startupReady = new Promise<void>((resolve) => {
      releaseStartup = resolve
    })
    const listModels = vi.fn(async () => [{ id: 'model', name: 'Model' }])
    registerIpc(
      dependencies({ listModels }, 'en', surface, {
        startupReady,
      }),
    )
    const handler = electronMock.handlers.get(IPC_CHANNELS.listModels)
    if (!handler) throw new Error('Model-list IPC handler was not registered.')

    const pending = handler(surface.event, { providerId: 'provider' })
    await Promise.resolve()
    expect(listModels).not.toHaveBeenCalled()
    releaseStartup?.()

    await expect(pending).resolves.toEqual([{ id: 'model', name: 'Model' }])
    expect(listModels).toHaveBeenCalledOnce()
  })

  it('formats stable synchronous agent guards in the configured English locale', async () => {
    const surface = rendererEvent()
    registerIpc(
      dependencies(
        {
          startRun: () => {
            throw new HostError({ code: 'agent.conversation_active' })
          },
        },
        'en',
        surface,
      ),
    )
    const handler = electronMock.handlers.get(IPC_CHANNELS.startRun)
    expect(handler).toBeDefined()

    await expect(
      handler?.(surface.event, {
        conversationId: 'conversation',
        userMessageId: 'user',
        assistantMessageId: 'assistant',
        message: 'continue',
        displayMessage: 'continue',
        contextPaths: [],
      }),
    ).rejects.toThrow('This conversation is already generating a response.')
  })

  it('localizes invalid IPC payloads but preserves and redacts external error text', async () => {
    const surface = rendererEvent()
    registerIpc(
      dependencies(
        {
          startRun: () => ({ runId: 'unused' }),
          listModels: async () => {
            throw new Error('Provider 자유 text Bearer top-secret-token')
          },
        },
        'en',
        surface,
      ),
    )
    const startHandler = electronMock.handlers.get(IPC_CHANNELS.startRun)
    const modelHandler = electronMock.handlers.get(IPC_CHANNELS.listModels)

    await expect(startHandler?.(surface.event, {})).rejects.toThrow('The request is invalid.')
    await expect(modelHandler?.(surface.event, { providerId: 'provider' })).rejects.toThrow(
      'Provider 자유 text Bearer [REDACTED]',
    )
  })

  it('uses the locale-aware fallback title for empty conversation summaries', async () => {
    const surface = rendererEvent()
    const record = {
      id: 'empty-title',
      summary: '',
      status: 'active',
      providerId: null,
      providerGeneration: null,
      modelId: null,
      workspacePath: '/workspace',
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      messageCount: 0,
      lastMessageAt: null,
    }
    const detail = { ...record, messages: [], runs: [], auditEvents: [] }
    registerIpc(
      dependencies({}, 'en', surface, {
        workspace: { getWorkspace: () => ({ name: 'workspace', path: '/workspace' }) },
        conversations: {
          listConversations: () => [record],
          getConversation: () => detail,
          fork: () => ({ ...detail, id: 'forked-empty-title' }),
        },
      }),
    )
    const listHandler = electronMock.handlers.get(IPC_CHANNELS.listConversations)
    const readHandler = electronMock.handlers.get(IPC_CHANNELS.readConversation)
    const forkHandler = electronMock.handlers.get(IPC_CHANNELS.forkConversation)

    await expect(listHandler?.(surface.event, {})).resolves.toEqual([
      expect.objectContaining({ id: 'empty-title', title: 'New conversation' }),
    ])
    await expect(readHandler?.(surface.event, { conversationId: 'empty-title' })).resolves.toEqual(
      expect.objectContaining({
        summary: expect.objectContaining({ id: 'empty-title', title: 'New conversation' }),
      }),
    )
    await expect(forkHandler?.(surface.event, { conversationId: 'empty-title' })).resolves.toEqual(
      expect.objectContaining({
        summary: expect.objectContaining({ id: 'forked-empty-title', title: 'New conversation' }),
      }),
    )
  })

  it('releases renderer ownership and its destroy listener after an interrupted run', async () => {
    const surface = rendererEvent()
    const cancelRun = vi.fn(async () => undefined)
    let emit!: (event: { runId: string; type: 'interrupted'; message: string }) => void
    registerIpc(
      dependencies(
        {
          startRun: (
            _input: unknown,
            listener: (event: { runId: string; type: 'interrupted'; message: string }) => void,
          ) => {
            emit = listener
            return { runId: 'interrupted-run' }
          },
          cancelRun,
        },
        'en',
        surface,
      ),
    )
    const startHandler = electronMock.handlers.get(IPC_CHANNELS.startRun)
    const cancelHandler = electronMock.handlers.get(IPC_CHANNELS.cancelRun)

    await expect(
      startHandler?.(surface.event, {
        conversationId: 'conversation',
        userMessageId: 'user',
        assistantMessageId: 'assistant',
        message: 'continue',
        displayMessage: 'continue',
        contextPaths: [],
      }),
    ).resolves.toEqual({ runId: 'interrupted-run' })
    expect(surface.sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function))
    const destroyListener = surface.sender.once.mock.calls[0]?.[1]
    expect(destroyListener).toBeTypeOf('function')

    emit({ runId: 'interrupted-run', type: 'interrupted', message: 'Run interrupted.' })

    expect(surface.sender.removeListener).toHaveBeenCalledWith('destroyed', destroyListener)
    await expect(cancelHandler?.(surface.event, { runId: 'interrupted-run' })).rejects.toThrow(
      'This renderer does not own the task.',
    )
    expect(cancelRun).not.toHaveBeenCalled()
  })
})
