import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationRepository } from '../src/main/services/conversations'
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

const WORKSPACE_PATH = '/workspace'
const temporaryDirectories: string[] = []
const repositories: ConversationRepository[] = []

function temporaryRepository(): ConversationRepository {
  const directory = mkdtempSync(join(tmpdir(), 'code-assistant-ipc-goals-'))
  temporaryDirectories.push(directory)
  const repository = new ConversationRepository({
    databasePath: join(directory, 'history.sqlite3'),
  })
  repositories.push(repository)
  return repository
}

function rendererSurface() {
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
  }
}

function registerGoalIpc(
  repository: ConversationRepository,
  withGoalMutation: (
    goalId: string,
    preflight: () => void,
    operation: () => Promise<unknown> | unknown,
  ) => Promise<unknown>,
  conversations: ConversationRepository = repository,
) {
  const surface = rendererSurface()
  registerIpc({
    getWindow: () => surface.window,
    isTrustedRendererUrl: () => true,
    settings: {
      getSettings: async () => ({ locale: 'en' }),
    },
    startupReady: Promise.resolve(),
    workspace: {
      getWorkspace: () => ({ name: 'workspace', path: WORKSPACE_PATH }),
    },
    agent: {
      withGoalMutation,
      cancelAllRuns: () => undefined,
    },
    conversations,
    commands: {},
    git: {},
    mutations: {},
    recoverWorkspaceMutations: async () => undefined,
    takeRecoveryNotice: () => null,
    skills: {},
    trust: {},
  } as unknown as Parameters<typeof registerIpc>[0])
  const handler = electronMock.handlers.get(IPC_CHANNELS.mutateGoal)
  if (!handler) throw new Error('Goal mutation IPC handler was not registered.')
  return { handler, surface }
}

function checkpointAfterPreflight(repository: ConversationRepository) {
  return async (
    goalId: string,
    preflight: () => void,
    operation: () => Promise<unknown> | unknown,
  ): Promise<unknown> => {
    preflight()
    const current = repository.getGoal(goalId)
    if (!current) throw new Error('Goal was not found during simulated cancellation.')
    repository.appendGoalCheckpoint({
      goalId,
      expectedGoalRevision: current.revision,
      summary: `Fallback checkpoint at revision ${current.revision.toString()}.`,
    })
    return operation()
  }
}

afterEach(() => {
  electronMock.handlers.clear()
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true })
})

describe('Goal mutation IPC revision boundary', () => {
  it('rebases edits and pauses on fallback checkpoints created while an active run is cancelled', async () => {
    const repository = temporaryRepository()
    const created = repository.createGoal({
      id: 'goal-rebase',
      workspacePath: WORKSPACE_PATH,
      objective: 'Original objective',
    })
    const { handler, surface } = registerGoalIpc(repository, checkpointAfterPreflight(repository))

    const edited = await handler(surface.event, {
      action: 'edit',
      goalId: created.id,
      expectedRevision: created.revision,
      objective: 'Edited after cancellation',
    })
    expect(edited).toMatchObject({
      summary: {
        objective: 'Edited after cancellation',
        status: 'active',
        revision: 3,
      },
    })

    const paused = await handler(surface.event, {
      action: 'pause',
      goalId: created.id,
      expectedRevision: 3,
    })
    expect(paused).toMatchObject({
      summary: {
        objective: 'Edited after cancellation',
        status: 'paused',
        revision: 5,
      },
    })
    expect(
      repository.listGoalCheckpoints(created.id).map((checkpoint) => checkpoint.goalRevision),
    ).toEqual([4, 2])
  })

  it('rejects a stale user-observed revision before cancellation can mutate the Goal', async () => {
    const repository = temporaryRepository()
    const created = repository.createGoal({
      id: 'goal-stale-preflight',
      workspacePath: WORKSPACE_PATH,
      objective: 'Original objective',
    })
    repository.updateGoal(created.id, {
      expectedRevision: created.revision,
      objective: 'Externally edited objective',
    })
    const { handler, surface } = registerGoalIpc(repository, checkpointAfterPreflight(repository))

    await expect(
      handler(surface.event, {
        action: 'pause',
        goalId: created.id,
        expectedRevision: created.revision,
      }),
    ).rejects.toThrow('The goal revision changed from 1 to 2.')
    expect(repository.getGoal(created.id)).toMatchObject({
      objective: 'Externally edited objective',
      status: 'active',
      revision: 2,
    })
    expect(repository.listGoalCheckpoints(created.id)).toEqual([])
  })

  it('keeps the post-cancellation update CAS-bound when an external writer races it', async () => {
    const repository = temporaryRepository()
    const created = repository.createGoal({
      id: 'goal-external-race',
      workspacePath: WORKSPACE_PATH,
      objective: 'Original objective',
    })
    const observedExpectedRevisions: number[] = []
    let injectExternalWrite = true
    const conversations = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === 'updateGoal') {
          return (goalId: string, input: Parameters<ConversationRepository['updateGoal']>[1]) => {
            observedExpectedRevisions.push(input.expectedRevision)
            if (injectExternalWrite) {
              injectExternalWrite = false
              const current = target.getGoal(goalId)
              if (!current) throw new Error('Goal was not found during the external race.')
              target.updateGoal(goalId, {
                expectedRevision: current.revision,
                progressSummary: 'External writer won the race.',
              })
            }
            return target.updateGoal(goalId, input)
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const { handler, surface } = registerGoalIpc(
      repository,
      checkpointAfterPreflight(repository),
      conversations,
    )

    await expect(
      handler(surface.event, {
        action: 'edit',
        goalId: created.id,
        expectedRevision: created.revision,
        objective: 'This edit must not overwrite the race winner',
      }),
    ).rejects.toThrow('Goal revision changed from 2 to 3.')
    expect(observedExpectedRevisions).toEqual([2])
    expect(repository.getGoal(created.id)).toMatchObject({
      objective: 'Original objective',
      progressSummary: 'External writer won the race.',
      revision: 3,
    })
  })
})
