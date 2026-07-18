import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, opendir, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import type { BrowserWindow, OpenDialogOptions } from 'electron'
import type {
  FilePreview,
  ListWorkspaceInput,
  WorkspaceDirectoryPage,
  WorkspaceEntry,
  WorkspaceSummary,
} from '../../shared/contracts'
import {
  formatServiceErrorDescriptor,
  SERVICE_ERROR_MARKER,
  type WorkspaceErrorCode,
  type WorkspaceErrorDetail,
  type WorkspaceServiceErrorDescriptor,
} from './service-error-messages'

const DEFAULT_IGNORED_DIRECTORY_NAMES = [
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'node_modules',
  'bower_components',
  'coverage',
  'dist',
  'out',
  'release',
  'target',
] as const

const SENSITIVE_DIRECTORY_NAMES = new Set([
  '.aws',
  '.azure',
  '.docker',
  '.git',
  '.gnupg',
  '.hg',
  '.kube',
  '.ssh',
  '.svn',
])

const SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^\.envrc$/i,
  /^\.git-credentials$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^(?:credentials?|secrets?)(?:\..+)?$/i,
  /^id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?$/i,
  /^application_default_credentials\.json$/i,
  /^.*service[-_]?account.*\.json$/i,
  /\.(?:jks|key|keystore|p12|pfx|pem)$/i,
] as const

const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.a',
  '.avi',
  '.bin',
  '.bmp',
  '.class',
  '.db',
  '.dll',
  '.dmg',
  '.doc',
  '.docx',
  '.eot',
  '.exe',
  '.gif',
  '.gz',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.lockb',
  '.mov',
  '.mp3',
  '.mp4',
  '.o',
  '.otf',
  '.pdf',
  '.png',
  '.pyc',
  '.sqlite',
  '.sqlite3',
  '.tar',
  '.tgz',
  '.ttf',
  '.wav',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.xls',
  '.xlsx',
  '.zip',
])

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.c': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.css': 'css',
  '.go': 'go',
  '.graphql': 'graphql',
  '.h': 'c',
  '.hpp': 'cpp',
  '.html': 'html',
  '.java': 'java',
  '.js': 'javascript',
  '.json': 'json',
  '.jsx': 'javascript',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.md': 'markdown',
  '.php': 'php',
  '.proto': 'protobuf',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.scss': 'scss',
  '.sh': 'shell',
  '.sql': 'sql',
  '.svelte': 'svelte',
  '.swift': 'swift',
  '.toml': 'toml',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.vue': 'vue',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
}

const PRIVATE_KEY_MARKER = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/
const HIGH_CONFIDENCE_SECRET_PATTERNS = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
] as const
const SECRET_ASSIGNMENT_PATTERN =
  /(?:api[._-]?key|access[._-]?token|auth[._-]?token|client[._-]?secret|password)\s*["']?\s*[:=]\s*(?:"([^"\r\n]{24,})"|'([^'\r\n]{24,})'|([^\s,#}\]]{24,}))/gi
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export interface WorkspaceLimits {
  treeDepth: number
  treeEntries: number
  listDepth: number
  listFiles: number
  listEntries: number
  readBytes: number
  searchFiles: number
  searchMatches: number
  searchBytesPerFile: number
  searchLineCharacters: number
}

const DEFAULT_LIMITS: Readonly<WorkspaceLimits> = {
  treeDepth: 3,
  treeEntries: 600,
  listDepth: 16,
  listFiles: 2_000,
  listEntries: 10_000,
  readBytes: 256 * 1024,
  searchFiles: 500,
  searchMatches: 200,
  searchBytesPerFile: 256 * 1024,
  searchLineCharacters: 500,
}

export interface WorkspacePersistence {
  getLastWorkspace(): Promise<WorkspaceSummary | null>
  setLastWorkspace(workspace: WorkspaceSummary | null): Promise<void>
}

export interface WorkspaceServiceOptions {
  settingsStore?: WorkspacePersistence
  limits?: Partial<WorkspaceLimits>
  ignoredDirectoryNames?: Iterable<string>
  sensitiveFilePatterns?: readonly RegExp[]
  directoryPicker?: (owner?: BrowserWindow) => Promise<string | null>
}

export interface TreeOptions {
  path?: string
  maxDepth?: number
  maxEntries?: number
  signal?: AbortSignal
}

export interface ListFilesOptions {
  path?: string
  maxDepth?: number
  maxFiles?: number
  extensions?: readonly string[]
  signal?: AbortSignal
}

export interface ReadFileOptions {
  maxBytes?: number
  truncate?: boolean
  signal?: AbortSignal
}

export interface SearchTextOptions {
  path?: string
  caseSensitive?: boolean
  maxDepth?: number
  maxFiles?: number
  maxMatches?: number
  maxBytesPerFile?: number
  signal?: AbortSignal
}

export interface SearchTextMatch {
  path: string
  line: number
  column: number
  preview: string
}

export interface WorkspaceAgentHelpers {
  listFiles(options?: ListFilesOptions): Promise<string[]>
  readFile(path: string, options?: ReadFileOptions): Promise<FilePreview>
  searchText(query: string, options?: SearchTextOptions): Promise<SearchTextMatch[]>
}

export type { WorkspaceErrorCode } from './service-error-messages'

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode
  readonly descriptor: WorkspaceServiceErrorDescriptor
  readonly [SERVICE_ERROR_MARKER] = true as const

  constructor(detail: WorkspaceErrorDetail, options?: ErrorOptions)
  constructor(code: WorkspaceErrorCode, message: string, options?: ErrorOptions)
  constructor(
    detailOrCode: WorkspaceErrorDetail | WorkspaceErrorCode,
    messageOrOptions?: string | ErrorOptions,
    legacyOptions?: ErrorOptions,
  ) {
    const descriptor = (
      typeof detailOrCode === 'string'
        ? { service: 'workspace', code: detailOrCode }
        : { service: 'workspace', ...detailOrCode }
    ) as WorkspaceServiceErrorDescriptor
    const message =
      typeof messageOrOptions === 'string'
        ? messageOrOptions
        : formatServiceErrorDescriptor('ko', descriptor)
    const options = typeof messageOrOptions === 'string' ? legacyOptions : messageOrOptions
    super(message, options)
    this.name = 'WorkspaceError'
    this.code = descriptor.code
    this.descriptor = descriptor
  }
}

