import { createServer, type RequestListener, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ResponsesApiDriver, type ResponsesApiProfile } from '../src/main/drivers/responses-api'
import {
  AssistantDriverError,
  type CanonicalDriverEvent,
  type CanonicalToolChoice,
} from '../src/main/runtime/assistant-driver'

const servers: ReturnType<typeof createServer>[] = []

function writeSse(response: ServerResponse, events: unknown[]): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end('data: [DONE]\n\n')
}

function completedResponse(
  id: string,
  output: unknown[],
  usage?: { input: number; output: number; reasoning: number },
): Record<string, unknown> {
  return {
    id,
    status: 'completed',
    error: null,
    incomplete_details: null,
    output,
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
  }
}

async function listen(handler: RequestListener): Promise<{ baseUrl: string }> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` }
}

function profile(baseUrl: string): ResponsesApiProfile {
  return { id: 'local', name: 'Local', baseUrl, apiKey: null, generation: 1 }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    ),
  )
})

describe('ResponsesApiDriver', () => {
  it('classifies a structured required-tool choice violation as retryable', async () => {
    const endpoint = await listen((request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end()
        return
      }
      request.resume()
      request.on('end', () => {
        writeSse(response, [
          {
            type: 'response.failed',
            sequence_number: 1,
            response: {
              id: 'required-tool-choice-violation',
              status: 'failed',
              error: {
                code: 'tool_choice_violation',
                message: 'Structured provider contract violation.',
              },
              incomplete_details: null,
              output: [],
              usage: null,
            },
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    const session = driver.appendUserMessage(driver.createSession(), '도구를 호출해줘')
    const events: CanonicalDriverEvent[] = []

    await expect(
      driver.runTurn(
        {
          runId: 'retry-required-tool-choice-violation',
          profile: profile(endpoint.baseUrl),
          model: 'test-model',
          instructions: 'Call an enabled tool.',
          session,
          tools: [
            {
              name: 'read_file',
              description: 'Read a file.',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            },
          ],
          toolChoice: 'required',
        },
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({
      failure: {
        code: 'provider-error',
        retryable: true,
      },
    })
    expect(events).toEqual([expect.objectContaining({ type: 'failed' })])
  })

  it('rejects a falsely completed stream whose response snapshot is incomplete', async () => {
    const endpoint = await listen((request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end()
        return
      }
      request.resume()
      request.on('end', () => {
        writeSse(response, [
          {
            type: 'response.completed',
            sequence_number: 1,
            response: {
              id: 'falsely-completed-response',
              status: 'incomplete',
              error: null,
              incomplete_details: { reason: 'max_output_tokens' },
              output: [],
              usage: {
                input_tokens: 17,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: 1_024,
                output_tokens_details: { reasoning_tokens: 3 },
                total_tokens: 1_041,
              },
            },
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    const session = driver.appendUserMessage(driver.createSession(), '상태를 확인해줘')
    const events: CanonicalDriverEvent[] = []

    await expect(
      driver.runTurn(
        {
          runId: 'falsely-completed-stream',
          profile: profile(endpoint.baseUrl),
          model: 'test-model',
          instructions: 'Answer accurately.',
          session,
          tools: [],
        },
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({
      failure: {
        code: 'stream-incomplete',
        message: expect.stringContaining('max_output_tokens'),
        retryable: false,
      },
    })
    expect(events).toEqual([
      {
        type: 'usage',
        usage: {
          inputTokens: 17,
          outputTokens: 1_024,
          reasoningTokens: 3,
          totalTokens: 1_041,
        },
      },
      expect.objectContaining({ type: 'failed' }),
    ])
  })

  it('lists models and exposes provider-neutral extensible capabilities', async () => {
    const endpoint = await listen((request, response) => {
      if (request.method !== 'GET' || !request.url?.startsWith('/v1/models')) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'z-model', object: 'model', created: 2, owned_by: 'test' },
            { id: 'a-model', object: 'model', created: 1, owned_by: 'test' },
          ],
          has_more: false,
        }),
      )
    })
    const driver = new ResponsesApiDriver()

    await expect(driver.listModels(profile(endpoint.baseUrl))).resolves.toEqual([
      { id: 'a-model', createdAt: 1 },
      { id: 'z-model', createdAt: 2 },
    ])
    const capabilities = await driver.inspect(profile(endpoint.baseUrl))
    expect(capabilities.features).toEqual(
      expect.arrayContaining(['streaming', 'tool-calling', 'reasoning', 'opaque-session']),
    )
    expect(capabilities.limits.maxOutputTokens).toBeGreaterThan(0)
  })

  it('normalizes provider-compatible nullable and numeric tool arguments from the active schema', async () => {
    const endpoint = await listen((request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end()
        return
      }
      request.resume()
      request.on('end', () => {
        writeSse(response, [
          {
            type: 'response.completed',
            sequence_number: 1,
            response: completedResponse('normalized-tool-response', [
              {
                id: 'normalized-tool-item',
                type: 'function_call',
                call_id: 'normalized-tool-call',
                name: 'run_command',
                arguments: JSON.stringify({
                  summary: 'Build the project',
                  argv: ['./mvnw', 'test'],
                  timeoutMs: '5000',
                }),
                status: 'completed',
              },
            ]),
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    const session = driver.appendUserMessage(driver.createSession(), 'Build it.')

    const result = await driver.runTurn(
      {
        runId: 'normalize-tool-arguments',
        profile: profile(endpoint.baseUrl),
        model: 'test-model',
        instructions: 'Use the command tool.',
        session,
        tools: [
          {
            name: 'run_command',
            description: 'Run a command.',
            inputSchema: {
              type: 'object',
              properties: {
                summary: { type: 'string' },
                argv: { type: 'array', items: { type: 'string' } },
                cwd: { default: null, anyOf: [{ type: 'string' }, { type: 'null' }] },
                timeoutMs: {
                  default: null,
                  anyOf: [{ type: 'integer' }, { type: 'null' }],
                },
              },
              required: ['summary', 'argv', 'cwd', 'timeoutMs'],
              additionalProperties: false,
            },
          },
        ],
      },
      () => undefined,
    )

    expect(result.toolCalls).toEqual([
      {
        callId: 'normalized-tool-call',
        name: 'run_command',
        argumentsJson: JSON.stringify({
          summary: 'Build the project',
          argv: ['./mvnw', 'test'],
          timeoutMs: 5000,
          cwd: null,
        }),
      },
    ])
  })

  it('preserves ambiguous null strings and does not invent destructive nullable arguments', async () => {
    const endpoint = await listen((request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end()
        return
      }
      request.resume()
      request.on('end', () => {
        writeSse(response, [
          {
            type: 'response.completed',
            sequence_number: 1,
            response: completedResponse('literal-null-response', [
              {
                id: 'literal-null-item',
                type: 'function_call',
                call_id: 'literal-null-call',
                name: 'write_value',
                arguments: JSON.stringify({ newContent: 'null' }),
                status: 'completed',
              },
            ]),
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    const session = driver.appendUserMessage(driver.createSession(), 'Write the literal value.')

    const result = await driver.runTurn({
      runId: 'preserve-literal-null',
      profile: profile(endpoint.baseUrl),
      model: 'test-model',
      instructions: 'Use the write tool.',
      session,
      tools: [
        {
          name: 'write_value',
          description: 'Write or delete a value.',
          inputSchema: {
            type: 'object',
            properties: {
              baseSha256: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              newContent: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            },
            required: ['baseSha256', 'newContent'],
            additionalProperties: false,
          },
        },
      ],
    })

    expect(JSON.parse(result.toolCalls[0]?.argumentsJson ?? '{}')).toEqual({ newContent: 'null' })
  })

  it('keeps provider replay state opaque across a streamed tool round trip', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const rawToolText =
      '<tool_call><function=read_file><parameter=path>src/value.ts</parameter></function></tool_call>'
    const endpoint = await listen((request, response) => {
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
        bodies.push(JSON.parse(source) as Record<string, unknown>)
        if (bodies.length === 1) {
          const leakedMessage = {
            id: 'leaked-message',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: rawToolText, annotations: [], logprobs: [] }],
          }
          writeSse(response, [
            {
              type: 'response.output_text.delta',
              sequence_number: 1,
              item_id: 'leaked-message',
              output_index: 0,
              content_index: 0,
              delta: rawToolText,
              logprobs: [],
            },
            {
              type: 'response.completed',
              sequence_number: 2,
              response: completedResponse(
                'response-tool',
                [
                  leakedMessage,
                  {
                    id: 'call-item',
                    type: 'function_call',
                    status: 'completed',
                    call_id: 'call-1',
                    name: 'read_file',
                    arguments: '{"path":"src/value.ts"}',
                  },
                ],
                { input: 5, output: 3, reasoning: 1 },
              ),
            },
          ])
          return
        }
        const text = '확인했습니다.'
        const message = {
          id: 'message-1',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
        }
        writeSse(response, [
          {
            type: 'response.output_text.delta',
            sequence_number: 1,
            item_id: 'message-1',
            output_index: 0,
            content_index: 0,
            delta: '확인',
            logprobs: [],
          },
          {
            type: 'response.completed',
            sequence_number: 2,
            response: completedResponse('response-final', [message]),
          },
        ])
      })
    })

    const driver = new ResponsesApiDriver()
    let session = driver.createSession([
      { type: 'message', role: 'user', content: '이전 질문' },
      { type: 'message', role: 'assistant', content: '이전 답변' },
    ])
    session = driver.appendUserMessage(session, '파일을 읽어줘')
    const events: CanonicalDriverEvent[] = []
    const first = await driver.runTurn(
      {
        runId: 'run-1',
        profile: profile(endpoint.baseUrl),
        model: 'test-model',
        instructions: 'Be careful.',
        session,
        tools: [
          {
            name: 'read_file',
            description: 'Read a file.',
            strict: true,
            inputSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      },
      (event) => events.push(event),
    )
    expect(first.toolCalls).toEqual([
      { callId: 'call-1', name: 'read_file', argumentsJson: '{"path":"src/value.ts"}' },
    ])
    expect(first.finalText).toBe('')
    expect(first.usage).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      reasoningTokens: 1,
      totalTokens: 8,
    })

    session = driver.appendToolResults(first.session, [
      { callId: 'call-1', output: '{"ok":true,"result":"42"}' },
    ])
    const second = await driver.runTurn({
      runId: 'run-1',
      profile: profile(endpoint.baseUrl),
      model: 'test-model',
      instructions: 'Be careful.',
      session,
      tools: [],
    })
    expect(second.finalText).toBe('확인했습니다.')
    expect(second.finishReason).toBe('stop')
    expect(events.map((event) => event.type)).toEqual([
      'tool-call',
      'usage',
      'checkpoint',
      'completed',
    ])

    const secondInput = bodies[1].input as Array<Record<string, unknown>>
    expect(secondInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: '파일을 읽어줘' }),
        expect.objectContaining({ type: 'function_call', call_id: 'call-1' }),
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call-1',
          output: '{"ok":true,"result":"42"}',
        }),
      ]),
    )
    expect(
      secondInput.some(
        (item) => item.role === 'assistant' && JSON.stringify(item).includes(rawToolText),
      ),
    ).toBe(false)
    expect(Object.keys(second.session).sort()).toEqual(['driverId', 'sessionId'])
    expect(() => new ResponsesApiDriver().compactSession(second.session)).toThrow(
      AssistantDriverError,
    )
  })

  it('preserves ordinary JSON text when tools are available but no tool is called', async () => {
    const text = '{"status":"ok","items":[1,2,3]}'
    const endpoint = await listen((request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end()
        return
      }
      const message = {
        id: 'json-message',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
      }
      writeSse(response, [
        {
          type: 'response.output_text.delta',
          sequence_number: 1,
          item_id: 'json-message',
          output_index: 0,
          content_index: 0,
          delta: text,
          logprobs: [],
        },
        {
          type: 'response.completed',
          sequence_number: 2,
          response: completedResponse('response-json', [message]),
        },
      ])
    })
    const driver = new ResponsesApiDriver()
    const events: CanonicalDriverEvent[] = []
    const session = driver.appendUserMessage(driver.createSession([]), 'JSON으로 답해줘')

    const result = await driver.runTurn(
      {
        runId: 'run-json',
        profile: profile(endpoint.baseUrl),
        model: 'test-model',
        instructions: 'Return JSON.',
        session,
        tools: [
          {
            name: 'read_file',
            description: 'Read a file.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      },
      (event) => events.push(event),
    )

    expect(result.finalText).toBe(text)
    expect(events.filter((event) => event.type === 'text-delta')).toEqual([
      { type: 'text-delta', delta: text },
    ])
  })

  it('adapts a complete provider-text tool envelope and replays it as a structured call', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const rawToolText = '파일을 확인하겠습니다.\n[Calling tool=read_file({"path":"src/value.ts"})]'
    const endpoint = await listen((request, response) => {
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
        bodies.push(JSON.parse(source) as Record<string, unknown>)
        const text = bodies.length === 1 ? rawToolText : '파일을 확인했습니다.'
        const message = {
          id: `adapted-message-${bodies.length.toString()}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
        }
        writeSse(response, [
          {
            type: 'response.completed',
            sequence_number: 1,
            response: completedResponse(`adapted-${bodies.length.toString()}`, [message]),
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    const events: CanonicalDriverEvent[] = []
    const tool = {
      name: 'read_file',
      description: 'Read one file.',
      strict: true,
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    }
    let session = driver.appendUserMessage(driver.createSession(), '파일을 읽어줘')

    const adapted = await driver.runTurn(
      {
        runId: 'adapt-textual-tool-call',
        profile: profile(endpoint.baseUrl),
        model: 'test-model',
        instructions: 'Use tools when needed.',
        session,
        tools: [tool],
      },
      (event) => events.push(event),
    )

    expect(adapted.finalText).toBe('')
    expect(adapted.toolCalls).toEqual([
      expect.objectContaining({
        name: 'read_file',
        argumentsJson: '{"path":"src/value.ts"}',
      }),
    ])
    expect(events.some((event) => event.type === 'text-delta')).toBe(false)
    expect(JSON.stringify(events)).not.toContain(rawToolText)

    const call = adapted.toolCalls[0]
    expect(call).toBeDefined()
    session = driver.appendToolResults(adapted.session, [
      { callId: call?.callId ?? '', output: '{"ok":true}' },
    ])
    const completed = await driver.runTurn({
      runId: 'complete-adapted-tool-call',
      profile: profile(endpoint.baseUrl),
      model: 'test-model',
      instructions: 'Use tools when needed.',
      session,
      tools: [tool],
    })

    expect(completed.finalText).toBe('파일을 확인했습니다.')
    expect(bodies).toHaveLength(2)
    expect(JSON.stringify(bodies[1]?.input)).toContain('function_call')
    expect(JSON.stringify(bodies[1]?.input)).toContain('function_call_output')
    expect(JSON.stringify(bodies[1]?.input)).not.toContain(rawToolText)
  })

  it('normalizes schema-compatible arguments in an adapted provider-text tool envelope', async () => {
    const rawToolText =
      '[Calling tool=run_command({"summary":"Build","argv":["./mvnw","test"],"timeoutMs":"5000"})]'
    const endpoint = await listen((request, response) => {
      request.resume()
      request.on('end', () => {
        const message = {
          id: 'normalized-text-tool-message',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: rawToolText, annotations: [], logprobs: [] }],
        }
        writeSse(response, [
          {
            type: 'response.completed',
            sequence_number: 1,
            response: completedResponse('normalized-text-tool-response', [message]),
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    const session = driver.appendUserMessage(driver.createSession(), 'Build it.')

    const result = await driver.runTurn({
      runId: 'normalize-text-tool-arguments',
      profile: profile(endpoint.baseUrl),
      model: 'test-model',
      instructions: 'Use the command tool.',
      session,
      tools: [
        {
          name: 'run_command',
          description: 'Run a command.',
          inputSchema: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              argv: { type: 'array', items: { type: 'string' } },
              cwd: { default: null, anyOf: [{ type: 'string' }, { type: 'null' }] },
              timeoutMs: {
                default: null,
                anyOf: [{ type: 'integer' }, { type: 'null' }],
              },
            },
            required: ['summary', 'argv', 'cwd', 'timeoutMs'],
            additionalProperties: false,
          },
        },
      ],
    })

    expect(result.toolCalls).toEqual([expect.objectContaining({ name: 'run_command' })])
    expect(JSON.parse(result.toolCalls[0]?.argumentsJson ?? '{}')).toEqual({
      summary: 'Build',
      argv: ['./mvnw', 'test'],
      timeoutMs: 5000,
      cwd: null,
    })
  })

  it('recovers once when a known tool call is returned as incomplete protocol text', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const rawToolText =
      '파일을 읽겠습니다.\n<tool_call><function=read_file><parameter=path>"src/value.ts"'
    const recoveredToolText = '[Calling tool=read_file({"path":"src/value.ts"})]'
    const endpoint = await listen((request, response) => {
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
        bodies.push(JSON.parse(source) as Record<string, unknown>)
        if (bodies.length === 1) {
          const malformedMessage = {
            id: 'malformed-message',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: rawToolText, annotations: [], logprobs: [] }],
          }
          writeSse(response, [
            {
              type: 'response.output_text.delta',
              sequence_number: 1,
              item_id: 'malformed-message',
              output_index: 0,
              content_index: 0,
              delta: rawToolText,
              logprobs: [],
            },
            {
              type: 'response.completed',
              sequence_number: 2,
              response: completedResponse('malformed-response', [malformedMessage], {
                input: 5,
                output: 4,
                reasoning: 1,
              }),
            },
          ])
          return
        }
        const recoveredMessage = {
          id: 'recovered-message',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [
            { type: 'output_text', text: recoveredToolText, annotations: [], logprobs: [] },
          ],
        }
        writeSse(response, [
          {
            type: 'response.completed',
            sequence_number: 1,
            response: completedResponse('recovered-response', [recoveredMessage], {
              input: 7,
              output: 3,
              reasoning: 0,
            }),
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    const events: CanonicalDriverEvent[] = []
    const session = driver.appendUserMessage(driver.createSession(), '파일을 읽어줘')

    const result = await driver.runTurn(
      {
        runId: 'recover-tool-protocol',
        profile: profile(endpoint.baseUrl),
        model: 'test-model',
        instructions: 'Use tools when needed.',
        session,
        tools: [
          {
            name: 'read_file',
            description: 'Read a file.',
            strict: true,
            inputSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      },
      (event) => events.push(event),
    )

    expect(bodies).toHaveLength(2)
    expect(bodies[0].instructions).toBe('Use tools when needed.')
    expect(bodies[1].instructions).toContain('structured function call')
    expect(JSON.stringify(bodies[1].input)).not.toContain(rawToolText)
    expect(result.finalText).toBe('')
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: 'read_file',
        argumentsJson: '{"path":"src/value.ts"}',
      }),
    ])
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      reasoningTokens: 1,
      totalTokens: 19,
    })
    expect(events.some((event) => event.type === 'text-delta')).toBe(false)
    expect(JSON.stringify(events)).not.toContain(rawToolText)
    expect(JSON.stringify(events)).not.toContain(recoveredToolText)
  })

  it('recovers a bracketed textual replay of a completed tool call without exposing it', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const argumentsJson = JSON.stringify({
      summary: 'Create a UI file',
      changes: [
        {
          path: 'src/App.jsx',
          baseSha256: null,
          newContent: 'export const App = () => <div>{"]"}</div>\n',
        },
      ],
    })
    const reorderedReplayArguments = JSON.stringify({
      changes: [
        {
          newContent: 'export const App = () => <div>{"]"}</div>\n',
          baseSha256: null,
          path: 'src/App.jsx',
        },
      ],
      summary: 'Create a UI file',
    })
    const rawReplay = `[Calling tool: propose_file_changes(${reorderedReplayArguments}])\n작업 결과를 정리했습니다.`
    const safeFinal = '파일 변경을 완료했습니다.'
    const endpoint = await listen((request, response) => {
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
        bodies.push(JSON.parse(source) as Record<string, unknown>)
        if (bodies.length === 1) {
          writeSse(response, [
            {
              type: 'response.completed',
              sequence_number: 1,
              response: completedResponse('initial-file-call', [
                {
                  id: 'initial-file-call-item',
                  type: 'function_call',
                  status: 'completed',
                  call_id: 'initial-file-call',
                  name: 'propose_file_changes',
                  arguments: argumentsJson,
                },
              ]),
            },
          ])
          return
        }
        const text = bodies.length === 2 ? rawReplay : safeFinal
        const message = {
          id: `replay-message-${bodies.length.toString()}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
        }
        writeSse(response, [
          {
            type: 'response.output_text.delta',
            sequence_number: 1,
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            delta: text,
            logprobs: [],
          },
          {
            type: 'response.completed',
            sequence_number: 2,
            response: completedResponse(`replay-${bodies.length.toString()}`, [message], {
              input: bodies.length === 2 ? 11 : 13,
              output: bodies.length === 2 ? 7 : 3,
              reasoning: 0,
            }),
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    const tool = {
      name: 'propose_file_changes',
      description: 'Propose exact file changes.',
      strict: true,
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          changes: { type: 'array' },
        },
        required: ['summary', 'changes'],
        additionalProperties: false,
      },
    }
    let session = driver.appendUserMessage(driver.createSession(), 'UI 파일을 만들어줘')
    const initial = await driver.runTurn({
      runId: 'bracketed-replay-initial',
      profile: profile(endpoint.baseUrl),
      model: 'test-model',
      instructions: 'Use tools and finish the request.',
      session,
      tools: [tool],
    })
    session = driver.appendToolResults(initial.session, [
      { callId: 'initial-file-call', output: '{"ok":true,"result":{"applied":true}}' },
    ])
    const events: CanonicalDriverEvent[] = []

    const recovered = await driver.runTurn(
      {
        runId: 'bracketed-replay-final',
        profile: profile(endpoint.baseUrl),
        model: 'test-model',
        instructions: 'Use tools and finish the request.',
        session,
        tools: [tool],
      },
      (event) => events.push(event),
    )

    expect(bodies).toHaveLength(3)
    expect(bodies[2].instructions).toContain('never repeat an identical completed call')
    expect(JSON.stringify(bodies[2].input)).not.toContain(rawReplay)
    expect(recovered.finalText).toBe(safeFinal)
    expect(recovered.toolCalls).toEqual([])
    expect(recovered.usage).toEqual({
      inputTokens: 24,
      outputTokens: 10,
      reasoningTokens: 0,
      totalTokens: 34,
    })
    expect(JSON.stringify(events)).not.toContain(rawReplay)
  })

  it('records the first attempt usage when textual tool recovery closes incomplete', async () => {
    let requestCount = 0
    const rawToolText = '<tool_call><function=read_file><parameter=path>"src/value.ts"'
    const endpoint = await listen((request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end()
        return
      }
      request.resume()
      request.on('end', () => {
        requestCount += 1
        if (requestCount === 2) {
          writeSse(response, [])
          return
        }
        if (requestCount === 3) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              id: 'incomplete-recovery-fallback',
              status: 'incomplete',
              error: null,
              incomplete_details: { reason: 'provider_transport' },
              output: [],
              usage: null,
            }),
          )
          return
        }
        const message = {
          id: 'incomplete-recovery-message',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: rawToolText, annotations: [], logprobs: [] }],
        }
        writeSse(response, [
          {
            type: 'response.completed',
            sequence_number: 1,
            response: completedResponse('incomplete-recovery-initial', [message], {
              input: 9,
              output: 4,
              reasoning: 1,
            }),
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    const events: CanonicalDriverEvent[] = []
    const session = driver.appendUserMessage(driver.createSession(), '파일을 읽어줘')

    await expect(
      driver.runTurn(
        {
          runId: 'incomplete-textual-recovery',
          profile: profile(endpoint.baseUrl),
          model: 'test-model',
          instructions: 'Use tools when needed.',
          session,
          tools: [
            {
              name: 'read_file',
              description: 'Read one file.',
              inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
                additionalProperties: false,
              },
            },
          ],
        },
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({ failure: { code: 'stream-incomplete' } })
    expect(requestCount).toBe(3)
    expect(events).toEqual([
      {
        type: 'usage',
        usage: {
          inputTokens: 9,
          outputTokens: 4,
          reasoningTokens: 1,
          totalTokens: 13,
        },
      },
      expect.objectContaining({ type: 'failed' }),
    ])
    expect(JSON.stringify(events)).not.toContain(rawToolText)
  })

  it('falls back to a non-streaming response after a clean stream closes without completion', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const endpoint = await listen((request, response) => {
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
        bodies.push(JSON.parse(source) as Record<string, unknown>)
        if (bodies.length === 1) {
          writeSse(response, [])
          return
        }
        const message = {
          id: 'non-stream-fallback-message',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: '비스트리밍 복구 응답',
              annotations: [],
              logprobs: [],
            },
          ],
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify(
            completedResponse('non-stream-fallback-response', [message], {
              input: 5,
              output: 3,
              reasoning: 0,
            }),
          ),
        )
      })
    })
    const driver = new ResponsesApiDriver()
    const events: CanonicalDriverEvent[] = []
    const session = driver.appendUserMessage(driver.createSession(), '결과를 알려줘')

    const result = await driver.runTurn(
      {
        runId: 'non-stream-fallback',
        profile: profile(endpoint.baseUrl),
        model: 'test-model',
        instructions: 'Report the result.',
        session,
        tools: [
          {
            name: 'read_file',
            description: 'Read one file.',
            inputSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      },
      (event) => events.push(event),
    )

    expect(bodies.map((body) => body.stream)).toEqual([true, false])
    expect(result).toMatchObject({
      finalText: '비스트리밍 복구 응답',
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 3, reasoningTokens: 0, totalTokens: 8 },
    })
    expect(events).toContainEqual({ type: 'text-delta', delta: '비스트리밍 복구 응답' })
  })

  it('falls back after a deferred text stream ends without a terminal finish reason', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const endpoint = await listen((request, response) => {
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
        bodies.push(JSON.parse(source) as Record<string, unknown>)
        if (bodies.length === 1) {
          writeSse(response, [
            {
              type: 'response.output_text.delta',
              sequence_number: 1,
              item_id: 'unterminated-message',
              output_index: 0,
              content_index: 0,
              delta: 'discarded provisional text',
              logprobs: [],
            },
          ])
          return
        }
        const message = {
          id: 'terminal-fallback-message',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Recovered complete answer',
              annotations: [],
              logprobs: [],
            },
          ],
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify(
            completedResponse('terminal-fallback-response', [message], {
              input: 8,
              output: 3,
              reasoning: 0,
            }),
          ),
        )
      })
    })
    const driver = new ResponsesApiDriver()
    const events: CanonicalDriverEvent[] = []
    const session = driver.appendUserMessage(driver.createSession(), 'Report after reading.')

    const result = await driver.runTurn(
      {
        runId: 'terminal-finish-fallback',
        profile: profile(endpoint.baseUrl),
        model: 'test-model',
        instructions: 'Report the result.',
        session,
        tools: [
          {
            name: 'read_file',
            description: 'Read one file.',
            inputSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      },
      (event) => events.push(event),
    )

    expect(bodies.map((body) => body.stream)).toEqual([true, false])
    expect(result.finalText).toBe('Recovered complete answer')
    expect(events).toContainEqual({ type: 'text-delta', delta: 'Recovered complete answer' })
    expect(JSON.stringify(events)).not.toContain('discarded provisional text')
  })

  it('falls back after a provider streaming error event before a completed snapshot', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const endpoint = await listen((request, response) => {
      let source = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => {
        source += chunk
      })
      request.on('end', () => {
        bodies.push(JSON.parse(source) as Record<string, unknown>)
        if (bodies.length === 1) {
          writeSse(response, [
            {
              type: 'error',
              sequence_number: 1,
              code: 'provider_stream_ended',
              message: 'provider-specific premature termination',
              param: null,
            },
          ])
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify(
            completedResponse('event-error-fallback', [
              {
                id: 'event-error-message',
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: 'Recovered from provider event',
                    annotations: [],
                    logprobs: [],
                  },
                ],
              },
            ]),
          ),
        )
      })
    })
    const driver = new ResponsesApiDriver()
    const session = driver.appendUserMessage(driver.createSession(), 'Recover the result.')

    const result = await driver.runTurn(
      {
        runId: 'provider-event-fallback',
        profile: profile(endpoint.baseUrl),
        model: 'test-model',
        instructions: 'Return a result.',
        session,
        tools: [
          {
            name: 'read_file',
            description: 'Read one file.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      },
      () => undefined,
    )

    expect(bodies.map((body) => body.stream)).toEqual([true, false])
    expect(result.finalText).toBe('Recovered from provider event')
  })

  it('fails closed when bracket recovery repeats an already completed structured call', async () => {
    let requestCount = 0
    const argumentsJson = '{"path":"src/value.ts"}'
    const rawReplay = `[도구 호출: read_file(${argumentsJson}])`
    const endpoint = await listen((request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end()
        return
      }
      request.resume()
      request.on('end', () => {
        requestCount += 1
        const output =
          requestCount === 2
            ? [
                {
                  id: 'duplicate-replay-message',
                  type: 'message',
                  status: 'completed',
                  role: 'assistant',
                  content: [
                    { type: 'output_text', text: rawReplay, annotations: [], logprobs: [] },
                  ],
                },
              ]
            : [
                {
                  id: `duplicate-call-${requestCount.toString()}`,
                  type: 'function_call',
                  status: 'completed',
                  call_id:
                    requestCount === 1 ? 'completed-read-call' : 'recovered-duplicate-read-call',
                  name: 'read_file',
                  arguments: argumentsJson,
                },
              ]
        writeSse(response, [
          {
            type: 'response.completed',
            sequence_number: 1,
            response: completedResponse(`duplicate-${requestCount.toString()}`, output),
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    const tool = {
      name: 'read_file',
      description: 'Read one file.',
      strict: true,
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    }
    let session = driver.appendUserMessage(driver.createSession(), '파일을 읽어줘')
    const initial = await driver.runTurn({
      runId: 'duplicate-replay-initial',
      profile: profile(endpoint.baseUrl),
      model: 'test-model',
      instructions: 'Read and report.',
      session,
      tools: [tool],
    })
    session = driver.appendToolResults(initial.session, [
      { callId: 'completed-read-call', output: '{"ok":true,"result":"value"}' },
    ])
    const events: CanonicalDriverEvent[] = []

    await expect(
      driver.runTurn(
        {
          runId: 'duplicate-replay-final',
          profile: profile(endpoint.baseUrl),
          model: 'test-model',
          instructions: 'Read and report.',
          session,
          tools: [tool],
        },
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({
      failure: {
        code: 'stream-incomplete',
        message: expect.stringContaining('duplicate call was not executed'),
      },
    })
    expect(requestCount).toBe(3)
    expect(events.map((event) => event.type)).toEqual(['failed'])
    expect(JSON.stringify(events)).not.toContain(rawReplay)
  })

  it('allows a structured retry when the replayed completed call had failed', async () => {
    let requestCount = 0
    const argumentsJson = '{"path":"src/value.ts"}'
    const rawReplay = `[도구 호출: read_file(${argumentsJson}])`
    const endpoint = await listen((request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end()
        return
      }
      request.resume()
      request.on('end', () => {
        requestCount += 1
        const output =
          requestCount === 2
            ? [
                {
                  id: 'failed-call-replay-message',
                  type: 'message',
                  status: 'completed',
                  role: 'assistant',
                  content: [
                    { type: 'output_text', text: rawReplay, annotations: [], logprobs: [] },
                  ],
                },
              ]
            : [
                {
                  id: `failed-call-retry-${requestCount.toString()}`,
                  type: 'function_call',
                  status: 'completed',
                  call_id: requestCount === 1 ? 'failed-read-call' : 'recovered-read-retry-call',
                  name: 'read_file',
                  arguments: argumentsJson,
                },
              ]
        writeSse(response, [
          {
            type: 'response.completed',
            sequence_number: 1,
            response: completedResponse(`failed-call-${requestCount.toString()}`, output),
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    const tool = {
      name: 'read_file',
      description: 'Read one file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    }
    let session = driver.appendUserMessage(driver.createSession(), '파일을 읽어줘')
    const initial = await driver.runTurn({
      runId: 'failed-retry-initial',
      profile: profile(endpoint.baseUrl),
      model: 'test-model',
      instructions: 'Read and report.',
      session,
      tools: [tool],
    })
    session = driver.appendToolResults(initial.session, [
      { callId: 'failed-read-call', output: '{"ok":false}', isError: true },
    ])

    const recovered = await driver.runTurn({
      runId: 'failed-retry-recovery',
      profile: profile(endpoint.baseUrl),
      model: 'test-model',
      instructions: 'Read and report.',
      session,
      tools: [tool],
    })

    expect(requestCount).toBe(3)
    expect(recovered.toolCalls).toEqual([
      {
        callId: 'recovered-read-retry-call',
        name: 'read_file',
        argumentsJson,
      },
    ])
    expect(recovered.finalText).toBe('')
  })

  it('fails closed without exposing tool protocol text when automatic recovery also fails', async () => {
    let requestCount = 0
    const rawToolTexts = [
      '<tool_call><function=read_file><parameter=path>"src/value.ts"',
      '[Calling tool=read_file({})',
    ]
    const endpoint = await listen((request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end()
        return
      }
      request.resume()
      request.on('end', () => {
        requestCount += 1
        const rawToolText = rawToolTexts[requestCount - 1]
        const message = {
          id: `malformed-message-${requestCount.toString()}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: rawToolText, annotations: [], logprobs: [] }],
        }
        writeSse(response, [
          {
            type: 'response.output_text.delta',
            sequence_number: 1,
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            delta: rawToolText,
            logprobs: [],
          },
          {
            type: 'response.completed',
            sequence_number: 2,
            response: completedResponse(`malformed-${requestCount.toString()}`, [message]),
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    const events: CanonicalDriverEvent[] = []
    const session = driver.appendUserMessage(driver.createSession(), '파일을 읽어줘')

    await expect(
      driver.runTurn(
        {
          runId: 'reject-tool-protocol',
          profile: profile(endpoint.baseUrl),
          model: 'test-model',
          instructions: 'Use tools when needed.',
          session,
          tools: [
            {
              name: 'read_file',
              description: 'Read a file.',
              inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
                additionalProperties: false,
              },
            },
          ],
        },
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({
      failure: {
        code: 'tool-protocol-invalid',
        retryable: false,
      },
    })
    expect(requestCount).toBe(2)
    expect(events.map((event) => event.type)).toEqual(['failed'])
    for (const rawToolText of rawToolTexts) {
      expect(JSON.stringify(events)).not.toContain(rawToolText)
    }
  })

  it('retains request tools only as protocol guards when tool choice is none', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const rawToolText =
      '<tool_call><function=read_file><parameter=path>"src/value.ts"</parameter></function></tool_call>'
    const finalText = '적용된 작업을 확인했고 이번 실행 결과를 정리했습니다.'
    const endpoint = await listen((request, response) => {
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
        bodies.push(JSON.parse(source) as Record<string, unknown>)
        const text = bodies.length === 1 ? rawToolText : finalText
        const message = {
          id: `guarded-message-${bodies.length.toString()}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
        }
        writeSse(response, [
          {
            type: 'response.output_text.delta',
            sequence_number: 1,
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            delta: text,
            logprobs: [],
          },
          {
            type: 'response.completed',
            sequence_number: 2,
            response: completedResponse(`guarded-response-${bodies.length.toString()}`, [message], {
              input: 7,
              output: 3,
              reasoning: 0,
            }),
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    const events: CanonicalDriverEvent[] = []
    const session = driver.appendUserMessage(driver.createSession(), '적용 결과만 알려줘')

    const result = await driver.runTurn(
      {
        runId: 'guard-tools-disabled-final',
        profile: profile(endpoint.baseUrl),
        model: 'test-model',
        instructions: 'Report only host-observed results.',
        session,
        tools: [
          {
            name: 'read_file',
            description: 'Read one file.',
            inputSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
        toolChoice: 'none',
      },
      (event) => events.push(event),
    )

    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      expect(body).not.toHaveProperty('tools')
      expect(body.tool_choice).toBe('none')
    }
    expect(bodies[1]?.instructions).toContain('normal final assistant text only')
    expect(bodies[1]?.instructions).toContain('Tool calling is disabled')
    expect(bodies[1]?.instructions).not.toContain('structured function call')
    expect(result.finalText).toBe(finalText)
    expect(result.toolCalls).toEqual([])
    expect(result.usage).toEqual({
      inputTokens: 14,
      outputTokens: 6,
      reasoningTokens: 0,
      totalTokens: 20,
    })
    expect(events.filter((event) => event.type === 'text-delta')).toEqual([
      { type: 'text-delta', delta: finalText },
    ])
    expect(JSON.stringify(events)).not.toContain(rawToolText)
  })

  it('rejects repeated structured calls from a tools-disabled provider as non-retryable', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const argumentsJson = '{"path":"src/never-executed.ts"}'
    const endpoint = await listen((request, response) => {
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
        bodies.push(JSON.parse(source) as Record<string, unknown>)
        const sequence = bodies.length.toString()
        writeSse(response, [
          {
            type: 'response.completed',
            sequence_number: 1,
            response: completedResponse(`forbidden-structured-${sequence}`, [
              {
                id: `forbidden-structured-item-${sequence}`,
                type: 'function_call',
                status: 'completed',
                call_id: `forbidden-structured-call-${sequence}`,
                name: 'read_file',
                arguments: argumentsJson,
              },
            ]),
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    const events: CanonicalDriverEvent[] = []
    const session = driver.appendUserMessage(driver.createSession(), '결과만 알려줘')

    await expect(
      driver.runTurn(
        {
          runId: 'reject-structured-tools-disabled-protocol',
          profile: profile(endpoint.baseUrl),
          model: 'test-model',
          instructions: 'Return normal final text only.',
          session,
          tools: [
            {
              name: 'read_file',
              description: 'Read one file.',
              inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
                additionalProperties: false,
              },
            },
          ],
          toolChoice: 'none',
        },
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({
      failure: {
        code: 'tool-protocol-invalid',
        retryable: false,
      },
    })
    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      expect(body).not.toHaveProperty('tools')
      expect(body.tool_choice).toBe('none')
    }
    expect(bodies[1]?.instructions).toContain('Tool calling is disabled')
    expect(bodies[1]?.instructions).toContain('normal final assistant text only')
    expect(bodies[1]?.instructions).not.toContain('structured function call')
    expect(events.map((event) => event.type)).toEqual(['failed'])
    expect(JSON.stringify(events)).not.toContain(argumentsJson)
  })

  it('classifies repeated guarded protocol text as a non-retryable semantic failure', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const rawToolTexts = [
      '<tool_call><function=read_file><parameter=path>"src/first.ts"',
      '[Calling tool=read_file({"path":"src/second.ts"})',
    ]
    const endpoint = await listen((request, response) => {
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
        bodies.push(JSON.parse(source) as Record<string, unknown>)
        const rawToolText = rawToolTexts[bodies.length - 1]
        const message = {
          id: `repeated-guard-message-${bodies.length.toString()}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: rawToolText, annotations: [], logprobs: [] }],
        }
        writeSse(response, [
          {
            type: 'response.output_text.delta',
            sequence_number: 1,
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            delta: rawToolText,
            logprobs: [],
          },
          {
            type: 'response.completed',
            sequence_number: 2,
            response: completedResponse(`repeated-guard-response-${bodies.length.toString()}`, [
              message,
            ]),
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    const events: CanonicalDriverEvent[] = []
    const session = driver.appendUserMessage(driver.createSession(), '결과만 알려줘')

    await expect(
      driver.runTurn(
        {
          runId: 'reject-repeated-guarded-protocol',
          profile: profile(endpoint.baseUrl),
          model: 'test-model',
          instructions: 'Return normal final text only.',
          session,
          tools: [],
          protocolGuardTools: [
            {
              name: 'read_file',
              description: 'Read one file.',
              inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
                additionalProperties: false,
              },
            },
          ],
          toolChoice: 'none',
        },
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({
      failure: {
        code: 'tool-protocol-invalid',
        retryable: false,
      },
    })
    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      expect(body).not.toHaveProperty('tools')
      expect(body.tool_choice).toBe('none')
    }
    expect(events.map((event) => event.type)).toEqual(['failed'])
    for (const rawToolText of rawToolTexts) {
      expect(JSON.stringify(events)).not.toContain(rawToolText)
    }
  })

  it('preserves fenced protocol examples and markup for unknown tools', async () => {
    const responses = [
      '```xml\n<tool_call><function=read_file><parameter=path>src/value.ts</parameter>\n```',
      '```text\n[Calling tool: read_file({"path":"src/value.ts"})]\n```',
      '```text\n[Calling tool=read_file({"path":"src/value.ts"})]\n```',
      '<tool_call><function=unknown_tool><parameter=value>1</parameter></function></tool_call>',
      '[Calling tool: unknown_tool({"path":"src/value.ts"})])',
      '[예시] read_file({"path":"src/value.ts"})',
      '예시로 read_file({"path":"src/value.ts"}) 호출 표현을 설명할 수 있습니다.',
      '일반 설명에서 tool_call이라는 단어만 언급했습니다.',
    ]
    let requestCount = 0
    const endpoint = await listen((request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end()
        return
      }
      request.resume()
      request.on('end', () => {
        const text = responses[requestCount]
        requestCount += 1
        const message = {
          id: `example-message-${requestCount.toString()}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
        }
        writeSse(response, [
          {
            type: 'response.completed',
            sequence_number: 1,
            response: completedResponse(`example-${requestCount.toString()}`, [message]),
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()

    for (const [index, text] of responses.entries()) {
      const session = driver.appendUserMessage(driver.createSession(), '예시를 보여줘')
      const result = await driver.runTurn({
        runId: `preserve-example-${index.toString()}`,
        profile: profile(endpoint.baseUrl),
        model: 'test-model',
        instructions: 'Explain only.',
        session,
        tools: [
          {
            name: 'read_file',
            description: 'Read a file.',
            inputSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      })
      expect(result.finalText).toBe(text)
    }
    expect(requestCount).toBe(responses.length)
  })

  it('serializes every provider-neutral tool choice into the Responses request body', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const endpoint = await listen((request, response) => {
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
        const body = JSON.parse(source) as Record<string, unknown>
        bodies.push(body)
        const choice = body.tool_choice
        const selectedName =
          choice === 'required'
            ? 'read_file'
            : choice && typeof choice === 'object' && 'name' in choice
              ? String(choice.name)
              : null
        const output = selectedName
          ? [
              {
                id: `call-${bodies.length.toString()}`,
                type: 'function_call',
                status: 'completed',
                call_id: `call-${bodies.length.toString()}`,
                name: selectedName,
                arguments: '{}',
              },
            ]
          : []
        writeSse(response, [
          {
            type: 'response.completed',
            sequence_number: 1,
            response: completedResponse(`choice-${bodies.length.toString()}`, output),
          },
        ])
      })
    })
    const choices: CanonicalToolChoice[] = [
      'auto',
      'none',
      'required',
      { type: 'function', name: 'write_file' },
    ]
    const tools = [
      {
        name: 'read_file',
        description: 'Read a file.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'write_file',
        description: 'Write a file.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ]
    const driver = new ResponsesApiDriver()

    for (const [index, toolChoice] of choices.entries()) {
      const session = driver.appendUserMessage(driver.createSession(), '도구 선택을 확인해줘')
      await driver.runTurn({
        runId: `tool-choice-${index.toString()}`,
        profile: profile(endpoint.baseUrl),
        model: 'test-model',
        instructions: 'Follow the requested tool policy.',
        session,
        tools,
        toolChoice,
      })
    }

    expect(bodies.map((body) => body.tool_choice)).toEqual(choices)
  })

  it.each<{
    label: string
    toolChoice: CanonicalToolChoice
    output: unknown[]
  }>([
    { label: 'required with no call', toolChoice: 'required', output: [] },
    {
      label: 'specific function with no call',
      toolChoice: { type: 'function', name: 'read_file' },
      output: [],
    },
    {
      label: 'specific function with a different call',
      toolChoice: { type: 'function', name: 'read_file' },
      output: [
        {
          id: 'wrong-call',
          type: 'function_call',
          status: 'completed',
          call_id: 'wrong-call',
          name: 'write_file',
          arguments: '{}',
        },
      ],
    },
  ])('fails closed when a provider violates $label', async ({ toolChoice, output }) => {
    const bodies: Array<Record<string, unknown>> = []
    const endpoint = await listen((request, response) => {
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
        bodies.push(JSON.parse(source) as Record<string, unknown>)
        writeSse(response, [
          {
            type: 'response.completed',
            sequence_number: 1,
            response: completedResponse('violated-choice', output, {
              input: 7,
              output: 2,
              reasoning: 1,
            }),
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    const events: CanonicalDriverEvent[] = []
    const session = driver.appendUserMessage(driver.createSession(), '도구를 호출해줘')

    await expect(
      driver.runTurn(
        {
          runId: 'violated-tool-choice',
          profile: profile(endpoint.baseUrl),
          model: 'test-model',
          instructions: 'Call the selected tool.',
          session,
          tools: [
            {
              name: 'read_file',
              description: 'Read a file.',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            },
            {
              name: 'write_file',
              description: 'Write a file.',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            },
          ],
          toolChoice,
        },
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({
      failure: { code: 'stream-incomplete', retryable: true },
    })
    expect(bodies).toHaveLength(1)
    expect(bodies[0].tool_choice).toEqual(toolChoice)
    expect(events).toEqual([
      {
        type: 'usage',
        usage: { inputTokens: 7, outputTokens: 2, reasoningTokens: 1, totalTokens: 9 },
      },
      expect.objectContaining({ type: 'failed' }),
    ])
  })

  it('retries without encrypted reasoning and remembers the capability result', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const endpoint = await listen((request, response) => {
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
        const body = JSON.parse(source) as Record<string, unknown>
        bodies.push(body)
        if (bodies.length === 1) {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              error: {
                message: 'Unsupported include reasoning.encrypted_content',
                type: 'invalid_request_error',
                param: 'include',
                code: null,
              },
            }),
          )
          return
        }
        writeSse(response, [
          {
            type: 'response.completed',
            sequence_number: 1,
            response: completedResponse(`response-${bodies.length.toString()}`, []),
          },
        ])
      })
    })
    const driver = new ResponsesApiDriver()
    let session = driver.appendUserMessage(driver.createSession(), '첫 질문')
    const first = await driver.runTurn({
      runId: 'fallback-1',
      profile: profile(endpoint.baseUrl),
      model: 'test-model',
      instructions: '',
      session,
      tools: [],
    })
    session = driver.appendUserMessage(first.session, '두 번째 질문')
    await driver.runTurn({
      runId: 'fallback-2',
      profile: profile(endpoint.baseUrl),
      model: 'test-model',
      instructions: '',
      session,
      tools: [],
    })

    expect(bodies).toHaveLength(3)
    expect(bodies[0].include).toEqual(['reasoning.encrypted_content'])
    expect(bodies[1]).not.toHaveProperty('include')
    expect(bodies[2]).not.toHaveProperty('include')
  })

  it('allows only HTTPS or loopback HTTP profiles without URL credentials or query data', async () => {
    const driver = new ResponsesApiDriver()
    await expect(driver.inspect(profile('https://api.example.com/v1'))).resolves.toBeDefined()
    await expect(driver.inspect(profile('http://localhost:8000/v1'))).resolves.toBeDefined()

    for (const baseUrl of [
      'http://api.example.com/v1',
      'https://user:secret@api.example.com/v1',
      'https://api.example.com/v1?tenant=one',
      'https://api.example.com/v1#fragment',
    ]) {
      await expect(driver.inspect(profile(baseUrl))).rejects.toBeInstanceOf(AssistantDriverError)
    }
  })
})
