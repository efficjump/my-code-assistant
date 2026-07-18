import { createHash } from 'node:crypto'
import { dirname, isAbsolute } from 'node:path'
import type { FilePreview } from '../../shared/contracts'
import {
  formatServiceErrorDescriptor,
  SERVICE_ERROR_MARKER,
  type SkillErrorCode,
  type SkillErrorDetail,
  type SkillServiceErrorDescriptor,
} from './service-error-messages'
import type { WorkspaceError, WorkspaceService } from './workspace'

export interface SkillSourceConfig {
  directory: string
  source: string
}

const DEFAULT_SKILL_SOURCES: readonly SkillSourceConfig[] = [
  { directory: '.agents/skills', source: 'agents' },
]
const SKILL_FILE_NAME = 'SKILL.md'
const DEFAULT_MAX_SKILLS = 100
const DEFAULT_SKILL_BYTES = 64 * 1024
const DEFAULT_MAX_RESOURCES = 200
const DEFAULT_RESOURCE_BYTES = 256 * 1024
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type SkillResourceKind = 'scripts' | 'references' | 'assets'
export type SkillSource = string
export type SkillScope = 'workspace'

export interface SkillResources {
  scripts: string[]
  references: string[]
  assets: string[]
}

export interface SkillDescriptor {
  id: string
  name: string
  description: string
  path: string
  /** SHA-256 of the complete SKILL.md source. */
  contentHash: string
  /** Revision supplied back to read calls to detect changes after discovery. */
  revision: string
  /** Compatibility root that supplied this skill. */
  source: SkillSource
  /** Skills discovered by this service are always scoped to the selected workspace. */
  scope: SkillScope
  /** Whether the model may select the skill from its description without an explicit mention. */
  allowImplicitInvocation: boolean
  resources: SkillResources
}

export interface SkillDocument {
  descriptor: SkillDescriptor
  content: string
}

export interface SkillsServiceOptions {
  maxSkills?: number
  maxSkillBytes?: number
  maxResourcesPerSkill?: number
  maxResourceBytes?: number
  sources?: readonly SkillSourceConfig[]
}

export type { SkillErrorCode } from './service-error-messages'

export class SkillError extends Error {
  readonly code: SkillErrorCode
  readonly descriptor: SkillServiceErrorDescriptor
  readonly [SERVICE_ERROR_MARKER] = true as const

  constructor(detail: SkillErrorDetail, options?: ErrorOptions)
  constructor(code: SkillErrorCode, message: string, options?: ErrorOptions)
  constructor(
    detailOrCode: SkillErrorDetail | SkillErrorCode,
    messageOrOptions?: string | ErrorOptions,
    legacyOptions?: ErrorOptions,
  ) {
    const descriptor = (
      typeof detailOrCode === 'string'
        ? { service: 'skill', code: detailOrCode }
        : { service: 'skill', ...detailOrCode }
    ) as SkillServiceErrorDescriptor
    const message =
      typeof messageOrOptions === 'string'
        ? messageOrOptions
        : formatServiceErrorDescriptor('ko', descriptor)
    const options = typeof messageOrOptions === 'string' ? legacyOptions : messageOrOptions
    super(message, options)
    this.name = 'SkillError'
    this.code = descriptor.code
    this.descriptor = descriptor
  }
}

interface ParsedSkill {
  name: string
  description: string
  allowImplicitInvocation: boolean
}