interface ResolvedWorkspacePath {
  canonicalPath: string
  displayPath: string
}

interface TraversalBudget {
  remaining: number
}

interface TraversedWorkspaceEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  canonicalPath: string
}

interface WorkspaceDirectoryCursor {
  scope: string
  kind: 'file' | 'directory'
  name: string
}

/**
 * Pure containment predicate for already canonicalized paths. It deliberately uses `relative`
 * instead of prefix matching, so `/project-copy` is not treated as a child of `/project`.
 */
export function isPathContained(canonicalRoot: string, canonicalCandidate: string): boolean {
  const root = resolve(canonicalRoot)
  const candidate = resolve(canonicalCandidate)
  const pathFromRoot = relative(root, candidate)
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  )
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function assertNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new WorkspaceError({ code: 'CANCELLED' }, { cause: signal.reason })
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`)
  }
  return value
}

function mergeLimits(overrides: Partial<WorkspaceLimits> = {}): WorkspaceLimits {
  return Object.fromEntries(
    Object.entries(DEFAULT_LIMITS).map(([name, defaultValue]) => [
      name,
      requirePositiveInteger(overrides[name as keyof WorkspaceLimits] ?? defaultValue, name),
    ]),
  ) as unknown as WorkspaceLimits
}

function cappedLimit(requested: number | undefined, configured: number, name: string): number {
  if (requested === undefined) return configured
  return Math.min(requirePositiveInteger(requested, name), configured)
}

function toPortablePath(path: string): string {
  return path.split(sep).join('/')
}

function compareWorkspaceEntryIdentity(
  left: Pick<TraversedWorkspaceEntry, 'kind' | 'name'>,
  right: Pick<TraversedWorkspaceEntry, 'kind' | 'name'>,
): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
  const localized = left.name.localeCompare(right.name)
  if (localized !== 0 || left.name === right.name) return localized
  return left.name < right.name ? -1 : 1
}

function insertSortedWorkspaceEntry(
  entries: TraversedWorkspaceEntry[],
  entry: TraversedWorkspaceEntry,
): void {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (compareWorkspaceEntryIdentity(entries[middle], entry) <= 0) low = middle + 1
    else high = middle
  }
  entries.splice(low, 0, entry)
}

function workspaceDirectoryCursorScope(root: string, displayDirectory: string): string {
  return createHash('sha256').update(root).update('\0').update(displayDirectory).digest('base64url')
}

function encodeWorkspaceDirectoryCursor(
  root: string,
  displayDirectory: string,
  entry: Pick<TraversedWorkspaceEntry, 'kind' | 'name'>,
): string {
  const cursor: WorkspaceDirectoryCursor = {
    scope: workspaceDirectoryCursorScope(root, displayDirectory),
    kind: entry.kind,
    name: entry.name,
  }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeWorkspaceDirectoryCursor(
  cursor: string,
  root: string,
  displayDirectory: string,
): WorkspaceDirectoryCursor {
  try {
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor) throw new Error('The cursor is not canonical.')
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('The cursor payload is not an object.')
    }
    const candidate = parsed as Partial<WorkspaceDirectoryCursor> & Record<string, unknown>
    if (
      Object.keys(candidate).length !== 3 ||
      typeof candidate.scope !== 'string' ||
      (candidate.kind !== 'directory' && candidate.kind !== 'file') ||
      typeof candidate.name !== 'string' ||
      candidate.name.length === 0 ||
      candidate.name.includes('\0')
    ) {
      throw new Error('The cursor payload is invalid.')
    }
    const decoded: WorkspaceDirectoryCursor = {
      scope: candidate.scope,
      kind: candidate.kind,
      name: candidate.name,
    }
    if (
      decoded.scope !== workspaceDirectoryCursorScope(root, displayDirectory) ||
      encodeWorkspaceDirectoryCursor(root, displayDirectory, decoded) !== cursor
    ) {
      throw new Error('The cursor belongs to another directory.')
    }
    return decoded
  } catch (error) {
    throw new RangeError('cursor must be a valid continuation returned for this directory.', {
      cause: error,
    })
  }
}

function pathSegments(path: string): string[] {
  return toPortablePath(path)
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
}

function hasSensitivePath(
  path: string,
  additionalPatterns: readonly RegExp[] = SENSITIVE_FILE_PATTERNS,
): boolean {
  const segments = pathSegments(path)
  if (segments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment.toLowerCase()))) return true

  const fileName = segments.at(-1) ?? ''
  return additionalPatterns.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(fileName)
  })
}

/** Shared path policy for any service that may expose workspace metadata outside the host. */
export function isSensitiveWorkspacePath(path: string): boolean {
  return hasSensitivePath(path)
}

function isLikelyBinary(fileName: string, bytes: Uint8Array): boolean {
  if (BINARY_EXTENSIONS.has(extname(fileName).toLowerCase())) return true

  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192))
  let controlCharacters = 0
  for (const byte of sample) {
    if (byte === 0) return true
    const allowedWhitespace = byte === 9 || byte === 10 || byte === 12 || byte === 13
    if (!allowedWhitespace && (byte < 32 || byte === 127)) controlCharacters += 1
  }

  if (sample.length > 0 && controlCharacters / sample.length > 0.1) return true

  try {
    UTF8_DECODER.decode(bytes)
    return false
  } catch {
    return true
  }
}

function trimIncompleteUtf8Suffix(bytes: Buffer): Buffer {
  for (let trim = 0; trim <= Math.min(3, bytes.length); trim += 1) {
    const candidate = trim === 0 ? bytes : bytes.subarray(0, bytes.length - trim)
    try {
      UTF8_DECODER.decode(candidate)
      return candidate
    } catch {
      // A UTF-8 code point can span at most four bytes; try the preceding boundary.
    }
  }
  return bytes
}

function inferLanguage(fileName: string): string {
  const lowerName = fileName.toLowerCase()
  if (lowerName === 'dockerfile') return 'dockerfile'
  if (lowerName === 'makefile') return 'makefile'
  return LANGUAGE_BY_EXTENSION[extname(lowerName)] ?? 'text'
}

function containsLikelySecret(content: string): boolean {
  if (PRIVATE_KEY_MARKER.test(content)) return true
  if (HIGH_CONFIDENCE_SECRET_PATTERNS.some((pattern) => pattern.test(content))) return true

  SECRET_ASSIGNMENT_PATTERN.lastIndex = 0
  for (const match of content.matchAll(SECRET_ASSIGNMENT_PATTERN)) {
    const value = (match[1] ?? match[2] ?? match[3]).toLocaleLowerCase()
    if (!/(?:example|placeholder|changeme|replace[_-]?me|your[_-])/.test(value)) return true
  }
  return false
}

/** Shared content policy for provider-bound workspace text. */
export function containsLikelyWorkspaceSecret(content: string): boolean {
  return containsLikelySecret(content)
}

function compactLine(line: string, matchIndex: number, maxCharacters: number): string {
  if (line.length <= maxCharacters) return line
  const halfWindow = Math.floor(maxCharacters / 2)
  const start = Math.max(0, Math.min(matchIndex - halfWindow, line.length - maxCharacters))
  const end = start + maxCharacters
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`
}

