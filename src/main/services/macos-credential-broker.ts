import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CredentialEncryptionContext, EncryptionAdapter } from './settings'

const REQUEST_MAGIC = Buffer.from('MCBR')
const RESPONSE_MAGIC = Buffer.from('MCBS')
const PROTOCOL_VERSION = 2
const REQUEST_HEADER_LENGTH = 16
const RESPONSE_HEADER_LENGTH = 12
const MAXIMUM_RESPONSE_BYTES = 65_536
const BROKER_TIMEOUT_MS = 10_000
const CREDENTIAL_BACKEND_METADATA_KEY = 'codeAssistantCredentialBackend'
const BROKER_KEY_ID_PATTERN = /^[0-9a-f]{32}$/u

function reportCredentialBrokerDiagnostic(
  operation: BrokerOperation,
  stage: 'artifact-verification' | 'native-response',
  error: unknown,
): void {
  if (process.env.CODE_ASSISTANT_CREDENTIAL_DIAGNOSTICS !== '1') return
  const message = error instanceof Error ? error.message : 'Unknown credential broker failure.'
  console.error(`[credential-broker] ${operation} ${stage}: ${message}`)
}

export interface MacCredentialBrokerBackendManifest {
  kind: 'macos-credential-broker-v1'
  architecture: 'arm64' | 'x64'
  cdHash: string
  executableSha256: string
  identifier: string
  keyId: string
  protocolVersion: number
  sourceDigest: string
}

export type MacCredentialBackendManifest =
  | MacCredentialBrokerBackendManifest
  | { kind: 'electron-safe-storage-v1' }

export type BrokerOperation = 'probe' | 'encrypt' | 'decrypt'

const operationCode: Record<BrokerOperation, number> = {
  probe: 1,
  encrypt: 2,
  decrypt: 3,
}

export function encodeCredentialBrokerRequest(
  operation: BrokerOperation,
  associatedData: Buffer = Buffer.alloc(0),
  payload: Buffer = Buffer.alloc(0),
): Buffer {
  if (associatedData.length > 8_192 || payload.length > 32_768) {
    throw new Error('Credential broker request exceeded its protocol limit.')
  }
  const header = Buffer.alloc(REQUEST_HEADER_LENGTH)
  REQUEST_MAGIC.copy(header, 0)
  header.writeUInt16BE(PROTOCOL_VERSION, 4)
  header.writeUInt8(operationCode[operation], 6)
  header.writeUInt8(0, 7)
  header.writeUInt32BE(associatedData.length, 8)
  header.writeUInt32BE(payload.length, 12)
  return Buffer.concat([header, associatedData, payload])
}

export function decodeCredentialBrokerResponse(frame: Buffer): Buffer {
  if (
    frame.length < RESPONSE_HEADER_LENGTH ||
    !frame.subarray(0, 4).equals(RESPONSE_MAGIC) ||
    frame.readUInt16BE(4) !== PROTOCOL_VERSION
  ) {
    throw new Error('Credential broker returned an invalid response.')
  }
  const status = frame.readUInt16BE(6)
  const payloadLength = frame.readUInt32BE(8)
  if (
    payloadLength > MAXIMUM_RESPONSE_BYTES ||
    frame.length !== RESPONSE_HEADER_LENGTH + payloadLength
  ) {
    throw new Error('Credential broker returned an invalid response length.')
  }
  if (status !== 0) {
    throw new Error(`Credential broker rejected the operation with status ${status.toString()}.`)
  }
  return frame.subarray(RESPONSE_HEADER_LENGTH)
}

