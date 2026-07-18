import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { CanonicalToolDefinition } from '../src/main/runtime/assistant-driver'
import { ToolRegistry } from '../src/main/services/tools'

const definition: CanonicalToolDefinition = {
  name: 'echo_value',
  description: 'Echo one value.',
  strict: true,
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
}

const context = {
  runId: 'run',
  callId: 'call',
  deadlineAt: Date.now() + 60_000,
  signal: new AbortController().signal,
  workspaceTrusted: true,
  workspacePath: '/workspace',
  contextPaths: new Set<string>(),
  emit: () => undefined,
}

describe('ToolRegistry', () => {
  it('discovers enabled tools and validates their runtime arguments', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition,
      schema: z.object({ value: z.string().max(20) }).strict(),
      capability: 'read',
      risk: 'read-only',
      origin: 'builtin',
      execute: ({ value }) => ({ value }),
    })

    expect(registry.definitions(context).map((tool) => tool.name)).toEqual(['echo_value'])
    await expect(registry.execute('echo_value', '{"value":"ok"}', context)).resolves.toEqual({
      value: 'ok',
    })
    await expect(
      registry.execute('echo_value', '{"value":"ok","extra":true}', context),
    ).rejects.toThrow()
  })

  it('recovers provider-double-encoded containers from the registered JSON Schema', async () => {
    const registry = new ToolRegistry()
    const nestedDefinition: CanonicalToolDefinition = {
      name: 'apply_changes',
      description: 'Apply structured changes.',
      strict: true,
      inputSchema: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                metadata: { type: 'object', additionalProperties: true },
              },
              required: ['path', 'metadata'],
              additionalProperties: false,
            },
          },
          label: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        },
        required: ['changes', 'label'],
        additionalProperties: false,
      },
    }
    registry.register({
      definition: nestedDefinition,
      schema: z
        .object({
          changes: z.array(
            z.object({ path: z.string(), metadata: z.record(z.string(), z.unknown()) }).strict(),
          ),
          label: z.union([z.string(), z.array(z.string())]),
        })
        .strict(),
      capability: 'read',
      risk: 'read-only',
      origin: 'builtin',
      execute: (input) => input,
    })

    const argumentsJson = JSON.stringify({
      changes: JSON.stringify([
        { path: 'src/main.ts', metadata: JSON.stringify({ source: 'model' }) },
      ]),
      label: '["keep","as","text"]',
    })
    await expect(registry.execute('apply_changes', argumentsJson, context)).resolves.toEqual({
      changes: [{ path: 'src/main.ts', metadata: { source: 'model' } }],
      label: '["keep","as","text"]',
    })
  })

  it('does not coerce scalar strings or schema-unknown properties', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition,
      schema: z.object({ value: z.string() }).strict(),
      capability: 'read',
      risk: 'read-only',
      origin: 'builtin',
      execute: ({ value }) => value,
    })

    await expect(registry.execute('echo_value', '{"value":"[1,2]"}', context)).resolves.toBe(
      '[1,2]',
    )
    await expect(
      registry.execute('echo_value', '{"value":"ok","extra":"{\\"nested\\":true}"}', context),
    ).rejects.toThrow()
  })

  it('normalizes unambiguous anyOf scalars and defaults without changing string unions', async () => {
    const registry = new ToolRegistry()
    const commandDefinition: CanonicalToolDefinition = {
      name: 'run_typed_command',
      description: 'Run a typed command.',
      strict: true,
      inputSchema: {
        type: 'object',
        properties: {
          timeoutMs: {
            default: null,
            anyOf: [{ type: 'integer' }, { type: 'null' }],
          },
          literal: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['timeoutMs', 'literal'],
        additionalProperties: false,
      },
    }
    registry.register({
      definition: commandDefinition,
      schema: z
        .object({
          timeoutMs: z.number().int().nullable().default(null),
          literal: z.string().nullable(),
        })
        .strict(),
      capability: 'read',
      risk: 'read-only',
      origin: 'builtin',
      execute: (input) => input,
    })

    await expect(
      registry.execute('run_typed_command', '{"timeoutMs":"5000","literal":"null"}', context),
    ).resolves.toEqual({ timeoutMs: 5000, literal: 'null' })
    await expect(
      registry.execute(
        'run_typed_command',
        '{"timeoutMs":"9007199254740992","literal":"ok"}',
        context,
      ),
    ).rejects.toThrow()
  })

  it('normalizes recursive containers and scalars through local refs and combinators', async () => {
    const registry = new ToolRegistry()
    const referencedDefinition: CanonicalToolDefinition = {
      name: 'apply_referenced_settings',
      description: 'Apply referenced settings.',
      strict: true,
      inputSchema: {
        $defs: {
          retryCount: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          settings: {
            allOf: [
              {
                type: 'object',
                properties: { retries: { $ref: '#/$defs/retryCount' } },
                required: ['retries'],
                additionalProperties: false,
              },
            ],
          },
        },
        type: 'object',
        properties: {
          settings: { $ref: '#/$defs/settings' },
        },
        required: ['settings'],
        additionalProperties: false,
      },
    }
    registry.register({
      definition: referencedDefinition,
      schema: z
        .object({ settings: z.object({ retries: z.number().int().nullable() }).strict() })
        .strict(),
      capability: 'read',
      risk: 'read-only',
      origin: 'builtin',
      execute: (input) => input,
    })

    await expect(
      registry.execute(
        'apply_referenced_settings',
        JSON.stringify({ settings: JSON.stringify({ retries: '3' }) }),
        context,
      ),
    ).resolves.toEqual({ settings: { retries: 3 } })
  })

  it('repairs the selected union branch without changing properties it leaves unconstrained', async () => {
    const registry = new ToolRegistry()
    const unionDefinition: CanonicalToolDefinition = {
      name: 'apply_union_settings',
      description: 'Apply one of two settings shapes.',
      strict: true,
      inputSchema: {
        oneOf: [
          {
            type: 'object',
            properties: {
              kind: { const: 'typed' },
              value: { type: 'integer' },
            },
            required: ['kind', 'value'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              kind: { const: 'open' },
              retries: { type: 'integer' },
            },
            required: ['kind', 'retries'],
            additionalProperties: true,
          },
        ],
      },
    }
    registry.register({
      definition: unionDefinition,
      schema: z.union([
        z.object({ kind: z.literal('typed'), value: z.number().int() }).strict(),
        z.object({ kind: z.literal('open'), retries: z.number().int() }).passthrough(),
      ]),
      capability: 'read',
      risk: 'read-only',
      origin: 'builtin',
      execute: (input) => input,
    })

    await expect(
      registry.execute(
        'apply_union_settings',
        JSON.stringify({ kind: 'open', retries: '2', value: '5' }),
        context,
      ),
    ).resolves.toEqual({ kind: 'open', retries: 2, value: '5' })
  })

  it('returns a read-only receipt without changing the legacy execute result', async () => {
    const registry = new ToolRegistry()
    let resolverCalls = 0
    registry.register({
      definition,
      schema: z.object({ value: z.string() }).strict(),
      capability: 'read',
      risk: 'read-only',
      origin: 'builtin',
      execute: ({ value }) => ({ echoed: value }),
      resolveEffectReceipt: () => {
        resolverCalls += 1
        return { effectAttempted: true, executed: true, applied: true }
      },
    })

    await expect(registry.execute('echo_value', '{"value":"legacy"}', context)).resolves.toEqual({
      echoed: 'legacy',
    })
    await expect(
      registry.executeWithReceipt('echo_value', '{"value":"receipt"}', context),
    ).resolves.toEqual({
      result: { echoed: 'receipt' },
      receipt: { effectAttempted: false, executed: true, applied: false },
    })
    expect(resolverCalls).toBe(0)
  })

  it('requires side-effecting tools to opt in before claiming an applied receipt', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition,
      schema: z.object({ value: z.string() }).strict(),
      capability: 'write',
      risk: 'approval-required',
      origin: 'builtin',
      execute: ({ value }) => ({ path: value }),
    })

    await expect(
      registry.executeWithReceipt('echo_value', '{"value":"src/new.ts"}', context),
    ).resolves.toEqual({
      result: { path: 'src/new.ts' },
      receipt: { effectAttempted: true, executed: true, applied: false },
    })
  })

  it('uses a result-aware receipt resolver to distinguish a denied side effect', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition,
      schema: z.object({ value: z.string() }).strict(),
      capability: 'process',
      risk: 'approval-required',
      origin: 'builtin',
      execute: ({ value }) => ({ executed: false as const, decision: 'denied' as const, value }),
      resolveEffectReceipt: ({ input, result, context: receiptContext }) => {
        expect(input).toEqual({ value: 'blocked' })
        expect(result).toEqual({ executed: false, decision: 'denied', value: 'blocked' })
        expect(receiptContext).toBe(context)
        return { effectAttempted: true, executed: result.executed, applied: false }
      },
    })

    await expect(
      registry.executeWithReceipt('echo_value', '{"value":"blocked"}', context),
    ).resolves.toEqual({
      result: { executed: false, decision: 'denied', value: 'blocked' },
      receipt: { effectAttempted: true, executed: false, applied: false },
    })
  })

  it('rejects contradictory dynamic receipts', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition,
      schema: z.object({ value: z.string() }).strict(),
      capability: 'write',
      risk: 'approval-required',
      origin: 'builtin',
      execute: ({ value }) => value,
      resolveEffectReceipt: () => ({ effectAttempted: true, executed: false, applied: true }),
    })
    await expect(
      registry.executeWithReceipt('echo_value', '{"value":"x"}', context),
    ).rejects.toThrow('일관되지 않습니다')
  })

  it('rejects duplicate, oversized, malformed, disabled, and cancelled calls', async () => {
    const registry = new ToolRegistry({ maximumArgumentCharacters: 20 })
    const registration = {
      definition,
      schema: z.object({ value: z.string() }).strict(),
      capability: 'read' as const,
      risk: 'read-only' as const,
      origin: 'builtin' as const,
      isEnabled: ({ workspaceTrusted }: { workspaceTrusted: boolean }) => workspaceTrusted,
      execute: ({ value }: { value: string }) => value,
    }
    registry.register(registration)
    expect(() => registry.register(registration)).toThrow('중복')
    await expect(
      registry.execute('echo_value', JSON.stringify({ value: 'x'.repeat(30) }), context),
    ).rejects.toThrow('한도')
    await expect(registry.execute('echo_value', '{', context)).rejects.toThrow('JSON')
    await expect(
      registry.execute('echo_value', '{"value":"ok"}', { ...context, workspaceTrusted: false }),
    ).rejects.toThrow('사용할 수 없는')

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(
      registry.execute('echo_value', '{"value":"ok"}', {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled')
  })

  it('localizes registry-owned dispatch and receipt failures from the tool context', async () => {
    const registry = new ToolRegistry({ maximumArgumentCharacters: 20 })
    registry.register({
      definition,
      schema: z.object({ value: z.string() }).strict(),
      capability: 'write',
      risk: 'approval-required',
      origin: 'builtin',
      execute: ({ value }) => value,
      resolveEffectReceipt: () => ({ effectAttempted: true, executed: false, applied: true }),
    })
    registry.register({
      definition: { ...definition, name: 'bad_receipt' },
      schema: z.object({ value: z.string() }).strict(),
      capability: 'write',
      risk: 'approval-required',
      origin: 'builtin',
      execute: ({ value }) => value,
      resolveEffectReceipt: () => ({}) as never,
    })
    const englishContext = { ...context, locale: 'en' as const }

    await expect(registry.execute('missing_tool', '{}', englishContext)).rejects.toThrow(
      'The tool is not allowed or currently unavailable: missing_tool',
    )
    await expect(registry.execute('echo_value', '{', englishContext)).rejects.toThrow(
      'Tool arguments are not valid JSON.',
    )
    await expect(
      registry.execute('echo_value', JSON.stringify({ value: 'x'.repeat(30) }), englishContext),
    ).rejects.toThrow('Tool arguments exceeded the 20-character limit.')
    await expect(
      registry.executeWithReceipt('echo_value', '{"value":"x"}', englishContext),
    ).rejects.toThrow('The tool effect receipt is inconsistent: echo_value')
    await expect(
      registry.executeWithReceipt('bad_receipt', '{"value":"x"}', englishContext),
    ).rejects.toThrow('The tool effect receipt is invalid: bad_receipt')
  })

  it('accepts large bounded arguments with the default provider-facing budget', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition,
      schema: z.object({ value: z.string() }).strict(),
      capability: 'read',
      risk: 'read-only',
      origin: 'builtin',
      execute: ({ value }) => value.length,
    })
    const value = 'x'.repeat(100_000)

    await expect(registry.execute('echo_value', JSON.stringify({ value }), context)).resolves.toBe(
      value.length,
    )
  })

  it('enforces run-mode and actor policy in both discovery and dispatch', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition,
      schema: z.object({ value: z.string() }).strict(),
      capability: 'write',
      risk: 'approval-required',
      origin: 'builtin',
      allowedModes: ['interactive', 'goal'],
      allowedActors: ['main'],
      execute: ({ value }) => value,
    })

    const planContext = { ...context, runMode: 'plan' as const, actor: 'main' as const }
    expect(registry.definitions(planContext)).toEqual([])
    await expect(registry.execute('echo_value', '{"value":"x"}', planContext)).rejects.toThrow(
      '사용할 수 없는',
    )

    const subagentContext = {
      ...context,
      runMode: 'goal' as const,
      actor: 'subagent' as const,
    }
    expect(registry.definitions(subagentContext)).toEqual([])
    await expect(registry.execute('echo_value', '{"value":"x"}', subagentContext)).rejects.toThrow(
      '사용할 수 없는',
    )

    const goalContext = { ...context, runMode: 'goal' as const, actor: 'main' as const }
    expect(registry.definitions(goalContext).map((tool) => tool.name)).toEqual(['echo_value'])
    await expect(registry.execute('echo_value', '{"value":"x"}', goalContext)).resolves.toBe('x')
  })

  it('keeps mutating tools out of answer and plan intents', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition,
      schema: z.object({ value: z.string() }).strict(),
      capability: 'write',
      risk: 'approval-required',
      origin: 'builtin',
      execute: ({ value }) => value,
    })

    for (const intent of ['answer', 'plan'] as const) {
      const readOnlyContext = { ...context, intent }
      expect(registry.definitions(readOnlyContext)).toEqual([])
      await expect(
        registry.execute('echo_value', '{"value":"x"}', readOnlyContext),
      ).rejects.toThrow('사용할 수 없는')
    }

    const actContext = { ...context, intent: 'act' as const }
    expect(registry.definitions(actContext).map((tool) => tool.name)).toEqual(['echo_value'])
    await expect(registry.execute('echo_value', '{"value":"x"}', actContext)).resolves.toBe('x')
  })

  it('fails closed for write, process, and network capabilities even if risk is misclassified', async () => {
    const registry = new ToolRegistry()
    for (const capability of ['write', 'process', 'network'] as const) {
      registry.register({
        definition: { ...definition, name: `${capability}_probe` },
        schema: z.object({ value: z.string() }).strict(),
        capability,
        risk: 'read-only',
        origin: 'builtin',
        execute: ({ value }) => value,
      })
    }

    for (const intent of ['answer', 'plan'] as const) {
      const readOnlyContext = { ...context, intent }
      expect(registry.definitions(readOnlyContext)).toEqual([])
      for (const capability of ['write', 'process', 'network'] as const) {
        await expect(
          registry.execute(`${capability}_probe`, '{"value":"x"}', readOnlyContext),
        ).rejects.toThrow('사용할 수 없는')
      }
    }
  })
})
