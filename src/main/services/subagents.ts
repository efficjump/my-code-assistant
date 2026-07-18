import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { WorkspaceError, WorkspaceService } from './workspace'

export type SubagentProfileFormat = 'markdown' | 'toml'

export interface SubagentProfileSourceConfig {
  directory: string
  extension: string
  source: string
  format: SubagentProfileFormat
}

const DEFAULT_PROFILE_SOURCES: readonly SubagentProfileSourceConfig[] = [
  { directory: '.agents/agents', extension: '.md', source: 'agents', format: 'markdown' },
]

const DEFAULT_MAX_PROFILES = 100
const DEFAULT_PROFILE_BYTES = 64 * 1024
const PROFILE_NAME_PATTERN = /^[a-z0-9]+(?:[a-z0-9_-]{0,62}[a-z0-9])?$/
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const SUBAGENT_READ_ONLY_TOOLS = [
  'list_files',
  'read_file',
  'search_text',
  'git_status',
  'git_diff',
  'list_skills',
  'read_skill',
] as const

export type SubagentReadOnlyTool = (typeof SUBAGENT_READ_ONLY_TOOLS)[number]
export type SubagentProfileSource = 'builtin' | string
export type SubagentProfileScope = 'builtin' | 'workspace'

export interface SubagentProfileDescriptor {
  id: string
  name: string
  description: string
  path: string | null
  revision: string
  source: SubagentProfileSource
  scope: SubagentProfileScope
  model: string | null
  tools: SubagentReadOnlyTool[]
  skills: string[]
}

export interface SubagentProfileDocument {
  descriptor: SubagentProfileDescriptor
  developerInstructions: string
}

export interface SubagentProfilesTrustReader {
  isTrusted(workspacePath: string): Promise<boolean>
}

export interface SubagentProfilesServiceOptions {
  maxProfiles?: number
  maxProfileBytes?: number
  sources?: readonly SubagentProfileSourceConfig[]
}

export type SubagentProfileErrorCode = 'PROFILE_NOT_FOUND' | 'REVISION_MISMATCH'

export class SubagentProfileError extends Error {
  readonly code: SubagentProfileErrorCode

  constructor(code: SubagentProfileErrorCode, message: string) {
    super(message)
    this.name = 'SubagentProfileError'
    this.code = code
  }
}

interface ParsedProfile {
  name: string
  description: string
  developerInstructions: string
  model: string | null
  tools: SubagentReadOnlyTool[]
  skills: string[]
}

interface RawProfile {
  name?: string
  description?: string
  developerInstructions?: string
  model?: string
  tools?: string[]
  skills?: string[]
}

interface DiscoveredProfile {
  descriptor: SubagentProfileDescriptor
  developerInstructions: string
}

const TOOL_ALIASES: Readonly<Record<string, SubagentReadOnlyTool>> = {
  glob: 'list_files',
  list_files: 'list_files',
  listfiles: 'list_files',
  read: 'read_file',
  read_file: 'read_file',
  readfile: 'read_file',
  grep: 'search_text',
  search: 'search_text',
  search_text: 'search_text',
  searchtext: 'search_text',
  git_status: 'git_status',
  gitstatus: 'git_status',
  git_diff: 'git_diff',
  gitdiff: 'git_diff',
  list_skills: 'list_skills',
  listskills: 'list_skills',
  read_skill: 'read_skill',
  readskill: 'read_skill',
}

