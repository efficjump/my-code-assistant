import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatServiceError } from '../src/main/services/service-error-messages'
import { TrustStore, TrustStoreError, workspaceFingerprint } from '../src/main/services/trust'

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('TrustStore', () => {
  it('persists explicit decisions across restarts without reusing trust after a move', async () => {
    const parent = await temporaryDirectory('code-assistant-trust-workspace-')
    const userData = await temporaryDirectory('code-assistant-trust-data-')
    const originalPath = join(parent, 'original')
    const movedPath = join(parent, 'moved')
    await mkdir(originalPath)

    const first = new TrustStore({ userDataPath: userData })
    const unknown = await first.getWorkspaceTrust(originalPath)
    expect(unknown).toMatchObject({ trusted: false, decided: false })

    const saved = await first.setWorkspaceTrust(originalPath, true)
    expect(saved).toMatchObject({ trusted: true, decided: true })
    expect(saved.fingerprint).toBe(workspaceFingerprint(saved.canonicalPath))

    const restarted = new TrustStore({ userDataPath: userData })
    await expect(restarted.getWorkspaceTrust(originalPath)).resolves.toMatchObject({
      trusted: true,
      decided: true,
      fingerprint: saved.fingerprint,
    })

    await rename(originalPath, movedPath)
    const moved = await restarted.getWorkspaceTrust(movedPath)
    expect(moved).toMatchObject({ trusted: false, decided: false })
    expect(moved.fingerprint).not.toBe(saved.fingerprint)
  })

  it('atomically replaces a versioned owner-only file and supports forgetting', async () => {
    const workspace = await temporaryDirectory('code-assistant-trust-workspace-')
    const userData = await temporaryDirectory('code-assistant-trust-data-')
    const store = new TrustStore({ userDataPath: userData })

    await store.setWorkspaceTrust(workspace, true)
    await store.setWorkspaceTrust(workspace, false)

    const trustPath = join(userData, 'workspace-trust.json')
    if (process.platform !== 'win32') {
      expect((await stat(trustPath)).mode & 0o777).toBe(0o600)
    }
    expect((await readdir(userData)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    await expect(
      new TrustStore({ userDataPath: userData }).getWorkspaceTrust(workspace),
    ).resolves.toMatchObject({ trusted: false, decided: true })

    await store.forgetWorkspace(workspace)
    await expect(store.getWorkspaceTrust(workspace)).resolves.toMatchObject({
      trusted: false,
      decided: false,
    })
  })

  it('wraps trust-file read and atomic write failures with localized descriptors', async () => {
    const workspace = await temporaryDirectory('code-assistant-trust-workspace-')
    const readData = await temporaryDirectory('code-assistant-trust-read-')
    await mkdir(join(readData, 'workspace-trust.json'))
    const readError = await new TrustStore({ userDataPath: readData })
      .getWorkspaceTrust(workspace)
      .catch((error: unknown) => error)
    expect(readError).toBeInstanceOf(TrustStoreError)
    expect(readError).toMatchObject({ code: 'TRUST_READ_FAILED' })
    expect((readError as TrustStoreError).cause).toBeInstanceOf(Error)
    expect(formatServiceError(readError, 'en')).toContain(
      'The workspace trust file could not be read',
    )

    const writeData = await temporaryDirectory('code-assistant-trust-write-')
    const writeStore = new TrustStore({ userDataPath: writeData })
    await writeStore.getWorkspaceTrust(workspace)
    await rm(writeData, { recursive: true })
    await writeFile(writeData, 'blocks directory recreation')
    const writeError = await writeStore
      .setWorkspaceTrust(workspace, true)
      .catch((error: unknown) => error)
    expect(writeError).toBeInstanceOf(TrustStoreError)
    expect(writeError).toMatchObject({ code: 'TRUST_WRITE_FAILED' })
    expect((writeError as TrustStoreError).cause).toBeInstanceOf(Error)
    expect(formatServiceError(writeError, 'ko')).toContain(
      '작업 공간 신뢰 파일을 저장하지 못했습니다',
    )
  })
})
