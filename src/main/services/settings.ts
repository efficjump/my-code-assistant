import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  type AppSettings,
  appLocaleSchema,
  DEFAULT_AGENT_RUN_TIMEOUT_MINUTES,
  DEFAULT_APP_LOCALE,
  DEFAULT_MAX_TOTAL_TOOL_CALLS,
  MAX_AGENT_RUN_TIMEOUT_MINUTES,
  MAX_PROVIDER_API_KEY_BYTES,
  MAX_TOTAL_TOOL_CALLS,
  type ProviderInput,
  type ProviderSummary,
  providerInputSchema,
  providerUrlSchema,
  type SettingsInput,
  settingsInputSchema,
  type WorkspaceApprovalPolicy,
  type WorkspaceApprovalPolicyConfiguration,
  type WorkspaceSummary,
  workspaceApprovalPoliciesSchema,
  workspaceApprovalPolicyConfigurationSchema,
  workspaceApprovalPolicySchema,
} from '../../shared/contracts'
import {
  formatServiceErrorDescriptor,
  SERVICE_ERROR_MARKER,
  type SettingsServiceErrorDescriptor,
  type SettingsStoreErrorCode,
  type SettingsStoreErrorDetail,
} from './service-error-messages'

const SETTINGS_VERSION = 5 as const
const PREVIOUS_SETTINGS_VERSION = 4 as const
const OLDER_SETTINGS_VERSION = 3 as const
const EARLIER_SETTINGS_VERSION = 2 as const
const LEGACY_SETTINGS_VERSION = 1 as const
const DEFAULT_ASSISTANT_DRIVER_ID = 'responses-api'
const CREDENTIAL_CIPHERTEXT_MARKER = 'safe-storage:'
const ASYNC_CREDENTIAL_CIPHERTEXT_PREFIX = `${CREDENTIAL_CIPHERTEXT_MARKER}async:v1:`
const BROKER_CREDENTIAL_CIPHERTEXT_MARKER = 'credential-broker:'
const BROKER_CREDENTIAL_CIPHERTEXT_PREFIX = `${BROKER_CREDENTIAL_CIPHERTEXT_MARKER}mac:v1:`
const BROKER_KEY_ID_PATTERN = /^[0-9a-f]{32}$/u
export const MAX_PERSISTED_CREDENTIAL_CHARACTERS = 32_768

const persistedProviderSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(80),
    baseUrl: providerUrlSchema,
    driverId: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]{0,79}$/)
      .default(DEFAULT_ASSISTANT_DRIVER_ID),
    generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
    encryptedApiKey: z.string().min(1).max(MAX_PERSISTED_CREDENTIAL_CHARACTERS).optional(),
  })
  .strict()

const workspaceSummarySchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    path: z.string().trim().min(1).max(4096),
  })
  .strict()

const persistedSettingsFields = {
  providers: z.array(persistedProviderSchema),
  activeProviderId: z.string().trim().min(1).max(120).nullable(),
  activeModelId: z.string().trim().min(1).max(512).nullable(),
  theme: z.enum(['system', 'dark', 'light']),
  maxToolIterations: z.number().int().min(1).max(20),
  lastWorkspace: workspaceSummarySchema.nullable(),
}

const previousPersistedSettingsFields = {
  ...persistedSettingsFields,
  maxTotalToolCalls: z.number().int().min(1).max(MAX_TOTAL_TOOL_CALLS),
}

const runTimeoutPersistedSettingsFields = {
  ...previousPersistedSettingsFields,
  runTimeoutMinutes: z.number().int().min(1).max(MAX_AGENT_RUN_TIMEOUT_MINUTES),
}

const currentPersistedSettingsFields = {
  ...runTimeoutPersistedSettingsFields,
  locale: appLocaleSchema,
}

const legacyPersistedSettingsSchema = z
  .object({
    version: z.literal(LEGACY_SETTINGS_VERSION),
    ...persistedSettingsFields,
  })
  .strict()

const persistedSettingsSchema = z
  .object({
    version: z.literal(SETTINGS_VERSION),
    ...currentPersistedSettingsFields,
    workspaceApprovalPolicies: workspaceApprovalPoliciesSchema,
  })
  .strict()

const previousPersistedSettingsSchema = z
  .object({
    version: z.literal(PREVIOUS_SETTINGS_VERSION),
    ...runTimeoutPersistedSettingsFields,
    workspaceApprovalPolicies: workspaceApprovalPoliciesSchema,
  })
  .strict()

const olderPersistedSettingsSchema = z
  .object({
    version: z.literal(OLDER_SETTINGS_VERSION),
    ...previousPersistedSettingsFields,
    workspaceApprovalPolicies: workspaceApprovalPoliciesSchema,
  })
  .strict()

const earlierPersistedSettingsSchema = z
  .object({
    version: z.literal(EARLIER_SETTINGS_VERSION),
    ...persistedSettingsFields,
    workspaceApprovalPolicies: workspaceApprovalPoliciesSchema,
  })
  .strict()

type PersistedSettings = z.infer<typeof persistedSettingsSchema>
type PersistedProvider = z.infer<typeof persistedProviderSchema>

export interface EncryptionAdapter {
  readonly ciphertextFormat?: 'safe-storage' | 'credential-broker-v1'
  readonly credentialKeyId?: string
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  isAsyncEncryptionAvailable?(): Promise<boolean>
  encryptStringAsync?(plainText: string, context?: CredentialEncryptionContext): Promise<Buffer>
  decryptStringAsync?(
    encrypted: Buffer,
    context?: CredentialEncryptionContext,
  ): Promise<AsyncDecryptionResult>
}