export function decodeCredentialBrokerIdentity(payload: Buffer): {
  isAppleTeamSigned: boolean
  keyId: string
} {
  if (payload.length < 3 || (payload[0] !== 0 && payload[0] !== 1)) {
    throw new Error('Credential broker returned an invalid identity probe.')
  }
  const keyIdLength = payload.readUInt16BE(1)
  if (keyIdLength === 0 || payload.length !== 3 + keyIdLength) {
    throw new Error('Credential broker returned an invalid identity probe.')
  }
  const keyIdBytes = payload.subarray(3)
  const keyId = keyIdBytes.toString('utf8')
  if (!BROKER_KEY_ID_PATTERN.test(keyId) || !Buffer.from(keyId, 'utf8').equals(keyIdBytes)) {
    throw new Error('Credential broker returned an invalid key ID.')
  }
  return { isAppleTeamSigned: payload[0] === 1, keyId }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseMacCredentialBackendManifest(value: unknown): MacCredentialBackendManifest {
  if (!isRecord(value)) throw new Error('Packaged credential backend metadata is missing.')
  if (value.kind === 'electron-safe-storage-v1') {
    if (Object.keys(value).length !== 1) {
      throw new Error('Packaged safeStorage metadata is invalid.')
    }
    return { kind: 'electron-safe-storage-v1' }
  }
  if (value.kind !== 'macos-credential-broker-v1') {
    throw new Error('Packaged credential backend metadata is unsupported.')
  }
  const expectedKeys = [
    'architecture',
    'cdHash',
    'executableSha256',
    'identifier',
    'keyId',
    'kind',
    'protocolVersion',
    'sourceDigest',
  ]
  if (Object.keys(value).sort().join('\0') !== expectedKeys.join('\0')) {
    throw new Error('Packaged credential broker metadata is invalid.')
  }
  if (
    (value.architecture !== 'arm64' && value.architecture !== 'x64') ||
    typeof value.cdHash !== 'string' ||
    !/^[0-9a-f]{40,64}$/u.test(value.cdHash) ||
    typeof value.executableSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.executableSha256) ||
    typeof value.identifier !== 'string' ||
    value.identifier.length === 0 ||
    typeof value.keyId !== 'string' ||
    !BROKER_KEY_ID_PATTERN.test(value.keyId) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    typeof value.sourceDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.sourceDigest)
  ) {
    throw new Error('Packaged credential broker metadata is invalid.')
  }
  return {
    architecture: value.architecture,
    cdHash: value.cdHash,
    executableSha256: value.executableSha256,
    identifier: value.identifier,
    keyId: value.keyId,
    kind: value.kind,
    protocolVersion: value.protocolVersion,
    sourceDigest: value.sourceDigest,
  }
}

export async function readMacCredentialBackendManifest(
  applicationPath: string,
): Promise<MacCredentialBackendManifest> {
  let packageJson: unknown
  try {
    packageJson = JSON.parse(await readFile(join(applicationPath, 'package.json'), 'utf8'))
  } catch (error) {
    throw new Error('Packaged credential backend metadata could not be read.', { cause: error })
  }
  if (!isRecord(packageJson)) throw new Error('Packaged application metadata is invalid.')
  return parseMacCredentialBackendManifest(packageJson[CREDENTIAL_BACKEND_METADATA_KEY])
}

function runCodesign(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/codesign',
      args,
      { encoding: 'utf8', env: {}, maxBuffer: 1_048_576, timeout: BROKER_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error('Packaged credential broker signature is invalid.', { cause: error }))
          return
        }
        resolve(`${stdout}${stderr}`)
      },
    )
  })
}

async function verifyPackagedBrokerArtifact(
  executablePath: string,
  manifest: MacCredentialBrokerBackendManifest,
): Promise<void> {
  const fileStat = await lstat(executablePath).catch((error) => {
    throw new Error('Packaged credential broker is missing.', { cause: error })
  })
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || (fileStat.mode & 0o111) === 0) {
    throw new Error('Packaged credential broker is not an executable regular file.')
  }
  const digest = createHash('sha256')
    .update(await readFile(executablePath))
    .digest('hex')
  if (digest !== manifest.executableSha256) {
    throw new Error('Packaged credential broker executable digest changed.')
  }
  await runCodesign(['--verify', '--strict', '--verbose=2', executablePath])
  const details = await runCodesign(['--display', '--verbose=4', executablePath])
  const identifier = details.match(/^Identifier=(.+)$/mu)?.[1]?.trim()
  const cdHash = details.match(/^CDHash=([0-9a-f]+)$/imu)?.[1]?.toLowerCase()
  if (identifier !== manifest.identifier || cdHash !== manifest.cdHash) {
    throw new Error('Packaged credential broker signature evidence changed.')
  }
}

export function credentialBrokerAssociatedData(context: CredentialEncryptionContext): Buffer {
  const providerId = Buffer.from(context.providerId, 'utf8')
  const baseUrl = Buffer.from(context.baseUrl, 'utf8')
  if (
    providerId.length === 0 ||
    providerId.length > 512 ||
    baseUrl.length === 0 ||
    baseUrl.length > 4096
  ) {
    throw new Error('Credential encryption context exceeded its protocol limit.')
  }
  const result = Buffer.alloc(2 + 8 + 2 + providerId.length + 2 + baseUrl.length)
  let offset = 0
  result.writeUInt16BE(1, offset)
  offset += 2
  result.writeBigUInt64BE(BigInt(context.generation), offset)
  offset += 8
  result.writeUInt16BE(providerId.length, offset)
  offset += 2
  providerId.copy(result, offset)
  offset += providerId.length
  result.writeUInt16BE(baseUrl.length, offset)
  offset += 2
  baseUrl.copy(result, offset)
  return result
}

export class MacCredentialBrokerClient {
  constructor(
    private readonly executablePath: string,
    private readonly verifyExecutable: (() => Promise<void>) | null = null,
  ) {}

  async probeIdentity(): Promise<{ isAppleTeamSigned: boolean; keyId: string }> {
    const payload = await this.request('probe')
    return decodeCredentialBrokerIdentity(payload)
  }

