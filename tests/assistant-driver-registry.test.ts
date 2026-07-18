import { describe, expect, it } from 'vitest'
import type { AssistantDriver } from '../src/main/runtime/assistant-driver'
import { AssistantDriverRegistry } from '../src/main/runtime/assistant-driver-registry'

const driver = (id: string): AssistantDriver =>
  ({
    id,
    inspect: async () => ({ features: [], limits: {} }),
    listModels: async () => [],
  }) as unknown as AssistantDriver

describe('AssistantDriverRegistry', () => {
  it('registers, resolves, lists, and unregisters dynamic drivers', () => {
    const beta = driver('beta-driver')
    const alpha = driver('alpha-driver')
    const registry = new AssistantDriverRegistry([beta])
    const unregister = registry.register(alpha)

    expect(registry.require('alpha-driver')).toBe(alpha)
    expect(registry.list().map(({ id }) => id)).toEqual(['alpha-driver', 'beta-driver'])
    unregister()
    expect(registry.get('alpha-driver')).toBeNull()
  })

  it('rejects invalid, duplicate, and unknown driver ids', () => {
    const registry = new AssistantDriverRegistry()
    expect(() => registry.register(driver('Invalid'))).toThrow('invalid')
    registry.register(driver('valid-driver'))
    expect(() => registry.register(driver('valid-driver'))).toThrow('already')
    expect(() => registry.require('missing-driver')).toThrow('not registered')
  })
})