export interface CredentialEncryptionContext {
  providerId: string
  baseUrl: string
  generation: number
}

export interface AsyncDecryptionResult {
  result: string
  shouldReEncrypt: boolean
}

export interface SettingsStoreOptions {
  /** Defaults to Electron's `app.getPath('userData')`. Primarily useful for tests. */
  userDataPath?: string
  /** Defaults to Electron's `safeStorage`. A plaintext adapter must never be supplied. */
  encryption?: EncryptionAdapter
  /** Legacy Electron safeStorage used only to migrate existing ciphertext to the primary adapter. */
  legacyEncryption?: EncryptionAdapter
  fileName?: string
}

interface ResolvedSettingsDependencies {
  userDataPath: string
  encryption: EncryptionAdapter
  legacyEncryption: EncryptionAdapter | null
}

export interface ProviderCredentials extends ProviderSummary {
  apiKey: string | null
  generation: number
}

interface DecryptedApiKey {
  value: string
  replacementCiphertext?: string
}

interface EncryptionCapabilities {
  encryption: EncryptionAdapter
  asyncEncryption: CompleteAsyncEncryptionAdapter | null
  asyncAvailable: boolean
  syncAvailable: boolean
  availabilityError?: unknown
}

interface EncodedCiphertext {
  buffer: Buffer
  format: 'async-v1' | 'broker-v1' | 'legacy-sync'
  keyId?: string
}

export type { SettingsStoreErrorCode } from './service-error-messages'

export class SettingsStoreError extends Error {
  readonly code: SettingsStoreErrorCode
  readonly descriptor: SettingsServiceErrorDescriptor
  readonly [SERVICE_ERROR_MARKER] = true as const

  constructor(detail: SettingsStoreErrorDetail, options?: ErrorOptions)
  constructor(code: SettingsStoreErrorCode, message: string, options?: ErrorOptions)
  constructor(
    detailOrCode: SettingsStoreErrorDetail | SettingsStoreErrorCode,
    messageOrOptions?: string | ErrorOptions,
    legacyOptions?: ErrorOptions,
  ) {
    const descriptor = (
      typeof detailOrCode === 'string'
        ? { service: 'settings', code: detailOrCode }
        : { service: 'settings', ...detailOrCode }
    ) as SettingsServiceErrorDescriptor
    const message =
      typeof messageOrOptions === 'string'
        ? messageOrOptions
        : formatServiceErrorDescriptor('ko', descriptor)
    const options = typeof messageOrOptions === 'string' ? legacyOptions : messageOrOptions
    super(message, options)
    this.name = 'SettingsStoreError'
    this.code = descriptor.code
    this.descriptor = descriptor
  }
}

function defaultSettings(): PersistedSettings {
  return {
    version: SETTINGS_VERSION,
    providers: [],
    activeProviderId: null,
    activeModelId: null,
    theme: 'system',
    locale: DEFAULT_APP_LOCALE,
    maxToolIterations: 8,
    maxTotalToolCalls: DEFAULT_MAX_TOTAL_TOOL_CALLS,
    runTimeoutMinutes: DEFAULT_AGENT_RUN_TIMEOUT_MINUTES,
    lastWorkspace: null,
    workspaceApprovalPolicies: [],
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

interface CompleteAsyncEncryptionAdapter extends EncryptionAdapter {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plainText: string, context?: CredentialEncryptionContext): Promise<Buffer>
  decryptStringAsync(
    encrypted: Buffer,
    context?: CredentialEncryptionContext,
  ): Promise<AsyncDecryptionResult>
}

function getAsyncEncryptionAdapter(
  encryption: EncryptionAdapter,
): CompleteAsyncEncryptionAdapter | null | undefined {
  const asyncMethods = [
    encryption.isAsyncEncryptionAvailable,
    encryption.encryptStringAsync,
    encryption.decryptStringAsync,
  ]
  const methodCount = asyncMethods.filter((method) => typeof method === 'function').length
  if (methodCount === 0) return null
  if (methodCount !== asyncMethods.length) return undefined
  return encryption as CompleteAsyncEncryptionAdapter
}

function cloneSettings(settings: PersistedSettings): PersistedSettings {
  return {
    ...settings,
    providers: settings.providers.map((provider) => ({ ...provider })),
    lastWorkspace: settings.lastWorkspace ? { ...settings.lastWorkspace } : null,
    workspaceApprovalPolicies: settings.workspaceApprovalPolicies.map(cloneWorkspaceApprovalPolicy),
  }
}

function cloneWorkspaceApprovalPolicy(policy: WorkspaceApprovalPolicy): WorkspaceApprovalPolicy {
  return {
    workspacePath: policy.workspacePath,
    fileChanges:
      policy.fileChanges.mode === 'manual'
        ? { mode: 'manual' }
        : {
            ...policy.fileChanges,
            rules: policy.fileChanges.rules.map((rule) => ({
              pathPrefix: rule.pathPrefix,
              operations: [...rule.operations],
            })),
          },
    commands:
      policy.commands.mode === 'manual'
        ? { mode: 'manual' }
        : {
            mode: 'auto',
            scope: policy.commands.scope,
            rules: policy.commands.rules.map((rule) => ({
              ...rule,
              argumentPrefix: [...rule.argumentPrefix],
            })),
          },
  }
}

function manualWorkspaceApprovalPolicy(workspacePath: string): WorkspaceApprovalPolicy {
  return workspaceApprovalPolicySchema.parse({
    workspacePath,
    fileChanges: { mode: 'manual' },
    commands: { mode: 'manual' },
  })
}

function toProviderSummary(provider: PersistedProvider): ProviderSummary {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    driverId: provider.driverId,
    apiKeyConfigured: provider.encryptedApiKey !== undefined,
  }
}

