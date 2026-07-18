import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test'
import type { ReadinessSnapshot } from '../../src/shared/contracts'

interface RecordedRequest {
  method: string
  path: string
  body: unknown
}

interface MockProvider {
  baseUrl: string
  requests: RecordedRequest[]
  close(): Promise<void>
}

const repositoryRoot = resolve(process.cwd())
const modelId = 'e2e-model'
const streamedAnswer = '모의 스트리밍 응답입니다.'
const malformedRecoveryPrompt = '불완전한 도구 호출을 안전하게 복구해 줘'
const recoveredAnswer = '불완전 호출을 숨기고 자동 복구했습니다.'
const automaticFilePrompt = '승인 정책으로 파일을 자동 생성해 줘'
const automaticFileAnswer = '승인 정책 범위에서 파일을 생성했습니다.'
const manualApprovalPrompt = '직접 승인 후 검증 파일을 생성해 줘'
const manualApprovalAnswer = '직접 승인된 파일을 생성했습니다.'
const promiseOnlyPrompt = '앞서 설계한 기능을 실제 파일로 구현해 줘'
const promiseOnlyDraft = '구현하겠습니다. 계속 진행할까요?'
const promiseRecoveryAnswer = '요청한 기능 파일을 실제로 생성했습니다.'
const textualReplayPrompt = '완료된 파일 도구 호출을 텍스트로 반복하지 말고 구현해 줘'
const textualReplayAnswer = '완료된 도구 결과만 사용해 안전하게 마무리했습니다.'

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  let source = ''
  for await (const chunk of request) source += chunk.toString('utf8')
  if (!source) return null
  try {
    return JSON.parse(source)
  } catch {
    return source
  }
}

function latestUserMessage(body: unknown): string {
  if (!body || typeof body !== 'object' || !('input' in body) || !Array.isArray(body.input)) {
    return ''
  }
  for (let index = body.input.length - 1; index >= 0; index -= 1) {
    const item = body.input[index]
    if (!item || typeof item !== 'object' || !('role' in item) || item.role !== 'user') continue
    if ('content' in item && typeof item.content === 'string') return item.content
  }
  return ''
}

function responseSnapshot(): Record<string, unknown> {
  return {
    id: 'resp_e2e_1',
    object: 'response',
    created_at: Math.floor(Date.now() / 1_000),
    status: 'completed',
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 16_000,
    model: modelId,
    output: [
      {
        id: 'msg_e2e_1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: streamedAnswer,
            annotations: [],
          },
        ],
      },
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'auto',
    usage: {
      input_tokens: 5,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 8,
    },
  }
}

function completedSnapshot(
  id: string,
  output: unknown[],
  usage = { input: 5, output: 3 },
): Record<string, unknown> {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1_000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    model: modelId,
    output,
    usage: {
      input_tokens: usage.input,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: usage.output,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: usage.input + usage.output,
    },
  }
}

function writeSseEvent(response: ServerResponse, value: unknown): void {
  const type =
    typeof value === 'object' && value && 'type' in value ? String(value.type) : 'message'
  response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)
}

