import type { ZodType, z } from 'zod'
import {
  type AgentEvent,
  type AgentRunIntent,
  type AppLocale,
  DEFAULT_APP_LOCALE,
} from '../../shared/contracts'
import type { CanonicalToolDefinition } from '../runtime/assistant-driver'
import { normalizeJsonSchemaValue } from '../runtime/json-schema-normalizer'
import { HostError } from './host-errors'
import { hostMessages } from './host-messages'

export type ToolCapability = 'read' | 'git' | 'write' | 'process' | 'skill' | 'network' | 'goal'
export type ToolRisk = 'read-only' | 'host-managed' | 'approval-required'
export type AgentRunMode = 'interactive' | 'plan' | 'goal'
export type ToolActor = 'main' | 'subagent'

export interface ToolContext {
  runId: string
  callId: string
  deadlineAt: number
  signal: AbortSignal
  workspaceTrusted: boolean
  workspacePath: string | null
  conversationId?: string
  goalId?: string
  runMode?: AgentRunMode
  intent?: AgentRunIntent
  actor?: ToolActor
  /** UI locale captured when the owning run started. */
  locale?: AppLocale
  /** Paths explicitly selected or safely observed during this run. */
  contextPaths: Set<string>
  emit: (event: AgentEvent) => void
}

export interface ToolExecutionReceipt {
  /** Whether the tool invocation requested a host-side side effect. */
  effectAttempted: boolean
  /** Whether the underlying side-effecting operation was actually executed. */
  executed: boolean
  /** Whether that operation successfully applied a side effect. */
  applied: boolean
}

export interface ToolExecutionResult<TResult = unknown> {
  result: TResult
  receipt: ToolExecutionReceipt
}

export interface ToolEffectReceiptContext<TInput = unknown, TResult = unknown> {
  input: TInput
  result: TResult
  context: ToolContext
}

export interface RegisteredTool<TSchema extends ZodType = ZodType, TResult = unknown> {
  definition: CanonicalToolDefinition
  schema: TSchema
  capability: ToolCapability
  risk: ToolRisk
  origin: 'builtin' | 'workspace' | 'mcp'
  allowedModes?: readonly AgentRunMode[]
  allowedIntents?: readonly AgentRunIntent[]
  allowedActors?: readonly ToolActor[]
  isEnabled?: (context: ToolContext) => boolean
  summarize?: (input: z.output<TSchema>, context: ToolContext) => string
  execute: (input: z.output<TSchema>, context: ToolContext) => Promise<TResult> | TResult
  /**
   * Resolves the effect receipt from the validated input and completed tool result.
   * Read-only tools always receive the registry's read-only receipt and do not call this resolver.
   */
  resolveEffectReceipt?: (
    execution: ToolEffectReceiptContext<z.output<TSchema>, TResult>,
  ) => Promise<ToolExecutionReceipt> | ToolExecutionReceipt
}

export interface ToolRegistryOptions {
  maximumArgumentCharacters?: number
}

const READ_ONLY_INTENT_CAPABILITIES = new Set<ToolCapability>(['read', 'git', 'skill', 'goal'])
const DEFAULT_MAXIMUM_ARGUMENT_CHARACTERS = 1_500_000