function toAppSettings(settings: PersistedSettings): AppSettings {
  return {
    providers: settings.providers.map(toProviderSummary),
    activeProviderId: settings.activeProviderId,
    activeModelId: settings.activeModelId,
    theme: settings.theme,
    locale: settings.locale,
    maxToolIterations: settings.maxToolIterations,
    maxTotalToolCalls: settings.maxTotalToolCalls,
    runTimeoutMinutes: settings.runTimeoutMinutes,
  }
}

function assertSelectionIsValid(
  settings: Pick<PersistedSettings, 'providers'>,
  activeProviderId: string | null,
  activeModelId: string | null,
): void {
  if (activeProviderId === null && activeModelId !== null) {
    throw new SettingsStoreError({
      code: 'INVALID_ACTIVE_SELECTION',
      identifier: 'provider-required',
    })
  }

  if (
    activeProviderId !== null &&
    !settings.providers.some((provider) => provider.id === activeProviderId)
  ) {
    throw new SettingsStoreError({
      code: 'INVALID_ACTIVE_SELECTION',
      identifier: 'provider-missing',
      providerId: activeProviderId,
    })
  }
}

/**
 * Persists application settings and provider credentials under Electron's userData directory.
 * API keys are only written after `safeStorage` successfully encrypts them; encryption failure is
 * fatal and never falls back to plaintext storage.
 */
export class SettingsStore {
  private readonly options: SettingsStoreOptions
  private dependenciesPromise: Promise<ResolvedSettingsDependencies> | undefined
  private settingsPromise: Promise<PersistedSettings> | undefined
  private mutationTail: Promise<void> = Promise.resolve()
  private startupCredentialMigrationPromise: Promise<number> | undefined
  private readonly startupCredentialMigrationFailures = new Map<
    string,
    { ciphertext: string; error: SettingsStoreError }
  >()

  constructor(options: SettingsStoreOptions = {}) {
    this.options = options
  }

  async getSettings(): Promise<AppSettings> {
    return toAppSettings(await this.load())
  }

  /** Migrates every legacy credential once, checkpointing each provider with a generation CAS. */
  async migrateProviderCredentialsAtStartup(): Promise<number> {
    this.startupCredentialMigrationPromise ??= this.performStartupCredentialMigration().catch(
      (error: unknown) => {
        const failure =
          error instanceof SettingsStoreError
            ? error
            : new SettingsStoreError(
                { code: 'ENCRYPTION_FAILED', operation: 'decrypt' },
                { cause: error },
              )
        throw failure
      },
    )
    return this.startupCredentialMigrationPromise
  }

  private async performStartupCredentialMigration(): Promise<number> {
    const { encryption } = await this.resolveDependencies()
    if (encryption.ciphertextFormat !== 'credential-broker-v1') return 0

    const snapshot = await this.load()
    const providers = [...snapshot.providers].sort((left, right) => {
      if (left.id === snapshot.activeProviderId) return -1
      if (right.id === snapshot.activeProviderId) return 1
      return 0
    })
    let migrated = 0
    let firstFailure: SettingsStoreError | undefined
    for (const provider of providers) {
      if (!provider.encryptedApiKey || (await this.isPrimaryCiphertext(provider.encryptedApiKey))) {
        continue
      }
      try {
        const decrypted = await this.decryptApiKey(provider.encryptedApiKey, {
          providerId: provider.id,
          baseUrl: provider.baseUrl,
          generation: provider.generation,
        })
        if (!decrypted.replacementCiphertext) {
          throw new SettingsStoreError({ code: 'ENCRYPTION_FAILED', operation: 'decrypt' })
        }
        const replaced = await this.replaceEncryptedApiKey(
          provider.id,
          provider.generation,
          provider.encryptedApiKey,
          decrypted.replacementCiphertext,
        )
        if (!replaced) {
          throw new SettingsStoreError({ code: 'ENCRYPTION_FAILED', operation: 'decrypt' })
        }
        migrated += 1
      } catch (error) {
        const failure =
          error instanceof SettingsStoreError
            ? error
            : new SettingsStoreError(
                { code: 'ENCRYPTION_FAILED', operation: 'decrypt' },
                { cause: error },
              )
        this.startupCredentialMigrationFailures.set(provider.id, {
          ciphertext: provider.encryptedApiKey,
          error: failure,
        })
        firstFailure ??= failure
        // Electron does not expose a stable denial-vs-corruption code. Stop after the first
        // failure so one denied Keychain interaction cannot trigger a sequence of UI prompts.
        break
      }
    }
    if (firstFailure) throw firstFailure
    return migrated
  }

  async listProviders(): Promise<ProviderSummary[]> {
    return (await this.load()).providers.map(toProviderSummary)
  }

  async getProvider(providerId: string): Promise<ProviderCredentials | null> {
    const provider = (await this.load()).providers.find((item) => item.id === providerId)
    if (!provider) return null

    const decryptedApiKey = provider.encryptedApiKey
      ? await this.decryptApiKey(provider.encryptedApiKey, {
          providerId: provider.id,
          baseUrl: provider.baseUrl,
          generation: provider.generation,
        })
      : null
    if (decryptedApiKey?.replacementCiphertext && provider.encryptedApiKey) {
      const migrated = await this.replaceEncryptedApiKey(
        provider.id,
        provider.generation,
        provider.encryptedApiKey,
        decryptedApiKey.replacementCiphertext,
      )
      if (!migrated) {
        throw new SettingsStoreError({ code: 'ENCRYPTION_FAILED', operation: 'decrypt' })
      }
    }

    return {
      ...toProviderSummary(provider),
      apiKey: decryptedApiKey?.value ?? null,
      generation: provider.generation,
    }
  }

