import { describe, expect, it } from 'vitest'
import {
  assertStableSignatureEvidence,
  electronBuilderArguments,
  findRunningMacBundleProcesses,
  identityMatches,
  localCredentialBrokerBuildConfiguration,
  normalizeFingerprint,
  parseIdentityListing,
  safeStorageBuildConfiguration,
  selectUniqueIdentity,
} from '../scripts/macos-signing.mjs'

describe('stable macOS signing helpers', () => {
  it('disables network timestamping only for the local self-signed identity', () => {
    expect(electronBuilderArguments('local-keychain')).toEqual([
      '--dir',
      '--config.mac.timestamp=none',
    ])
    expect(electronBuilderArguments('external-keychain')).toEqual(['--dir'])
    expect(electronBuilderArguments('external-certificate')).toEqual(['--dir'])
  })

  it('copies the pre-signed credential broker without letting the outer signer rewrite it', () => {
    const configuration = localCredentialBrokerBuildConfiguration(
      {
        extraResources: [{ from: 'existing', to: 'existing' }],
        mac: { signIgnore: ['existing-ignore'] },
      },
      {
        architecture: 'arm64',
        artifactPath: '/tmp/signed-credential-broker',
        cdHash: 'b'.repeat(40),
        executableSha256: 'c'.repeat(64),
        identifier: 'com.example.assistant.credential-broker',
        keyId: 'a'.repeat(32),
        protocolVersion: 2,
        sourceDigest: 'd'.repeat(64),
      },
    )

    expect(configuration.extraResources).toEqual([
      { from: 'existing', to: 'existing' },
      {
        from: '/tmp/signed-credential-broker',
        to: 'credential-broker/credential-broker',
      },
    ])
    expect(configuration.mac).toMatchObject({
      signIgnore: [
        'existing-ignore',
        String.raw`[/\\]Contents[/\\]Resources[/\\]credential-broker[/\\]credential-broker$`,
      ],
      timestamp: 'none',
    })
    expect(configuration.extraMetadata?.codeAssistantCredentialBackend).toMatchObject({
      keyId: 'a'.repeat(32),
      kind: 'macos-credential-broker-v1',
    })
  })

  it('marks external macOS packages for the safeStorage backend explicitly', () => {
    expect(safeStorageBuildConfiguration({}).extraMetadata).toEqual({
      codeAssistantCredentialBackend: { kind: 'electron-safe-storage-v1' },
    })
  })

  it('detects only main processes launched from package output bundles', () => {
    const appPath = '/tmp/release/mac-arm64/Code Assistant.app'
    const executable = `${appPath}/Contents/MacOS/Code Assistant`

    expect(
      findRunningMacBundleProcesses(
        [
          `  412 ${executable}`,
          `  413 ${executable} --diagnostics`,
          `  414 ${appPath}/Contents/Frameworks/Code Assistant Helper.app/Contents/MacOS/Code Assistant Helper --type=renderer`,
          '  415 /Applications/Code Assistant.app/Contents/MacOS/Code Assistant',
        ].join('\n'),
        [appPath],
        'Code Assistant',
      ),
    ).toEqual([
      { appPath, pid: 412 },
      { appPath, pid: 413 },
    ])
  })

  it('parses valid keychain identities and matches names or fingerprints', () => {
    const fingerprint = '0123456789ABCDEF0123456789ABCDEF01234567'
    const identities = parseIdentityListing(
      `  1) ${fingerprint} "Local Code Signing - Example"\n     1 valid identities found`,
    )

    expect(identities).toEqual([{ fingerprint, name: 'Local Code Signing - Example' }])
    expect(identityMatches(identities[0], 'local code')).toBe(false)
    expect(identityMatches(identities[0], 'Local Code')).toBe(true)
    expect(identityMatches(identities[0], normalizeFingerprint(fingerprint))).toBe(true)
  })

  it('requires CSC_NAME to identify exactly one certificate', () => {
    const identities = [
      { fingerprint: '0'.repeat(40), name: 'Local Code Signing - First' },
      { fingerprint: '1'.repeat(40), name: 'Local Code Signing - Second' },
    ]

    expect(() => selectUniqueIdentity(identities, 'Local Code Signing')).toThrow(/ambiguous/u)
    expect(selectUniqueIdentity(identities, '1'.repeat(40))).toEqual(identities[1])
  })

  it('accepts a certificate-bound designated requirement', () => {
    const evidence = assertStableSignatureEvidence({
      appId: 'com.example.assistant',
      detailsOutput: [
        'Identifier=com.example.assistant',
        'Signature size=4096',
        'Authority=Local Code Signing - Example',
      ].join('\n'),
      designatedRequirementOutput:
        'designated => identifier "com.example.assistant" and anchor trusted',
    })

    expect(evidence.identifier).toBe('com.example.assistant')
    expect(evidence.requirement).toContain('anchor trusted')
  })

  it.each([
    {
      detailsOutput: 'Identifier=com.example.assistant\nSignature=adhoc',
      requirement: 'designated => cdhash H"1234"',
    },
    {
      detailsOutput: 'Identifier=com.example.assistant\nAuthority=Local Code Signing - Example',
      requirement: 'designated => cdhash H"1234"',
    },
    {
      detailsOutput: 'Identifier=com.example.other\nAuthority=Local Code Signing - Example',
      requirement: 'designated => identifier "com.example.other" and anchor trusted',
    },
    {
      detailsOutput: 'Identifier=com.example.assistant\nAuthority=Local Code Signing - Example',
      requirement: 'designated => identifier "com.example.assistant"',
    },
  ])('rejects unstable or mismatched signature evidence', ({ detailsOutput, requirement }) => {
    expect(() =>
      assertStableSignatureEvidence({
        appId: 'com.example.assistant',
        designatedRequirementOutput: requirement,
        detailsOutput,
      }),
    ).toThrow()
  })
})