async function setComposerValue(composer: Locator, value: string): Promise<void> {
  await composer.evaluate((node, nextValue) => {
    const textarea = node as HTMLTextAreaElement
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (!valueSetter) throw new Error('HTMLTextAreaElement value setter is unavailable')
    valueSetter.call(textarea, nextValue)
    textarea.setSelectionRange(nextValue.length, nextValue.length)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
  await expect(composer).toHaveValue(value)
}

async function startMockProvider(): Promise<MockProvider> {
  const requests: RecordedRequest[] = []
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const body = await readRequestBody(request)
    requests.push({ method: request.method ?? 'GET', path, body })

    if (request.method === 'GET' && path === '/v1/models') {
      writeJson(response, 200, {
        object: 'list',
        data: [{ id: modelId, object: 'model', created: 1, owned_by: 'e2e' }],
      })
      return
    }

    if (request.method === 'POST' && path === '/v1/responses') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })
      const serializedBody = JSON.stringify(body)
      const userMessage = latestUserMessage(body)
      const toolChoice =
        body && typeof body === 'object' && 'tool_choice' in body ? body.tool_choice : undefined
      if (serializedBody.includes('Generate a concise conversation title')) {
        const title = '로컬 모의 공급자 응답 확인'
        const message = {
          id: 'msg_conversation_title',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: title, annotations: [] }],
        }
        writeSseEvent(response, {
          type: 'response.output_text.delta',
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          delta: title,
        })
        writeSseEvent(response, {
          type: 'response.completed',
          response: completedSnapshot('resp_conversation_title', [message]),
        })
        response.end('data: [DONE]\n\n')
        return
      }
      if (toolChoice === 'required' && serializedBody.includes('declare_run_completion')) {
        const requirement =
          userMessage.includes(promiseOnlyPrompt) ||
          userMessage.includes(automaticFilePrompt) ||
          userMessage.includes(manualApprovalPrompt) ||
          userMessage.includes(textualReplayPrompt)
            ? 'action'
            : 'response'
        writeSseEvent(response, {
          type: 'response.completed',
          response: completedSnapshot('resp_completion_contract', [
            {
              id: 'item_completion_contract',
              type: 'function_call',
              status: 'completed',
              call_id: 'call_completion_contract',
              name: 'declare_run_completion',
              arguments: JSON.stringify({
                requirement,
                requiredEffects: requirement === 'action' ? ['workspace-change'] : [],
                candidateDisposition:
                  requirement === 'action' &&
                  userMessage.includes(promiseOnlyPrompt) &&
                  !serializedBody.includes(promiseRecoveryAnswer)
                    ? 'retry'
                    : 'acceptable',
                rationale:
                  requirement === 'action'
                    ? 'The user expects an observable workspace change now.'
                    : 'A response satisfies the current request.',
              }),
            },
          ]),
        })
        response.end('data: [DONE]\n\n')
        return
      }
      if (userMessage.includes(textualReplayPrompt)) {
        const replayArguments = JSON.stringify({
          summary: '완료 호출 textual replay 방지 파일 생성',
          changes: [
            {
              path: 'REPLAY_GUARD.md',
              baseSha256: null,
              newContent: '# Replayed call blocked\n',
            },
          ],
        })
        if (serializedBody.includes('never repeat an identical completed call')) {
          const message = {
            id: 'msg_textual_replay_final',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: textualReplayAnswer, annotations: [] }],
          }
          writeSseEvent(response, {
            type: 'response.completed',
            response: completedSnapshot('resp_textual_replay_final', [message]),
          })
        } else if (serializedBody.includes('function_call_output')) {
          const rawReplay = `[Calling tool: propose_file_changes(${replayArguments}])`
          const message = {
            id: 'msg_textual_replay_raw',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: rawReplay, annotations: [] }],
          }
          writeSseEvent(response, {
            type: 'response.output_text.delta',
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            delta: rawReplay,
          })
          writeSseEvent(response, {
            type: 'response.completed',
            response: completedSnapshot('resp_textual_replay_raw', [message]),
          })
        } else {
          writeSseEvent(response, {
            type: 'response.completed',
            response: completedSnapshot('resp_textual_replay_call', [
              {
                id: 'item_textual_replay_call',
                type: 'function_call',
                status: 'completed',
                call_id: 'call_textual_replay',
                name: 'propose_file_changes',
                arguments: replayArguments,
              },
            ]),
          })
        }
        response.end('data: [DONE]\n\n')
        return
      }
      if (userMessage.includes(promiseOnlyPrompt)) {
        if (serializedBody.includes('function_call_output')) {
          const message = {
            id: 'msg_promise_recovery_final',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: promiseRecoveryAnswer, annotations: [] }],
          }
          writeSseEvent(response, {
            type: 'response.completed',
            response: completedSnapshot('resp_promise_recovery_final', [message]),
          })
        } else if (toolChoice === 'required') {
          writeSseEvent(response, {
            type: 'response.completed',
            response: completedSnapshot('resp_promise_recovery_call', [
              {
                id: 'item_promise_recovery_call',
                type: 'function_call',
                status: 'completed',
                call_id: 'call_promise_recovery',
                name: 'propose_file_changes',
                arguments: JSON.stringify({
                  summary: '무도구 완료 방지 E2E 파일 생성',
                  changes: [
                    {
                      path: 'ACTION_GUARD.md',
                      baseSha256: null,
                      newContent: '# Action completed\n',
                    },
                  ],
                }),
              },
            ]),
          })
        } else {
          const message = {
            id: 'msg_promise_only_draft',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: promiseOnlyDraft, annotations: [] }],
          }
          writeSseEvent(response, {
            type: 'response.output_text.delta',
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            delta: promiseOnlyDraft,
          })
          writeSseEvent(response, {
            type: 'response.completed',
            response: completedSnapshot('resp_promise_only_draft', [message]),
          })
        }
        response.end('data: [DONE]\n\n')
        return
      }
      if (userMessage.includes(automaticFilePrompt)) {
        if (serializedBody.includes('function_call_output')) {
          const message = {
            id: 'msg_auto_file_final',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: automaticFileAnswer, annotations: [] }],
          }
          writeSseEvent(response, {
            type: 'response.completed',
            response: completedSnapshot('resp_auto_file_final', [message]),
          })
        } else {
          writeSseEvent(response, {
            type: 'response.completed',
            response: completedSnapshot('resp_auto_file_call', [
              {
                id: 'item_auto_file_call',
                type: 'function_call',
                status: 'completed',
                call_id: 'call_auto_file',
                name: 'propose_file_changes',
                arguments: JSON.stringify({
                  summary: '자동 승인 E2E 파일 생성',
                  changes: [
                    {
                      path: 'backend/src/main/java/com/acme/AutoApproved.java',
                      baseSha256: null,
                      newContent: 'package com.acme;\n\npublic final class AutoApproved {}\n',
                    },
                  ],
                }),
              },
            ]),
          })
        }
        response.end('data: [DONE]\n\n')
        return
      }
      if (userMessage.includes(manualApprovalPrompt)) {
        if (serializedBody.includes('function_call_output')) {
          const message = {
            id: 'msg_manual_approval_final',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: manualApprovalAnswer, annotations: [] }],
          }
          writeSseEvent(response, {
            type: 'response.completed',
            response: completedSnapshot('resp_manual_approval_final', [message]),
          })
        } else {
          writeSseEvent(response, {
            type: 'response.completed',
            response: completedSnapshot('resp_manual_approval_call', [
              {
                id: 'item_manual_approval_call',
                type: 'function_call',
                status: 'completed',
                call_id: 'call_manual_approval',
                name: 'propose_file_changes',
                arguments: JSON.stringify({
                  summary: '직접 승인 dialog 검증 파일 생성',
                  changes: [
                    {
                      path: 'MANUAL_APPROVAL.md',
                      baseSha256: null,
                      newContent: '# Explicitly approved\n',
                    },
                  ],
                }),
              },
            ]),
          })
        }
        response.end('data: [DONE]\n\n')
        return
      }
      if (userMessage.includes(malformedRecoveryPrompt)) {
        if (serializedBody.includes('function_call_output')) {
          const message = {
            id: 'msg_recovered_final',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: recoveredAnswer, annotations: [] }],
          }
          writeSseEvent(response, {
            type: 'response.completed',
            response: completedSnapshot('resp_recovered_final', [message]),
          })
        } else if (serializedBody.includes('previous generation attempted')) {
          writeSseEvent(response, {
            type: 'response.completed',
            response: completedSnapshot('resp_recovered_call', [
              {
                id: 'item_recovered_call',
                type: 'function_call',
                status: 'completed',
                call_id: 'call_recovered_list',
                name: 'list_files',
                arguments: '{"path":null}',
              },
            ]),
          })
        } else {
          const rawToolText = '파일을 확인하겠습니다.\n[Calling tool=list_files({"path":null})]'
          const message = {
            id: 'msg_malformed_tool',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: rawToolText, annotations: [] }],
          }
          writeSseEvent(response, {
            type: 'response.output_text.delta',
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            delta: rawToolText,
          })
          writeSseEvent(response, {
            type: 'response.completed',
            response: completedSnapshot('resp_malformed_tool', [message]),
          })
        }
        response.end('data: [DONE]\n\n')
        return
      }
      const snapshot = responseSnapshot()
      writeSseEvent(response, { type: 'response.created', response: snapshot })
      writeSseEvent(response, {
        type: 'response.output_text.delta',
        item_id: 'msg_e2e_1',
        output_index: 0,
        content_index: 0,
        delta: '모의 스트리밍 ',
      })
      writeSseEvent(response, {
        type: 'response.output_text.delta',
        item_id: 'msg_e2e_1',
        output_index: 0,
        content_index: 0,
        delta: '응답입니다.',
      })
      writeSseEvent(response, { type: 'response.completed', response: snapshot })
      response.end('data: [DONE]\n\n')
      return
    }

    writeJson(response, 404, { error: { message: `Unexpected ${request.method} ${path}` } })
  })

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolvePromise()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Mock provider address unavailable')

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()))
      }),
  }
}