  async getActiveProvider(): Promise<ProviderCredentials | null> {
    const settings = await this.load()
    return settings.activeProviderId ? this.getProvider(settings.activeProviderId) : null
  }

  async getWorkspaceApprovalPolicy(workspacePath: string): Promise<WorkspaceApprovalPolicy> {
    const policy = (await this.load()).workspaceApprovalPolicies.find(
      (item) => item.workspacePath === workspacePath,
    )
    return policy
      ? cloneWorkspaceApprovalPolicy(policy)
      : manualWorkspaceApprovalPolicy(workspacePath)
  }

  async saveWorkspaceApprovalPolicy(
    workspacePath: string,
    input: WorkspaceApprovalPolicyConfiguration,
  ): Promise<WorkspaceApprovalPolicy> {
    const configuration = workspaceApprovalPolicyConfigurationSchema.parse(input)
    const policy = workspaceApprovalPolicySchema.parse({ workspacePath, ...configuration })

    return this.mutate(async (settings) => {
      const existingIndex = settings.workspaceApprovalPolicies.findIndex(
        (item) => item.workspacePath === policy.workspacePath,
      )
      const isManual = policy.fileChanges.mode === 'manual' && policy.commands.mode === 'manual'
      if (isManual) {
        if (existingIndex >= 0) settings.workspaceApprovalPolicies.splice(existingIndex, 1)
      } else if (existingIndex >= 0) {
        settings.workspaceApprovalPolicies[existingIndex] = cloneWorkspaceApprovalPolicy(policy)
      } else {
        settings.workspaceApprovalPolicies.push(cloneWorkspaceApprovalPolicy(policy))
      }
      return cloneWorkspaceApprovalPolicy(policy)
    })
  }

  async saveProvider(input: ProviderInput): Promise<AppSettings> {
    if (
      typeof input.apiKey === 'string' &&
      Buffer.byteLength(input.apiKey.trim(), 'utf8') > MAX_PROVIDER_API_KEY_BYTES
    ) {
      throw new SettingsStoreError({
        code: 'CREDENTIAL_TOO_LARGE',
        identifier: 'api-key',
        maximumBytes: MAX_PROVIDER_API_KEY_BYTES,
      })
    }
    const parsed = providerInputSchema.parse(input)

    return this.mutate(async (settings) => {
      const existingIndex = parsed.id
        ? settings.providers.findIndex((provider) => provider.id === parsed.id)
        : -1

      if (parsed.id && existingIndex < 0) {
        throw new SettingsStoreError({
          code: 'PROVIDER_NOT_FOUND',
          identifier: 'update',
          providerId: parsed.id,
        })
      }

      const existing = existingIndex >= 0 ? settings.providers[existingIndex] : undefined
      const mayReuseExistingCredential = existing?.baseUrl === parsed.baseUrl
      const providerIdentityChanged = Boolean(
        existing &&
          (existing.baseUrl !== parsed.baseUrl ||
            existing.driverId !== (parsed.driverId ?? existing.driverId) ||
            parsed.apiKey !== undefined ||
            (parsed.clearApiKey && existing.encryptedApiKey !== undefined)),
      )
      if (providerIdentityChanged && existing?.generation === Number.MAX_SAFE_INTEGER) {
        throw new SettingsStoreError({
          code: 'INVALID_SETTINGS_FILE',
          identifier: 'provider-generation',
          providerId: existing.id,
        })
      }
      const providerId = existing?.id ?? randomUUID()
      const generation = existing ? existing.generation + (providerIdentityChanged ? 1 : 0) : 1
      // Encryption runs inside the serialized mutation. A failure leaves both the cached draft and
      // the durable settings file untouched, while the AAD generation stays identical to the row.
      const encryptionContext = { providerId, baseUrl: parsed.baseUrl, generation }
      let encryptedApiKey: string | undefined
      if (parsed.apiKey) {
        encryptedApiKey = await this.encryptApiKey(parsed.apiKey, encryptionContext)
      } else if (!parsed.clearApiKey && mayReuseExistingCredential && existing?.encryptedApiKey) {
        if (generation === existing.generation) {
          encryptedApiKey = existing.encryptedApiKey
        } else {
          const decrypted = await this.decryptApiKey(existing.encryptedApiKey, {
            providerId: existing.id,
            baseUrl: existing.baseUrl,
            generation: existing.generation,
          })
          encryptedApiKey = await this.encryptApiKey(decrypted.value, encryptionContext)
        }
      }
      const provider: PersistedProvider = {
        id: providerId,
        name: parsed.name,
        baseUrl: parsed.baseUrl,
        driverId: parsed.driverId ?? existing?.driverId ?? DEFAULT_ASSISTANT_DRIVER_ID,
        generation,
        ...(encryptedApiKey ? { encryptedApiKey } : {}),
      }

      if (existingIndex >= 0) settings.providers[existingIndex] = provider
      else settings.providers.push(provider)

      return toAppSettings(settings)
    })
  }

  async removeProvider(input: string | { providerId: string }): Promise<AppSettings> {
    const providerId = typeof input === 'string' ? input.trim() : input.providerId.trim()
    if (!providerId) {
      throw new SettingsStoreError({ code: 'PROVIDER_NOT_FOUND', identifier: 'id-required' })
    }

    return this.mutate(async (settings) => {
      const providerIndex = settings.providers.findIndex((provider) => provider.id === providerId)
      if (providerIndex < 0) return toAppSettings(settings)

      settings.providers.splice(providerIndex, 1)
      if (settings.activeProviderId === providerId) {
        settings.activeProviderId = null
        settings.activeModelId = null
      }
      return toAppSettings(settings)
    })
  }

