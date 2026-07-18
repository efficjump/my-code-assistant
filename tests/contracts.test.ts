import { describe, expect, it } from 'vitest'
import {
  agentRunInputSchema,
  createGoalInputSchema,
  goalIdInputSchema,
  listGoalsInputSchema,
  listWorkspaceInputSchema,
  mutateGoalInputSchema,
  providerInputSchema,
  settingsInputSchema,
} from '../src/shared/contracts'

describe('IPC contracts', () => {
  const validAgentRun = {
    conversationId: 'conversation-1',
    userMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
    message: '저장소를 분석해줘',
    displayMessage: '저장소를 분석해줘',
    contextPaths: [],
  }

  it('requires bounded path-scoped workspace directory pagination inputs', () => {
    expect(listWorkspaceInputSchema.parse({ path: null, cursor: null })).toEqual({
      path: null,
      cursor: null,
    })
    expect(
      listWorkspaceInputSchema.safeParse({ path: 'backend/src', cursor: 'abc_123-XYZ' }).success,
    ).toBe(true)
    expect(listWorkspaceInputSchema.safeParse({ path: null }).success).toBe(false)
    expect(listWorkspaceInputSchema.safeParse({ path: '', cursor: null }).success).toBe(false)
    expect(listWorkspaceInputSchema.safeParse({ path: 'src\0outside', cursor: null }).success).toBe(
      false,
    )
    expect(listWorkspaceInputSchema.safeParse({ path: null, cursor: '' }).success).toBe(false)
    expect(listWorkspaceInputSchema.safeParse({ path: null, cursor: 'not base64!' }).success).toBe(
      false,
    )
    expect(
      listWorkspaceInputSchema.safeParse({ path: null, cursor: null, limit: 10 }).success,
    ).toBe(false)
  })

  it('allows HTTPS and local development provider URLs', () => {
    expect(
      providerInputSchema.parse({
        name: 'Example provider',
        baseUrl: 'https://api.example.com/v1/',
        apiKey: 'test-key',
      }).baseUrl,
    ).toBe('https://api.example.com/v1')

    expect(
      providerInputSchema.safeParse({ name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1' })
        .success,
    ).toBe(true)

    expect(
      providerInputSchema.safeParse({ name: 'IPv6 local', baseUrl: 'http://[::1]:11434/v1' })
        .success,
    ).toBe(true)
  })

  it('rejects insecure remote provider URLs', () => {
    expect(
      providerInputSchema.safeParse({ name: 'Remote', baseUrl: 'http://example.com/v1' }).success,
    ).toBe(false)
    expect(
      providerInputSchema.safeParse({
        name: 'Embedded credentials',
        baseUrl: 'https://secret@example.com/v1',
      }).success,
    ).toBe(false)
    expect(
      providerInputSchema.safeParse({
        name: 'Query credential',
        baseUrl: 'https://example.com/v1?api_key=secret',
      }).success,
    ).toBe(false)
  })

  it('keeps agent and safety settings within bounded limits', () => {
    expect(
      agentRunInputSchema.safeParse({
        conversationId: 'conversation-1',
        message: '저장소를 분석해줘',
        contextPaths: Array.from({ length: 21 }, (_, index) => `file-${index}.ts`),
      }).success,
    ).toBe(false)

    expect(
      settingsInputSchema.safeParse({
        activeProviderId: null,
        activeModelId: null,
        theme: 'system',
        locale: 'en',
        maxToolIterations: 8,
      }).success,
    ).toBe(true)
    expect(
      settingsInputSchema.safeParse({
        activeProviderId: null,
        activeModelId: null,
        theme: 'system',
        locale: 'fr',
        maxToolIterations: 8,
      }).success,
    ).toBe(false)
    expect(
      settingsInputSchema.safeParse({
        activeProviderId: null,
        activeModelId: null,
        theme: 'system',
        maxToolIterations: 21,
      }).success,
    ).toBe(false)
    expect(
      settingsInputSchema.safeParse({
        activeProviderId: null,
        activeModelId: null,
        theme: 'system',
        maxToolIterations: 8,
        maxTotalToolCalls: 1_001,
      }).success,
    ).toBe(false)
    expect(
      settingsInputSchema.safeParse({
        activeProviderId: null,
        activeModelId: null,
        theme: 'system',
        maxToolIterations: 8,
        runTimeoutMinutes: 61,
      }).success,
    ).toBe(false)
  })

  it('accepts explicit run intents while remaining compatible with existing callers', () => {
    expect(agentRunInputSchema.safeParse(validAgentRun).success).toBe(true)

    for (const intent of ['answer', 'plan', 'act'] as const) {
      expect(agentRunInputSchema.safeParse({ ...validAgentRun, intent }).success).toBe(true)
    }

    expect(agentRunInputSchema.safeParse({ ...validAgentRun, intent: 'unknown' }).success).toBe(
      false,
    )
    expect(
      agentRunInputSchema.safeParse({ ...validAgentRun, mode: 'plan', intent: 'act' }).success,
    ).toBe(false)
    expect(
      agentRunInputSchema.safeParse({ ...validAgentRun, mode: 'goal', intent: 'plan' }).success,
    ).toBe(false)
    expect(
      agentRunInputSchema.safeParse({ ...validAgentRun, mode: 'plan', intent: 'plan' }).success,
    ).toBe(true)
    expect(
      agentRunInputSchema.safeParse({
        ...validAgentRun,
        assistantMessageId: validAgentRun.userMessageId,
      }).success,
    ).toBe(false)
  })

  it('validates bounded goal queries without accepting renderer-owned scope', () => {
    expect(listGoalsInputSchema.parse({})).toEqual({})
    expect(listGoalsInputSchema.parse({ statuses: ['active', 'blocked'], limit: 25 })).toEqual({
      statuses: ['active', 'blocked'],
      limit: 25,
    })

    expect(listGoalsInputSchema.safeParse({ statuses: [] }).success).toBe(false)
    expect(listGoalsInputSchema.safeParse({ statuses: ['active', 'active'] }).success).toBe(false)
    expect(listGoalsInputSchema.safeParse({ statuses: ['running'] }).success).toBe(false)
    expect(listGoalsInputSchema.safeParse({ limit: 501 }).success).toBe(false)
    expect(listGoalsInputSchema.safeParse({ workspacePath: '/injected' }).success).toBe(false)
    expect(goalIdInputSchema.safeParse({ goalId: 'goal-1', usedTokens: 10 }).success).toBe(false)
  })

  it('only accepts user-owned goal creation fields', () => {
    expect(
      createGoalInputSchema.parse({ objective: 'Implement durable goals', tokenBudget: 50_000 }),
    ).toEqual({ objective: 'Implement durable goals', tokenBudget: 50_000 })

    expect(createGoalInputSchema.safeParse({ objective: '   ' }).success).toBe(false)
    expect(
      createGoalInputSchema.safeParse({
        objective: 'Goal',
        tokenBudget: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false)
    for (const injectedField of ['workspacePath', 'usedTokens', 'progressSummary', 'blocked']) {
      expect(
        createGoalInputSchema.safeParse({ objective: 'Goal', [injectedField]: 'injected' }).success,
      ).toBe(false)
    }
  })

  it('validates revision-bound goal mutations as a strict discriminated union', () => {
    const identity = { goalId: 'goal-1', expectedRevision: 3 }

    expect(
      mutateGoalInputSchema.safeParse({
        action: 'edit',
        ...identity,
        objective: 'Updated objective',
      }).success,
    ).toBe(true)
    expect(
      mutateGoalInputSchema.safeParse({ action: 'edit', ...identity, tokenBudget: null }).success,
    ).toBe(true)
    expect(mutateGoalInputSchema.safeParse({ action: 'edit', ...identity }).success).toBe(false)

    for (const action of ['pause', 'resume', 'clear'] as const) {
      expect(mutateGoalInputSchema.safeParse({ action, ...identity }).success).toBe(true)
    }

    expect(
      mutateGoalInputSchema.safeParse({
        action: 'complete',
        ...identity,
        summary: 'Verified and completed.',
      }).success,
    ).toBe(true)
    expect(mutateGoalInputSchema.safeParse({ action: 'complete', ...identity }).success).toBe(false)
    expect(
      mutateGoalInputSchema.safeParse({ action: 'pause', ...identity, blocked: 'injected' })
        .success,
    ).toBe(false)
    expect(
      mutateGoalInputSchema.safeParse({
        action: 'resume',
        ...identity,
        progressSummary: 'injected',
      }).success,
    ).toBe(false)
  })
})