  encrypt(plainText: string, context: CredentialEncryptionContext): Promise<Buffer> {
    return this.request(
      'encrypt',
      credentialBrokerAssociatedData(context),
      Buffer.from(plainText, 'utf8'),
    )
  }

  async decrypt(
    encrypted: Buffer,
    context: CredentialEncryptionContext,
  ): Promise<{ result: string; shouldReEncrypt: boolean }> {
    const result = await this.request('decrypt', credentialBrokerAssociatedData(context), encrypted)
    return { result: result.toString('utf8'), shouldReEncrypt: false }
  }

  private async request(
    operation: BrokerOperation,
    associatedData: Buffer = Buffer.alloc(0),
    payload: Buffer = Buffer.alloc(0),
  ): Promise<Buffer> {
    try {
      await this.verifyExecutable?.()
    } catch (error) {
      reportCredentialBrokerDiagnostic(operation, 'artifact-verification', error)
      throw error
    }
    const request = encodeCredentialBrokerRequest(operation, associatedData, payload)
    return new Promise((resolve, reject) => {
      const child = spawn(this.executablePath, [], {
        cwd: '/',
        env: {},
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const output: Buffer[] = []
      let outputBytes = 0
      let settled = false
      const finish = (error?: Error, value?: Buffer): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve(value ?? Buffer.alloc(0))
      }
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        finish(new Error('Credential broker timed out.'))
      }, BROKER_TIMEOUT_MS)

      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes > MAXIMUM_RESPONSE_BYTES) {
          child.kill('SIGKILL')
          finish(new Error('Credential broker response exceeded its limit.'))
          return
        }
        output.push(chunk)
      })
      // Drain bounded stderr without returning it; native failures must not expose sensitive data.
      child.stderr.on('data', () => undefined)
      child.once('error', (error) =>
        finish(new Error('Credential broker could not start.', { cause: error })),
      )
      child.once('close', () => {
        try {
          finish(undefined, decodeCredentialBrokerResponse(Buffer.concat(output)))
        } catch (error) {
          reportCredentialBrokerDiagnostic(operation, 'native-response', error)
          finish(error instanceof Error ? error : new Error('Credential broker failed.'))
        }
      })
      child.stdin.once('error', (error) =>
        finish(new Error('Credential broker request could not be written.', { cause: error })),
      )
      child.stdin.end(request)
    })
  }
}

export class MacCredentialBrokerEncryptionAdapter implements EncryptionAdapter {
  readonly ciphertextFormat = 'credential-broker-v1' as const
  readonly credentialKeyId: string

  constructor(
    private readonly client: MacCredentialBrokerClient,
    keyId: string,
  ) {
    if (!BROKER_KEY_ID_PATTERN.test(keyId)) {
      throw new Error('Credential broker adapter key ID is invalid.')
    }
    this.credentialKeyId = keyId
  }

  isEncryptionAvailable(): boolean {
    return false
  }

  encryptString(): Buffer {
    throw new Error('Credential broker only supports asynchronous encryption.')
  }

  decryptString(): string {
    throw new Error('Credential broker only supports asynchronous decryption.')
  }

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    const identity = await this.client.probeIdentity()
    if (identity.isAppleTeamSigned || identity.keyId !== this.credentialKeyId) {
      throw new Error('Credential broker identity changed after initialization.')
    }
    return true
  }

  encryptStringAsync(plainText: string, context?: CredentialEncryptionContext): Promise<Buffer> {
    if (!context) throw new Error('Credential broker requires an encryption context.')
    return this.client.encrypt(plainText, context)
  }

  decryptStringAsync(
    encrypted: Buffer,
    context?: CredentialEncryptionContext,
  ): Promise<{ result: string; shouldReEncrypt: boolean }> {
    if (!context) throw new Error('Credential broker requires an encryption context.')
    return this.client.decrypt(encrypted, context)
  }
}

export async function resolvePackagedMacCredentialEncryptionAdapter(
  applicationPath: string,
  resourcesPath: string,
): Promise<MacCredentialBrokerEncryptionAdapter | null> {
  const manifest = await readMacCredentialBackendManifest(applicationPath)
  if (manifest.kind === 'electron-safe-storage-v1') return null
  if (manifest.architecture !== process.arch) {
    throw new Error('Packaged credential broker architecture does not match this process.')
  }
  const executablePath = join(resourcesPath, 'credential-broker', 'credential-broker')
  const verifyExecutable = () => verifyPackagedBrokerArtifact(executablePath, manifest)
  await verifyExecutable()
  const client = new MacCredentialBrokerClient(executablePath, verifyExecutable)
  const identity = await client.probeIdentity()
  if (identity.isAppleTeamSigned || identity.keyId !== manifest.keyId) {
    throw new Error('Packaged credential broker identity does not match signed metadata.')
  }
  return new MacCredentialBrokerEncryptionAdapter(client, identity.keyId)
}