  async saveSettings(input: SettingsInput): Promise<AppSettings> {
    const parsed = settingsInputSchema.parse(input)

    return this.mutate(async (settings) => {
      assertSelectionIsValid(settings, parsed.activeProviderId, parsed.activeModelId)
      settings.activeProviderId = parsed.activeProviderId
      settings.activeModelId = parsed.activeModelId
      settings.theme = parsed.theme
      if (parsed.locale !== undefined) {
        settings.locale = parsed.locale
      }
      settings.maxToolIterations = parsed.maxToolIterations
      if (parsed.maxTotalToolCalls !== undefined) {
        settings.maxTotalToolCalls = parsed.maxTotalToolCalls
      }
      if (parsed.runTimeoutMinutes !== undefined) {
        settings.runTimeoutMinutes = parsed.runTimeoutMinutes
      }
      return toAppSettings(settings)
    })
  }

  async getLastWorkspace(): Promise<WorkspaceSummary | null> {
    const workspace = (await this.load()).lastWorkspace
    return workspace ? { ...workspace } : null
  }

  async setLastWorkspace(workspace: WorkspaceSummary | null): Promise<void> {
    const parsed = workspace === null ? null : workspaceSummarySchema.parse(workspace)
    await this.mutate(async (settings) => {
      settings.lastWorkspace = parsed ? { ...parsed } : null
    })
  }

  /** Clears the read cache so a subsequent call reloads settings changed by another process. */
  reload(): void {
    this.settingsPromise = undefined
  }

  private async resolveDependencies(): Promise<ResolvedSettingsDependencies> {
    if (!this.dependenciesPromise) {
      this.dependenciesPromise = (async () => {
        let userDataPath = this.options.userDataPath
        let encryption = this.options.encryption
        let legacyEncryption = this.options.legacyEncryption ?? null

        if (!userDataPath || !encryption) {
          const electron = await import('electron')
          userDataPath ??= electron.app.getPath('userData')
          if (!encryption) {
            const safeStorage = electron.safeStorage
            const safeStorageEncryption: EncryptionAdapter = {
              ciphertextFormat: 'safe-storage',
              isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
              encryptString: (plainText) => safeStorage.encryptString(plainText),
              decryptString: (encrypted) => safeStorage.decryptString(encrypted),
              isAsyncEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
              encryptStringAsync: (plainText) => safeStorage.encryptStringAsync(plainText),
              decryptStringAsync: (encrypted) => safeStorage.decryptStringAsync(encrypted),
              ...(typeof safeStorage.getSelectedStorageBackend === 'function'
                ? {
                    getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend(),
                  }
                : {}),
            }
            encryption = safeStorageEncryption
            if (process.platform === 'darwin' && electron.app.isPackaged) {
              const { resolvePackagedMacCredentialEncryptionAdapter } = await import(
                './macos-credential-broker'
              )
              const broker = await resolvePackagedMacCredentialEncryptionAdapter(
                electron.app.getAppPath(),
                process.resourcesPath,
              )
              if (broker) {
                encryption = broker
                legacyEncryption = safeStorageEncryption
              }
            }
          }
        }

        return { userDataPath, encryption, legacyEncryption }
      })()
    }
    return this.dependenciesPromise
  }

  private async getSettingsPath(): Promise<string> {
    const { userDataPath } = await this.resolveDependencies()
    return join(userDataPath, this.options.fileName ?? 'settings.json')
  }

  private load(): Promise<PersistedSettings> {
    this.settingsPromise ??= this.readFromDisk()
    return this.settingsPromise
  }

  private async readFromDisk(): Promise<PersistedSettings> {
    const settingsPath = await this.getSettingsPath()
    let source: string
    try {
      source = await readFile(settingsPath, 'utf8')
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return defaultSettings()
      throw new SettingsStoreError(
        { code: 'SETTINGS_READ_FAILED', path: settingsPath },
        { cause: error },
      )
    }

    try {
      const raw: unknown = JSON.parse(source)
      const current = persistedSettingsSchema.safeParse(raw)
      if (current.success) return current.data

      const previous = previousPersistedSettingsSchema.safeParse(raw)
      if (previous.success) {
        return {
          ...previous.data,
          version: SETTINGS_VERSION,
          locale: DEFAULT_APP_LOCALE,
        }
      }

      const older = olderPersistedSettingsSchema.safeParse(raw)
      if (older.success) {
        return {
          ...older.data,
          version: SETTINGS_VERSION,
          locale: DEFAULT_APP_LOCALE,
          runTimeoutMinutes: DEFAULT_AGENT_RUN_TIMEOUT_MINUTES,
        }
      }

      const earlier = earlierPersistedSettingsSchema.safeParse(raw)
      if (earlier.success) {
        return {
          ...earlier.data,
          version: SETTINGS_VERSION,
          locale: DEFAULT_APP_LOCALE,
          maxTotalToolCalls: DEFAULT_MAX_TOTAL_TOOL_CALLS,
          runTimeoutMinutes: DEFAULT_AGENT_RUN_TIMEOUT_MINUTES,
        }
      }

      const legacy = legacyPersistedSettingsSchema.safeParse(raw)
      if (legacy.success) {
        return {
          ...legacy.data,
          version: SETTINGS_VERSION,
          locale: DEFAULT_APP_LOCALE,
          maxTotalToolCalls: DEFAULT_MAX_TOTAL_TOOL_CALLS,
          runTimeoutMinutes: DEFAULT_AGENT_RUN_TIMEOUT_MINUTES,
          workspaceApprovalPolicies: [],
        }
      }
      throw current.error
    } catch {
      const backupPath = `${settingsPath}.corrupt-${Date.now()}`
      try {
        await rename(settingsPath, backupPath)
        await chmod(backupPath, 0o600).catch(() => undefined)
      } catch (backupError) {
        throw new SettingsStoreError(
          { code: 'INVALID_SETTINGS_FILE', identifier: 'backup-failed', path: settingsPath },
          { cause: backupError },
        )
      }
      return defaultSettings()
    }
  }

