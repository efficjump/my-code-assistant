import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { WorkspaceTrust } from './trust'
import { isPathContained, type WorkspaceError, type WorkspaceService } from './workspace'

const DEFAULT_PER_FILE_BYTES = 32 * 1024
const DEFAULT_TOTAL_BYTES = 128 * 1024
const DEFAULT_SOURCE_GROUPS: readonly InstructionSourceGroup[] = [
  {
    candidates: [
      { fileName: 'AGENTS.override.md', kind: 'agents-override' },
      { fileName: 'AGENTS.md', kind: 'agents' },
    ],
  },
]

export type InstructionKind = string
export type InstructionStatus = 'loaded' | 'sensitive' | 'oversized' | 'malformed'

export interface InstructionSource {
  fileName: string
  kind: InstructionKind
}

/** Candidates are checked in order; the first file present in each group wins. */
export interface InstructionSourceGroup {
  candidates: readonly InstructionSource[]
}

export interface InstructionLayer {
  path: string
  directory: string
  kind: InstructionKind
  status: InstructionStatus
  precedence: number
  bytes: number | null
  content: string | null
  message: string | null
}

export interface InstructionBundle {
  workspacePath: string | null
  trusted: boolean
  layers: InstructionLayer[]
  totalBytes: number
}

export interface InstructionTrustReader {
  getWorkspaceTrust(workspacePath: string): Promise<WorkspaceTrust>
}

export interface InstructionServiceOptions {
  perFileBytes?: number
  totalBytes?: number
  sourceGroups?: readonly InstructionSourceGroup[]
}