interface DiscoveredSkill {
  descriptor: SkillDescriptor
  content: string
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive integer.`)
  }
  return resolved
}

function normalizeSkillSources(
  sources: readonly SkillSourceConfig[] | undefined,
): readonly SkillSourceConfig[] {
  const selected = sources ?? DEFAULT_SKILL_SOURCES
  const seen = new Set<string>()
  return selected.map(({ directory, source }) => {
    const normalizedDirectory = directory.replace(/\/+$/, '')
    const normalizedSource = source.trim()
    if (
      !normalizedDirectory ||
      isAbsolute(normalizedDirectory) ||
      normalizedDirectory.includes('\\') ||
      normalizedDirectory
        .split('/')
        .some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      throw new RangeError('Skill source directories must be normalized workspace-relative paths.')
    }
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(normalizedSource)) {
      throw new RangeError('Skill source names must be stable lowercase identifiers.')
    }
    const identity = `${normalizedSource}\0${normalizedDirectory}`
    if (seen.has(identity)) throw new RangeError('Skill sources must be unique.')
    seen.add(identity)
    return Object.freeze({ directory: normalizedDirectory, source: normalizedSource })
  })
}

function isWorkspaceError(error: unknown, code: WorkspaceError['code']): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function parseQuotedScalar(source: string): string | null {
  const value = source.trim()
  if (!value) return ''
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) return null
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === 'string' ? parsed : null
    } catch {
      return null
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) return null
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

function parseBooleanScalar(source: string): boolean | null {
  const value = source.trim().toLocaleLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

function parseSkill(content: string): ParsedSkill | null {
  const lines = content.split(/\r?\n/)
  if (lines[0] !== '---') return null
  const closingIndex = lines.findIndex((line, index) => index > 0 && line === '---')
  if (
    closingIndex < 0 ||
    !lines
      .slice(closingIndex + 1)
      .join('\n')
      .trim()
  )
    return null

  const metadata = new Map<string, string>()
  let allowImplicitInvocation = true
  let implicitInvocationField: string | null = null
  for (const line of lines.slice(1, closingIndex)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const field = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line)
    if (!field) return null

    const key = field[1].toLowerCase()
    if (
      !['name', 'description', 'allow-implicit-invocation', 'disable-model-invocation'].includes(
        key,
      )
    ) {
      continue
    }
    if (key === 'allow-implicit-invocation' || key === 'disable-model-invocation') {
      if (implicitInvocationField !== null) return null
      const value = parseBooleanScalar(field[2])
      if (value === null) return null
      implicitInvocationField = key
      allowImplicitInvocation = key === 'disable-model-invocation' ? !value : value
      continue
    }
    if (metadata.has(key)) return null
    const value = parseQuotedScalar(field[2])
    if (value === null || /[\0\r\n]/.test(value)) return null
    metadata.set(key, value.trim())
  }

  const name = metadata.get('name') ?? ''
  const description = metadata.get('description') ?? ''
  if (!SKILL_NAME_PATTERN.test(name) || name.length > 64) return null
  if (!description || description.length > 1_024) return null
  return { name, description, allowImplicitInvocation }
}

function isSkillPath(path: string, directory: string): boolean {
  const segments = path.split('/')
  const rootSegments = directory.split('/')
  return (
    segments.length === 4 &&
    segments[0] === rootSegments[0] &&
    segments[1] === rootSegments[1] &&
    Boolean(segments[2]) &&
    !['.', '..'].includes(segments[2]) &&
    segments[3] === SKILL_FILE_NAME
  )
}

function opaqueSkillId(workspacePath: string, skillPath: string): string {
  return `workspace-skill:${createHash('sha256')
    .update(workspacePath)
    .update('\0')
    .update(skillPath)
    .digest('base64url')}`
}

function contentRevision(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function emptyResources(): SkillResources {
  return { scripts: [], references: [], assets: [] }
}

function cloneDescriptor(descriptor: SkillDescriptor): SkillDescriptor {
  return {
    ...descriptor,
    resources: {
      scripts: [...descriptor.resources.scripts],
      references: [...descriptor.resources.references],
      assets: [...descriptor.resources.assets],
    },
  }
}

function allResourcePaths(resources: SkillResources): string[] {
  return [...resources.scripts, ...resources.references, ...resources.assets]
}

/**
 * Repository skills use progressive disclosure: list() returns only metadata and safe resource
 * paths, while read() fetches the full instructions after verifying the listed revision.
 */
export class SkillsService {
  private readonly maxSkills: number
  private readonly maxSkillBytes: number
  private readonly maxResourcesPerSkill: number
  private readonly maxResourceBytes: number
  private readonly sources: readonly SkillSourceConfig[]

  constructor(
    private readonly workspace: WorkspaceService,
    options: SkillsServiceOptions = {},
  ) {
    this.maxSkills = positiveInteger(options.maxSkills, DEFAULT_MAX_SKILLS, 'maxSkills')
    this.maxSkillBytes = positiveInteger(
      options.maxSkillBytes,
      DEFAULT_SKILL_BYTES,
      'maxSkillBytes',
    )
    this.maxResourcesPerSkill = positiveInteger(
      options.maxResourcesPerSkill,
      DEFAULT_MAX_RESOURCES,
      'maxResourcesPerSkill',
    )
    this.maxResourceBytes = positiveInteger(
      options.maxResourceBytes,
      DEFAULT_RESOURCE_BYTES,
      'maxResourceBytes',
    )
    this.sources = normalizeSkillSources(options.sources)
  }

  async list(): Promise<SkillDescriptor[]> {
    return (await this.discover()).map(({ descriptor }) => cloneDescriptor(descriptor))
  }

  async read(id: string, revision: string): Promise<SkillDocument> {
    const skill = await this.findCurrent(id, revision)
    return { descriptor: cloneDescriptor(skill.descriptor), content: skill.content }
  }

  async readResource(id: string, revision: string, path: string): Promise<FilePreview> {
    const skill = await this.findCurrent(id, revision)
    if (!allResourcePaths(skill.descriptor.resources).includes(path)) {
      throw new SkillError({ code: 'INVALID_RESOURCE', identifier: 'not-listed' })
    }

    try {
      return await this.workspace.readFile(path, {
        maxBytes: this.maxResourceBytes,
        truncate: false,
      })
    } catch (error) {
      throw new SkillError(
        { code: 'INVALID_RESOURCE', identifier: 'read-failed' },
        { cause: error },
      )
    }
  }

  private async findCurrent(id: string, revision: string): Promise<DiscoveredSkill> {
    const skill = (await this.discover()).find((candidate) => candidate.descriptor.id === id)
    if (!skill) throw new SkillError({ code: 'SKILL_NOT_FOUND' })
    if (skill.descriptor.revision !== revision) {
      throw new SkillError({ code: 'REVISION_MISMATCH' })
    }
    return skill
  }

  private async discover(): Promise<DiscoveredSkill[]> {
    const workspace = this.workspace.getWorkspace()
    if (!workspace) return []

    const discovered: DiscoveredSkill[] = []
    const names = new Set<string>()
    for (const skillSource of this.sources) {
      if (discovered.length >= this.maxSkills) break
      let candidates: string[]
      try {
        candidates = await this.workspace.listFiles({
          path: skillSource.directory,
          maxDepth: 2,
          maxFiles: this.maxSkills * 4,
          extensions: [SKILL_FILE_NAME],
        })
      } catch (error) {
        if (
          isWorkspaceError(error, 'PATH_NOT_FOUND') ||
          isWorkspaceError(error, 'OUTSIDE_WORKSPACE')
        ) {
          continue
        }
        throw error
      }

      for (const path of candidates
        .filter((candidate) => isSkillPath(candidate, skillSource.directory))
        .sort((left, right) => left.localeCompare(right))) {
        if (discovered.length >= this.maxSkills) break
        let content: string
        try {
          content = (
            await this.workspace.readFile(path, {
              maxBytes: this.maxSkillBytes,
              truncate: false,
            })
          ).content
        } catch (error) {
          if (
            isWorkspaceError(error, 'FILE_TOO_LARGE') ||
            isWorkspaceError(error, 'SENSITIVE_FILE') ||
            isWorkspaceError(error, 'BINARY_FILE') ||
            isWorkspaceError(error, 'PATH_NOT_FOUND') ||
            isWorkspaceError(error, 'OUTSIDE_WORKSPACE')
          ) {
            continue
          }
          throw error
        }

        const parsed = parseSkill(content)
        if (!parsed) continue
        const duplicateKey = parsed.name.toLocaleLowerCase()
        if (names.has(duplicateKey)) continue

        const resources = await this.listResources(dirname(path))
        const revision = contentRevision(content)
        names.add(duplicateKey)
        discovered.push({
          descriptor: {
            id: opaqueSkillId(workspace.path, path),
            name: parsed.name,
            description: parsed.description,
            path,
            contentHash: revision,
            revision,
            source: skillSource.source,
            scope: 'workspace',
            allowImplicitInvocation: parsed.allowImplicitInvocation,
            resources,
          },
          content,
        })
      }
    }

    return discovered.sort((left, right) =>
      left.descriptor.name.localeCompare(right.descriptor.name),
    )
  }

  private async listResources(skillDirectory: string): Promise<SkillResources> {
    const resources = emptyResources()
    let paths: string[]
    try {
      paths = await this.workspace.listFiles({
        path: skillDirectory,
        maxDepth: 8,
        maxFiles: this.maxResourcesPerSkill + 1,
      })
    } catch {
      return resources
    }

    for (const path of paths.sort((left, right) => left.localeCompare(right))) {
      if (allResourcePaths(resources).length >= this.maxResourcesPerSkill) break
      for (const kind of ['scripts', 'references', 'assets'] as const) {
        if (path.startsWith(`${skillDirectory}/${kind}/`)) resources[kind].push(path)
      }
    }
    return resources
  }
}
