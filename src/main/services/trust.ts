import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import {
  formatServiceErrorDescriptor,
  SERVICE_ERROR_MARKER,
  type TrustServiceErrorDescriptor,
  type TrustStoreErrorCode,
  type TrustStoreErrorDetail,
} from './service-error-messages'

const TRUST_STORE_VERSION = 1 as const

const trustEntrySchema = z.object({
  canonicalPath: z.string().min(1).max(16_384),
  trusted: z.boolean(),
  updatedAt: z.string().datetime(),
})

const persistedTrustSchema = z.object({
  version: z.literal(TRUST_STORE_VERSION),
  workspaces: z.record(z.string().length(64), trustEntrySchema),
})

type PersistedTrust = z.infer<typeof persistedTrustSchema>

export interface WorkspaceTrust {
  canonicalPath: string
  fingerprint: string
  trusted: boolean
  decided: boolean
  updatedAt: string | null
}

export interface TrustStoreOptions {
  /** Defaults to Electron's userData directory. */
  userDataPath?: string
  fileName?: string
  now?: () => Date
}

export type { TrustStoreErrorCode } from './service-error-messages'

export class TrustStoreError extends Error {
  readonly code: TrustStoreErrorCode
  readonly descriptor: TrustServiceErrorDescriptor
  readonly [SERVICE_ERROR_MARKER] = true as const

  constructor(detail: TrustStoreErrorDetail, options?: ErrorOptions)
  constructor(code: TrustStoreErrorCode, message: string, options?: ErrorOptions)
  constructor(
    detailOrCode: TrustStoreErrorDetail | TrustStoreErrorCode,
    messageOrOptions?: string | ErrorOptions,
    legacyOptions?: ErrorOptions,
  ) {
    const descriptor = (
      typeof detailOrCode === 'string'
        ? { service: 'trust', code: detailOrCode }
        : { service: 'trust', ...detailOrCode }
    ) as TrustServiceErrorDescriptor
    const message =
      typeof messageOrOptions === 'string'
        ? messageOrOptions
        : formatServiceErrorDescriptor('ko', descriptor)
    const options = typeof messageOrOptions === 'string' ? legacyOptions : messageOrOptions
    super(message, options)
    this.name = 'TrustStoreError'
    this.code = descriptor.code
    this.descriptor = descriptor
  }
}

function emptyTrust(): PersistedTrust {
  return { version: TRUST_STORE_VERSION, workspaces: {} }
}

