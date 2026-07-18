import { describe, expect, it } from 'vitest'
import { normalizeJsonSchemaValue } from '../src/main/runtime/json-schema-normalizer'

describe('JSON Schema argument normalization', () => {
  it('normalizes copy-on-write without mutating nested provider input', () => {
    const source = {
      settings: {
        retries: '3',
        literal: 'null',
      },
    }
    const schema = {
      type: 'object',
      properties: {
        settings: {
          type: 'object',
          properties: {
            retries: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
            literal: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
      },
    }

    const normalized = normalizeJsonSchemaValue(source, schema)

    expect(normalized).toEqual({ settings: { retries: 3, literal: 'null' } })
    expect(normalized).not.toBe(source)
    expect((normalized as typeof source).settings).not.toBe(source.settings)
    expect(source).toEqual({ settings: { retries: '3', literal: 'null' } })
  })

  it('bounds recursive schema and value cycles', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: {},
    }
    ;(schema.properties as Record<string, unknown>).child = { $ref: '#' }
    const source: Record<string, unknown> = {}
    source.child = source

    const normalized = normalizeJsonSchemaValue(source, schema, 4)

    expect(normalized).toBe(source)
    expect(normalized).toHaveProperty('child', source)
  })

  it('does not inject a default required only by an unselected union branch', () => {
    const source = { kind: 'configured', value: 'ready' }
    const schema = {
      oneOf: [
        {
          type: 'object',
          properties: {
            kind: { const: 'defaulted' },
            value: { type: 'string' },
            timeoutMs: {
              default: null,
              anyOf: [{ type: 'integer' }, { type: 'null' }],
            },
          },
          required: ['kind', 'value', 'timeoutMs'],
        },
        {
          type: 'object',
          properties: { kind: { const: 'configured' }, value: { type: 'string' } },
          required: ['kind', 'value'],
        },
      ],
    }

    expect(normalizeJsonSchemaValue(source, schema)).toBe(source)
  })

  it('does not apply scalar or container repairs owned only by another union branch', () => {
    const source = {
      kind: 'open',
      value: '5',
      payload: '{"literal":"keep as text"}',
    }
    const schema = {
      anyOf: [
        {
          type: 'object',
          properties: {
            kind: { const: 'typed' },
            value: { type: 'integer' },
            payload: { type: 'object' },
          },
          required: ['kind', 'value', 'payload'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { kind: { const: 'open' } },
          required: ['kind'],
          additionalProperties: true,
        },
      ],
    }

    expect(normalizeJsonSchemaValue(source, schema)).toBe(source)
  })

  it('applies a union repair when every viable branch produces the same value', () => {
    const source = { value: '5' }
    const schema = {
      anyOf: [
        {
          type: 'object',
          properties: { value: { type: 'integer' }, left: { type: 'string' } },
          required: ['value'],
        },
        {
          type: 'object',
          properties: { value: { type: 'integer' }, right: { type: 'boolean' } },
          required: ['value'],
        },
      ],
    }

    expect(normalizeJsonSchemaValue(source, schema)).toEqual({ value: 5 })
    expect(source).toEqual({ value: '5' })
  })

  it('does not combine conditional default and nullable annotations from separate branches', () => {
    const source = {}
    const schema = {
      type: 'object',
      properties: {
        timeoutMs: {
          oneOf: [{ type: 'integer', default: null }, { type: 'null' }],
        },
      },
      required: ['timeoutMs'],
    }

    expect(normalizeJsonSchemaValue(source, schema)).toBe(source)
  })

  it('injects an unconditional null default only when the whole property accepts null', () => {
    const schema = {
      type: 'object',
      properties: {
        timeoutMs: {
          default: null,
          anyOf: [{ type: 'integer' }, { type: 'null' }],
        },
      },
      required: ['timeoutMs'],
    }

    expect(normalizeJsonSchemaValue({}, schema)).toEqual({ timeoutMs: null })
  })

  it('preserves numeric strings when Number conversion would round or underflow', () => {
    const schema = {
      type: 'object',
      properties: { value: { type: 'integer' } },
      required: ['value'],
    }
    for (const value of [
      '9007199254740991.1',
      '1.0000000000000001',
      '0.99999999999999999',
      '1e-324',
    ]) {
      const source = { value }
      expect(normalizeJsonSchemaValue(source, schema)).toBe(source)
    }
    expect(normalizeJsonSchemaValue({ value: '5.000' }, schema)).toEqual({ value: 5 })
  })

  it('resolves percent-encoded slashes within a local JSON Pointer segment', () => {
    const schema = {
      $defs: { 'retry/count': { type: 'integer' } },
      type: 'object',
      properties: { value: { $ref: '#/$defs/retry%2Fcount' } },
    }

    expect(normalizeJsonSchemaValue({ value: '3' }, schema)).toEqual({ value: 3 })
  })
})