const BUILTIN_PROFILES = [
  {
    name: 'explorer',
    description: 'Read-heavy codebase explorer that maps relevant paths and returns evidence.',
    developerInstructions:
      'Explore the requested codebase area without modifying files or starting processes. Prefer targeted search and file reads. Return concise findings with workspace-relative paths and clearly separate evidence from inference.',
  },
  {
    name: 'general',
    description: 'General-purpose read-only delegate for bounded supporting work.',
    developerInstructions:
      'Complete the delegated supporting task using read-only workspace evidence. Stay within the requested scope, do not modify files or start processes, and return the result and any unresolved uncertainty to the parent agent.',
  },
  {
    name: 'reviewer',
    description: 'Code reviewer focused on correctness, security, regressions, and missing tests.',
    developerInstructions:
      'Review the requested code like an owner without modifying files or starting processes. Prioritize actionable correctness, security, regression, and test findings. Cite the relevant workspace-relative paths and avoid style-only feedback.',
  },
  {
    name: 'tester',
    description: 'Read-only test specialist that designs coverage from repository evidence.',
    developerInstructions:
      'Inspect implementation and existing test conventions without modifying files or starting processes. Identify realistic failure modes and propose concrete tests at the appropriate level, citing workspace-relative paths.',
  },
] as const

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive integer.`)
  }
  return resolved
}

function normalizeProfileSources(
  sources: readonly SubagentProfileSourceConfig[] | undefined,
): readonly SubagentProfileSourceConfig[] {
  const selected = sources ?? DEFAULT_PROFILE_SOURCES
  const seen = new Set<string>()
  return selected.map(({ directory, extension, source, format }) => {
    const normalizedDirectory = directory.replace(/\/+$/, '')
    const normalizedExtension = extension.trim().toLocaleLowerCase()
    const normalizedSource = source.trim()
    if (
      !normalizedDirectory ||
      isAbsolute(normalizedDirectory) ||
      normalizedDirectory.includes('\\') ||
      normalizedDirectory
        .split('/')
        .some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      throw new RangeError(
        'Profile source directories must be normalized workspace-relative paths.',
      )
    }
    if (!/^\.[a-z0-9]+$/.test(normalizedExtension)) {
      throw new RangeError('Profile source extensions must be simple lowercase file extensions.')
    }
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(normalizedSource)) {
      throw new RangeError('Profile source names must be stable lowercase identifiers.')
    }
    if (format !== 'markdown' && format !== 'toml') {
      throw new RangeError('Profile source formats must be markdown or toml.')
    }
    const identity = `${normalizedSource}\0${normalizedDirectory}\0${normalizedExtension}`
    if (seen.has(identity)) throw new RangeError('Profile sources must be unique.')
    seen.add(identity)
    return Object.freeze({
      directory: normalizedDirectory,
      extension: normalizedExtension,
      source: normalizedSource,
      format,
    })
  })
}

function isWorkspaceError(error: unknown, code: WorkspaceError['code']): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function revisionFor(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

function normalizeToolKey(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[ .-]+/g, '_')
}

/** Maps compatible tool names to the fixed read-only host capability set. */
export function normalizeReadOnlyToolAllowlist(
  requested?: readonly string[],
): SubagentReadOnlyTool[] {
  if (requested === undefined) return [...SUBAGENT_READ_ONLY_TOOLS]
  const selected = new Set<SubagentReadOnlyTool>()
  for (const value of requested) {
    const tool = TOOL_ALIASES[normalizeToolKey(value)]
    if (tool) selected.add(tool)
  }
  return SUBAGENT_READ_ONLY_TOOLS.filter((tool) => selected.has(tool))
}

function cloneDescriptor(descriptor: SubagentProfileDescriptor): SubagentProfileDescriptor {
  return { ...descriptor, tools: [...descriptor.tools], skills: [...descriptor.skills] }
}

function parseQuotedScalar(source: string, allowBare: boolean): string | null {
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
  return allowBare && !/[\0\r\n]/.test(value) ? value : null
}

function splitListItems(source: string): string[] | null {
  const items: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (const character of source) {
    if (quote === '"' && escaped) {
      current += character
      escaped = false
      continue
    }
    if (quote === '"' && character === '\\') {
      current += character
      escaped = true
      continue
    }
    if (quote) {
      current += character
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      current += character
      continue
    }
    if (character === ',') {
      items.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  if (quote || escaped) return null
  if (current.trim() || items.length > 0) items.push(current.trim())
  return items
}

function parseInlineList(source: string, allowBare: boolean): string[] | null {
  const value = source.trim()
  if (!value.startsWith('[') || !value.endsWith(']')) return null
  const inner = value.slice(1, -1).trim()
  if (!inner) return []
  const items = splitListItems(inner)
  if (!items || items.some((item) => !item)) return null
  const parsed = items.map((item) => parseQuotedScalar(item, allowBare))
  return parsed.every((item): item is string => item !== null) ? parsed : null
}

function parseYamlListValue(
  lines: string[],
  index: number,
  value: string,
): {
  values: string[]
  lastIndex: number
} | null {
  if (value.trim()) {
    const inline = parseInlineList(value, true)
    if (inline) return { values: inline, lastIndex: index }
    const scalar = parseQuotedScalar(value, true)
    return scalar === null ? null : { values: [scalar], lastIndex: index }
  }

  const values: string[] = []
  let lastIndex = index
  for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
    const child = /^\s+-\s*(.*)$/.exec(lines[childIndex])
    if (!child) break
    const scalar = parseQuotedScalar(child[1], true)
    if (scalar === null || !scalar) return null
    values.push(scalar)
    lastIndex = childIndex
  }
  return { values, lastIndex }
}

function readIndentedBlock(
  lines: string[],
  index: number,
  folded: boolean,
): {
  value: string
  lastIndex: number
} | null {
  const block: string[] = []
  let lastIndex = index
  for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
    const line = lines[childIndex]
    if (line && !/^\s/.test(line)) break
    block.push(line.replace(/^(?: {1,4}|\t)/, ''))
    lastIndex = childIndex
  }
  if (block.length === 0) return null
  return { value: folded ? block.join(' ').trim() : block.join('\n').trim(), lastIndex }
}

function parseMarkdownProfile(content: string): ParsedProfile | null {
  const lines = content.split(/\r?\n/)
  if (lines[0] !== '---') return null
  const closingIndex = lines.findIndex((line, index) => index > 0 && line === '---')
  if (closingIndex < 0) return null

  const frontmatter = lines.slice(1, closingIndex)
  const raw: RawProfile = {}
  const seen = new Set<string>()
  for (let index = 0; index < frontmatter.length; index += 1) {
    const line = frontmatter[index]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!field) return null
    const key = field[1].toLocaleLowerCase().replace(/-/g, '_')
    const recognized = ['name', 'description', 'developer_instructions', 'model', 'tools', 'skills']
    if (!recognized.includes(key)) {
      if (['|', '>'].includes(field[2].trim())) {
        const ignored = readIndentedBlock(frontmatter, index, field[2].trim() === '>')
        if (!ignored) return null
        index = ignored.lastIndex
      } else if (!field[2].trim()) {
        const ignored = parseYamlListValue(frontmatter, index, field[2])
        if (ignored) index = ignored.lastIndex
      }
      continue
    }
    if (seen.has(key)) return null
    seen.add(key)

    if (key === 'tools' || key === 'skills') {
      const parsed = parseYamlListValue(frontmatter, index, field[2])
      if (!parsed) return null
      if (key === 'tools') raw.tools = parsed.values
      else raw.skills = parsed.values
      index = parsed.lastIndex
      continue
    }
    if (key === 'developer_instructions' && ['|', '>'].includes(field[2].trim())) {
      const block = readIndentedBlock(frontmatter, index, field[2].trim() === '>')
      if (!block) return null
      raw.developerInstructions = block.value
      index = block.lastIndex
      continue
    }
    const scalar = parseQuotedScalar(field[2], true)
    if (scalar === null) return null
    if (key === 'developer_instructions') raw.developerInstructions = scalar
    else if (key === 'name') raw.name = scalar
    else if (key === 'description') raw.description = scalar
    else raw.model = scalar
  }

  const body = lines
    .slice(closingIndex + 1)
    .join('\n')
    .trim()
  return validateProfile(raw, raw.developerInstructions?.trim() || body)
}

function parseTomlMultiline(
  lines: string[],
  index: number,
  source: string,
): {
  value: string
  lastIndex: number
} | null {
  const delimiter = source.startsWith('"""') ? '"""' : source.startsWith("'''") ? "'''" : null
  if (!delimiter) return null
  const initial = source.slice(3)
  const sameLineEnd = initial.indexOf(delimiter)
  if (sameLineEnd >= 0) {
    if (initial.slice(sameLineEnd + 3).trim()) return null
    return { value: initial.slice(0, sameLineEnd), lastIndex: index }
  }

  const value = [initial]
  for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
    const line = lines[childIndex]
    const end = line.indexOf(delimiter)
    if (end >= 0) {
      if (line.slice(end + 3).trim()) return null
      value.push(line.slice(0, end))
      return { value: value.join('\n').trim(), lastIndex: childIndex }
    }
    value.push(line)
  }
  return null
}

function parseTomlProfile(content: string): ParsedProfile | null {
  const lines = content.split(/\r?\n/)
  const raw: RawProfile = {}
  const seen = new Set<string>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) return null
    const field = /^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.*)$/.exec(line)
    if (!field) return null
    const key = field[1].toLocaleLowerCase().replace(/-/g, '_')
    if (
      !['name', 'description', 'developer_instructions', 'model', 'tools', 'skills'].includes(key)
    ) {
      continue
    }
    if (seen.has(key)) return null
    seen.add(key)

    if (key === 'tools' || key === 'skills') {
      const parsed = parseInlineList(field[2], false)
      if (!parsed) return null
      if (key === 'tools') raw.tools = parsed
      else raw.skills = parsed
      continue
    }
    if (key === 'developer_instructions') {
      const multiline = parseTomlMultiline(lines, index, field[2])
      if (multiline) {
        raw.developerInstructions = multiline.value
        index = multiline.lastIndex
        continue
      }
    }
    const scalar = parseQuotedScalar(field[2], false)
    if (scalar === null) return null
    if (key === 'developer_instructions') raw.developerInstructions = scalar
    else if (key === 'name') raw.name = scalar
    else if (key === 'description') raw.description = scalar
    else raw.model = scalar
  }
  return validateProfile(raw, raw.developerInstructions ?? '')
}

function validateProfile(raw: RawProfile, developerInstructions: string): ParsedProfile | null {
  const name = raw.name?.trim().toLocaleLowerCase() ?? ''
  const description = raw.description?.trim() ?? ''
  const instructions = developerInstructions.trim()
  const model = raw.model?.trim() || null
  if (!PROFILE_NAME_PATTERN.test(name) || name.length > 64) return null
  if (!description || description.length > 1_024 || /[\0\r\n]/.test(description)) return null
  if (!instructions || instructions.length > 60_000 || instructions.includes('\0')) return null
  if (model && (model.length > 512 || /[\0\r\n]/.test(model))) return null

  const skills = [...new Set((raw.skills ?? []).map((skill) => skill.trim().toLocaleLowerCase()))]
    .filter((skill) => SKILL_NAME_PATTERN.test(skill) && skill.length <= 64)
    .slice(0, 64)
    .sort((left, right) => left.localeCompare(right))
  return {
    name,
    description,
    developerInstructions: instructions,
    model,
    tools: normalizeReadOnlyToolAllowlist(raw.tools),
    skills,
  }
}

function isProfilePath(path: string, directory: string, extension: string): boolean {
  const segments = path.split('/')
  const root = directory.split('/')
  return (
    segments.length === 3 &&
    segments[0] === root[0] &&
    segments[1] === root[1] &&
    segments[2].toLocaleLowerCase().endsWith(extension)
  )
}

function workspaceProfileId(workspacePath: string, profilePath: string): string {
  return `workspace-agent:${createHash('sha256')
    .update(workspacePath)
    .update('\0')
    .update(profilePath)
    .digest('base64url')}`
}

function builtinProfiles(): DiscoveredProfile[] {
  return BUILTIN_PROFILES.map((profile) => {
    const revision = revisionFor(JSON.stringify(profile))
    return {
      descriptor: {
        id: `builtin-agent:${profile.name}`,
        name: profile.name,
        description: profile.description,
        path: null,
        revision,
        source: 'builtin',
        scope: 'builtin',
        model: null,
        tools: [...SUBAGENT_READ_ONLY_TOOLS],
        skills: [],
      },
      developerInstructions: profile.developerInstructions,
    }
  })
}

/**
 * Discovers read-only subagent profiles. Workspace-owned definitions are loaded only while the
 * canonical workspace remains trusted; custom definitions may override lower-precedence sources.
 */
export class SubagentProfilesService {
  private readonly maxProfiles: number
  private readonly maxProfileBytes: number
  private readonly sources: readonly SubagentProfileSourceConfig[]

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly trust: SubagentProfilesTrustReader,
    options: SubagentProfilesServiceOptions = {},
  ) {
    this.maxProfiles = positiveInteger(options.maxProfiles, DEFAULT_MAX_PROFILES, 'maxProfiles')
    this.maxProfileBytes = positiveInteger(
      options.maxProfileBytes,
      DEFAULT_PROFILE_BYTES,
      'maxProfileBytes',
    )
    this.sources = normalizeProfileSources(options.sources)
  }

  async list(): Promise<SubagentProfileDescriptor[]> {
    return (await this.discover()).map(({ descriptor }) => cloneDescriptor(descriptor))
  }

  async read(id: string, revision: string): Promise<SubagentProfileDocument> {
    const profile = (await this.discover()).find((candidate) => candidate.descriptor.id === id)
    if (!profile) {
      throw new SubagentProfileError(
        'PROFILE_NOT_FOUND',
        'The requested subagent profile was not found.',
      )
    }
    if (profile.descriptor.revision !== revision) {
      throw new SubagentProfileError(
        'REVISION_MISMATCH',
        'The subagent profile changed after discovery. Review it again before use.',
      )
    }
    return {
      descriptor: cloneDescriptor(profile.descriptor),
      developerInstructions: profile.developerInstructions,
    }
  }

  private async discover(): Promise<DiscoveredProfile[]> {
    const builtins = builtinProfiles()
    const selected = this.workspace.getWorkspace()
    if (!selected || !(await this.trust.isTrusted(selected.path))) return builtins

    const custom: DiscoveredProfile[] = []
    const names = new Set<string>()
    for (const profileSource of this.sources) {
      if (custom.length >= this.maxProfiles) break
      let candidates: string[]
      try {
        candidates = await this.workspace.listFiles({
          path: profileSource.directory,
          maxDepth: 1,
          maxFiles: this.maxProfiles * 4,
          extensions: [profileSource.extension],
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
        .filter((candidate) =>
          isProfilePath(candidate, profileSource.directory, profileSource.extension),
        )
        .sort((left, right) => left.localeCompare(right))) {
        if (custom.length >= this.maxProfiles) break
        let content: string
        try {
          content = (
            await this.workspace.readFile(path, {
              maxBytes: this.maxProfileBytes,
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

        const parsed =
          profileSource.format === 'toml'
            ? parseTomlProfile(content)
            : parseMarkdownProfile(content)
        if (!parsed || names.has(parsed.name)) continue
        names.add(parsed.name)
        custom.push({
          descriptor: {
            id: workspaceProfileId(selected.path, path),
            name: parsed.name,
            description: parsed.description,
            path,
            revision: revisionFor(content),
            source: profileSource.source,
            scope: 'workspace',
            model: parsed.model,
            tools: parsed.tools,
            skills: parsed.skills,
          },
          developerInstructions: parsed.developerInstructions,
        })
      }
    }

    if (
      this.workspace.getWorkspace()?.path !== selected.path ||
      !(await this.trust.isTrusted(selected.path))
    ) {
      return builtins
    }

    for (const builtin of builtins) {
      if (!names.has(builtin.descriptor.name)) custom.push(builtin)
    }
    return custom.sort((left, right) => left.descriptor.name.localeCompare(right.descriptor.name))
  }
}