/** Secure workspace access shared by renderer IPC handlers and the agent runtime. */
export class WorkspaceService implements WorkspaceAgentHelpers {
  private readonly persistence: WorkspacePersistence | undefined
  private readonly limits: WorkspaceLimits
  private readonly ignoredDirectoryNames: ReadonlySet<string>
  private readonly sensitiveFilePatterns: readonly RegExp[]
  private readonly directoryPicker: (owner?: BrowserWindow) => Promise<string | null>
  private rootPath: string | null = null

  constructor(options: WorkspaceServiceOptions = {}) {
    this.persistence = options.settingsStore
    this.limits = mergeLimits(options.limits)
    this.ignoredDirectoryNames = new Set(
      [...(options.ignoredDirectoryNames ?? DEFAULT_IGNORED_DIRECTORY_NAMES)].map((name) =>
        name.toLocaleLowerCase(),
      ),
    )
    this.sensitiveFilePatterns = options.sensitiveFilePatterns ?? SENSITIVE_FILE_PATTERNS
    this.directoryPicker = options.directoryPicker ?? WorkspaceService.pickDirectoryWithElectron
  }

  getWorkspace(): WorkspaceSummary | null {
    return this.rootPath ? this.createSummary(this.rootPath) : null
  }

  isSensitivePath(path: string): boolean {
    return hasSensitivePath(path, this.sensitiveFilePatterns)
  }