  private mutate<T>(mutation: (draft: PersistedSettings) => Promise<T> | T): Promise<T> {
    const operation = this.mutationTail.then(async () => {
      const draft = cloneSettings(await this.load())
      const result = await mutation(draft)
      assertSelectionIsValid(draft, draft.activeProviderId, draft.activeModelId)
      await this.writeToDisk(draft)
      this.settingsPromise = Promise.resolve(draft)
      return result
    })

    this.mutationTail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async writeToDisk(settings: PersistedSettings): Promise<void> {
    const settingsPath = await this.getSettingsPath()
    const settingsDirectory = (await this.resolveDependencies()).userDataPath
    const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`
    const validation = persistedSettingsSchema.safeParse(settings)
    if (!validation.success) {
      throw new SettingsStoreError(
        { code: 'INVALID_SETTINGS_FILE', identifier: 'write-validation', path: settingsPath },
        { cause: validation.error },
      )
    }
    const serialized = `${JSON.stringify(validation.data, null, 2)}\n`

    try {
      await mkdir(settingsDirectory, { recursive: true, mode: 0o700 })
      const handle = await open(temporaryPath, 'wx', 0o600)
      try {
        await handle.writeFile(serialized, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }

      try {
        await rename(temporaryPath, settingsPath)
        // Existing files keep their previous mode after replacement on some platforms.
        await chmod(settingsPath, 0o600).catch(() => undefined)
      } finally {
        await unlink(temporaryPath).catch((error: unknown) => {
          if (!isNodeError(error, 'ENOENT')) throw error
        })
      }
    } catch (error) {
      if (error instanceof SettingsStoreError) throw error
      throw new SettingsStoreError(
        { code: 'SETTINGS_WRITE_FAILED', path: settingsPath },
        { cause: error },
      )
    }
  }

  private async getEncryptionCapabilities(
    operation: 'read' | 'save',
    selectedEncryption?: EncryptionAdapter,
  ): Promise<EncryptionCapabilities> {
    const encryption = selectedEncryption ?? (await this.resolveDependencies()).encryption

    try {
      if (encryption.getSelectedStorageBackend?.() === 'basic_text') {
        throw new SettingsStoreError({ code: 'ENCRYPTION_UNAVAILABLE', operation })
      }

      const asyncEncryption = getAsyncEncryptionAdapter(encryption)
      if (asyncEncryption === undefined) {
        throw new SettingsStoreError({ code: 'ENCRYPTION_UNAVAILABLE', operation })
      }

      let availabilityError: unknown
      let asyncAvailable = false
      if (asyncEncryption) {
        try {
          asyncAvailable = await asyncEncryption.isAsyncEncryptionAvailable()
        } catch (error) {
          availabilityError = error
        }
      }

      let syncAvailable = false
      try {
        syncAvailable = encryption.isEncryptionAvailable()
      } catch (error) {
        availabilityError ??= error
      }

      return {
        encryption,
        asyncEncryption,
        asyncAvailable,
        syncAvailable,
        ...(availabilityError === undefined ? {} : { availabilityError }),
      }
    } catch (error) {
      if (error instanceof SettingsStoreError) throw error
      throw new SettingsStoreError({ code: 'ENCRYPTION_UNAVAILABLE', operation }, { cause: error })
    }
  }

  private async encryptApiKey(
    apiKey: string,
    context: CredentialEncryptionContext,
  ): Promise<string> {
    const capabilities = await this.getEncryptionCapabilities('save')
    const { encryption, asyncEncryption } = capabilities

    if (asyncEncryption && !capabilities.asyncAvailable) {
      throw new SettingsStoreError(
        { code: 'ENCRYPTION_UNAVAILABLE', operation: 'save' },
        capabilities.availabilityError === undefined
          ? undefined
          : { cause: capabilities.availabilityError },
      )
    }
    if (!asyncEncryption && !capabilities.syncAvailable) {
      throw new SettingsStoreError(
        { code: 'ENCRYPTION_UNAVAILABLE', operation: 'save' },
        capabilities.availabilityError === undefined
          ? undefined
          : { cause: capabilities.availabilityError },
      )
    }

    try {
      const encrypted = asyncEncryption
        ? await asyncEncryption.encryptStringAsync(apiKey, context)
        : encryption.encryptString(apiKey)
      let prefix = asyncEncryption ? ASYNC_CREDENTIAL_CIPHERTEXT_PREFIX : ''
      if (encryption.ciphertextFormat === 'credential-broker-v1') {
        if (
          typeof encryption.credentialKeyId !== 'string' ||
          !BROKER_KEY_ID_PATTERN.test(encryption.credentialKeyId)
        ) {
          throw new Error('Credential broker key ID is unavailable.')
        }
        prefix = `${BROKER_CREDENTIAL_CIPHERTEXT_PREFIX}${encryption.credentialKeyId}:`
      }
      return this.encodeCiphertext(encrypted, prefix)
    } catch (error) {
      if (error instanceof SettingsStoreError) throw error
      throw new SettingsStoreError(
        { code: 'ENCRYPTION_FAILED', operation: 'encrypt' },
        { cause: error },
      )
    }
  }

  private async decryptApiKey(
    encoded: string,
    context: CredentialEncryptionContext,
  ): Promise<DecryptedApiKey> {
    let ciphertext: EncodedCiphertext
    try {
      ciphertext = this.decodeCiphertext(encoded)
    } catch (error) {
      throw new SettingsStoreError(
        { code: 'ENCRYPTION_FAILED', operation: 'decrypt' },
        { cause: error },
      )
    }

    const dependencies = await this.resolveDependencies()
    const primaryEncryption = dependencies.encryption

    const startupFailure = this.startupCredentialMigrationFailures.get(context.providerId)
    if (startupFailure?.ciphertext === encoded) {
      throw startupFailure.error
    }

    if (ciphertext.format === 'broker-v1') {
      if (
        primaryEncryption.ciphertextFormat !== 'credential-broker-v1' ||
        !primaryEncryption.credentialKeyId ||
        ciphertext.keyId !== primaryEncryption.credentialKeyId
      ) {
        throw new SettingsStoreError({ code: 'CREDENTIAL_REENTRY_REQUIRED' })
      }
      const capabilities = await this.getEncryptionCapabilities('read', primaryEncryption)
      if (!capabilities.asyncEncryption || !capabilities.asyncAvailable) {
        throw new SettingsStoreError(
          { code: 'ENCRYPTION_UNAVAILABLE', operation: 'read' },
          capabilities.availabilityError === undefined
            ? undefined
            : { cause: capabilities.availabilityError },
        )
      }
      try {
        const decrypted = await this.decryptAsync(
          capabilities.asyncEncryption,
          ciphertext.buffer,
          context,
        )
        if (!decrypted.shouldReEncrypt) return { value: decrypted.result }
        return {
          value: decrypted.result,
          replacementCiphertext: await this.encryptApiKey(decrypted.result, context),
        }
      } catch (error) {
        if (error instanceof SettingsStoreError) throw error
        throw new SettingsStoreError(
          { code: 'ENCRYPTION_FAILED', operation: 'decrypt' },
          { cause: error },
        )
      }
    }

    if (ciphertext.format === 'async-v1') {
      const sourceEncryption =
        primaryEncryption.ciphertextFormat === 'credential-broker-v1'
          ? dependencies.legacyEncryption
          : primaryEncryption
      if (!sourceEncryption) {
        throw new SettingsStoreError({ code: 'ENCRYPTION_UNAVAILABLE', operation: 'read' })
      }
      const capabilities = await this.getEncryptionCapabilities('read', sourceEncryption)
      const { asyncEncryption } = capabilities
      if (!asyncEncryption || !capabilities.asyncAvailable) {
        throw new SettingsStoreError(
          { code: 'ENCRYPTION_UNAVAILABLE', operation: 'read' },
          capabilities.availabilityError === undefined
            ? undefined
            : { cause: capabilities.availabilityError },
        )
      }

      try {
        const decrypted = await this.decryptAsync(asyncEncryption, ciphertext.buffer, context)
        if (!decrypted.shouldReEncrypt && sourceEncryption === primaryEncryption) {
          return { value: decrypted.result }
        }

        return {
          value: decrypted.result,
          replacementCiphertext: await this.encryptApiKey(decrypted.result, context),
        }
      } catch (error) {
        if (error instanceof SettingsStoreError) throw error
        throw new SettingsStoreError(
          { code: 'ENCRYPTION_FAILED', operation: 'decrypt' },
          { cause: error },
        )
      }
    }

    const legacyEncryption =
      primaryEncryption.ciphertextFormat === 'credential-broker-v1'
        ? dependencies.legacyEncryption
        : primaryEncryption
    if (!legacyEncryption) {
      throw new SettingsStoreError({ code: 'ENCRYPTION_UNAVAILABLE', operation: 'read' })
    }
    const capabilities = await this.getEncryptionCapabilities('read', legacyEncryption)
    const { encryption, asyncEncryption } = capabilities
    let asyncDecryptionError: unknown
    if (asyncEncryption && capabilities.asyncAvailable) {
      try {
        // OSCryptAsync keeps legacy providers available while stored data is migrated. Trying it
        // first lets Electron 43+ recover ciphertext written by the former synchronous API even
        // when that API is no longer available in the current process.
        const decrypted = await this.decryptAsync(asyncEncryption, ciphertext.buffer, context)
        let replacementCiphertext: string
        try {
          replacementCiphertext = await this.encryptApiKey(decrypted.result, context)
        } catch (error) {
          if (error instanceof SettingsStoreError) throw error
          throw new SettingsStoreError(
            { code: 'ENCRYPTION_FAILED', operation: 'encrypt' },
            { cause: error },
          )
        }
        return { value: decrypted.result, replacementCiphertext }
      } catch (error) {
        if (error instanceof SettingsStoreError) throw error
        asyncDecryptionError = error
      }
    }

    if (capabilities.syncAvailable) {
      let value: string
      try {
        value = encryption.decryptString(ciphertext.buffer)
      } catch (error) {
        if (error instanceof SettingsStoreError) throw error
        if (asyncDecryptionError !== undefined) {
          throw new SettingsStoreError(
            { code: 'CREDENTIAL_REENTRY_REQUIRED' },
            {
              cause: new AggregateError(
                [asyncDecryptionError, error],
                'Every available credential decryption backend rejected the legacy ciphertext.',
              ),
            },
          )
        }
        throw new SettingsStoreError(
          { code: 'ENCRYPTION_FAILED', operation: 'decrypt' },
          { cause: error },
        )
      }

      try {
        return {
          value,
          replacementCiphertext: await this.encryptApiKey(value, context),
        }
      } catch (error) {
        if (error instanceof SettingsStoreError) throw error
        throw new SettingsStoreError(
          { code: 'ENCRYPTION_FAILED', operation: 'encrypt' },
          { cause: error },
        )
      }
    }

    // Electron exposes both temporary Keychain failures and permanent decrypt failures as Promise
    // rejections without a stable typed code. Preserve the ciphertext and avoid claiming that key
    // re-entry is required unless every available backend was actually tried and rejected it.
    if (asyncDecryptionError !== undefined) {
      throw new SettingsStoreError(
        { code: 'ENCRYPTION_FAILED', operation: 'decrypt' },
        { cause: asyncDecryptionError },
      )
    }
    throw new SettingsStoreError(
      { code: 'ENCRYPTION_UNAVAILABLE', operation: 'read' },
      capabilities.availabilityError === undefined
        ? undefined
        : { cause: capabilities.availabilityError },
    )
  }

  private decodeCiphertext(encoded: string): EncodedCiphertext {
    const format = encoded.startsWith(BROKER_CREDENTIAL_CIPHERTEXT_PREFIX)
      ? 'broker-v1'
      : encoded.startsWith(ASYNC_CREDENTIAL_CIPHERTEXT_PREFIX)
        ? 'async-v1'
        : 'legacy-sync'
    if (
      format === 'legacy-sync' &&
      (encoded.startsWith(CREDENTIAL_CIPHERTEXT_MARKER) ||
        encoded.startsWith(BROKER_CREDENTIAL_CIPHERTEXT_MARKER))
    ) {
      throw new Error('The credential ciphertext format is not supported.')
    }

    let keyId: string | undefined
    let payload: string
    if (format === 'broker-v1') {
      const brokerPayload = encoded.slice(BROKER_CREDENTIAL_CIPHERTEXT_PREFIX.length)
      const separator = brokerPayload.indexOf(':')
      keyId = separator < 0 ? undefined : brokerPayload.slice(0, separator)
      if (!keyId || !BROKER_KEY_ID_PATTERN.test(keyId)) {
        throw new Error('The credential broker key ID is invalid.')
      }
      payload = brokerPayload.slice(separator + 1)
    } else {
      payload =
        format === 'async-v1' ? encoded.slice(ASYNC_CREDENTIAL_CIPHERTEXT_PREFIX.length) : encoded
    }
    const buffer = Buffer.from(payload, 'base64')
    if (buffer.length === 0 || buffer.toString('base64') !== payload) {
      throw new Error('The credential ciphertext encoding is invalid.')
    }
    return { buffer, format, ...(keyId ? { keyId } : {}) }
  }

  private async decryptAsync(
    encryption: CompleteAsyncEncryptionAdapter,
    ciphertext: Buffer,
    context: CredentialEncryptionContext,
  ): Promise<AsyncDecryptionResult> {
    const decrypted = await encryption.decryptStringAsync(ciphertext, context)
    if (typeof decrypted.result !== 'string' || typeof decrypted.shouldReEncrypt !== 'boolean') {
      throw new Error('The asynchronous decryption result was invalid.')
    }
    return decrypted
  }

  private encodeCiphertext(encrypted: Buffer, prefix: string): string {
    if (encrypted.length === 0) throw new Error('The encryption result was empty.')
    const encoded = `${prefix}${encrypted.toString('base64')}`
    if (encoded.length > MAX_PERSISTED_CREDENTIAL_CHARACTERS) {
      throw new SettingsStoreError({
        code: 'CREDENTIAL_TOO_LARGE',
        identifier: 'encrypted-api-key',
        maximumCharacters: MAX_PERSISTED_CREDENTIAL_CHARACTERS,
      })
    }
    return encoded
  }

  private async replaceEncryptedApiKey(
    providerId: string,
    expectedGeneration: number,
    expectedCiphertext: string,
    replacementCiphertext: string,
  ): Promise<boolean> {
    return this.mutate((settings) => {
      const provider = settings.providers.find((item) => item.id === providerId)
      if (!provider || provider.generation !== expectedGeneration) return false
      if (provider.encryptedApiKey === expectedCiphertext) {
        provider.encryptedApiKey = replacementCiphertext
        return true
      }
      // Concurrent key-rotation migrations preserve the credential generation. A provider edit
      // increments it, so only a ciphertext already migrated by a peer may be accepted here.
      return this.isPrimaryCiphertext(provider.encryptedApiKey)
    })
  }

  private async isPrimaryCiphertext(encoded: string | undefined): Promise<boolean> {
    if (!encoded) return false
    const { encryption } = await this.resolveDependencies()
    if (encryption.ciphertextFormat === 'credential-broker-v1') {
      try {
        const ciphertext = this.decodeCiphertext(encoded)
        return ciphertext.format === 'broker-v1' && ciphertext.keyId === encryption.credentialKeyId
      } catch {
        return false
      }
    }
    return encryption.isAsyncEncryptionAvailable
      ? encoded.startsWith(ASYNC_CREDENTIAL_CIPHERTEXT_PREFIX)
      : !encoded.startsWith(CREDENTIAL_CIPHERTEXT_MARKER) &&
          !encoded.startsWith(BROKER_CREDENTIAL_CIPHERTEXT_MARKER)
  }
}