/** Runtime registry: discovery is dynamic, while validation and policy metadata stay deterministic. */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()
  private readonly maximumArgumentCharacters: number

  constructor(options: ToolRegistryOptions = {}) {
    this.maximumArgumentCharacters =
      options.maximumArgumentCharacters ?? DEFAULT_MAXIMUM_ARGUMENT_CHARACTERS
  }

  register<TSchema extends ZodType, TResult>(tool: RegisteredTool<TSchema, TResult>): () => void {
    const name = tool.definition.name
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || this.tools.has(name)) {
      throw new HostError({ code: 'tool.registration_invalid', tool: name })
    }
    if (tool.definition.strict !== true) {
      throw new HostError({ code: 'tool.strict_required', tool: name })
    }
    this.tools.set(name, tool as RegisteredTool)
    return () => {
      if (this.tools.get(name) === tool) this.tools.delete(name)
    }
  }

  definitions(context: ToolContext): CanonicalToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => this.isEnabled(tool, context))
      .map((tool) => tool.definition)
  }

  metadata(context: ToolContext): Array<{
    name: string
    capability: ToolCapability
    risk: ToolRisk
    origin: RegisteredTool['origin']
  }> {
    return [...this.tools.values()]
      .filter((tool) => this.isEnabled(tool, context))
      .map((tool) => ({
        name: tool.definition.name,
        capability: tool.capability,
        risk: tool.risk,
        origin: tool.origin,
      }))
  }

  risk(name: string, context: ToolContext): ToolRisk {
    const tool = this.tools.get(name)
    if (!tool || !this.isEnabled(tool, context)) {
      throw new HostError({ code: 'tool.unavailable', tool: name }, { locale: context.locale })
    }
    return tool.risk
  }

  async execute(name: string, rawArguments: string, context: ToolContext): Promise<unknown> {
    const { tool, input } = this.parse(name, rawArguments, context)
    if (context.signal.aborted) throw context.signal.reason ?? new Error('작업이 취소되었습니다.')
    return tool.execute(input, context)
  }

  validateArguments(name: string, rawArguments: string, context: ToolContext): void {
    this.parse(name, rawArguments, context)
  }

  async executeWithReceipt(
    name: string,
    rawArguments: string,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const { tool, input } = this.parse(name, rawArguments, context)
    if (context.signal.aborted) throw context.signal.reason ?? new Error('작업이 취소되었습니다.')

    const result = await tool.execute(input, context)
    if (this.isReadOnly(tool)) {
      return {
        result,
        receipt: { effectAttempted: false, executed: true, applied: false },
      }
    }

    const receipt = tool.resolveEffectReceipt
      ? await tool.resolveEffectReceipt({ input, result, context })
      : { effectAttempted: true, executed: true, applied: false }
    this.assertValidReceipt(receipt, tool.definition.name, context.locale)
    return { result, receipt }
  }

  describe(name: string, rawArguments: string, context: ToolContext): string {
    const { tool, input } = this.parse(name, rawArguments, context)
    const summary = tool.summarize?.(input, context)
    return (
      summary?.trim() ||
      hostMessages(context.locale ?? DEFAULT_APP_LOCALE).tool.fallback(tool.definition.name)
    )
  }

  private parse(
    name: string,
    rawArguments: string,
    context: ToolContext,
  ): { tool: RegisteredTool; input: unknown } {
    const tool = this.tools.get(name)
    if (!tool || !this.isEnabled(tool, context)) {
      throw new HostError({ code: 'tool.unavailable', tool: name }, { locale: context.locale })
    }
    if (rawArguments.length > this.maximumArgumentCharacters) {
      throw new HostError(
        {
          code: 'tool.arguments_too_long',
          limit: this.maximumArgumentCharacters,
        },
        { locale: context.locale },
      )
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(rawArguments)
    } catch {
      throw new HostError({ code: 'tool.invalid_json' }, { locale: context.locale })
    }
    const initial = tool.schema.safeParse(parsedJson)
    if (initial.success) return { tool, input: initial.data }

    const normalizedJson = normalizeJsonSchemaValue(parsedJson, tool.definition.inputSchema)
    if (normalizedJson === parsedJson) throw initial.error
    return { tool, input: tool.schema.parse(normalizedJson) }
  }

  private isEnabled(tool: RegisteredTool, context: ToolContext): boolean {
    const runMode = context.runMode ?? 'interactive'
    const intent = context.intent ?? (runMode === 'plan' ? 'plan' : 'act')
    const actor = context.actor ?? 'main'
    const intentRiskAllowed =
      intent === 'act' ||
      (tool.risk === 'read-only' && READ_ONLY_INTENT_CAPABILITIES.has(tool.capability))
    return (
      (tool.isEnabled?.(context) ?? true) &&
      intentRiskAllowed &&
      (tool.allowedModes?.includes(runMode) ?? true) &&
      (tool.allowedIntents?.includes(intent) ?? true) &&
      (tool.allowedActors?.includes(actor) ?? true)
    )
  }

  private isReadOnly(tool: RegisteredTool): boolean {
    return tool.risk === 'read-only' && READ_ONLY_INTENT_CAPABILITIES.has(tool.capability)
  }

  private assertValidReceipt(
    receipt: ToolExecutionReceipt,
    toolName: string,
    locale?: AppLocale,
  ): void {
    if (
      typeof receipt.effectAttempted !== 'boolean' ||
      typeof receipt.executed !== 'boolean' ||
      typeof receipt.applied !== 'boolean'
    ) {
      throw new HostError({ code: 'tool.receipt_invalid', tool: toolName }, { locale })
    }
    if (receipt.applied && (!receipt.effectAttempted || !receipt.executed)) {
      throw new HostError({ code: 'tool.receipt_inconsistent', tool: toolName }, { locale })
    }
  }
}