interface ReadOutcome {
  status: InstructionStatus
  bytes: number | null
  content: string | null
  message: string | null
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive integer.`)
  }
  return resolved
}

function normalizeSourceGroups(
  groups: readonly InstructionSourceGroup[] | undefined,
): readonly InstructionSourceGroup[] {
  const selected = groups ?? DEFAULT_SOURCE_GROUPS
  return selected.map((group) => {
    if (group.candidates.length === 0) {
      throw new RangeError('Instruction source groups must contain at least one candidate.')
    }
    const candidates = group.candidates.map(({ fileName, kind }) => {
      const normalizedFileName = fileName.trim()
      const normalizedKind = kind.trim()
      if (
        !normalizedFileName ||
        normalizedFileName === '.' ||
        normalizedFileName === '..' ||
        normalizedFileName.includes('/') ||
        normalizedFileName.includes('\\')
      ) {
        throw new RangeError('Instruction source file names must be workspace-local file names.')
      }
      if (!/^[a-z][a-z0-9-]{0,79}$/.test(normalizedKind)) {
        throw new RangeError('Instruction source kinds must be stable lowercase identifiers.')
      }
      return Object.freeze({ fileName: normalizedFileName, kind: normalizedKind })
    })
    return Object.freeze({ candidates })
  })
}

function isWorkspaceError(error: unknown, code: WorkspaceError['code']): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function portablePath(path: string): string {
  return path.split(sep).join('/')
}

function joinWorkspacePath(directory: string, fileName: string): string {
  return directory ? `${directory}/${fileName}` : fileName
}

function parentDirectories(directory: string): string[] {
  const segments = directory.split('/').filter(Boolean)
  return Array.from({ length: segments.length + 1 }, (_, index) =>
    segments.slice(0, index).join('/'),
  )
}

/**
 * Loads repository instructions only after an explicit trust decision. Layers are returned from
 * broadest to most specific; callers can preserve this provenance when assembling a model prompt.
 */
export class InstructionService {
  private readonly perFileBytes: number
  private readonly totalBytes: number
  private readonly sourceGroups: readonly InstructionSourceGroup[]

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly trust: InstructionTrustReader,
    options: InstructionServiceOptions = {},
  ) {
    this.perFileBytes = positiveInteger(
      options.perFileBytes,
      DEFAULT_PER_FILE_BYTES,
      'perFileBytes',
    )
    this.totalBytes = positiveInteger(options.totalBytes, DEFAULT_TOTAL_BYTES, 'totalBytes')
    this.sourceGroups = normalizeSourceGroups(options.sourceGroups)
  }

  async load(contextPaths: readonly string[] = []): Promise<InstructionBundle> {
    const summary = this.workspace.getWorkspace()
    if (!summary) return { workspacePath: null, trusted: false, layers: [], totalBytes: 0 }

    const trust = await this.trust.getWorkspaceTrust(summary.path)
    if (!trust.trusted) {
      return { workspacePath: summary.path, trusted: false, layers: [], totalBytes: 0 }
    }

    const directories = await this.contextDirectories(summary.path, contextPaths)
    const layers: InstructionLayer[] = []
    const visitedPaths = new Set<string>()
    let totalBytes = 0

    const addCandidate = async (
      directory: string,
      fileName: string,
      kind: InstructionKind,
    ): Promise<'missing' | 'present'> => {
      const path = joinWorkspacePath(directory, fileName)
      if (visitedPaths.has(path)) return 'present'
      visitedPaths.add(path)

      const outcome = await this.readInstruction(path, totalBytes)
      if (!outcome) return 'missing'

      const layer: InstructionLayer = {
        path,
        directory,
        kind,
        status: outcome.status,
        precedence: layers.length,
        bytes: outcome.bytes,
        content: outcome.content,
        message: outcome.message,
      }
      layers.push(layer)
      if (outcome.status === 'loaded') totalBytes += outcome.bytes ?? 0
      return 'present'
    }

    for (const directory of directories) {
      for (const group of this.sourceGroups) {
        for (const source of group.candidates) {
          if ((await addCandidate(directory, source.fileName, source.kind)) === 'present') break
        }
      }
    }

    return { workspacePath: summary.path, trusted: true, layers, totalBytes }
  }

  private async contextDirectories(
    canonicalRoot: string,
    contextPaths: readonly string[],
  ): Promise<string[]> {
    const requestedDirectories = new Set<string>([''])

    for (const requestedPath of contextPaths) {
      if (!requestedPath || requestedPath.includes('\0')) continue
      const lexicalPath = isAbsolute(requestedPath)
        ? resolve(requestedPath)
        : resolve(canonicalRoot, requestedPath)
      if (!isPathContained(canonicalRoot, lexicalPath)) continue

      const workspacePath = portablePath(relative(canonicalRoot, lexicalPath))
      let directory = workspacePath
      try {
        await this.workspace.listTree({ path: workspacePath, maxDepth: 1, maxEntries: 1 })
      } catch (error) {
        if (!isWorkspaceError(error, 'NOT_A_DIRECTORY')) continue
        const segments = workspacePath.split('/')
        segments.pop()
        directory = segments.join('/')
      }

      for (const ancestor of parentDirectories(directory)) requestedDirectories.add(ancestor)
    }

    return [...requestedDirectories].sort((left, right) => {
      const depthDifference =
        left.split('/').filter(Boolean).length - right.split('/').filter(Boolean).length
      return depthDifference || left.localeCompare(right)
    })
  }

  private async readInstruction(path: string, currentTotal: number): Promise<ReadOutcome | null> {
    try {
      const preview = await this.workspace.readFile(path, {
        maxBytes: this.perFileBytes,
        truncate: false,
      })
      const content = preview.content
      if (!content.trim()) {
        return {
          status: 'malformed',
          bytes: 0,
          content: null,
          message: 'The instruction file is empty.',
        }
      }

      const bytes = Buffer.byteLength(content, 'utf8')
      if (currentTotal + bytes > this.totalBytes) {
        return {
          status: 'oversized',
          bytes,
          content: null,
          message: `The combined instruction limit of ${this.totalBytes} bytes was reached.`,
        }
      }
      return { status: 'loaded', bytes, content, message: null }
    } catch (error) {
      if (isWorkspaceError(error, 'PATH_NOT_FOUND')) return null
      if (isWorkspaceError(error, 'SENSITIVE_FILE')) {
        return {
          status: 'sensitive',
          bytes: null,
          content: null,
          message: error instanceof Error ? error.message : 'Sensitive content was blocked.',
        }
      }
      if (isWorkspaceError(error, 'FILE_TOO_LARGE')) {
        return {
          status: 'oversized',
          bytes: null,
          content: null,
          message: error instanceof Error ? error.message : 'The instruction file is too large.',
        }
      }
      return {
        status: 'malformed',
        bytes: null,
        content: null,
        message: error instanceof Error ? error.message : 'The instruction file could not be read.',
      }
    }
  }
}