async function seedTestState(
  userDataPath: string,
  workspacePath: string,
  providerBaseUrl: string,
): Promise<void> {
  await mkdir(userDataPath, { recursive: true, mode: 0o700 })
  await writeFile(
    join(userDataPath, 'settings.json'),
    `${JSON.stringify(
      {
        version: 1,
        providers: [
          {
            id: 'e2e-provider',
            name: 'E2E Mock Provider',
            baseUrl: providerBaseUrl,
          },
        ],
        activeProviderId: 'e2e-provider',
        activeModelId: modelId,
        theme: 'light',
        maxToolIterations: 4,
        lastWorkspace: {
          name: 'e2e-workspace',
          path: workspacePath,
        },
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

async function titlebarPanelControls(page: Page): Promise<{
  titlebar: Locator
  leftToggle: Locator
  rightToggle: Locator
}> {
  const titlebar = page.locator('.titlebar')
  const leftToggle = titlebar.locator('button[aria-controls="workspace-explorer-panel"]')
  const rightToggle = titlebar.locator('button[aria-controls="file-preview-panel"]')

  await expect(titlebar).toHaveCount(1)
  await expect(
    titlebar.locator('.titlebar-left > button[aria-controls="workspace-explorer-panel"]'),
  ).toHaveCount(1)
  await expect(
    titlebar.locator('.titlebar-actions > button[aria-controls="file-preview-panel"]'),
  ).toHaveCount(1)

  return { titlebar, leftToggle, rightToggle }
}

async function expandWorkspaceDirectories(page: Page, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const row = page.locator(`.tree-row[title="${path}"]`)
    await expect(row, `${path} should be visible in the workspace explorer`).toBeVisible()
    if ((await row.getAttribute('aria-expanded')) === 'false') await row.click()
    await expect(row).toHaveAttribute('aria-expanded', 'true')
  }
}

test.describe.configure({ mode: 'serial' })

test.describe('Electron application smoke', () => {
  let application: ElectronApplication
  let page: Page
  let provider: MockProvider
  let temporaryRoot: string
  let userDataPath: string
  let workspacePath: string

  test.beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'code-assistant-e2e-'))
    userDataPath = join(temporaryRoot, 'user-data')
    workspacePath = join(temporaryRoot, 'e2e-workspace')
    await mkdir(join(workspacePath, 'prompts'), { recursive: true })
    await mkdir(join(workspacePath, 'backend', 'src', 'main', 'java', 'com', 'acme'), {
      recursive: true,
    })
    await writeFile(join(workspacePath, 'README.md'), '# E2E workspace\n', 'utf8')
    await writeFile(
      join(workspacePath, 'backend', 'src', 'main', 'java', 'com', 'acme', 'App.java'),
      'package com.acme;\n\npublic final class App {}\n',
      'utf8',
    )
    await writeFile(
      join(workspacePath, 'prompts', 'greet.command.md'),
      [
        '---',
        'name: greet',
        'description: E2E greeting prompt',
        'argument-hint: <topic>',
        '---',
        'Return a concise greeting about $ARGUMENTS.',
      ].join('\n'),
      'utf8',
    )
    workspacePath = await realpath(workspacePath)
    provider = await startMockProvider()
    await seedTestState(userDataPath, workspacePath, provider.baseUrl)

    application = await electron.launch({
      args: [repositoryRoot, `--user-data-dir=${userDataPath}`],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'false',
      },
      timeout: 30_000,
    })
    page = await application.firstWindow({ timeout: 30_000 })
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByRole('heading', { name: '오늘은 무엇을 만들어볼까요?' })).toBeVisible()
    await expect(page.locator('select[title="AI 모델"]')).toHaveValue(modelId)
  })

  test.afterAll(async () => {
    await application?.close().catch(() => undefined)
    await provider?.close().catch(() => undefined)
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  })

  test('boots through the real preload with hardened renderer preferences and CSP', async () => {
    const expectedUserDataPath = await realpath(userDataPath)
    const runtimeUserDataPath = await application.evaluate(({ app }) => app.getPath('userData'))
    expect(await realpath(runtimeUserDataPath)).toBe(expectedUserDataPath)

    const rendererBoundary = await page.evaluate(() => {
      const assistant = Reflect.get(window, 'assistant') as Record<string, unknown>
      return {
        url: window.location.href,
        processType: typeof Reflect.get(globalThis, 'process'),
        requireType: typeof Reflect.get(globalThis, 'require'),
        assistantType: typeof assistant,
        assistantFrozen: Object.isFrozen(assistant),
        bootstrapType: typeof assistant.bootstrap,
        startRunType: typeof assistant.startRun,
        createGoalType: typeof assistant.createGoal,
      }
    })
    expect(rendererBoundary).toEqual({
      url: 'app://renderer/index.html',
      processType: 'undefined',
      requireType: 'undefined',
      assistantType: 'object',
      assistantFrozen: true,
      bootstrapType: 'function',
      startRunType: 'function',
      createGoalType: 'function',
    })
    expect(await page.evaluate(() => window.open('data:text/html,blocked') === null)).toBe(true)
    expect(application.windows()).toHaveLength(1)

    const responsePromise = page.waitForResponse(
      (response) => response.url() === 'app://renderer/index.html',
    )
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('Main window not found')
      window.webContents.reload()
    })
    const headers = await (await responsePromise).allHeaders()
    await page.waitForLoadState('domcontentloaded')
    const csp = headers['content-security-policy'] ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    const root = page.locator('html')
    await expect(root).toHaveAttribute('data-theme', 'light')
    const palette = await root.evaluate((element) => {
      const styles = getComputedStyle(element)
      return {
        background: styles.getPropertyValue('--bg').trim().toLowerCase(),
        panel: styles.getPropertyValue('--panel').trim().toLowerCase(),
        accent: styles.getPropertyValue('--accent').trim().toLowerCase(),
        text: styles.getPropertyValue('--text').trim().toLowerCase(),
      }
    })
    expect(palette).toEqual({
      background: '#f7f9fc',
      panel: '#ffffff',
      accent: '#173f6d',
      text: '#102a43',
    })
    await expect(page.getByRole('progressbar', { name: '설정 3개 완료 · 1개 남음' })).toBeVisible()
  })

  test('shows only the next readiness step and focuses the composer from an available action', async () => {
    const progress = page.getByRole('progressbar', { name: '설정 3개 완료 · 1개 남음' })
    await expect(progress).toHaveAttribute('aria-valuenow', '3')
    await expect(progress).toHaveAttribute('aria-valuetext', '설정 3개 완료 · 1개 남음')
    await expect(page.locator('.readiness-next-step')).toContainText('Workspace Trust')
    await expect(page.locator('.readiness-next-step')).toContainText('제한됨')
    await expect(page.locator('.readiness-next-step')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Trust 검토' })).toHaveClass(/primary-button/)

    const startConversation = page.getByRole('button', { name: '요청 입력하기', exact: true })
    await expect(startConversation).toHaveClass(/ghost-button/)
    const screenshotPath = process.env.READINESS_HUB_SCREENSHOT_PATH
    if (screenshotPath) await page.locator('.chat-panel').screenshot({ path: screenshotPath })
    await startConversation.click()
    await expect(page.getByRole('combobox', { name: '메시지 입력' })).toBeFocused()

    const readiness = await page.evaluate(async () => {
      const assistant = Reflect.get(window, 'assistant') as {
        bootstrap(): Promise<{ readiness: ReadinessSnapshot }>
      }
      return (await assistant.bootstrap()).readiness
    })
    expect(readiness.status).toBe('restricted')
    expect(readiness.primaryActionId).toBe('workspace.trust')
    expect(readiness.actions.find(({ id }) => id === 'conversation.start')?.availability).toBe(
      'available',
    )
  })

  test('keeps both panel controls in one app bar and accessible at narrow widths', async () => {
    const { titlebar, leftToggle, rightToggle } = await titlebarPanelControls(page)
    const newConversation = titlebar.getByRole('button', { name: '새 대화 시작' })

    await expect(leftToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(rightToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(newConversation).toHaveText('새 대화')
    await expect(
      titlebar.locator('.titlebar-left').getByRole('button', { name: '새 대화 시작' }),
    ).toBeVisible()

    const leftBox = await leftToggle.boundingBox()
    const rightBox = await rightToggle.boundingBox()
    expect(leftBox).not.toBeNull()
    expect(rightBox).not.toBeNull()
    expect(
      Math.abs(
        (leftBox?.y ?? 0) +
          (leftBox?.height ?? 0) / 2 -
          ((rightBox?.y ?? 0) + (rightBox?.height ?? 0) / 2),
      ),
    ).toBeLessThanOrEqual(1)

    const actionLabels = await titlebar
      .locator('.titlebar-actions > button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))
    expect(actionLabels).toEqual(['Goals', '대화 기록', '설정 열기', '파일 미리보기 접기'])

    await rightToggle.click()
    await expect(rightToggle).toBeFocused()
    await expect(rightToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(rightToggle).toHaveAccessibleName('파일 미리보기 펼치기')
    await expect(page.locator('#file-preview-panel')).toBeHidden()
    await rightToggle.click()
    await expect(rightToggle).toBeFocused()
    await expect(rightToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('#file-preview-panel')).toBeVisible()

    await leftToggle.click()
    await expect(leftToggle).toBeFocused()
    await expect(leftToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(leftToggle).toHaveAccessibleName('탐색기 펼치기')
    await expect(page.locator('#workspace-explorer-panel')).toBeHidden()
    await leftToggle.click()
    await expect(leftToggle).toBeFocused()
    await expect(leftToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('#workspace-explorer-panel')).toBeVisible()

    try {
      const narrowSize = await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (!window) throw new Error('Main window not found')
        window.setContentSize(1_000, 700)
        return window.getContentSize()
      })
      expect(narrowSize).toEqual([1_000, 700])
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1_000)
      await expect(leftToggle).toBeVisible()
      await expect(rightToggle).toBeVisible()
      await expect(page.locator('#workspace-explorer-panel')).toBeVisible()
      await expect(page.locator('#file-preview-panel')).toBeVisible()
    } finally {
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (!window) throw new Error('Main window not found')
        window.setContentSize(1_440, 900)
      })
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1_440)
    }
  })

  test('expands deep source folders without presenting deferred children as empty', async () => {
    const sourcePaths = [
      'backend',
      'backend/src',
      'backend/src/main',
      'backend/src/main/java',
      'backend/src/main/java/com',
      'backend/src/main/java/com/acme',
    ]

    await expandWorkspaceDirectories(page, sourcePaths)

    await expect(
      page.locator('.tree-row[title="backend/src/main/java/com/acme/App.java"]'),
    ).toBeVisible()
    const explorerCapturePath = process.env.CODE_ASSISTANT_EXPLORER_CAPTURE
    if (explorerCapturePath) await page.screenshot({ path: explorerCapturePath })
  })

  test('shows one continuous focus ring around the complete composer', async () => {
    const input = page.getByRole('combobox', { name: '메시지 입력' })
    const composer = page.locator('.composer')
    const unfocusedShadow = await composer.evaluate(
      (element) => getComputedStyle(element).boxShadow,
    )

    await input.click()
    await expect(input).toBeFocused()
    await expect
      .poll(() => composer.evaluate((element) => getComputedStyle(element).boxShadow))
      .not.toBe(unfocusedShadow)

    const focusPresentation = await input.evaluate((element) => {
      const container = element.closest('.composer')
      if (!(container instanceof HTMLElement)) throw new Error('Composer container is unavailable')
      return {
        inputShadow: getComputedStyle(element).boxShadow,
        containerHasFocus: container.matches(':focus-within'),
      }
    })

    expect(focusPresentation).toEqual({
      inputShadow: 'none',
      containerHasFocus: true,
    })

    const screenshotPath = process.env.COMPOSER_FOCUS_SCREENSHOT_PATH
    if (screenshotPath) await page.locator('.chat-panel').screenshot({ path: screenshotPath })
  })

  test('switches the complete interface locale, persists it across reload, and restores Korean', async () => {
    const root = page.locator('html')
    await expect(root).toHaveAttribute('lang', 'ko')
    await expect(page.getByRole('heading', { name: '오늘은 무엇을 만들어볼까요?' })).toBeVisible()

    let controls = await titlebarPanelControls(page)
    await expect(controls.leftToggle).toHaveAccessibleName('탐색기 접기')
    await expect(controls.rightToggle).toHaveAccessibleName('파일 미리보기 접기')
    await expect(controls.titlebar.getByRole('button', { name: '새 대화 시작' })).toHaveText(
      '새 대화',
    )

    await page.locator('button[aria-label="설정 열기"]:visible').first().click()
    await expect(page.getByRole('heading', { name: '설정', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '설정 닫기' })).toBeFocused()
    await expect(controls.titlebar).toHaveAttribute('inert', '')
    await expect(controls.titlebar).toHaveAttribute('aria-hidden', 'true')
    await page.keyboard.press('Shift+Tab')
    await expect
      .poll(() =>
        page
          .locator('.settings-modal')
          .evaluate((dialog) => dialog.contains(document.activeElement)),
      )
      .toBe(true)
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: '설정 닫기' })).toBeFocused()

    await page.getByLabel('표시 이름').fill('저장 전 공급자 초안')
    await page.locator('.provider-form input[type="password"]').fill('unsaved-api-key-draft')
    const koreanLocaleSelect = page.getByLabel('표시 언어')
    await expect(koreanLocaleSelect).toHaveValue('ko')
    await koreanLocaleSelect.selectOption('en')

    await expect(root).toHaveAttribute('lang', 'en')
    await expect
      .poll(async () => {
        const source = JSON.parse(await readFile(join(userDataPath, 'settings.json'), 'utf8')) as {
          version?: number
          locale?: string
        }
        return { version: source.version, locale: source.locale }
      })
      .toEqual({ version: 5, locale: 'en' })
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('code-assistant.locale')))
      .toBe('en')

    const englishSettingsHeading = page.getByRole('heading', { name: 'Settings', exact: true })
    await expect(englishSettingsHeading).toBeVisible()
    await expect(page.getByLabel('Display language')).toHaveValue('en')
    await expect(page.getByLabel('Display name')).toHaveValue('저장 전 공급자 초안')
    await expect(page.locator('.provider-form input[type="password"]')).toHaveValue(
      'unsaved-api-key-draft',
    )
    await expect(page.getByLabel('Default model')).toHaveValue(modelId)
    await page.getByRole('button', { name: 'Close settings' }).click()
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open settings' }).first()).toBeFocused()
    await expect(controls.titlebar).not.toHaveAttribute('inert', '')
    await expect(controls.titlebar).not.toHaveAttribute('aria-hidden', 'true')

    controls = await titlebarPanelControls(page)
    await expect(
      controls.titlebar.getByRole('button', { name: 'Start a new conversation' }),
    ).toHaveText('New conversation')
    await expect(controls.leftToggle).toHaveAccessibleName('Collapse explorer')
    await expect(controls.rightToggle).toHaveAccessibleName('Collapse file preview')
    await expect(page.locator('#workspace-explorer-panel')).toHaveAttribute(
      'aria-label',
      'Workspace explorer',
    )
    await expect(page.locator('#file-preview-panel')).toHaveAttribute('aria-label', 'File preview')
    await expect(
      page.getByRole('heading', { name: 'What would you like to build today?' }),
    ).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Select a file to preview' })).toBeVisible()
    const englishActionLabels = await controls.titlebar
      .locator('.titlebar-actions > button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))
    expect(englishActionLabels).toEqual([
      'Goals',
      'Conversation history',
      'Open settings',
      'Collapse file preview',
    ])

    await controls.rightToggle.click()
    await expect(controls.rightToggle).toBeFocused()
    await expect(controls.rightToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(controls.rightToggle).toHaveAccessibleName('Expand file preview')
    await controls.rightToggle.click()
    await expect(controls.rightToggle).toBeFocused()
    await expect(controls.rightToggle).toHaveAttribute('aria-expanded', 'true')

    await controls.leftToggle.click()
    await expect(controls.leftToggle).toBeFocused()
    await expect(controls.leftToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(controls.leftToggle).toHaveAccessibleName('Expand explorer')
    await controls.leftToggle.click()
    await expect(controls.leftToggle).toBeFocused()
    await expect(controls.leftToggle).toHaveAttribute('aria-expanded', 'true')

    await controls.titlebar.getByRole('button', { name: 'Goals' }).click()
    await expect(page.getByRole('button', { name: 'New Goal' })).toBeVisible()
    await expect(page.getByText('No open Goals.', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')

    const reloadResponse = page.waitForResponse(
      (response) => response.url() === 'app://renderer/index.html',
    )
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.reload()
    })
    await reloadResponse
    await page.waitForLoadState('domcontentloaded')

    await expect(root).toHaveAttribute('lang', 'en')
    await expect(
      page.getByRole('heading', { name: 'What would you like to build today?' }),
    ).toBeVisible()
    controls = await titlebarPanelControls(page)
    await expect(
      controls.titlebar.getByRole('button', { name: 'Start a new conversation' }),
    ).toHaveText('New conversation')
    await expect(controls.leftToggle).toHaveAccessibleName('Collapse explorer')
    await expect(controls.rightToggle).toHaveAccessibleName('Collapse file preview')

    await controls.titlebar.getByRole('button', { name: 'Open settings' }).click()
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
    const englishLocaleSelect = page.getByLabel('Display language')
    await expect(englishLocaleSelect).toHaveValue('en')
    await englishLocaleSelect.selectOption('ko')

    await expect(root).toHaveAttribute('lang', 'ko')
    await expect
      .poll(async () => {
        const source = JSON.parse(await readFile(join(userDataPath, 'settings.json'), 'utf8')) as {
          version?: number
          locale?: string
        }
        return { version: source.version, locale: source.locale }
      })
      .toEqual({ version: 5, locale: 'ko' })

    const koreanSettingsHeading = page.getByRole('heading', { name: '설정', exact: true })
    await expect(koreanSettingsHeading).toBeVisible()
    await expect(page.getByLabel('표시 언어')).toHaveValue('ko')
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('code-assistant.locale')))
      .toBe('ko')
    await page.getByRole('button', { name: '설정 닫기' }).click()
    await expect(page.getByRole('heading', { name: '설정', exact: true })).toHaveCount(0)

    controls = await titlebarPanelControls(page)
    await expect(controls.titlebar.getByRole('button', { name: '새 대화 시작' })).toHaveText(
      '새 대화',
    )
    await expect(controls.leftToggle).toHaveAccessibleName('탐색기 접기')
    await expect(controls.rightToggle).toHaveAccessibleName('파일 미리보기 접기')
    await expect(page.getByRole('heading', { name: '오늘은 무엇을 만들어볼까요?' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '미리볼 파일을 선택하세요' })).toBeVisible()

    await controls.titlebar.getByRole('button', { name: 'Goals' }).click()
    await expect(page.getByRole('button', { name: '새 Goal' })).toBeVisible()
    await expect(page.getByText('열린 Goal이 없습니다.', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('persists workspace trust and supports accessible slash keyboard navigation', async () => {
    await page.getByRole('button', { name: 'Trust 검토' }).click()
    await expect(page.getByRole('progressbar')).toHaveCount(0)
    const readyDescription = page.getByText(
      '원하는 작업을 입력하거나 참고할 파일을 추가해 시작하세요.',
      { exact: true },
    )
    const requestButton = page.getByRole('button', { name: '요청 입력하기', exact: true })
    await expect(readyDescription).toBeVisible()
    await expect(requestButton).toBeVisible()
    const [descriptionBox, requestButtonBox] = await Promise.all([
      readyDescription.boundingBox(),
      requestButton.boundingBox(),
    ])
    expect(descriptionBox).not.toBeNull()
    expect(requestButtonBox).not.toBeNull()
    if (!descriptionBox || !requestButtonBox) throw new Error('Ready layout bounds are unavailable')
    expect(requestButtonBox.y - (descriptionBox.y + descriptionBox.height)).toBeGreaterThanOrEqual(
      20,
    )
    await expect(page.locator('.readiness-next-step')).toHaveCount(0)
    await expect(requestButton).toHaveClass(/primary-button/)
    await expect(page.getByText(/사용자 명령 1개/)).toBeVisible()

    const trustSource = JSON.parse(
      await readFile(join(userDataPath, 'workspace-trust.json'), 'utf8'),
    ) as { workspaces: Record<string, { canonicalPath: string; trusted: boolean }> }
    expect(Object.values(trustSource.workspaces)).toContainEqual(
      expect.objectContaining({ canonicalPath: workspacePath, trusted: true }),
    )

    const composer = page.getByRole('combobox', { name: '메시지 입력' })
    await page.mouse.move(0, 0)
    await setComposerValue(composer, '/')
    const listbox = page.getByRole('listbox', { name: '사용 가능한 슬래시 명령' })
    await expect(listbox).toBeVisible()
    await expect(composer).toHaveAttribute('aria-expanded', 'true')
    const initialSelection = listbox.locator('[role="option"][aria-selected="true"]')
    await expect(initialSelection).toContainText('/new')

    await composer.press('ArrowDown')
    const nextSelection = listbox.locator('[role="option"][aria-selected="true"]')
    await expect(nextSelection).toContainText('/clear')
    await composer.press('Enter')
    await expect(composer).toHaveValue('/clear')
    await expect(listbox.locator('[role="option"][aria-selected="true"]')).toContainText('/clear')
    await composer.press('Enter')
    await expect(composer).toHaveValue('')
    await expect(listbox).toBeHidden()

    await setComposerValue(composer, '/prompts:gre')
    await expect(listbox.getByRole('option')).toHaveCount(1)
    await expect(listbox.getByRole('option')).toContainText('/prompts:greet')
    await composer.press('Enter')
    await expect(composer).toHaveValue('/prompts:greet ')

    await setComposerValue(composer, '/sta')
    await expect(listbox).toBeVisible()
    await composer.press('Escape')
    await expect(listbox).toBeHidden()
    await expect(composer).toHaveValue('/sta')
  })

  test('traps focus in closeable dialogs, blocks the background, and restores the opener', async () => {
    const { titlebar } = await titlebarPanelControls(page)
    const historyTrigger = titlebar.getByRole('button', { name: '대화 기록' })
    await historyTrigger.click()
    const historyDialog = page.getByRole('dialog', { name: '대화 기록' })
    await expect(historyDialog).toBeVisible()
    await expect(page.getByRole('button', { name: '대화 기록 닫기' })).toBeFocused()
    await expect(titlebar).toHaveAttribute('inert', '')
    await expect(titlebar).toHaveAttribute('aria-hidden', 'true')
    await page.keyboard.press('Shift+Tab')
    await expect
      .poll(() => historyDialog.evaluate((dialog) => dialog.contains(document.activeElement)))
      .toBe(true)
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: '대화 기록 닫기' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(historyDialog).toHaveCount(0)
    await expect(historyTrigger).toBeFocused()
    await expect(titlebar).not.toHaveAttribute('inert', '')
    await expect(titlebar).not.toHaveAttribute('aria-hidden', 'true')

    const composer = page.getByRole('combobox', { name: '메시지 입력' })
    await setComposerValue(composer, '/git-status')
    await composer.press('Enter')
    const workspaceDialog = page.getByRole('dialog', { name: 'Git 및 Skills' })
    await expect(workspaceDialog).toBeVisible()
    await expect(page.getByRole('button', { name: 'Git 및 Skills 닫기' })).toBeFocused()
    await expect(titlebar).toHaveAttribute('inert', '')
    await page.keyboard.press('Escape')
    await expect(workspaceDialog).toHaveCount(0)
    await expect(composer).toBeFocused()
    await expect(titlebar).not.toHaveAttribute('inert', '')
  })

  test('keeps mandatory approval open on Escape and applies the same focus boundary to undo', async () => {
    const { titlebar } = await titlebarPanelControls(page)
    const composer = page.getByRole('combobox', { name: '메시지 입력' })
    await composer.fill(manualApprovalPrompt)
    await page.getByRole('button', { name: '보내기' }).click()

    const approvalDialog = page.getByRole('alertdialog', { name: '파일 변경 승인' })
    await expect(approvalDialog).toBeVisible()
    const deny = page.getByRole('button', { name: '거부' })
    const approve = page.getByRole('button', { name: '정확히 이 작업 승인' })
    await expect(deny).toBeFocused()
    await expect(titlebar).toHaveAttribute('inert', '')
    await page.keyboard.press('Shift+Tab')
    await expect(approve).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(deny).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(approvalDialog).toBeVisible()
    await expect(deny).toBeFocused()

    await approve.click()
    await expect(approvalDialog).toHaveCount(0)
    await expect(page.getByText(manualApprovalAnswer, { exact: true })).toBeVisible()
    await expect(readFile(join(workspacePath, 'MANUAL_APPROVAL.md'), 'utf8')).resolves.toBe(
      '# Explicitly approved\n',
    )
    await expect(titlebar).not.toHaveAttribute('inert', '')

    await setComposerValue(composer, '/undo')
    await page.getByRole('button', { name: '보내기' }).click()
    const undoDialog = page.getByRole('alertdialog', {
      name: '마지막 파일 변경을 되돌릴까요?',
    })
    await expect(undoDialog).toBeVisible()
    await expect(undoDialog.getByRole('button', { name: '취소' })).toBeFocused()
    await expect(titlebar).toHaveAttribute('inert', '')
    await page.keyboard.press('Escape')
    await expect(undoDialog).toHaveCount(0)
    await expect(titlebar).not.toHaveAttribute('inert', '')
  })

  test('configures scoped file and command auto-approval from settings', async () => {
    await page.locator('button[aria-label="설정 열기"]:visible').first().click()
    await expect(page.getByRole('heading', { name: '설정', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '승인 자동화' })).toBeVisible()
    await expect(page.locator('.policy-workspace-scope small')).toHaveAttribute(
      'title',
      workspacePath,
    )
    const runTimeout = page.getByLabel('작업 실행 제한 시간 (분)')
    await expect(runTimeout).toHaveValue('15')
    await runTimeout.fill('20')

    const quickFileApproval = page.getByLabel('파일 생성·수정 자동 승인')
    await quickFileApproval.check()
    await expect(quickFileApproval).toBeChecked()
    const fileMode = page.getByRole('group', { name: '파일 변경 승인 방식' })
    await expect(fileMode.getByRole('button', { name: '자동 승인' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await page.getByLabel('요청당 최대 파일').fill('12')
    await page.getByLabel('최대 변경 줄').fill('750')
    await page.getByLabel('최대 변경 바이트').fill('250000')

    const commandMode = page.getByRole('group', { name: '명령 실행 승인 방식' })
    await commandMode.getByRole('button', { name: '자동 승인' }).click()
    await page.getByLabel('절대 실행 파일 경로').fill('/usr/bin/env')
    await page.getByLabel(/필수 인수 접두사/).fill('printf\n%s\nverified')
    await page.getByLabel('접두사 뒤 추가 인수 허용').check()

    await page.getByLabel('표시 언어').selectOption('en')
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
    await expect(page.getByLabel('Default model')).toHaveValue(modelId)
    await expect(page.getByLabel('Run time limit (minutes)')).toHaveValue('20')
    await expect(page.getByLabel('Automatically approve file creation and edits')).toBeChecked()
    await expect(page.getByLabel('Maximum files per request')).toHaveValue('12')
    await expect(page.getByLabel('Maximum changed lines')).toHaveValue('750')
    await expect(page.getByLabel('Maximum changed bytes')).toHaveValue('250000')
    await expect(page.getByLabel('Absolute executable path')).toHaveValue('/usr/bin/env')
    await expect(page.getByLabel(/Required argument prefix/)).toHaveValue('printf\n%s\nverified')
    await expect(page.getByLabel('Allow additional arguments after the prefix')).toBeChecked()

    await page.getByLabel('Display language').selectOption('ko')
    await expect(page.getByRole('heading', { name: '설정', exact: true })).toBeVisible()
    await expect(quickFileApproval).toBeChecked()
    await expect(page.getByLabel('요청당 최대 파일')).toHaveValue('12')
    await expect(page.getByLabel('절대 실행 파일 경로')).toHaveValue('/usr/bin/env')
    await expect(page.getByLabel(/필수 인수 접두사/)).toHaveValue('printf\n%s\nverified')

    await page.getByRole('button', { name: '정책 저장' }).click()
    await expect(page.getByText('현재 워크스페이스의 승인 정책을 저장했습니다.')).toBeVisible()
    await page.getByRole('button', { name: 'AI 설정 저장' }).click()
    await expect(page.getByRole('heading', { name: '설정', exact: true })).toHaveCount(0)

    const settingsSource = JSON.parse(
      await readFile(join(userDataPath, 'settings.json'), 'utf8'),
    ) as {
      runTimeoutMinutes: number
      workspaceApprovalPolicies: Array<{
        workspacePath: string
        fileChanges: {
          mode: string
          scope?: string
          maxFilesPerRequest?: number
          rules?: Array<{ pathPrefix: string; operations: string[] }>
        }
        commands: { mode: string; rules?: Array<{ executable: string }> }
      }>
    }
    expect(settingsSource.runTimeoutMinutes).toBe(20)
    expect(settingsSource.workspaceApprovalPolicies).toContainEqual(
      expect.objectContaining({
        workspacePath,
        fileChanges: expect.objectContaining({
          mode: 'auto',
          scope: 'all-act-runs',
          maxFilesPerRequest: 12,
          rules: [{ pathPrefix: '.', operations: ['create', 'update'] }],
        }),
        commands: expect.objectContaining({
          mode: 'auto',
          rules: [expect.objectContaining({ executable: '/usr/bin/env' })],
        }),
      }),
    )
  })

  test('creates and manages an independent workspace Goal through the frozen preload API', async () => {
    const unrelatedConversation = 'Goal 실행과 무관한 기존 대화 문맥'
    const originalObjective = 'E2E에서 독립 Goal 수명주기를 검증한다.'
    const revisedObjective = 'E2E에서 격리된 Goal 실행과 수명주기를 검증한다.'
    const terminalObjective = '기본 필터에서 숨길 종료 Goal'
    const composer = page.getByRole('combobox', { name: '메시지 입력' })
    await composer.fill(unrelatedConversation)
    await page.getByRole('button', { name: '보내기' }).click()
    await expect(page.getByText(streamedAnswer, { exact: true })).toBeVisible()

    let goalsTrigger = page.getByRole('button', { name: 'Goals' }).first()
    await goalsTrigger.click()
    await expect(page.getByRole('heading', { name: 'Goals' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Goals 닫기' })).toBeFocused()
    await page.getByRole('button', { name: '새 Goal' }).click()
    await page.getByLabel('목표').fill(originalObjective)
    await page.getByLabel('토큰 예산 (선택)').fill('5000')
    await page.getByRole('button', { name: 'Goal 만들기' }).click()

    await expect(page.getByRole('heading', { name: originalObjective })).toBeVisible()
    await expect(page.getByText('5,000', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: '편집' }).click()
    await page.getByLabel('목표').fill(revisedObjective)
    await page.getByLabel('토큰 예산 (선택)').fill('')
    await page.getByRole('button', { name: '변경 저장' }).click()
    await expect(page.getByRole('heading', { name: revisedObjective })).toBeVisible()
    await expect(page.locator('.goal-budget strong')).toHaveText('0')

    await page.getByRole('button', { name: '일시정지' }).click()
    await expect(page.getByText('일시정지', { exact: true }).last()).toBeVisible()
    await page.getByRole('button', { name: '재개' }).click()
    await expect(page.getByText('진행 중', { exact: true }).last()).toBeVisible()
    await expect(page.getByRole('button', { name: new RegExp(revisedObjective) })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    const requestsBeforeGoalRun = provider.requests.length
    await page.getByRole('button', { name: '지금 실행' }).click()
    await expect(page.getByRole('heading', { name: 'Goals' })).toHaveCount(0)
    await expect(page.getByText(unrelatedConversation, { exact: true })).toHaveCount(0)
    await expect(page.getByText(`Goal 계속: ${revisedObjective}`, { exact: true })).toBeVisible()
    await expect(page.getByText(streamedAnswer, { exact: true })).toBeVisible()
    await expect(page.locator('article[aria-label="사용자 메시지"]')).toHaveCount(1)
    await expect(page.locator('article[aria-label="AI 응답"]')).toHaveCount(1)
    await expect
      .poll(() =>
        provider.requests.slice(requestsBeforeGoalRun).find((request) => {
          if (request.path !== '/v1/responses') return false
          return latestUserMessage(request.body).includes('Continue the attached durable goal')
        }),
      )
      .toBeTruthy()
    const goalRunRequest = provider.requests.slice(requestsBeforeGoalRun).find((request) => {
      if (request.path !== '/v1/responses') return false
      return latestUserMessage(request.body).includes('Continue the attached durable goal')
    })
    expect(JSON.stringify(goalRunRequest?.body)).not.toContain(unrelatedConversation)

    goalsTrigger = page.getByRole('button', { name: 'Goals' }).first()
    await goalsTrigger.click()
    await page.getByRole('button', { name: '새 Goal' }).click()
    await page.getByLabel('목표').fill(terminalObjective)
    await page.getByRole('button', { name: 'Goal 만들기' }).click()
    await expect(page.getByRole('heading', { name: terminalObjective })).toBeVisible()
    await page.getByRole('button', { name: 'Goal 종료' }).click()
    await page.getByRole('button', { name: 'Goal 영구 종료 확인' }).click()
    await expect(page.getByText(terminalObjective, { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '열린 Goal' }).click()
    await expect(page.getByText(terminalObjective, { exact: true }).first()).toBeVisible()
    await page.getByRole('button', { name: '전체 상태' }).click()
    await expect(page.getByText(terminalObjective, { exact: true })).toHaveCount(0)

    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: 'Goals' })).toHaveCount(0)
    await expect(goalsTrigger).toBeFocused()

    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.reload()
    })
    await page.waitForLoadState('domcontentloaded')
    goalsTrigger = page.getByRole('button', { name: 'Goals' }).first()
    await goalsTrigger.click()
    await expect(page.getByText(revisedObjective).first()).toBeVisible()
    await expect(page.getByText(terminalObjective, { exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: 'Goals' })).toHaveCount(0)
  })

  test('streams one mocked Responses API run into the conversation with usage', async () => {
    const requestsBefore = provider.requests.length
    const composer = page.getByRole('combobox', { name: '메시지 입력' })
    await composer.fill('로컬 모의 공급자에게 응답해 줘')
    await page.getByRole('button', { name: '보내기' }).click()

    await expect(page.getByText('로컬 모의 공급자에게 응답해 줘', { exact: true })).toBeVisible()
    await expect(page.getByText(streamedAnswer, { exact: true })).toBeVisible()
    await expect(page.locator('article[aria-label="사용자 메시지"]')).toHaveCount(1)
    await expect(page.locator('article[aria-label="AI 응답"]')).toHaveCount(1)
    await expect(page.locator('.message-meta')).toHaveCount(0)
    await expect(page.getByText('토큰 16', { exact: true })).toBeVisible()
    const response = page.locator('article[aria-label="AI 응답"]')
    const responseText = response.getByText(streamedAnswer, { exact: true })
    const copyAnswer = response.getByRole('button', { name: '답변 복사' })
    await expect(copyAnswer).toBeVisible()
    const [textBox, copyBox] = await Promise.all([
      responseText.boundingBox(),
      copyAnswer.boundingBox(),
    ])
    expect(textBox).not.toBeNull()
    expect(copyBox).not.toBeNull()
    expect(copyBox?.x).toBeLessThan((textBox?.x ?? 0) + 80)
    expect(copyBox?.y).toBeGreaterThan(textBox?.y ?? 0)
    const screenshotPath = process.env.ANSWER_COPY_SCREENSHOT_PATH
    if (screenshotPath) await response.screenshot({ path: screenshotPath })
    await copyAnswer.click()
    await expect(response.getByRole('button', { name: '복사됨' })).toBeVisible()
    await expect
      .poll(() => application.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(streamedAnswer)
    await expect(page.getByRole('button', { name: '중지' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '보내기' })).toBeDisabled()

    await expect
      .poll(
        () =>
          provider.requests
            .slice(requestsBefore)
            .filter((request) => request.path === '/v1/responses').length,
      )
      .toBe(3)
    const responseRequests = provider.requests
      .slice(requestsBefore)
      .filter((request) => request.path === '/v1/responses')
    const responseRequest = responseRequests[0]
    expect(responseRequest?.method).toBe('POST')
    expect(responseRequest?.body).toEqual(
      expect.objectContaining({
        model: modelId,
        stream: true,
        store: false,
      }),
    )
    expect(JSON.stringify(responseRequest?.body)).toContain('로컬 모의 공급자에게 응답해 줘')
    expect(responseRequests[1]?.body).toEqual(expect.objectContaining({ tool_choice: 'required' }))
    expect(JSON.stringify(responseRequests[1]?.body)).toContain('declare_run_completion')
    expect(responseRequests[2]?.body).toEqual(
      expect.objectContaining({ tool_choice: 'none', max_output_tokens: 64 }),
    )
    await page.getByRole('button', { name: '대화 기록' }).click()
    await expect(
      page.getByText('로컬 모의 공급자 응답 확인', { exact: true }).first(),
    ).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('discards promise-only output and performs the required workspace action', async () => {
    const requestsBefore = provider.requests.length
    const composer = page.getByRole('combobox', { name: '메시지 입력' })
    await composer.fill(promiseOnlyPrompt)
    await page.getByRole('button', { name: '보내기' }).click()

    await expect(page.getByText(promiseRecoveryAnswer, { exact: true })).toBeVisible()
    await expect(page.getByText(promiseOnlyDraft, { exact: true })).toHaveCount(0)
    const currentResponse = page.locator('article[aria-label="AI 응답"]').last()
    const activityToggle = currentResponse.locator('button.tool-activity-toggle')
    await expect(activityToggle).toBeVisible()
    await expect(activityToggle).toHaveAccessibleName(
      /도구 실행 내역 펼치기 · 1개 · 파일 1개 적용 · 완료 1개/,
    )
    await expect(currentResponse.getByText('파일 1개 적용 완료', { exact: true })).toBeVisible()
    await expect(activityToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(currentResponse.getByText('propose_file_changes', { exact: true })).toHaveCount(0)
    expect((await activityToggle.boundingBox())?.height).toBeLessThanOrEqual(36)
    expect(
      await activityToggle.evaluate((element) => getComputedStyle(element).borderLeftWidth),
    ).toBe('0px')
    await activityToggle.press('Enter')
    await expect(activityToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(
      currentResponse.locator('.tool-activity-list[aria-label="도구 실행 상세"]'),
    ).toBeVisible()
    await expect(currentResponse.getByText('propose_file_changes', { exact: true })).toBeVisible()
    await activityToggle.press('Space')
    await expect(activityToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(currentResponse.getByText('propose_file_changes', { exact: true })).toHaveCount(0)
    await expect(page.locator('.tool-card')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '파일 변경 승인' })).toHaveCount(0)
    await expect(readFile(join(workspacePath, 'ACTION_GUARD.md'), 'utf8')).resolves.toBe(
      '# Action completed\n',
    )

    const runRequests = provider.requests
      .slice(requestsBefore)
      .filter((request) => request.path === '/v1/responses')
    expect(runRequests).toHaveLength(4)
    expect(runRequests[1]?.body).toEqual(expect.objectContaining({ tool_choice: 'required' }))
    expect(JSON.stringify(runRequests[1]?.body)).toContain('declare_run_completion')
    expect(runRequests[2]?.body).toEqual(expect.objectContaining({ tool_choice: 'required' }))
    expect(runRequests[3]?.body).not.toHaveProperty('tool_choice')
  })

  test('applies a matching file policy without opening the approval dialog', async () => {
    await expandWorkspaceDirectories(page, [
      'backend',
      'backend/src',
      'backend/src/main',
      'backend/src/main/java',
      'backend/src/main/java/com',
      'backend/src/main/java/com/acme',
    ])
    const composer = page.getByRole('combobox', { name: '메시지 입력' })
    await composer.fill(automaticFilePrompt)
    await page.getByRole('button', { name: '보내기' }).click()

    await expect(page.getByText(automaticFileAnswer, { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '파일 변경 승인' })).toHaveCount(0)
    const automaticResponse = page.locator('article[aria-label="AI 응답"]').last()
    await automaticResponse.getByRole('button', { name: /도구 실행 내역 펼치기/ }).click()
    await expect(automaticResponse.getByText('propose_file_changes', { exact: true })).toBeVisible()
    await expect(
      readFile(
        join(workspacePath, 'backend', 'src', 'main', 'java', 'com', 'acme', 'AutoApproved.java'),
        'utf8',
      ),
    ).resolves.toBe('package com.acme;\n\npublic final class AutoApproved {}\n')
    await expect(
      page.locator('.tree-row[title="backend/src/main/java/com/acme/AutoApproved.java"]'),
    ).toBeVisible()
  })

  test('hides a textual replay of an already completed tool call', async () => {
    const requestsBefore = provider.requests.length
    const composer = page.getByRole('combobox', { name: '메시지 입력' })
    await composer.fill(textualReplayPrompt)
    await page.getByRole('button', { name: '보내기' }).click()

    await expect(page.getByText(textualReplayAnswer, { exact: true })).toBeVisible()
    const replayResponse = page.locator('article[aria-label="AI 응답"]').last()
    await replayResponse.getByRole('button', { name: /도구 실행 내역 펼치기/ }).click()
    await expect(replayResponse.getByText('propose_file_changes', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '파일 변경 승인' })).toHaveCount(0)
    await expect(readFile(join(workspacePath, 'REPLAY_GUARD.md'), 'utf8')).resolves.toBe(
      '# Replayed call blocked\n',
    )
    let visibleConversation = await page.locator('main').innerText()
    expect(visibleConversation).not.toContain('[Calling tool:')
    expect(visibleConversation).not.toContain('"newContent":"# Replayed call blocked')

    const runRequests = provider.requests
      .slice(requestsBefore)
      .filter((request) => request.path === '/v1/responses')
    expect(runRequests).toHaveLength(4)
    expect(JSON.stringify(runRequests[1]?.body)).toContain('function_call_output')
    expect(JSON.stringify(runRequests[2]?.body)).toContain(
      'never repeat an identical completed call',
    )
    expect(JSON.stringify(runRequests[2]?.body)).not.toContain('[Calling tool:')
    expect(runRequests[3]?.body).toEqual(expect.objectContaining({ tool_choice: 'required' }))
    expect(JSON.stringify(runRequests[3]?.body)).toContain('declare_run_completion')

    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.reload()
    })
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('button', { name: '대화 기록' }).first().click()
    const latestConversation = page.locator('.history-item-main').first()
    await expect(latestConversation).toBeVisible()
    await latestConversation.click()
    await expect(page.getByText(textualReplayPrompt, { exact: true })).toBeVisible()
    await expect(page.getByText(textualReplayAnswer, { exact: true })).toBeVisible()
    visibleConversation = await page.locator('main').innerText()
    expect(visibleConversation).not.toContain('[Calling tool:')
    expect(visibleConversation).not.toContain('"newContent":"# Replayed call blocked')
  })

  test('hides and automatically recovers malformed provider tool protocol text', async () => {
    const requestsBefore = provider.requests.length
    const composer = page.getByRole('combobox', { name: '메시지 입력' })
    await composer.fill(malformedRecoveryPrompt)
    await page.getByRole('button', { name: '보내기' }).click()

    await expect(page.getByText(recoveredAnswer, { exact: true })).toBeVisible()
    const recoveredResponse = page.locator('article[aria-label="AI 응답"]').last()
    await recoveredResponse.getByRole('button', { name: /도구 실행 내역 펼치기/ }).click()
    await expect(recoveredResponse.getByText('list_files', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '중지' })).toHaveCount(0)
    const visibleConversation = await page.locator('main').innerText()
    expect(visibleConversation).not.toContain('[Calling tool=')

    const runRequests = provider.requests
      .slice(requestsBefore)
      .filter((request) => request.path === '/v1/responses')
    expect(runRequests).toHaveLength(3)
    expect(JSON.stringify(runRequests[1]?.body)).toContain('function_call_output')
    expect(JSON.stringify(runRequests[1]?.body)).not.toContain('[Calling tool=')
    expect(runRequests[2]?.body).toEqual(expect.objectContaining({ tool_choice: 'required' }))
    expect(JSON.stringify(runRequests[2]?.body)).toContain('declare_run_completion')
  })

  test('does not allow Escape to bypass forced first-run settings', async () => {
    const { titlebar } = await titlebarPanelControls(page)
    await page.getByRole('button', { name: '설정 열기' }).first().click()
    const settingsDialog = page.getByRole('dialog', { name: '설정' })
    await expect(settingsDialog).toBeVisible()

    await settingsDialog.getByRole('button', { name: '제거', exact: true }).click()
    await settingsDialog.getByRole('button', { name: '정말 제거', exact: true }).click()
    await expect(settingsDialog.getByRole('button', { name: '설정 닫기' })).toHaveCount(0)
    await expect(settingsDialog.getByRole('button', { name: '새 공급자 추가' })).toBeFocused()
    await expect(titlebar).toHaveAttribute('inert', '')

    await page.keyboard.press('Escape')
    await expect(settingsDialog).toBeVisible()
    await expect(titlebar).toHaveAttribute('inert', '')
  })
})