function cloneTrust(source: PersistedTrust): PersistedTrust {
  return {
    version: source.version,
    workspaces: Object.fromEntries(
      Object.entries(source.workspaces).map(([fingerprint, entry]) => [fingerprint, { ...entry }]),
    ),
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function canonicalizeWorkspace(workspacePath: string): Promise<string> {
  if (!workspacePath || workspacePath.includes('\0')) {
    throw new TrustStoreError({ code: 'INVALID_WORKSPACE', identifier: 'path-required' })
  }

  try {
    const canonicalPath = await realpath(resolve(workspacePath))
    if (!(await stat(canonicalPath)).isDirectory()) {
      throw new TrustStoreError({
        code: 'INVALID_WORKSPACE',
        identifier: 'not-directory',
        path: canonicalPath,
      })
    }
    return canonicalPath
  } catch (error) {
    if (error instanceof TrustStoreError) throw error
    throw new TrustStoreError(
      { code: 'INVALID_WORKSPACE', identifier: 'canonicalize', path: workspacePath },
      { cause: error },
    )
  }
}

/**
 * Trust is scoped to the canonical path, rather than a display name or repository metadata.
 * Moving a repository therefore produces a new fingerprint and a new, untrusted decision.
 */
export function workspaceFingerprint(canonicalPath: string): string {
  return createHash('sha256').update('workspace-trust\0').update(canonicalPath).digest('hex')
}

export class TrustStore {
  private readonly options: TrustStoreOptions
  private statePromise: Promise<PersistedTrust> | undefined
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(options: TrustStoreOptions = {}) {
    this.options = options
  }

  async getWorkspaceTrust(workspacePath: string): Promise<WorkspaceTrust> {
    const canonicalPath = await canonicalizeWorkspace(workspacePath)
    const fingerprint = workspaceFingerprint(canonicalPath)
    const entry = (await this.load()).workspaces[fingerprint]

    // The path check also makes a hash collision fail closed.
    if (!entry || entry.canonicalPath !== canonicalPath) {
      return {
        canonicalPath,
        fingerprint,
        trusted: false,
        decided: false,
        updatedAt: null,
      }
    }

    return {
      canonicalPath,
      fingerprint,
      trusted: entry.trusted,
      decided: true,
      updatedAt: entry.updatedAt,
    }
  }

  async isTrusted(workspacePath: string): Promise<boolean> {
    return (await this.getWorkspaceTrust(workspacePath)).trusted
  }

  async setWorkspaceTrust(workspacePath: string, trusted: boolean): Promise<WorkspaceTrust> {
    const canonicalPath = await canonicalizeWorkspace(workspacePath)
    const fingerprint = workspaceFingerprint(canonicalPath)
    const updatedAt = (this.options.now ?? (() => new Date()))().toISOString()

    return this.mutate(async (draft) => {
      draft.workspaces[fingerprint] = { canonicalPath, trusted, updatedAt }
      return { canonicalPath, fingerprint, trusted, decided: true, updatedAt }
    })
  }

  async forgetWorkspace(workspacePath: string): Promise<WorkspaceTrust> {
    const canonicalPath = await canonicalizeWorkspace(workspacePath)
    const fingerprint = workspaceFingerprint(canonicalPath)

    return this.mutate(async (draft) => {
      delete draft.workspaces[fingerprint]
      return { canonicalPath, fingerprint, trusted: false, decided: false, updatedAt: null }
    })
  }

  /** Clears the in-memory snapshot so external changes can be observed on the next read. */
  reload(): void {
    this.statePromise = undefined
  }

  private async userDataPath(): Promise<string> {
    if (this.options.userDataPath) return this.options.userDataPath
    const { app } = await import('electron')
    return app.getPath('userData')
  }

  private async trustPath(): Promise<string> {
    return join(await this.userDataPath(), this.options.fileName ?? 'workspace-trust.json')
  }

  private load(): Promise<PersistedTrust> {
    this.statePromise ??= this.readFromDisk()
    return this.statePromise
  }

  private async readFromDisk(): Promise<PersistedTrust> {
    const trustPath = await this.trustPath()
    let source: string
    try {
      source = await readFile(trustPath, 'utf8')
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return emptyTrust()
      throw new TrustStoreError({ code: 'TRUST_READ_FAILED', path: trustPath }, { cause: error })
    }

    try {
      return persistedTrustSchema.parse(JSON.parse(source))
    } catch {
      const backupPath = `${trustPath}.corrupt-${Date.now()}`
      try {
        await rename(trustPath, backupPath)
        await chmod(backupPath, 0o600).catch(() => undefined)
      } catch (backupError) {
        throw new TrustStoreError(
          { code: 'INVALID_TRUST_FILE', identifier: 'backup-failed', path: trustPath },
          { cause: backupError },
        )
      }
      return emptyTrust()
    }
  }

  private mutate<T>(mutation: (draft: PersistedTrust) => Promise<T> | T): Promise<T> {
    const operation = this.mutationTail.then(async () => {
      const draft = cloneTrust(await this.load())
      const result = await mutation(draft)
      await this.writeToDisk(draft)
      this.statePromise = Promise.resolve(draft)
      return result
    })

    this.mutationTail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async writeToDisk(state: PersistedTrust): Promise<void> {
    const directoryPath = await this.userDataPath()
    const trustPath = await this.trustPath()
    const temporaryPath = `${trustPath}.${randomUUID()}.tmp`

    try {
      await mkdir(directoryPath, { recursive: true, mode: 0o700 })
      const handle = await open(temporaryPath, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }

      try {
        await rename(temporaryPath, trustPath)
        await chmod(trustPath, 0o600)
        // Persist the directory entry where the platform supports directory fsync.
        const directoryHandle = await open(directoryPath, 'r').catch(() => null)
        if (directoryHandle) {
          try {
            await directoryHandle.sync().catch(() => undefined)
          } finally {
            await directoryHandle.close()
          }
        }
      } finally {
        await unlink(temporaryPath).catch((error: unknown) => {
          if (!isNodeError(error, 'ENOENT')) throw error
        })
      }
    } catch (error) {
      if (error instanceof TrustStoreError) throw error
      throw new TrustStoreError({ code: 'TRUST_WRITE_FAILED', path: trustPath }, { cause: error })
    }
  }
}