  containsSensitiveContent(content: string): boolean {
    return containsLikelySecret(content)
  }

  async restoreLastWorkspace(): Promise<WorkspaceSummary | null> {
    const previousWorkspace = await this.persistence?.getLastWorkspace()
    if (!previousWorkspace) return null

    try {
      return await this.openWorkspace(previousWorkspace.path, false)
    } catch (error) {
      if (
        error instanceof WorkspaceError &&
        (error.code === 'PATH_NOT_FOUND' || error.code === 'NOT_A_DIRECTORY')
      ) {
        await this.persistence?.setLastWorkspace(null).catch(() => undefined)
        return null
      }
      throw error
    }
  }

  async chooseWorkspace(owner?: BrowserWindow): Promise<WorkspaceSummary | null> {
    const selectedPath = await this.directoryPicker(owner)
    return selectedPath ? this.openWorkspace(selectedPath) : null
  }

  async openWorkspace(path: string, persist = true): Promise<WorkspaceSummary> {
    if (!path || path.includes('\0')) {
      throw new WorkspaceError({ code: 'PATH_NOT_FOUND', identifier: 'path-required' })
    }

    let canonicalRoot: string
    try {
      canonicalRoot = await realpath(resolve(path))
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw new WorkspaceError(
          { code: 'PATH_NOT_FOUND', identifier: 'workspace', path },
          { cause: error },
        )
      }
      throw error
    }

    if (hasSensitivePath(canonicalRoot, this.sensitiveFilePatterns)) {
      throw new WorkspaceError({
        code: 'SENSITIVE_FILE',
        identifier: 'workspace-root',
        path: canonicalRoot,
      })
    }

    const rootStats = await stat(canonicalRoot)
    if (!rootStats.isDirectory()) {
      throw new WorkspaceError({ code: 'NOT_A_DIRECTORY', identifier: 'workspace', path })
    }

