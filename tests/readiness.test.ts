import { describe, expect, it } from 'vitest'
import { buildReadinessSnapshot } from '../src/shared/readiness'

describe('readiness snapshot', () => {
  it('guides missing dependencies in order without exposing blocked actions', () => {
    const snapshot = buildReadinessSnapshot({
      providerSelected: false,
      modelSelected: false,
      workspaceSelected: false,
      workspaceTrusted: false,
    })

    expect(snapshot.status).toBe('action-required')
    expect(snapshot.primaryActionId).toBe('settings.open-provider')
    expect(snapshot.items).toEqual([
      { id: 'provider', status: 'required', actionId: 'settings.open-provider' },
      { id: 'model', status: 'blocked', actionId: 'settings.select-model' },
      { id: 'workspace', status: 'recommended', actionId: 'workspace.choose' },
      { id: 'trust', status: 'blocked', actionId: 'workspace.trust' },
    ])
    expect(snapshot.actions.find(({ id }) => id === 'settings.select-model')).toMatchObject({
      availability: 'blocked',
      reasonCode: 'provider-required',
    })
  })

  it('keeps chat available while prioritizing a restricted workspace decision', () => {
    const snapshot = buildReadinessSnapshot({
      providerSelected: true,
      modelSelected: true,
      workspaceSelected: true,
      workspaceTrusted: false,
    })

    expect(snapshot.status).toBe('restricted')
    expect(snapshot.primaryActionId).toBe('workspace.trust')
    expect(snapshot.actions.find(({ id }) => id === 'conversation.start')).toMatchObject({
      availability: 'available',
    })
  })

  it('becomes ready only when every code-workspace dependency is complete', () => {
    const snapshot = buildReadinessSnapshot({
      providerSelected: true,
      modelSelected: true,
      workspaceSelected: true,
      workspaceTrusted: true,
    })

    expect(snapshot.status).toBe('ready')
    expect(snapshot.primaryActionId).toBe('conversation.start')
    expect(snapshot.items.every(({ status }) => status === 'complete')).toBe(true)
    expect(snapshot.actions.find(({ id }) => id === 'conversation.start')?.revision).toBe('1111')
  })

  it('normalizes impossible trust and model combinations to their dependency state', () => {
    const snapshot = buildReadinessSnapshot({
      providerSelected: false,
      modelSelected: true,
      workspaceSelected: false,
      workspaceTrusted: true,
    })

    expect(snapshot.items.find(({ id }) => id === 'model')?.status).toBe('blocked')
    expect(snapshot.items.find(({ id }) => id === 'trust')?.status).toBe('blocked')
    expect(snapshot.actions.find(({ id }) => id === 'conversation.start')?.availability).toBe(
      'blocked',
    )
  })
})
