import { describe, expect, it } from 'vitest'
import {
  credentialBrokerAssociatedData,
  decodeCredentialBrokerIdentity,
  decodeCredentialBrokerResponse,
  encodeCredentialBrokerRequest,
  parseMacCredentialBackendManifest,
} from '../src/main/services/macos-credential-broker'

describe('macOS credential broker protocol', () => {
  it('encodes a bounded, versioned request frame', () => {
    const frame = encodeCredentialBrokerRequest(
      'encrypt',
      Buffer.from('associated-data'),
      Buffer.from('secret'),
    )

    expect(frame.subarray(0, 4).toString()).toBe('MCBR')
    expect(frame.readUInt16BE(4)).toBe(2)
    expect(frame.readUInt8(6)).toBe(2)
    expect(frame.readUInt8(7)).toBe(0)
    expect(frame.readUInt32BE(8)).toBe(Buffer.byteLength('associated-data'))
    expect(frame.readUInt32BE(12)).toBe(Buffer.byteLength('secret'))
    expect(frame.subarray(16).toString()).toBe('associated-datasecret')
  })

  it('decodes the signed broker key ID from the identity probe', () => {
    const keyId = 'a'.repeat(32)
    const payload = Buffer.concat([
      Buffer.from([0, 0, Buffer.byteLength(keyId)]),
      Buffer.from(keyId),
    ])

    expect(decodeCredentialBrokerIdentity(payload)).toEqual({
      isAppleTeamSigned: false,
      keyId,
    })
    expect(() => decodeCredentialBrokerIdentity(Buffer.from([0, 0, 1, 0xff]))).toThrow()
  })

  it('requires explicit and strict packaged backend metadata', () => {
    expect(parseMacCredentialBackendManifest({ kind: 'electron-safe-storage-v1' })).toEqual({
      kind: 'electron-safe-storage-v1',
    })
    expect(() => parseMacCredentialBackendManifest(undefined)).toThrow(/missing/u)
    expect(() =>
      parseMacCredentialBackendManifest({
        kind: 'electron-safe-storage-v1',
        unexpected: true,
      }),
    ).toThrow(/invalid/u)
  })

  it('binds ciphertext context to provider identity, endpoint, and generation', () => {
    const context = {
      providerId: 'provider-a',
      baseUrl: 'https://example.com/v1',
      generation: 7,
    }
    const original = credentialBrokerAssociatedData(context)

    expect(credentialBrokerAssociatedData({ ...context, providerId: 'provider-b' })).not.toEqual(
      original,
    )
    expect(
      credentialBrokerAssociatedData({ ...context, baseUrl: 'https://other.example/v1' }),
    ).not.toEqual(original)
    expect(credentialBrokerAssociatedData({ ...context, generation: 8 })).not.toEqual(original)
  })

  it('rejects failed, truncated, and trailing-byte responses', () => {
    const response = (status: number, payload: Buffer, declaredLength = payload.length): Buffer => {
      const header = Buffer.alloc(12)
      header.write('MCBS')
      header.writeUInt16BE(2, 4)
      header.writeUInt16BE(status, 6)
      header.writeUInt32BE(declaredLength, 8)
      return Buffer.concat([header, payload])
    }

    expect(decodeCredentialBrokerResponse(response(0, Buffer.from('result'))).toString()).toBe(
      'result',
    )
    expect(() => decodeCredentialBrokerResponse(response(1, Buffer.alloc(0)))).toThrow(/status 1/u)
    expect(() => decodeCredentialBrokerResponse(response(0, Buffer.from('x'), 2))).toThrow(
      /length/u,
    )
    expect(() => decodeCredentialBrokerResponse(response(0, Buffer.from('xx'), 1))).toThrow(
      /length/u,
    )
  })
})
