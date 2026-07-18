import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  CREDENTIAL_BROKER_PROTOCOL_VERSION,
  normalizeFingerprint,
  runCommand,
  verifyCredentialBrokerArtifact,
} from './macos-signing.mjs'

const BROKER_SOURCE_DIRECTORY = join('native', 'macos', 'credential-broker')
const BROKER_KEY_ID_PATTERN = /^[0-9a-f]{32}$/u

function swiftString(value) {
  return JSON.stringify(value)
}

function brokerArchitecture() {
  if (process.arch === 'arm64' || process.arch === 'x64') return process.arch
  throw new Error(`Credential broker does not support the ${process.arch} architecture.`)
}

function targetTriple(architecture) {
  return `${architecture === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`
}

export function createCredentialBrokerKeyId() {
  return randomBytes(16).toString('hex')
}

export function assertCredentialBrokerKeyId(value) {
  if (typeof value !== 'string' || !BROKER_KEY_ID_PATTERN.test(value)) {
    throw new Error('Credential broker key ID is invalid.')
  }
  return value
}

export function credentialBrokerSourceDigest(
  projectRoot,
  metadata,
  architecture = brokerArchitecture(),
  keyId,
) {
  const validatedKeyId = assertCredentialBrokerKeyId(keyId)
  const sourceDirectory = join(projectRoot, BROKER_SOURCE_DIRECTORY)
  const sourceNames = readdirSync(sourceDirectory)
    .filter((name) => name.endsWith('.swift'))
    .sort()
  if (sourceNames.length === 0) throw new Error('Credential broker Swift sources are missing.')

  const digest = createHash('sha256')
  digest.update(`appId\0${metadata.appId}\0`)
  digest.update(`productName\0${metadata.productName}\0`)
  digest.update(`protocol\0${String(CREDENTIAL_BROKER_PROTOCOL_VERSION)}\0`)
  digest.update(`target\0${targetTriple(architecture)}\0`)
  digest.update(`keyId\0${validatedKeyId}\0`)
  for (const name of sourceNames) {
    digest.update(`file\0${name}\0`)
    digest.update(readFileSync(join(sourceDirectory, name)))
    digest.update('\0')
  }
  return digest.digest('hex')
}

function generatedBuildIdentity(metadata, keyId) {
  return `import Foundation

enum BrokerBuildIdentity {
    static let parentBundleIdentifier = ${swiftString(metadata.appId)}
    static let brokerIdentifier = ${swiftString(`${metadata.appId}.credential-broker`)}
    static let keyIdentifier = ${swiftString(keyId)}
    static let keychainService = ${swiftString(`${metadata.appId}.credential-broker.keys.${keyId}`)}
    static let keychainAccount = ${swiftString(`master-key-v1:${keyId}`)}
    static let keychainDescriptor = ${swiftString(`${metadata.productName} credential encryption key`)}
    static let protocolVersion: UInt16 = ${String(CREDENTIAL_BROKER_PROTOCOL_VERSION)}
}
`
}

function atomicCopy(source, destination) {
  const directory = dirname(destination)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const temporary = join(
    directory,
    `.${basename(destination)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  )
  copyFileSync(source, temporary)
  chmodSync(temporary, 0o500)
  renameSync(temporary, destination)
  chmodSync(destination, 0o500)
}

export function prepareCredentialBroker({
  certificateSha1,
  configPath,
  existingBroker,
  keychain,
  metadata,
  projectRoot,
  replace = false,
}) {
  const architecture = brokerArchitecture()
  const keyId =
    existingBroker && !replace
      ? assertCredentialBrokerKeyId(existingBroker.keyId)
      : createCredentialBrokerKeyId()
  const sourceDigest = credentialBrokerSourceDigest(projectRoot, metadata, architecture, keyId)

  if (existingBroker && !replace) {
    if (existingBroker.sourceDigest !== sourceDigest) {
      throw new Error(
        'Credential broker source changed. Re-run with --replace-broker to rotate it explicitly.',
      )
    }
    verifyCredentialBrokerArtifact(
      existingBroker.artifactPath,
      metadata,
      certificateSha1,
      existingBroker,
    )
    return existingBroker
  }

  const workingDirectory = mkdtempSync(join(tmpdir(), 'code-assistant-credential-broker-'))
  chmodSync(workingDirectory, 0o700)
  const generatedIdentityPath = join(workingDirectory, 'GeneratedBuildIdentity.swift')
  const compiledPath = join(workingDirectory, 'credential-broker')
  const sourceDirectory = join(projectRoot, BROKER_SOURCE_DIRECTORY)
  const sourcePaths = readdirSync(sourceDirectory)
    .filter((name) => name.endsWith('.swift'))
    .sort()
    .map((name) => join(sourceDirectory, name))

  try {
    writeFileSync(generatedIdentityPath, generatedBuildIdentity(metadata, keyId), { mode: 0o600 })
    runCommand('/usr/bin/xcrun', [
      'swiftc',
      '-O',
      '-whole-module-optimization',
      '-target',
      targetTriple(architecture),
      '-framework',
      'Security',
      '-framework',
      'CryptoKit',
      '-o',
      compiledPath,
      ...sourcePaths,
      generatedIdentityPath,
    ])
    chmodSync(compiledPath, 0o700)
    runCommand('/usr/bin/codesign', [
      '--force',
      '--options',
      'runtime',
      '--timestamp=none',
      '--identifier',
      `${metadata.appId}.credential-broker`,
      '--keychain',
      keychain,
      '--sign',
      normalizeFingerprint(certificateSha1),
      compiledPath,
    ])

    const evidence = verifyCredentialBrokerArtifact(
      compiledPath,
      metadata,
      certificateSha1,
      undefined,
    )
    const artifactPath = resolve(
      dirname(configPath),
      'credential-broker',
      normalizeFingerprint(certificateSha1).toLowerCase(),
      keyId,
      sourceDigest,
      architecture,
      'credential-broker',
    )
    atomicCopy(compiledPath, artifactPath)
    const persistedEvidence = verifyCredentialBrokerArtifact(
      artifactPath,
      metadata,
      certificateSha1,
      evidence,
    )
    return {
      architecture,
      artifactPath,
      cdHash: persistedEvidence.cdHash,
      executableSha256: persistedEvidence.executableSha256,
      identifier: persistedEvidence.identifier,
      keyId,
      protocolVersion: CREDENTIAL_BROKER_PROTOCOL_VERSION,
      sourceDigest,
    }
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true })
  }
}
