import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type CredentialEncryptionContext,
  type EncryptionAdapter,
  MAX_PERSISTED_CREDENTIAL_CHARACTERS,
  SettingsStore,
  type SettingsStoreError,
} from '../src/main/services/settings'
import { MAX_PROVIDER_API_KEY_BYTES, type WorkspaceApprovalPolicy } from '../src/shared/contracts'

const temporaryDirectories: string[] = []
const TEST_BROKER_KEY_ID = 'a'.repeat(32)

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'code-assistant-settings-'))
  temporaryDirectories.push(directory)
  return directory
}

const testEncryption: EncryptionAdapter = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from([...Buffer.from(plainText)].map((byte) => byte ^ 0xa5)),
  decryptString: (encrypted) => Buffer.from([...encrypted].map((byte) => byte ^ 0xa5)).toString(),
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('SettingsStore', () => {
  it('stores provider credentials encrypted and only returns a public summary', async () => {
    const userDataPath = await createTemporaryDirectory()
    const store = new SettingsStore({ userDataPath, encryption: testEncryption })
    const secret = 'provider-secret-value'

    const settings = await store.saveProvider({
      name: 'Provider',
      baseUrl: 'https://example.com/v1',
      apiKey: secret,
    })

    expect(settings.providers).toHaveLength(1)
    expect(settings.providers[0]).not.toHaveProperty('apiKey')
    const persisted = await readFile(join(userDataPath, 'settings.json'), 'utf8')
    expect(persisted).not.toContain(secret)

    const credentials = await store.getProvider(settings.providers[0].id)
    expect(credentials?.apiKey).toBe(secret)
  })

  it('accepts an ASCII API key exactly at the UTF-8 byte limit', async () => {
    const userDataPath = await createTemporaryDirectory()
    const store = new SettingsStore({ userDataPath, encryption: testEncryption })
    const boundaryKey = 'a'.repeat(MAX_PROVIDER_API_KEY_BYTES)

    const saved = await store.saveProvider({
      name: 'Boundary provider',
      baseUrl: 'https://example.com/v1',
      apiKey: boundaryKey,
    })

    expect(Buffer.byteLength(boundaryKey, 'utf8')).toBe(MAX_PROVIDER_API_KEY_BYTES)
    await expect(store.getProvider(saved.providers[0].id)).resolves.toMatchObject({
      apiKey: boundaryKey,
    })
  })

  it('rejects a multibyte API key over the UTF-8 limit before changing persisted settings', async () => {
    const userDataPath = await createTemporaryDirectory()
    const store = new SettingsStore({ userDataPath, encryption: testEncryption })
    const saved = await store.saveProvider({
      name: 'Preserved provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'preserved-secret',
    })
    const settingsPath = join(userDataPath, 'settings.json')
    const before = await readFile(settingsPath, 'utf8')
    const oversizedKey = '한'.repeat(Math.floor(MAX_PROVIDER_API_KEY_BYTES / 3) + 1)

    expect(Buffer.byteLength(oversizedKey, 'utf8')).toBeGreaterThan(MAX_PROVIDER_API_KEY_BYTES)
    await expect(
      store.saveProvider({
        id: saved.providers[0].id,
        name: 'Preserved provider',
        baseUrl: 'https://example.com/v1',
        apiKey: oversizedKey,
      }),
    ).rejects.toMatchObject({
      code: 'CREDENTIAL_TOO_LARGE',
      descriptor: {
        identifier: 'api-key',
        maximumBytes: MAX_PROVIDER_API_KEY_BYTES,
      },
    })
    expect(await readFile(settingsPath, 'utf8')).toBe(before)

    const restarted = new SettingsStore({ userDataPath, encryption: testEncryption })
    await expect(restarted.getProvider(saved.providers[0].id)).resolves.toMatchObject({
      apiKey: 'preserved-secret',
    })
    expect((await readdir(userDataPath)).some((name) => name.includes('.corrupt-'))).toBe(false)
  })

  it.each([
    'synchronous',
    'asynchronous',
  ] as const)('rejects %s ciphertext overhead before replacing the existing settings file', async (mode) => {
    const userDataPath = await createTemporaryDirectory()
    const baseline = new SettingsStore({ userDataPath, encryption: testEncryption })
    const saved = await baseline.saveProvider({
      name: 'Preserved provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'preserved-secret',
    })
    const settingsPath = join(userDataPath, 'settings.json')
    const before = await readFile(settingsPath, 'utf8')
    const base64BoundaryBytes = Math.floor(MAX_PERSISTED_CREDENTIAL_CHARACTERS / 4) * 3
    const oversizedCiphertext =
      mode === 'synchronous'
        ? Buffer.alloc(base64BoundaryBytes + 1)
        : Buffer.alloc(base64BoundaryBytes)
    const encryption: EncryptionAdapter =
      mode === 'synchronous'
        ? {
            isEncryptionAvailable: () => true,
            encryptString: () => oversizedCiphertext,
            decryptString: (encrypted) => encrypted.toString(),
          }
        : {
            isEncryptionAvailable: () => false,
            encryptString: () => Buffer.alloc(0),
            decryptString: () => '',
            isAsyncEncryptionAvailable: async () => true,
            encryptStringAsync: async () => oversizedCiphertext,
            decryptStringAsync: async () => ({ result: '', shouldReEncrypt: false }),
          }
    const store = new SettingsStore({ userDataPath, encryption })

    await expect(
      store.saveProvider({
        id: saved.providers[0].id,
        name: 'Preserved provider',
        baseUrl: 'https://example.com/v1',
        apiKey: 'replacement-secret',
      }),
    ).rejects.toMatchObject({
      code: 'CREDENTIAL_TOO_LARGE',
      descriptor: {
        identifier: 'encrypted-api-key',
        maximumCharacters: MAX_PERSISTED_CREDENTIAL_CHARACTERS,
      },
    })
    expect(await readFile(settingsPath, 'utf8')).toBe(before)

    const restarted = new SettingsStore({ userDataPath, encryption: testEncryption })
    await expect(restarted.getProvider(saved.providers[0].id)).resolves.toMatchObject({
      apiKey: 'preserved-secret',
    })
  })

  it('advances provider generation only when endpoint or credential material changes', async () => {
    const userDataPath = await createTemporaryDirectory()
    const store = new SettingsStore({ userDataPath, encryption: testEncryption })
    const created = await store.saveProvider({
      name: 'Original name',
      baseUrl: 'https://first.example.com/v1',
      apiKey: 'first-secret',
    })
    const providerId = created.providers[0].id

    expect((await store.getProvider(providerId))?.generation).toBe(1)

    await store.saveProvider({
      id: providerId,
      name: 'Cosmetic rename',
      baseUrl: 'https://first.example.com/v1',
    })
    expect(await store.getProvider(providerId)).toMatchObject({
      name: 'Cosmetic rename',
      generation: 1,
      apiKey: 'first-secret',
    })

    await store.saveProvider({
      id: providerId,
      name: 'Cosmetic rename',
      baseUrl: 'https://first.example.com/v1',
      apiKey: 'replacement-secret',
    })
    expect(await store.getProvider(providerId)).toMatchObject({
      generation: 2,
      apiKey: 'replacement-secret',
    })

    await store.saveProvider({
      id: providerId,
      name: 'Cosmetic rename',
      baseUrl: 'https://second.example.com/v1',
    })
    expect(await store.getProvider(providerId)).toMatchObject({
      generation: 3,
      apiKey: null,
    })
  })

  it('refuses to save a key when secure encryption is unavailable', async () => {
    const userDataPath = await createTemporaryDirectory()
    const store = new SettingsStore({
      userDataPath,
      encryption: {
        ...testEncryption,
        isEncryptionAvailable: () => false,
      },
    })

    await expect(
      store.saveProvider({
        name: 'Provider',
        baseUrl: 'https://example.com/v1',
        apiKey: 'must-not-be-written',
      }),
    ).rejects.toMatchObject({
      code: 'ENCRYPTION_UNAVAILABLE',
    } satisfies Partial<SettingsStoreError>)
  })

  it('rejects Electron basic_text as a secure credential backend', async () => {
    const userDataPath = await createTemporaryDirectory()
    const store = new SettingsStore({
      userDataPath,
      encryption: {
        ...testEncryption,
        getSelectedStorageBackend: () => 'basic_text',
      },
    })

    await expect(
      store.saveProvider({
        name: 'Provider',
        baseUrl: 'https://example.com/v1',
        apiKey: 'must-not-be-written',
      }),
    ).rejects.toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE' })
  })

  it('uses the asynchronous encryption API when synchronous availability is false', async () => {
    const userDataPath = await createTemporaryDirectory()
    let synchronousCallCount = 0
    const encryption: EncryptionAdapter = {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        synchronousCallCount += 1
        throw new Error('The synchronous encryptor must not be used.')
      },
      decryptString: () => {
        synchronousCallCount += 1
        throw new Error('The synchronous decryptor must not be used.')
      },
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText) => Buffer.from(`async:${plainText}`),
      decryptStringAsync: async (encrypted) => ({
        result: encrypted.toString().slice('async:'.length),
        shouldReEncrypt: false,
      }),
    }
    const store = new SettingsStore({ userDataPath, encryption })

    const saved = await store.saveProvider({
      name: 'Async provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'async-only-secret',
    })
    const persisted = JSON.parse(await readFile(join(userDataPath, 'settings.json'), 'utf8')) as {
      providers: Array<{ encryptedApiKey: string }>
    }

    expect(persisted.providers[0].encryptedApiKey).toMatch(/^safe-storage:async:v1:/)
    await expect(store.getProvider(saved.providers[0].id)).resolves.toMatchObject({
      apiKey: 'async-only-secret',
    })
    expect(synchronousCallCount).toBe(0)
  })

  it('re-encrypts a broker credential with the next AAD generation when the driver changes', async () => {
    const userDataPath = await createTemporaryDirectory()
    const encryptedContexts: CredentialEncryptionContext[] = []
    const decryptedContexts: CredentialEncryptionContext[] = []
    const brokerEncryption: EncryptionAdapter = {
      ciphertextFormat: 'credential-broker-v1',
      credentialKeyId: TEST_BROKER_KEY_ID,
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText, context) => {
        if (!context) throw new Error('Missing credential context.')
        encryptedContexts.push({ ...context })
        return Buffer.from(JSON.stringify({ context, plainText }))
      },
      decryptStringAsync: async (encrypted, context) => {
        if (!context) throw new Error('Missing credential context.')
        decryptedContexts.push({ ...context })
        const decoded = JSON.parse(encrypted.toString()) as {
          context: CredentialEncryptionContext
          plainText: string
        }
        if (JSON.stringify(decoded.context) !== JSON.stringify(context)) {
          throw new Error('Credential AAD did not match.')
        }
        return { result: decoded.plainText, shouldReEncrypt: false }
      },
    }
    const store = new SettingsStore({ userDataPath, encryption: brokerEncryption })
    const created = await store.saveProvider({
      name: 'Context-bound provider',
      baseUrl: 'https://example.com/v1',
      driverId: 'responses-api',
      apiKey: 'context-bound-secret',
    })
    const providerId = created.providers[0].id

    await store.saveProvider({
      id: providerId,
      name: 'Context-bound provider',
      baseUrl: 'https://example.com/v1',
      driverId: 'alternate-responses',
    })

    await expect(store.getProvider(providerId)).resolves.toMatchObject({
      apiKey: 'context-bound-secret',
      generation: 2,
    })
    expect(decryptedContexts).toContainEqual({
      providerId,
      baseUrl: 'https://example.com/v1',
      generation: 1,
    })
    expect(encryptedContexts).toContainEqual({
      providerId,
      baseUrl: 'https://example.com/v1',
      generation: 2,
    })
    const persisted = JSON.parse(await readFile(join(userDataPath, 'settings.json'), 'utf8')) as {
      providers: Array<{ encryptedApiKey: string }>
    }
    expect(persisted.providers[0].encryptedApiKey).toMatch(/^credential-broker:mac:v1:/)
  })

  it('migrates safeStorage ciphertext to the broker exactly once without advancing generation', async () => {
    const userDataPath = await createTemporaryDirectory()
    let safeDecryptCount = 0
    let brokerEncryptCount = 0
    let brokerDecryptCount = 0
    const safeStorageEncryption: EncryptionAdapter = {
      ciphertextFormat: 'safe-storage',
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText) => Buffer.from(`safe:${plainText}`),
      decryptStringAsync: async (encrypted) => {
        safeDecryptCount += 1
        return { result: encrypted.toString().slice('safe:'.length), shouldReEncrypt: false }
      },
    }
    const writer = new SettingsStore({ userDataPath, encryption: safeStorageEncryption })
    const created = await writer.saveProvider({
      name: 'Migrated provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'migrated-secret',
    })
    const providerId = created.providers[0].id
    const brokerEncryption: EncryptionAdapter = {
      ciphertextFormat: 'credential-broker-v1',
      credentialKeyId: TEST_BROKER_KEY_ID,
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText, context) => {
        brokerEncryptCount += 1
        return Buffer.from(JSON.stringify({ context, plainText }))
      },
      decryptStringAsync: async (encrypted, context) => {
        brokerDecryptCount += 1
        const decoded = JSON.parse(encrypted.toString()) as {
          context: CredentialEncryptionContext
          plainText: string
        }
        if (JSON.stringify(decoded.context) !== JSON.stringify(context)) {
          throw new Error('Credential AAD did not match.')
        }
        return { result: decoded.plainText, shouldReEncrypt: false }
      },
    }
    const migrated = new SettingsStore({
      userDataPath,
      encryption: brokerEncryption,
      legacyEncryption: safeStorageEncryption,
    })

    await expect(migrated.getProvider(providerId)).resolves.toMatchObject({
      apiKey: 'migrated-secret',
      generation: 1,
    })
    const afterMigration = JSON.parse(
      await readFile(join(userDataPath, 'settings.json'), 'utf8'),
    ) as { providers: Array<{ encryptedApiKey: string; generation: number }> }
    expect(afterMigration.providers[0]).toMatchObject({ generation: 1 })
    expect(afterMigration.providers[0].encryptedApiKey).toMatch(/^credential-broker:mac:v1:/)

    await expect(migrated.getProvider(providerId)).resolves.toMatchObject({
      apiKey: 'migrated-secret',
      generation: 1,
    })
    expect(safeDecryptCount).toBe(1)
    expect(brokerEncryptCount).toBe(1)
    expect(brokerDecryptCount).toBe(1)
  })

  it('migrates active and inactive provider credentials together at startup', async () => {
    const userDataPath = await createTemporaryDirectory()
    let legacyDecryptCount = 0
    const legacyEncryption: EncryptionAdapter = {
      ciphertextFormat: 'safe-storage',
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText) => Buffer.from(`safe:${plainText}`),
      decryptStringAsync: async (encrypted) => {
        legacyDecryptCount += 1
        return { result: encrypted.toString().slice(5), shouldReEncrypt: false }
      },
    }
    const writer = new SettingsStore({ userDataPath, encryption: legacyEncryption })
    const first = await writer.saveProvider({
      name: 'Active provider',
      baseUrl: 'https://active.example/v1',
      apiKey: 'active-secret',
    })
    const second = await writer.saveProvider({
      name: 'Inactive provider',
      baseUrl: 'https://inactive.example/v1',
      apiKey: 'inactive-secret',
    })
    await writer.saveSettings({
      activeProviderId: first.providers[0].id,
      activeModelId: 'model',
      theme: 'system',
      maxToolIterations: 8,
    })
    const brokerEncryption: EncryptionAdapter = {
      ciphertextFormat: 'credential-broker-v1',
      credentialKeyId: TEST_BROKER_KEY_ID,
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText, context) =>
        Buffer.from(JSON.stringify({ context, plainText })),
      decryptStringAsync: async (encrypted) => {
        const decoded = JSON.parse(encrypted.toString()) as { plainText: string }
        return { result: decoded.plainText, shouldReEncrypt: false }
      },
    }
    const migrated = new SettingsStore({
      userDataPath,
      encryption: brokerEncryption,
      legacyEncryption,
    })

    await expect(migrated.migrateProviderCredentialsAtStartup()).resolves.toBe(2)
    const persisted = JSON.parse(await readFile(join(userDataPath, 'settings.json'), 'utf8')) as {
      providers: Array<{ encryptedApiKey: string; generation: number }>
    }
    expect(persisted.providers).toHaveLength(2)
    expect(
      persisted.providers.every((provider) =>
        provider.encryptedApiKey.startsWith(`credential-broker:mac:v1:${TEST_BROKER_KEY_ID}:`),
      ),
    ).toBe(true)
    expect(persisted.providers.map((provider) => provider.generation)).toEqual([1, 1])
    expect(legacyDecryptCount).toBe(2)
    await expect(migrated.getProvider(second.providers[1].id)).resolves.toMatchObject({
      apiKey: 'inactive-secret',
    })
  })

  it('migrates active and later valid providers around one failure without retrying it', async () => {
    const userDataPath = await createTemporaryDirectory()
    let legacyDecryptCount = 0
    const legacyDecryptedValues: string[] = []
    const legacyEncryption: EncryptionAdapter = {
      ciphertextFormat: 'safe-storage',
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText) => Buffer.from(`safe:${plainText}`),
      decryptStringAsync: async (encrypted) => {
        legacyDecryptCount += 1
        const value = encrypted.toString().slice(5)
        legacyDecryptedValues.push(value)
        if (value === 'unavailable-secret') throw new Error('Legacy key approval failed.')
        return { result: value, shouldReEncrypt: false }
      },
    }
    const writer = new SettingsStore({ userDataPath, encryption: legacyEncryption })
    const first = await writer.saveProvider({
      name: 'Migratable provider',
      baseUrl: 'https://first.example/v1',
      apiKey: 'available-secret',
    })
    const second = await writer.saveProvider({
      name: 'Unavailable provider',
      baseUrl: 'https://second.example/v1',
      apiKey: 'unavailable-secret',
    })
    const third = await writer.saveProvider({
      name: 'Later valid provider',
      baseUrl: 'https://third.example/v1',
      apiKey: 'later-secret',
    })
    await writer.saveSettings({
      activeProviderId: third.providers[2].id,
      activeModelId: 'model',
      theme: 'system',
      maxToolIterations: 8,
    })
    const brokerEncryption: EncryptionAdapter = {
      ciphertextFormat: 'credential-broker-v1',
      credentialKeyId: TEST_BROKER_KEY_ID,
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText, context) =>
        Buffer.from(JSON.stringify({ context, plainText })),
      decryptStringAsync: async (encrypted) => ({
        result: (JSON.parse(encrypted.toString()) as { plainText: string }).plainText,
        shouldReEncrypt: false,
      }),
    }
    const store = new SettingsStore({
      userDataPath,
      encryption: brokerEncryption,
      legacyEncryption,
    })

    await expect(store.migrateProviderCredentialsAtStartup()).rejects.toMatchObject({
      code: 'ENCRYPTION_FAILED',
    })
    const afterFailure = JSON.parse(
      await readFile(join(userDataPath, 'settings.json'), 'utf8'),
    ) as { providers: Array<{ encryptedApiKey: string }> }
    expect(afterFailure.providers[0].encryptedApiKey).toContain(
      `credential-broker:mac:v1:${TEST_BROKER_KEY_ID}:`,
    )
    expect(afterFailure.providers[1].encryptedApiKey).toMatch(/^safe-storage:async:v1:/)
    expect(afterFailure.providers[2].encryptedApiKey).toContain(
      `credential-broker:mac:v1:${TEST_BROKER_KEY_ID}:`,
    )
    await expect(store.getProvider(first.providers[0].id)).resolves.toMatchObject({
      apiKey: 'available-secret',
    })
    await expect(store.getProvider(third.providers[2].id)).resolves.toMatchObject({
      apiKey: 'later-secret',
    })
    await expect(store.getProvider(second.providers[1].id)).rejects.toMatchObject({
      code: 'ENCRYPTION_FAILED',
    })
    expect(legacyDecryptCount).toBe(3)
    expect(legacyDecryptedValues[0]).toBe('later-secret')
  })

  it('stops startup migration after one denial instead of prompting every later provider', async () => {
    const userDataPath = await createTemporaryDirectory()
    let legacyDecryptCount = 0
    const legacyEncryption: EncryptionAdapter = {
      ciphertextFormat: 'safe-storage',
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText) => Buffer.from(`safe:${plainText}`),
      decryptStringAsync: async (encrypted) => {
        legacyDecryptCount += 1
        const value = encrypted.toString().slice(5)
        if (value === 'denied-secret') throw new Error('Keychain approval was denied.')
        return { result: value, shouldReEncrypt: false }
      },
    }
    const writer = new SettingsStore({ userDataPath, encryption: legacyEncryption })
    const first = await writer.saveProvider({
      name: 'Denied active provider',
      baseUrl: 'https://first.example/v1',
      apiKey: 'denied-secret',
    })
    await writer.saveProvider({
      name: 'Later provider',
      baseUrl: 'https://second.example/v1',
      apiKey: 'second-secret',
    })
    const third = await writer.saveProvider({
      name: 'Explicitly accessed provider',
      baseUrl: 'https://third.example/v1',
      apiKey: 'third-secret',
    })
    await writer.saveSettings({
      activeProviderId: first.providers[0].id,
      activeModelId: 'model',
      theme: 'system',
      maxToolIterations: 8,
    })
    const brokerEncryption: EncryptionAdapter = {
      ciphertextFormat: 'credential-broker-v1',
      credentialKeyId: TEST_BROKER_KEY_ID,
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText, context) =>
        Buffer.from(JSON.stringify({ context, plainText })),
      decryptStringAsync: async (encrypted) => ({
        result: (JSON.parse(encrypted.toString()) as { plainText: string }).plainText,
        shouldReEncrypt: false,
      }),
    }
    const store = new SettingsStore({
      userDataPath,
      encryption: brokerEncryption,
      legacyEncryption,
    })

    await expect(store.migrateProviderCredentialsAtStartup()).rejects.toMatchObject({
      code: 'ENCRYPTION_FAILED',
    })
    expect(legacyDecryptCount).toBe(1)
    await expect(store.getProvider(first.providers[0].id)).rejects.toMatchObject({
      code: 'ENCRYPTION_FAILED',
    })
    expect(legacyDecryptCount).toBe(1)

    await expect(store.getProvider(third.providers[2].id)).resolves.toMatchObject({
      apiKey: 'third-secret',
    })
    expect(legacyDecryptCount).toBe(2)
  })

  it('preserves rotated broker ciphertext while allowing a replacement key in the new namespace', async () => {
    const userDataPath = await createTemporaryDirectory()
    const oldKeyId = '1'.repeat(32)
    const newKeyId = '2'.repeat(32)
    const adapter = (keyId: string, onDecrypt?: () => void): EncryptionAdapter => ({
      ciphertextFormat: 'credential-broker-v1',
      credentialKeyId: keyId,
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText, context) =>
        Buffer.from(JSON.stringify({ context, keyId, plainText })),
      decryptStringAsync: async (encrypted, context) => {
        onDecrypt?.()
        const decoded = JSON.parse(encrypted.toString()) as {
          context: CredentialEncryptionContext
          keyId: string
          plainText: string
        }
        if (
          decoded.keyId !== keyId ||
          JSON.stringify(decoded.context) !== JSON.stringify(context)
        ) {
          throw new Error('Credential namespace or AAD did not match.')
        }
        return { result: decoded.plainText, shouldReEncrypt: false }
      },
    })
    const oldStore = new SettingsStore({ userDataPath, encryption: adapter(oldKeyId) })
    const created = await oldStore.saveProvider({
      name: 'Rotated provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'old-secret',
    })
    const providerId = created.providers[0].id
    const settingsPath = join(userDataPath, 'settings.json')
    const beforeRead = await readFile(settingsPath, 'utf8')
    let newDecryptCount = 0
    const newStore = new SettingsStore({
      userDataPath,
      encryption: adapter(newKeyId, () => {
        newDecryptCount += 1
      }),
    })

    await expect(newStore.getProvider(providerId)).rejects.toMatchObject({
      code: 'CREDENTIAL_REENTRY_REQUIRED',
    })
    expect(newDecryptCount).toBe(0)
    expect(await readFile(settingsPath, 'utf8')).toBe(beforeRead)

    await newStore.saveProvider({
      id: providerId,
      name: 'Rotated provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'replacement-secret',
    })
    await expect(newStore.getProvider(providerId)).resolves.toMatchObject({
      apiKey: 'replacement-secret',
      generation: 2,
    })
    expect(await readFile(settingsPath, 'utf8')).toContain(`credential-broker:mac:v1:${newKeyId}:`)
  })

  it('fails closed on an unknown broker ciphertext version', async () => {
    const userDataPath = await createTemporaryDirectory()
    let decryptCallCount = 0
    const brokerEncryption: EncryptionAdapter = {
      ciphertextFormat: 'credential-broker-v1',
      credentialKeyId: TEST_BROKER_KEY_ID,
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText) => Buffer.from(plainText),
      decryptStringAsync: async () => {
        decryptCallCount += 1
        return { result: 'must-not-be-returned', shouldReEncrypt: false }
      },
    }
    const writer = new SettingsStore({ userDataPath, encryption: brokerEncryption })
    const saved = await writer.saveProvider({
      name: 'Future broker provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'future-secret',
    })
    const settingsPath = join(userDataPath, 'settings.json')
    const persisted = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      providers: Array<{ encryptedApiKey: string }>
    }
    persisted.providers[0].encryptedApiKey = 'credential-broker:mac:v999:ZmFrZQ=='
    await writeFile(settingsPath, JSON.stringify(persisted))
    const reader = new SettingsStore({ userDataPath, encryption: brokerEncryption })

    await expect(reader.getProvider(saved.providers[0].id)).rejects.toMatchObject({
      code: 'ENCRYPTION_FAILED',
    })
    expect(decryptCallCount).toBe(0)
  })

  it('keeps async ciphertext unavailable errors distinct from legacy key re-entry', async () => {
    const userDataPath = await createTemporaryDirectory()
    const availableEncryption: EncryptionAdapter = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText) => Buffer.from(`async:${plainText}`),
      decryptStringAsync: async (encrypted) => ({
        result: encrypted.toString().slice('async:'.length),
        shouldReEncrypt: false,
      }),
    }
    const writer = new SettingsStore({ userDataPath, encryption: availableEncryption })
    const saved = await writer.saveProvider({
      name: 'Async provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'temporarily-unavailable-secret',
    })
    const before = await readFile(join(userDataPath, 'settings.json'), 'utf8')
    const unavailableEncryption: EncryptionAdapter = {
      ...availableEncryption,
      isEncryptionAvailable: () => true,
      isAsyncEncryptionAvailable: async () => false,
    }
    const reader = new SettingsStore({ userDataPath, encryption: unavailableEncryption })

    await expect(reader.getProvider(saved.providers[0].id)).rejects.toMatchObject({
      code: 'ENCRYPTION_UNAVAILABLE',
    })
    expect(await readFile(join(userDataPath, 'settings.json'), 'utf8')).toBe(before)
  })

  it('rejects unknown versioned credential markers without attempting decryption', async () => {
    const userDataPath = await createTemporaryDirectory()
    let decryptCallCount = 0
    const encryption: EncryptionAdapter = {
      isEncryptionAvailable: () => true,
      encryptString: (plainText) => Buffer.from(plainText),
      decryptString: () => {
        decryptCallCount += 1
        return 'must-not-be-returned'
      },
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText) => Buffer.from(plainText),
      decryptStringAsync: async () => {
        decryptCallCount += 1
        return { result: 'must-not-be-returned', shouldReEncrypt: false }
      },
    }
    const writer = new SettingsStore({ userDataPath, encryption })
    const saved = await writer.saveProvider({
      name: 'Future provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'future-secret',
    })
    const settingsPath = join(userDataPath, 'settings.json')
    const persisted = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      providers: Array<{ encryptedApiKey: string }>
    }
    persisted.providers[0].encryptedApiKey = 'safe-storage:async:v999:ZmFrZQ=='
    await writeFile(settingsPath, JSON.stringify(persisted))
    const before = await readFile(settingsPath, 'utf8')
    const reader = new SettingsStore({ userDataPath, encryption })

    await expect(reader.getProvider(saved.providers[0].id)).rejects.toMatchObject({
      code: 'ENCRYPTION_FAILED',
    })
    expect(decryptCallCount).toBe(0)
    expect(await readFile(settingsPath, 'utf8')).toBe(before)
  })

  it('migrates unmarked synchronous ciphertext through the compatible async decryptor first', async () => {
    const userDataPath = await createTemporaryDirectory()
    const legacyStore = new SettingsStore({ userDataPath, encryption: testEncryption })
    const saved = await legacyStore.saveProvider({
      name: 'Legacy provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'legacy-secret',
    })
    const before = JSON.parse(await readFile(join(userDataPath, 'settings.json'), 'utf8')) as {
      providers: Array<{ encryptedApiKey: string; generation: number }>
    }
    let asyncEncryptCount = 0
    let syncDecryptCount = 0
    let asyncDecryptCount = 0
    const encryption: EncryptionAdapter = {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error('New credentials must use the asynchronous encryptor.')
      },
      decryptString: (encrypted) => {
        syncDecryptCount += 1
        return testEncryption.decryptString(encrypted)
      },
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText) => {
        asyncEncryptCount += 1
        return Buffer.from(`rotated:${plainText}`)
      },
      decryptStringAsync: async (encrypted) => {
        asyncDecryptCount += 1
        const source = encrypted.toString()
        return {
          result: source.startsWith('rotated:')
            ? source.slice('rotated:'.length)
            : testEncryption.decryptString(encrypted),
          shouldReEncrypt: false,
        }
      },
    }
    const migratedStore = new SettingsStore({ userDataPath, encryption })

    await expect(migratedStore.getProvider(saved.providers[0].id)).resolves.toMatchObject({
      apiKey: 'legacy-secret',
      generation: 1,
    })
    const after = JSON.parse(await readFile(join(userDataPath, 'settings.json'), 'utf8')) as {
      providers: Array<{ encryptedApiKey: string; generation: number }>
    }
    expect(after.providers[0].encryptedApiKey).toMatch(/^safe-storage:async:v1:/)
    expect(after.providers[0].encryptedApiKey).not.toBe(before.providers[0].encryptedApiKey)
    expect(after.providers[0].generation).toBe(before.providers[0].generation)

    const reloadedStore = new SettingsStore({ userDataPath, encryption })
    await expect(reloadedStore.getProvider(saved.providers[0].id)).resolves.toMatchObject({
      apiKey: 'legacy-secret',
    })
    expect(syncDecryptCount).toBe(0)
    expect(asyncDecryptCount).toBe(2)
    expect(asyncEncryptCount).toBe(1)
  })

  it('falls back to synchronous legacy decryption when the async provider cannot read it', async () => {
    const userDataPath = await createTemporaryDirectory()
    const legacyStore = new SettingsStore({ userDataPath, encryption: testEncryption })
    const saved = await legacyStore.saveProvider({
      name: 'Fallback provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'legacy-secret',
    })
    let syncDecryptCount = 0
    let asyncDecryptCount = 0
    const encryption: EncryptionAdapter = {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.alloc(0),
      decryptString: (encrypted) => {
        syncDecryptCount += 1
        return testEncryption.decryptString(encrypted)
      },
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText) => Buffer.from(`async:${plainText}`),
      decryptStringAsync: async (encrypted) => {
        asyncDecryptCount += 1
        if (!encrypted.toString().startsWith('async:')) {
          throw new Error('This async provider does not expose its legacy key.')
        }
        return { result: encrypted.toString().slice('async:'.length), shouldReEncrypt: false }
      },
    }
    const store = new SettingsStore({ userDataPath, encryption })

    await expect(store.getProvider(saved.providers[0].id)).resolves.toMatchObject({
      apiKey: 'legacy-secret',
    })
    expect(asyncDecryptCount).toBe(1)
    expect(syncDecryptCount).toBe(1)
    expect(await readFile(join(userDataPath, 'settings.json'), 'utf8')).toMatch(
      /safe-storage:async:v1:/,
    )
  })

  it('does not overwrite a concurrently replaced credential during legacy migration', async () => {
    const userDataPath = await createTemporaryDirectory()
    const legacyStore = new SettingsStore({ userDataPath, encryption: testEncryption })
    const saved = await legacyStore.saveProvider({
      name: 'Concurrent provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'legacy-secret',
    })
    let releaseMigration: ((ciphertext: Buffer) => void) | undefined
    let notifyMigrationStarted: (() => void) | undefined
    const migrationStarted = new Promise<void>((resolve) => {
      notifyMigrationStarted = resolve
    })
    const encryption: EncryptionAdapter = {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.alloc(0),
      decryptString: (encrypted) => testEncryption.decryptString(encrypted),
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText) => {
        if (plainText !== 'legacy-secret') return Buffer.from(`async:${plainText}`)
        notifyMigrationStarted?.()
        return new Promise<Buffer>((resolve) => {
          releaseMigration = resolve
        })
      },
      decryptStringAsync: async (encrypted) => ({
        result: encrypted.toString().startsWith('async:')
          ? encrypted.toString().slice('async:'.length)
          : testEncryption.decryptString(encrypted),
        shouldReEncrypt: false,
      }),
    }
    const store = new SettingsStore({ userDataPath, encryption })
    const migratingRead = store.getProvider(saved.providers[0].id)
    await migrationStarted

    await store.saveProvider({
      id: saved.providers[0].id,
      name: 'Concurrent provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'replacement-secret',
    })
    releaseMigration?.(Buffer.from('async:legacy-secret'))

    await expect(migratingRead).rejects.toMatchObject({ code: 'ENCRYPTION_FAILED' })
    await expect(store.getProvider(saved.providers[0].id)).resolves.toMatchObject({
      apiKey: 'replacement-secret',
      generation: 2,
    })
  })

  it('migrates legacy ciphertext with async storage when sync storage is unavailable', async () => {
    const userDataPath = await createTemporaryDirectory()
    const legacyStore = new SettingsStore({ userDataPath, encryption: testEncryption })
    const saved = await legacyStore.saveProvider({
      name: 'Legacy provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'legacy-secret',
    })
    const before = await readFile(join(userDataPath, 'settings.json'), 'utf8')
    let asyncDecryptCount = 0
    const encryption: EncryptionAdapter = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText) => Buffer.from(`async:${plainText}`),
      decryptStringAsync: async (encrypted) => {
        asyncDecryptCount += 1
        return {
          result: encrypted.toString().startsWith('async:')
            ? encrypted.toString().slice('async:'.length)
            : testEncryption.decryptString(encrypted),
          shouldReEncrypt: false,
        }
      },
    }
    const store = new SettingsStore({ userDataPath, encryption })

    await expect(store.getProvider(saved.providers[0].id)).resolves.toMatchObject({
      apiKey: 'legacy-secret',
      generation: 1,
    })
    expect(asyncDecryptCount).toBe(1)
    const after = await readFile(join(userDataPath, 'settings.json'), 'utf8')
    expect(after).not.toBe(before)
    expect(after).toMatch(/safe-storage:async:v1:/)
  })

  it('preserves legacy ciphertext without requiring re-entry after one async rejection', async () => {
    const userDataPath = await createTemporaryDirectory()
    const legacyStore = new SettingsStore({ userDataPath, encryption: testEncryption })
    const saved = await legacyStore.saveProvider({
      name: 'Unavailable legacy provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'legacy-secret',
    })
    const settingsPath = join(userDataPath, 'settings.json')
    const before = await readFile(settingsPath, 'utf8')
    const encryption: EncryptionAdapter = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText) => Buffer.from(`async:${plainText}`),
      decryptStringAsync: async () => {
        throw new Error('Legacy key is unavailable in this application context.')
      },
    }
    const store = new SettingsStore({ userDataPath, encryption })

    const error = await store.getProvider(saved.providers[0].id).catch((caught) => caught)
    expect(error).toMatchObject({ code: 'ENCRYPTION_FAILED' })
    expect(error).not.toMatchObject({ code: 'CREDENTIAL_REENTRY_REQUIRED' })
    expect(JSON.stringify(error)).not.toContain('legacy-secret')
    expect(await readFile(settingsPath, 'utf8')).toBe(before)
  })

  it('reports read encryption unavailable when neither legacy backend can be attempted', async () => {
    const userDataPath = await createTemporaryDirectory()
    const legacyStore = new SettingsStore({ userDataPath, encryption: testEncryption })
    const saved = await legacyStore.saveProvider({
      name: 'Unavailable provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'legacy-secret',
    })
    const settingsPath = join(userDataPath, 'settings.json')
    const before = await readFile(settingsPath, 'utf8')
    const store = new SettingsStore({
      userDataPath,
      encryption: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => '',
        isAsyncEncryptionAvailable: async () => false,
        encryptStringAsync: async () => Buffer.alloc(0),
        decryptStringAsync: async () => ({ result: '', shouldReEncrypt: false }),
      },
    })

    await expect(store.getProvider(saved.providers[0].id)).rejects.toMatchObject({
      code: 'ENCRYPTION_UNAVAILABLE',
      descriptor: { operation: 'read' },
    })
    expect(await readFile(settingsPath, 'utf8')).toBe(before)
  })

  it('requires re-entry only after both async and sync legacy decryption reject', async () => {
    const userDataPath = await createTemporaryDirectory()
    const legacyStore = new SettingsStore({ userDataPath, encryption: testEncryption })
    const saved = await legacyStore.saveProvider({
      name: 'Unreadable provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'legacy-secret',
    })
    const settingsPath = join(userDataPath, 'settings.json')
    const before = await readFile(settingsPath, 'utf8')
    const store = new SettingsStore({
      userDataPath,
      encryption: {
        isEncryptionAvailable: () => true,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => {
          throw new Error('The synchronous legacy key is unavailable.')
        },
        isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async () => Buffer.alloc(0),
        decryptStringAsync: async () => {
          throw new Error('The asynchronous legacy key is unavailable.')
        },
      },
    })

    const error = await store.getProvider(saved.providers[0].id).catch((caught) => caught)
    expect(error).toMatchObject({ code: 'CREDENTIAL_REENTRY_REQUIRED' })
    expect(error.cause).toBeInstanceOf(AggregateError)
    expect((error.cause as AggregateError).errors).toHaveLength(2)
    expect(JSON.stringify(error)).not.toContain('legacy-secret')
    expect(await readFile(settingsPath, 'utf8')).toBe(before)
  })

  it('re-encrypts rotated async ciphertext and fails closed if migration encryption fails', async () => {
    const userDataPath = await createTemporaryDirectory()
    let encryptionShouldFail = false
    let encryptedVersion = 0
    const encryption: EncryptionAdapter = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText) => {
        if (encryptionShouldFail) throw new Error('Key rotation is temporarily unavailable.')
        encryptedVersion += 1
        return Buffer.from(`${encryptedVersion}:${plainText}`)
      },
      decryptStringAsync: async (encrypted) => ({
        result: encrypted.toString().split(':').slice(1).join(':'),
        shouldReEncrypt: true,
      }),
    }
    const store = new SettingsStore({ userDataPath, encryption })
    const saved = await store.saveProvider({
      name: 'Rotating provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'rotation-secret',
    })
    const beforeFailure = await readFile(join(userDataPath, 'settings.json'), 'utf8')
    encryptionShouldFail = true

    await expect(store.getProvider(saved.providers[0].id)).rejects.toMatchObject({
      code: 'ENCRYPTION_FAILED',
    })
    expect(await readFile(join(userDataPath, 'settings.json'), 'utf8')).toBe(beforeFailure)

    encryptionShouldFail = false
    await expect(store.getProvider(saved.providers[0].id)).resolves.toMatchObject({
      apiKey: 'rotation-secret',
      generation: 1,
    })
    const afterSuccess = await readFile(join(userDataPath, 'settings.json'), 'utf8')
    expect(afterSuccess).not.toBe(beforeFailure)
  })

  it('preserves the previous ciphertext when async key rotation exceeds the persistence limit', async () => {
    const userDataPath = await createTemporaryDirectory()
    let returnOversizedCiphertext = false
    const encryption: EncryptionAdapter = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plainText) =>
        returnOversizedCiphertext
          ? Buffer.alloc(Math.floor(MAX_PERSISTED_CREDENTIAL_CHARACTERS / 4) * 3)
          : Buffer.from(`async:${plainText}`),
      decryptStringAsync: async (encrypted) => ({
        result: encrypted.toString().slice('async:'.length),
        shouldReEncrypt: true,
      }),
    }
    const store = new SettingsStore({ userDataPath, encryption })
    const saved = await store.saveProvider({
      name: 'Rotating provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'rotation-secret',
    })
    const settingsPath = join(userDataPath, 'settings.json')
    const before = await readFile(settingsPath, 'utf8')
    returnOversizedCiphertext = true

    await expect(store.getProvider(saved.providers[0].id)).rejects.toMatchObject({
      code: 'CREDENTIAL_TOO_LARGE',
      descriptor: { identifier: 'encrypted-api-key' },
    })
    expect(await readFile(settingsPath, 'utf8')).toBe(before)
  })

  it('validates the complete persisted state before atomically replacing an existing file', async () => {
    const userDataPath = await createTemporaryDirectory()
    const store = new SettingsStore({ userDataPath, encryption: testEncryption })
    await store.saveSettings({
      activeProviderId: null,
      activeModelId: null,
      theme: 'light',
      maxToolIterations: 8,
    })
    const settingsPath = join(userDataPath, 'settings.json')
    const before = await readFile(settingsPath, 'utf8')
    const cached = await (store as unknown as { load(): Promise<{ theme: string }> }).load()
    cached.theme = 'invalid-internal-theme'

    await expect(store.setLastWorkspace(null)).rejects.toMatchObject({
      code: 'INVALID_SETTINGS_FILE',
      descriptor: { identifier: 'write-validation', path: settingsPath },
    })
    expect(await readFile(settingsPath, 'utf8')).toBe(before)

    const restarted = new SettingsStore({ userDataPath, encryption: testEncryption })
    await expect(restarted.getSettings()).resolves.toMatchObject({ theme: 'light' })
    expect((await readdir(userDataPath)).some((name) => name.includes('.corrupt-'))).toBe(false)
  })

  it('does not reuse a credential when the provider endpoint changes', async () => {
    const userDataPath = await createTemporaryDirectory()
    const store = new SettingsStore({ userDataPath, encryption: testEncryption })
    const created = await store.saveProvider({
      name: 'Provider',
      baseUrl: 'https://first.example.com/v1',
      apiKey: 'origin-bound-secret',
    })

    const updated = await store.saveProvider({
      id: created.providers[0].id,
      name: 'Provider',
      baseUrl: 'https://second.example.com/v1',
    })

    expect(updated.providers[0].apiKeyConfigured).toBe(false)
    expect((await store.getProvider(updated.providers[0].id))?.apiKey).toBeNull()
  })

  it('can explicitly remove a saved credential without deleting the provider', async () => {
    const userDataPath = await createTemporaryDirectory()
    const store = new SettingsStore({ userDataPath, encryption: testEncryption })
    const created = await store.saveProvider({
      name: 'Provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'removable-secret',
    })

    const updated = await store.saveProvider({
      id: created.providers[0].id,
      name: 'Provider',
      baseUrl: 'https://example.com/v1',
      clearApiKey: true,
    })

    expect(updated.providers[0].apiKeyConfigured).toBe(false)
    expect((await store.getProvider(updated.providers[0].id))?.apiKey).toBeNull()
  })

  it('migrates version 1 settings to fail-closed manual workspace approvals', async () => {
    const userDataPath = await createTemporaryDirectory()
    await writeFile(
      join(userDataPath, 'settings.json'),
      JSON.stringify({
        version: 1,
        providers: [],
        activeProviderId: null,
        activeModelId: null,
        theme: 'dark',
        maxToolIterations: 6,
        lastWorkspace: { name: 'legacy', path: '/tmp/legacy-workspace' },
      }),
    )
    const store = new SettingsStore({ userDataPath, encryption: testEncryption })

    expect(await store.getSettings()).toMatchObject({
      theme: 'dark',
      locale: 'ko',
      maxToolIterations: 6,
      maxTotalToolCalls: 100,
      runTimeoutMinutes: 15,
    })
    await expect(store.getWorkspaceApprovalPolicy('/tmp/legacy-workspace')).resolves.toEqual({
      workspacePath: '/tmp/legacy-workspace',
      fileChanges: { mode: 'manual' },
      commands: { mode: 'manual' },
    })

    // An older renderer payload must preserve the migrated manual policy and write the new version.
    await store.saveSettings({
      activeProviderId: null,
      activeModelId: null,
      theme: 'light',
      maxToolIterations: 6,
    })
    const persisted = JSON.parse(await readFile(join(userDataPath, 'settings.json'), 'utf8')) as {
      version: number
      locale: string
      workspaceApprovalPolicies: unknown[]
    }
    expect(persisted.version).toBe(5)
    expect(persisted.locale).toBe('ko')
    expect(persisted.workspaceApprovalPolicies).toEqual([])
  })

  it('migrates version 2 settings with an explicit total tool-call budget', async () => {
    const userDataPath = await createTemporaryDirectory()
    await writeFile(
      join(userDataPath, 'settings.json'),
      JSON.stringify({
        version: 2,
        providers: [],
        activeProviderId: null,
        activeModelId: null,
        theme: 'system',
        maxToolIterations: 7,
        lastWorkspace: null,
        workspaceApprovalPolicies: [],
      }),
    )
    const store = new SettingsStore({ userDataPath, encryption: testEncryption })

    expect(await store.getSettings()).toMatchObject({
      locale: 'ko',
      maxToolIterations: 7,
      maxTotalToolCalls: 100,
    })
    await store.saveSettings({
      activeProviderId: null,
      activeModelId: null,
      theme: 'system',
      maxToolIterations: 7,
      maxTotalToolCalls: 75,
    })
    const persisted = JSON.parse(await readFile(join(userDataPath, 'settings.json'), 'utf8')) as {
      version: number
      maxTotalToolCalls: number
    }
    expect(persisted).toMatchObject({
      version: 5,
      locale: 'ko',
      maxTotalToolCalls: 75,
      runTimeoutMinutes: 15,
    })
  })

  it('migrates version 3 settings with a configurable run timeout', async () => {
    const userDataPath = await createTemporaryDirectory()
    await writeFile(
      join(userDataPath, 'settings.json'),
      JSON.stringify({
        version: 3,
        providers: [],
        activeProviderId: null,
        activeModelId: null,
        theme: 'system',
        maxToolIterations: 8,
        maxTotalToolCalls: 75,
        lastWorkspace: null,
        workspaceApprovalPolicies: [],
      }),
    )
    const store = new SettingsStore({ userDataPath, encryption: testEncryption })

    expect(await store.getSettings()).toMatchObject({
      locale: 'ko',
      maxTotalToolCalls: 75,
      runTimeoutMinutes: 15,
    })
    await store.saveSettings({
      activeProviderId: null,
      activeModelId: null,
      theme: 'system',
      maxToolIterations: 8,
      maxTotalToolCalls: 75,
      runTimeoutMinutes: 30,
    })
    expect(JSON.parse(await readFile(join(userDataPath, 'settings.json'), 'utf8'))).toMatchObject({
      version: 5,
      locale: 'ko',
      runTimeoutMinutes: 30,
    })
  })

  it('migrates version 4 settings and preserves an explicit locale across older saves', async () => {
    const userDataPath = await createTemporaryDirectory()
    await writeFile(
      join(userDataPath, 'settings.json'),
      JSON.stringify({
        version: 4,
        providers: [],
        activeProviderId: null,
        activeModelId: null,
        theme: 'system',
        maxToolIterations: 8,
        maxTotalToolCalls: 75,
        runTimeoutMinutes: 30,
        lastWorkspace: null,
        workspaceApprovalPolicies: [],
      }),
    )
    const store = new SettingsStore({ userDataPath, encryption: testEncryption })

    expect(await store.getSettings()).toMatchObject({
      locale: 'ko',
      maxTotalToolCalls: 75,
      runTimeoutMinutes: 30,
    })

    await expect(
      store.saveSettings({
        activeProviderId: null,
        activeModelId: null,
        theme: 'system',
        locale: 'en',
        maxToolIterations: 8,
        maxTotalToolCalls: 75,
        runTimeoutMinutes: 30,
      }),
    ).resolves.toMatchObject({ locale: 'en' })

    await expect(
      store.saveSettings({
        activeProviderId: null,
        activeModelId: null,
        theme: 'dark',
        maxToolIterations: 7,
      }),
    ).resolves.toMatchObject({ locale: 'en' })

    expect(JSON.parse(await readFile(join(userDataPath, 'settings.json'), 'utf8'))).toMatchObject({
      version: 5,
      locale: 'en',
      theme: 'dark',
      maxToolIterations: 7,
      maxTotalToolCalls: 75,
      runTimeoutMinutes: 30,
    })
  })

  it('persists independent, workspace-bound file and command auto-approval rules', async () => {
    const userDataPath = await createTemporaryDirectory()
    const store = new SettingsStore({ userDataPath, encryption: testEncryption })
    const workspacePath = '/tmp/automation-workspace'
    const workspaceApprovalPolicies = [
      {
        workspacePath,
        fileChanges: {
          mode: 'auto' as const,
          scope: 'all-act-runs' as const,
          rules: [
            { pathPrefix: 'src', operations: ['create', 'update'] },
            { pathPrefix: 'tests', operations: ['create', 'update', 'delete'] },
          ],
          maxFilesPerRequest: 20,
          maxChangedLinesPerRequest: 5_000,
          maxChangedBytesPerRequest: 2_000_000,
        },
        commands: {
          mode: 'auto' as const,
          scope: 'goals-only' as const,
          rules: [
            {
              executable: '/usr/local/bin/pnpm',
              argumentPrefix: ['test'],
              allowAdditionalArguments: true,
              workingDirectoryPrefix: '.',
              maxTimeoutMs: 120_000,
              allowHostNetwork: false,
            },
          ],
        },
      },
    ] satisfies WorkspaceApprovalPolicy[]

    await store.saveSettings({
      activeProviderId: null,
      activeModelId: null,
      theme: 'system',
      maxToolIterations: 8,
    })
    const saved = await store.saveWorkspaceApprovalPolicy(workspacePath, {
      fileChanges: workspaceApprovalPolicies[0].fileChanges,
      commands: workspaceApprovalPolicies[0].commands,
    })
    expect(saved).toEqual(workspaceApprovalPolicies[0])
    await expect(store.getWorkspaceApprovalPolicy(workspacePath)).resolves.toEqual(
      workspaceApprovalPolicies[0],
    )

    // Compatibility saves that omit policies cannot silently clear an existing grant.
    await store.saveSettings({
      activeProviderId: null,
      activeModelId: null,
      theme: 'dark',
      maxToolIterations: 7,
    })
    await expect(store.getWorkspaceApprovalPolicy(workspacePath)).resolves.toEqual(
      workspaceApprovalPolicies[0],
    )

    await store.saveWorkspaceApprovalPolicy(workspacePath, {
      fileChanges: { mode: 'manual' },
      commands: { mode: 'manual' },
    })
    const persisted = JSON.parse(await readFile(join(userDataPath, 'settings.json'), 'utf8')) as {
      workspaceApprovalPolicies: unknown[]
    }
    expect(persisted.workspaceApprovalPolicies).toEqual([])
  })

  it('strictly rejects broad, ambiguous, escaping, and renderer-scoped approval rules', async () => {
    const userDataPath = await createTemporaryDirectory()
    const store = new SettingsStore({ userDataPath, encryption: testEncryption })
    const commandRule = {
      executable: '/usr/local/bin/pnpm',
      argumentPrefix: ['test'],
      allowAdditionalArguments: false,
      workingDirectoryPrefix: '.',
      maxTimeoutMs: 60_000,
      allowHostNetwork: false,
    }

    await expect(
      store.saveWorkspaceApprovalPolicy('/tmp/workspace', {
        fileChanges: {
          mode: 'auto',
          rules: [],
          maxFilesPerRequest: 1,
          maxChangedLinesPerRequest: 1,
          maxChangedBytesPerRequest: 1,
        },
        commands: { mode: 'manual' },
      } as never),
    ).rejects.toThrow()
    await expect(
      store.saveWorkspaceApprovalPolicy('/tmp/workspace', {
        fileChanges: {
          mode: 'auto',
          scope: 'all-act-runs',
          rules: [{ pathPrefix: '../outside', operations: ['update'] }],
          maxFilesPerRequest: 1,
          maxChangedLinesPerRequest: 1,
          maxChangedBytesPerRequest: 1,
        },
        commands: { mode: 'manual' },
      }),
    ).rejects.toThrow()
    await expect(
      store.saveWorkspaceApprovalPolicy('/tmp/workspace', {
        fileChanges: { mode: 'manual' },
        commands: {
          mode: 'auto',
          scope: 'goals-only',
          rules: [{ ...commandRule, unexpectedGrant: true }],
        },
      } as never),
    ).rejects.toThrow()
    await expect(
      store.saveWorkspaceApprovalPolicy('/tmp/workspace', {
        fileChanges: { mode: 'manual' },
        commands: {
          mode: 'auto',
          scope: 'goals-only',
          rules: [{ ...commandRule, executable: 'pnpm' }],
        },
      }),
    ).rejects.toThrow()
    await expect(
      store.saveWorkspaceApprovalPolicy('/tmp/workspace', {
        fileChanges: { mode: 'manual' },
        commands: {
          mode: 'auto',
          scope: 'goals-only',
          rules: [{ ...commandRule, argumentPrefix: [], allowAdditionalArguments: true }],
        },
      }),
    ).rejects.toThrow()
    await expect(
      store.saveWorkspaceApprovalPolicy('/tmp/workspace', {
        workspacePath: '/renderer-owned-path',
        fileChanges: { mode: 'manual' },
        commands: { mode: 'manual' },
      } as never),
    ).rejects.toThrow()
    await expect(store.getWorkspaceApprovalPolicy('/tmp/workspace')).resolves.toEqual({
      workspacePath: '/tmp/workspace',
      fileChanges: { mode: 'manual' },
      commands: { mode: 'manual' },
    })
  })

  it('backs up a version 2 settings file containing unknown policy fields', async () => {
    const userDataPath = await createTemporaryDirectory()
    await writeFile(
      join(userDataPath, 'settings.json'),
      JSON.stringify({
        version: 2,
        providers: [],
        activeProviderId: null,
        activeModelId: null,
        theme: 'system',
        maxToolIterations: 8,
        lastWorkspace: null,
        workspaceApprovalPolicies: [
          {
            workspacePath: '/tmp/workspace',
            fileChanges: { mode: 'manual', implicitAutoApprove: true },
            commands: { mode: 'manual' },
          },
        ],
      }),
    )
    const store = new SettingsStore({ userDataPath, encryption: testEncryption })

    await expect(store.getWorkspaceApprovalPolicy('/tmp/workspace')).resolves.toMatchObject({
      fileChanges: { mode: 'manual' },
      commands: { mode: 'manual' },
    })
    expect(
      (await readdir(userDataPath)).some((name) => name.startsWith('settings.json.corrupt-')),
    ).toBe(true)
  })
})