    const summary = this.createSummary(canonicalRoot)
    if (persist) await this.persistence?.setLastWorkspace(summary)
    this.rootPath = canonicalRoot
    return summary
  }

  async clearWorkspace(): Promise<void> {
    await this.persistence?.setLastWorkspace(null)
    this.rootPath = null
  }

  async listWorkspace(input: ListWorkspaceInput): Promise<WorkspaceDirectoryPage> {
    const root = this.requireRoot()
    const start = await this.resolveWithinRoot(input.path ?? '', undefined, root)
    const startStats = await stat(start.canonicalPath)
    if (!startStats.isDirectory()) {
      throw new WorkspaceError({
        code: 'NOT_A_DIRECTORY',
        identifier: 'path',
        path: start.displayPath,
      })
    }

    this.assertNotSensitive(start.displayPath, relative(root, start.canonicalPath))
    const cursor = input.cursor
      ? decodeWorkspaceDirectoryCursor(input.cursor, root, start.displayPath)
      : null
    const page = await this.listVisibleDirectoryEntriesPage(
      root,
      start.canonicalPath,
      start.displayPath,
      cursor,
      this.limits.treeEntries,
    )
    const selected = page.entries
    const complete = !page.hasMore
    const entries: WorkspaceEntry[] = []

    for (const entry of selected) {
      if (entry.kind === 'file') {
        entries.push({ name: entry.name, path: entry.path, kind: 'file' })
        continue
      }
      entries.push({
        name: entry.name,
        path: entry.path,
        kind: 'directory',
        hasChildren: await this.directoryHasVisibleChild(root, entry.canonicalPath, entry.path),
      })
    }

    const lastEntry = selected.at(-1)
    return {
      entries,
      complete,
      nextCursor:
        complete || !lastEntry
          ? null
          : encodeWorkspaceDirectoryCursor(root, start.displayPath, lastEntry),
    }
  }

  async listTree(options: TreeOptions = {}): Promise<WorkspaceEntry[]> {
    assertNotAborted(options.signal)
    const root = this.requireRoot()
    const maxDepth = cappedLimit(options.maxDepth, this.limits.treeDepth, 'maxDepth')
    const maxEntries = cappedLimit(options.maxEntries, this.limits.treeEntries, 'maxEntries')
    const start = await this.resolveWithinRoot(options.path ?? '', options.signal, root)
    const startStats = await stat(start.canonicalPath)
    if (!startStats.isDirectory()) {
      throw new WorkspaceError({
        code: 'NOT_A_DIRECTORY',
        identifier: 'path',
        path: start.displayPath,
      })
    }

    this.assertNotSensitive(start.displayPath, relative(root, start.canonicalPath))
    const seenDirectories = new Set<string>([start.canonicalPath])
    return this.buildTree(
      root,
      start.canonicalPath,
      start.displayPath,
      1,
      maxDepth,
      { remaining: maxEntries },
      seenDirectories,
      options.signal,
    )
  }

  async listFiles(options: ListFilesOptions = {}): Promise<string[]> {
    assertNotAborted(options.signal)
    const root = this.requireRoot()
    const maxDepth = cappedLimit(options.maxDepth, this.limits.listDepth, 'maxDepth')
    const maxFiles = cappedLimit(options.maxFiles, this.limits.listFiles, 'maxFiles')
    const extensions = options.extensions
      ? new Set(options.extensions.map((extension) => extension.toLowerCase()))
      : null
    const start = await this.resolveWithinRoot(options.path ?? '', options.signal, root)
    const startStats = await stat(start.canonicalPath)
    if (startStats.isFile()) {
      this.assertNotSensitive(start.displayPath, relative(root, start.canonicalPath))
      if (
        extensions &&
        ![...extensions].some((extension) => start.displayPath.toLowerCase().endsWith(extension))
      ) {
        return []
      }
      return [start.displayPath]
    }
    if (!startStats.isDirectory()) {
      throw new WorkspaceError({
        code: 'NOT_A_DIRECTORY',
        identifier: 'path',
        path: start.displayPath,
      })
    }

    this.assertNotSensitive(start.displayPath, relative(root, start.canonicalPath))
    const files: string[] = []
    const seenDirectories = new Set<string>([start.canonicalPath])
    let visitedEntries = 0

    const visit = async (
      directoryPath: string,
      displayDirectory: string,
      depth: number,
    ): Promise<void> => {
      assertNotAborted(options.signal)
      if (
        depth > maxDepth ||
        files.length >= maxFiles ||
        visitedEntries >= this.limits.listEntries
      ) {
        return
      }

      const entries = await this.readDirectoryNames(
        directoryPath,
        this.limits.listEntries - visitedEntries,
        options.signal,
      )
      for (const name of entries) {
        assertNotAborted(options.signal)
        if (files.length >= maxFiles || visitedEntries >= this.limits.listEntries) break
        visitedEntries += 1
        if (this.ignoredDirectoryNames.has(name.toLocaleLowerCase())) continue

        const lexicalPath = resolve(directoryPath, name)
        const displayPath = displayDirectory ? `${displayDirectory}/${name}` : name
        const inspected = await this.inspectTraversalPath(
          root,
          lexicalPath,
          displayPath,
          options.signal,
        )
        if (!inspected) continue

        if (inspected.kind === 'directory') {
          if (depth < maxDepth && !seenDirectories.has(inspected.canonicalPath)) {
            seenDirectories.add(inspected.canonicalPath)
            await visit(inspected.canonicalPath, displayPath, depth + 1)
          }
        } else if (
          !extensions ||
          [...extensions].some((extension) => name.toLowerCase().endsWith(extension))
        ) {
          files.push(displayPath)
        }
      }
    }

    await visit(start.canonicalPath, start.displayPath, 1)
    return files.sort((left, right) => left.localeCompare(right))
  }

  async readFile(path: string, options: ReadFileOptions = {}): Promise<FilePreview> {
    assertNotAborted(options.signal)
    const root = this.requireRoot()
    const maxBytes = cappedLimit(options.maxBytes, this.limits.readBytes, 'maxBytes')
    const resolvedPath = await this.resolveWithinRoot(path, options.signal, root)
    const canonicalRelativePath = relative(root, resolvedPath.canonicalPath)
    this.assertNotSensitive(resolvedPath.displayPath, canonicalRelativePath)

    if (
      BINARY_EXTENSIONS.has(extname(resolvedPath.displayPath).toLowerCase()) ||
      BINARY_EXTENSIONS.has(extname(resolvedPath.canonicalPath).toLowerCase())
    ) {
      throw new WorkspaceError({ code: 'BINARY_FILE', path: resolvedPath.displayPath })
    }

    const handle = await open(
      resolvedPath.canonicalPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    )
    let bytes: Buffer
    let truncated: boolean
    try {
      assertNotAborted(options.signal)
      const fileStats = await handle.stat()
      if (!fileStats.isFile()) {
        throw new WorkspaceError({ code: 'NOT_A_FILE', path: resolvedPath.displayPath })
      }

      const postOpenCanonicalPath = await realpath(resolvedPath.canonicalPath)
      if (!isPathContained(root, postOpenCanonicalPath)) {
        throw new WorkspaceError({
          code: 'OUTSIDE_WORKSPACE',
          identifier: 'changed-during-read',
          path: resolvedPath.displayPath,
        })
      }
      this.assertNotSensitive(resolvedPath.displayPath, relative(root, postOpenCanonicalPath))
      const postOpenPathStats = await stat(postOpenCanonicalPath)
      if (fileStats.dev !== postOpenPathStats.dev || fileStats.ino !== postOpenPathStats.ino) {
        throw new WorkspaceError({
          code: 'PATH_NOT_FOUND',
          identifier: 'replaced-during-read',
          path: resolvedPath.displayPath,
        })
      }

      const readLength = Math.min(fileStats.size, maxBytes + 1)
      bytes = Buffer.alloc(readLength)
      let bytesRead = 0
      while (bytesRead < readLength) {
        assertNotAborted(options.signal)
        const result = await handle.read(bytes, bytesRead, readLength - bytesRead, bytesRead)
        if (result.bytesRead === 0) break
        bytesRead += result.bytesRead
      }
      bytes = bytes.subarray(0, bytesRead)
      truncated = fileStats.size > maxBytes || bytes.length > maxBytes
      if (truncated) bytes = trimIncompleteUtf8Suffix(bytes.subarray(0, maxBytes))
    } finally {
      await handle.close()
    }

    if (truncated && options.truncate === false) {
      throw new WorkspaceError({
        code: 'FILE_TOO_LARGE',
        path: resolvedPath.displayPath,
        maximumBytes: maxBytes,
      })
    }
    if (isLikelyBinary(resolvedPath.displayPath, bytes)) {
      throw new WorkspaceError({ code: 'BINARY_FILE', path: resolvedPath.displayPath })
    }

    let content = UTF8_DECODER.decode(bytes)
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
    if (containsLikelySecret(content)) {
      throw new WorkspaceError({
        code: 'SENSITIVE_FILE',
        identifier: 'content',
        path: resolvedPath.displayPath,
      })
    }

    return {
      name: basename(resolvedPath.displayPath),
      path: resolvedPath.displayPath,
      language: inferLanguage(resolvedPath.displayPath),
      content,
      truncated,
      sha256: truncated ? null : createHash('sha256').update(bytes).digest('hex'),
    }
  }

  async readTextFile(path: string, options: ReadFileOptions = {}): Promise<FilePreview> {
    return this.readFile(path, options)
  }

  async searchText(query: string, options: SearchTextOptions = {}): Promise<SearchTextMatch[]> {
    assertNotAborted(options.signal)
    if (!query || query.length > 1_000 || query.includes('\0')) {
      throw new WorkspaceError({
        code: 'INVALID_QUERY',
        minimumCharacters: 1,
        maximumCharacters: 1_000,
      })
    }

    const maxFiles = cappedLimit(options.maxFiles, this.limits.searchFiles, 'maxFiles')
    const maxMatches = cappedLimit(options.maxMatches, this.limits.searchMatches, 'maxMatches')
    const maxBytesPerFile = cappedLimit(
      options.maxBytesPerFile,
      this.limits.searchBytesPerFile,
      'maxBytesPerFile',
    )
    const files = await this.listFiles({
      path: options.path,
      maxDepth: options.maxDepth,
      maxFiles,
      signal: options.signal,
    })
    const needle = options.caseSensitive ? query : query.toLocaleLowerCase()
    const matches: SearchTextMatch[] = []

    for (const path of files) {
      assertNotAborted(options.signal)
      if (matches.length >= maxMatches) break
      let preview: FilePreview
      try {
        preview = await this.readFile(path, { maxBytes: maxBytesPerFile, signal: options.signal })
      } catch (error) {
        if (
          error instanceof WorkspaceError &&
          ['BINARY_FILE', 'SENSITIVE_FILE', 'PATH_NOT_FOUND'].includes(error.code)
        ) {
          continue
        }
        throw error
      }

      const lines = preview.content.split(/\r?\n/)
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex]
        const haystack = options.caseSensitive ? line : line.toLocaleLowerCase()
        const matchIndex = haystack.indexOf(needle)
        if (matchIndex < 0) continue

        matches.push({
          path,
          line: lineIndex + 1,
          column: matchIndex + 1,
          preview: compactLine(line, matchIndex, this.limits.searchLineCharacters),
        })
        if (matches.length >= maxMatches) break
      }
    }

    return matches
  }

  private static async pickDirectoryWithElectron(owner?: BrowserWindow): Promise<string | null> {
    const { dialog } = await import('electron')
    const dialogOptions: OpenDialogOptions = {
      title: 'Open workspace',
      properties: ['openDirectory'],
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }

  private requireRoot(): string {
    if (!this.rootPath) {
      throw new WorkspaceError({ code: 'NO_WORKSPACE' })
    }
    return this.rootPath
  }

  private createSummary(rootPath: string): WorkspaceSummary {
    return { name: basename(rootPath), path: rootPath }
  }

  private async resolveWithinRoot(
    requestedPath: string,
    signal?: AbortSignal,
    expectedRoot?: string,
  ): Promise<ResolvedWorkspacePath> {
    assertNotAborted(signal)
    const root = expectedRoot ?? this.requireRoot()
    if (requestedPath.includes('\0')) {
      throw new WorkspaceError({ code: 'OUTSIDE_WORKSPACE', identifier: 'invalid-path' })
    }

    const lexicalPath = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(root, requestedPath || '.')
    if (!isPathContained(root, lexicalPath)) {
      throw new WorkspaceError({
        code: 'OUTSIDE_WORKSPACE',
        identifier: 'path',
        path: requestedPath,
      })
    }

    let canonicalPath: string
    try {
      canonicalPath = await realpath(lexicalPath)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw new WorkspaceError(
          { code: 'PATH_NOT_FOUND', identifier: 'path', path: requestedPath },
          { cause: error },
        )
      }
      throw error
    }
    assertNotAborted(signal)

    if (!isPathContained(root, canonicalPath)) {
      throw new WorkspaceError({
        code: 'OUTSIDE_WORKSPACE',
        identifier: 'symlink',
        path: requestedPath,
      })
    }

    const displayPath = toPortablePath(relative(root, lexicalPath))
    return { canonicalPath, displayPath }
  }

  private assertNotSensitive(displayPath: string, canonicalRelativePath: string): void {
    if (
      hasSensitivePath(displayPath, this.sensitiveFilePatterns) ||
      hasSensitivePath(canonicalRelativePath, this.sensitiveFilePatterns)
    ) {
      throw new WorkspaceError({
        code: 'SENSITIVE_FILE',
        identifier: 'path',
        path: displayPath,
      })
    }
  }

  private async inspectTraversalPath(
    root: string,
    lexicalPath: string,
    displayPath: string,
    signal?: AbortSignal,
  ): Promise<{ canonicalPath: string; kind: 'file' | 'directory' } | null> {
    assertNotAborted(signal)
    if (hasSensitivePath(displayPath, this.sensitiveFilePatterns)) return null

    let canonicalPath: string
    try {
      canonicalPath = await realpath(lexicalPath)
    } catch (error) {
      if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) return null
      throw error
    }
    assertNotAborted(signal)

    if (!isPathContained(root, canonicalPath)) return null
    if (hasSensitivePath(relative(root, canonicalPath), this.sensitiveFilePatterns)) return null

    let pathStats: Awaited<ReturnType<typeof stat>>
    try {
      pathStats = await stat(canonicalPath)
    } catch (error) {
      if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) return null
      throw error
    }
    assertNotAborted(signal)

    if (pathStats.isDirectory()) return { canonicalPath, kind: 'directory' }
    if (pathStats.isFile()) return { canonicalPath, kind: 'file' }
    return null
  }

  private async listVisibleDirectoryEntriesPage(
    root: string,
    directoryPath: string,
    displayDirectory: string,
    after: WorkspaceDirectoryCursor | null,
    maximumEntries: number,
    signal?: AbortSignal,
  ): Promise<{ entries: TraversedWorkspaceEntry[]; hasMore: boolean }> {
    assertNotAborted(signal)
    const directory = await opendir(directoryPath)
    const entries: TraversedWorkspaceEntry[] = []
    let hasMore = false
    for await (const directoryEntry of directory) {
      assertNotAborted(signal)
      const name = directoryEntry.name
      if (this.ignoredDirectoryNames.has(name.toLocaleLowerCase())) continue
      const displayPath = displayDirectory ? `${displayDirectory}/${name}` : name
      const inspected = await this.inspectTraversalPath(
        root,
        resolve(directoryPath, name),
        displayPath,
        signal,
      )
      if (!inspected) continue
      const entry: TraversedWorkspaceEntry = {
        name,
        path: displayPath,
        kind: inspected.kind,
        canonicalPath: inspected.canonicalPath,
      }
      if (after && compareWorkspaceEntryIdentity(entry, after) <= 0) continue
      insertSortedWorkspaceEntry(entries, entry)
      if (entries.length > maximumEntries) {
        entries.pop()
        hasMore = true
      }
    }
    return { entries, hasMore }
  }

  private async directoryHasVisibleChild(
    root: string,
    directoryPath: string,
    displayDirectory: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    assertNotAborted(signal)
    const directory = await opendir(directoryPath)
    for await (const entry of directory) {
      assertNotAborted(signal)
      if (this.ignoredDirectoryNames.has(entry.name.toLocaleLowerCase())) continue
      const displayPath = displayDirectory ? `${displayDirectory}/${entry.name}` : entry.name
      const inspected = await this.inspectTraversalPath(
        root,
        resolve(directoryPath, entry.name),
        displayPath,
        signal,
      )
      if (inspected) return true
    }
    return false
  }

  private async buildTree(
    root: string,
    directoryPath: string,
    displayDirectory: string,
    depth: number,
    maxDepth: number,
    budget: TraversalBudget,
    seenDirectories: Set<string>,
    signal?: AbortSignal,
  ): Promise<WorkspaceEntry[]> {
    assertNotAborted(signal)
    if (budget.remaining <= 0) return []
    const names = await this.readDirectoryNames(directoryPath, budget.remaining, signal)
    const entries: WorkspaceEntry[] = []

    for (const name of names) {
      assertNotAborted(signal)
      if (budget.remaining <= 0) break
      if (this.ignoredDirectoryNames.has(name.toLocaleLowerCase())) continue

      const displayPath = displayDirectory ? `${displayDirectory}/${name}` : name
      const inspected = await this.inspectTraversalPath(
        root,
        resolve(directoryPath, name),
        displayPath,
        signal,
      )
      if (!inspected) continue

      budget.remaining -= 1
      const entry: WorkspaceEntry =
        inspected.kind === 'directory'
          ? {
              name,
              path: displayPath,
              kind: 'directory',
              hasChildren: await this.directoryHasVisibleChild(
                root,
                inspected.canonicalPath,
                displayPath,
                signal,
              ),
            }
          : { name, path: displayPath, kind: 'file' }

      if (
        inspected.kind === 'directory' &&
        depth < maxDepth &&
        !seenDirectories.has(inspected.canonicalPath)
      ) {
        seenDirectories.add(inspected.canonicalPath)
        const children = await this.buildTree(
          root,
          inspected.canonicalPath,
          displayPath,
          depth + 1,
          maxDepth,
          budget,
          seenDirectories,
          signal,
        )
        if (children.length > 0) entry.children = children
      }
      entries.push(entry)
    }

    return entries.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name)
    })
  }

  private async readDirectoryNames(
    path: string,
    maxEntries?: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    assertNotAborted(signal)
    const directory = await opendir(path)
    const names: string[] = []
    for await (const entry of directory) {
      assertNotAborted(signal)
      names.push(entry.name)
      if (maxEntries !== undefined && names.length >= maxEntries) break
    }
    return names.sort((left, right) => left.localeCompare(right))
  }
}
