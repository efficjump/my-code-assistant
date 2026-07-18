import { createHash } from 'node:crypto'
import type {
  ExpandSlashCommandInput,
  SlashCommandDescriptor,
  SlashCommandExpansion,
} from '../../shared/contracts'
import { MAX_AGENT_MESSAGE_CHARACTERS } from '../../shared/contracts'
import {
  type CommandErrorCode,
  type CommandErrorDetail,
  type CommandServiceErrorDescriptor,
  formatServiceErrorDescriptor,
  SERVICE_ERROR_MARKER,
} from './service-error-messages'
import type { WorkspaceService } from './workspace'

const COMMAND_FILE_SUFFIX = '.command.md'
const COMMAND_NAMESPACE = 'prompts:'
const MAX_COMMAND_FILES = 100
const MAX_COMMAND_BYTES = 64 * 1024
const MAX_DESCRIPTION_CHARACTERS = 500
const MAX_ARGUMENT_HINT_CHARACTERS = 200
const COMMAND_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u
const NAMED_ARGUMENT_PATTERN = /^([A-Z][A-Z0-9_]*)=(.*)$/s

export type { CommandErrorCode } from './service-error-messages'

export class CommandError extends Error {
  readonly code: CommandErrorCode
  readonly descriptor: CommandServiceErrorDescriptor
  readonly [SERVICE_ERROR_MARKER] = true as const

  constructor(detail: CommandErrorDetail, options?: ErrorOptions)
  constructor(code: CommandErrorCode, message: string, options?: ErrorOptions)
  constructor(
    detailOrCode: CommandErrorDetail | CommandErrorCode,
    messageOrOptions?: string | ErrorOptions,
    legacyOptions?: ErrorOptions,
  ) {
    const descriptor = (
      typeof detailOrCode === 'string'
        ? { service: 'command', code: detailOrCode }
        : { service: 'command', ...detailOrCode }
    ) as CommandServiceErrorDescriptor
    const message =
      typeof messageOrOptions === 'string'
        ? messageOrOptions
        : formatServiceErrorDescriptor('ko', descriptor)
    const options = typeof messageOrOptions === 'string' ? legacyOptions : messageOrOptions
    super(message, options)
    this.name = 'CommandError'
    this.code = descriptor.code
    this.descriptor = descriptor
  }
}

interface CommandMetadata {
  name?: string
  description?: string
  argumentHint?: string
}

interface ParsedCommandFile {
  metadata: CommandMetadata
  template: string
}

interface DiscoveredCommand {
  descriptor: SlashCommandDescriptor
  template: string
}

interface ParsedArguments {
  raw: string
  positional: string[]
  named: ReadonlyMap<string, string>
}

function isSafeRelativeCommandPath(path: string): boolean {
  if (
    !path ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    !path.toLowerCase().endsWith(COMMAND_FILE_SUFFIX)
  ) {
    return false
  }
  return path
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function parseQuotedMetadataValue(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed.startsWith('"') || trimmed.startsWith("'") ? null : trimmed

  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"')) return null
    try {
      const parsed = JSON.parse(trimmed)
      return typeof parsed === 'string' ? parsed : null
    } catch {
      return null
    }
  }

  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'")) return null
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }

  return trimmed
}

function parseCommandFile(content: string): ParsedCommandFile | null {
  const lines = content.split(/\r?\n/)
  const metadata: CommandMetadata = {}
  let bodyStart = 0

  if (lines[0] === '---') {
    const closingIndex = lines.findIndex((line, index) => index > 0 && line === '---')
    if (closingIndex < 0) return null

    const seenFields = new Set<string>()
    for (const line of lines.slice(1, closingIndex)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue
      const field = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line)
      if (!field) return null

      const key = field[1].toLowerCase()
      if (!['name', 'description', 'argument-hint'].includes(key)) continue
      if (seenFields.has(key)) return null
      seenFields.add(key)

      const value = parseQuotedMetadataValue(field[2])
      if (value === null || /[\0\r\n]/.test(value)) return null
      if (key === 'name') metadata.name = value
      if (key === 'description') metadata.description = value
      if (key === 'argument-hint') metadata.argumentHint = value
    }
    bodyStart = closingIndex + 1
  }

  const template = lines.slice(bodyStart).join('\n').trim()
  return template ? { metadata, template } : null
}

function commandLeafName(metadataName: string | undefined, path: string): string | null {
  const fileName = path.split('/').at(-1)
  if (!fileName) return null
  const fallbackName = fileName.slice(0, -COMMAND_FILE_SUFFIX.length)
  const requestedName = (metadataName ?? fallbackName).trim()
  const withoutNamespace = requestedName.startsWith(COMMAND_NAMESPACE)
    ? requestedName.slice(COMMAND_NAMESPACE.length)
    : requestedName
  const normalized = withoutNamespace.toLowerCase()
  return COMMAND_NAME_PATTERN.test(normalized) ? normalized : null
}

function createCommandId(workspacePath: string, commandPath: string): string {
  const digest = createHash('sha256')
    .update(workspacePath)
    .update('\0')
    .update(commandPath)
    .digest('base64url')
  return `workspace-command:${digest}`
}

function createCommandRevision(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function tokenizeArguments(source: string): string[] {
  const tokens: string[] = []
  let token = ''
  let tokenStarted = false
  let quote: "'" | '"' | null = null

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quote === "'") {
      if (character === "'") quote = null
      else token += character
      continue
    }

    if (quote === '"') {
      if (character === '"') {
        quote = null
      } else if (character === '\\') {
        index += 1
        if (index >= source.length) {
          throw new CommandError({
            code: 'INVALID_ARGUMENTS',
            identifier: 'incomplete-escape',
          })
        }
        const escaped = source[index]
        if (escaped === '\n') continue
        token += ['$', '`', '"', '\\'].includes(escaped) ? escaped : `\\${escaped}`
      } else {
        token += character
      }
      continue
    }

    if (/\s/u.test(character)) {
      if (tokenStarted) {
        tokens.push(token)
        token = ''
        tokenStarted = false
      }
      continue
    }

    tokenStarted = true
    if (character === "'" || character === '"') {
      quote = character
    } else if (character === '\\') {
      index += 1
      if (index >= source.length) {
        throw new CommandError({ code: 'INVALID_ARGUMENTS', identifier: 'incomplete-escape' })
      }
      token += source[index]
    } else {
      token += character
    }
  }

  if (quote) {
    throw new CommandError({ code: 'INVALID_ARGUMENTS', identifier: 'unclosed-quote' })
  }
  if (tokenStarted) tokens.push(token)
  return tokens
}

function parseArguments(source: string): ParsedArguments {
  const positional: string[] = []
  const named = new Map<string, string>()
  for (const token of tokenizeArguments(source)) {
    const assignment = NAMED_ARGUMENT_PATTERN.exec(token)
    if (assignment) named.set(assignment[1], assignment[2])
    else positional.push(token)
  }
  return { raw: source.trim(), positional, named }
}

function expandTemplate(template: string, args: ParsedArguments): string {
  let expanded = ''
  for (let index = 0; index < template.length; index += 1) {
    const character = template[index]
    if (character !== '$') {
      expanded += character
      continue
    }

    const next = template[index + 1]
    if (next === '$') {
      expanded += '$'
      index += 1
      continue
    }
    if (next && /[1-9]/.test(next)) {
      expanded += args.positional[Number(next) - 1] ?? ''
      index += 1
      continue
    }

    const variable = /^[A-Z][A-Z0-9_]*/.exec(template.slice(index + 1))?.[0]
    if (!variable) {
      expanded += '$'
      continue
    }
    expanded += variable === 'ARGUMENTS' ? args.raw : (args.named.get(variable) ?? '')
    index += variable.length
  }

  if (expanded.length > MAX_AGENT_MESSAGE_CHARACTERS) {
    throw new CommandError({
      code: 'EXPANSION_TOO_LARGE',
      maximumCharacters: MAX_AGENT_MESSAGE_CHARACTERS,
    })
  }
  return expanded
}

/** Discovers and safely expands prompt commands from the currently open workspace. */
export class CommandService {
  constructor(private readonly workspace: WorkspaceService) {}

  async listSlashCommands(): Promise<SlashCommandDescriptor[]> {
    return (await this.discover()).map(({ descriptor }) => descriptor)
  }

  async expandSlashCommand(input: ExpandSlashCommandInput): Promise<SlashCommandExpansion> {
    const command = (await this.discover()).find(({ descriptor }) => descriptor.id === input.id)
    if (!command) {
      throw new CommandError({ code: 'COMMAND_NOT_FOUND' })
    }
    if (command.descriptor.revision !== input.revision) {
      throw new CommandError({ code: 'COMMAND_CHANGED' })
    }
    return {
      id: command.descriptor.id,
      prompt: expandTemplate(command.template, parseArguments(input.arguments)),
    }
  }

  private async discover(): Promise<DiscoveredCommand[]> {
    const workspaceAtStart = this.workspace.getWorkspace()
    if (!workspaceAtStart) return []

    const paths = await this.workspace.listFiles({
      extensions: [COMMAND_FILE_SUFFIX],
      maxFiles: MAX_COMMAND_FILES,
    })
    const discovered: DiscoveredCommand[] = []
    const names = new Set<string>()
    const ids = new Set<string>()

    for (const path of paths) {
      if (!isSafeRelativeCommandPath(path)) continue
      let content: string
      try {
        content = (
          await this.workspace.readFile(path, { maxBytes: MAX_COMMAND_BYTES, truncate: false })
        ).content
      } catch {
        continue
      }

      const parsed = parseCommandFile(content)
      const leafName = parsed ? commandLeafName(parsed.metadata.name, path) : null
      if (!parsed || !leafName) continue

      const name = `${COMMAND_NAMESPACE}${leafName}`
      const id = createCommandId(workspaceAtStart.path, path)
      if (names.has(name) || ids.has(id)) continue
      const description = parsed.metadata.description?.trim() ?? ''
      const argumentHint = parsed.metadata.argumentHint?.trim() || null
      if (
        description.length > MAX_DESCRIPTION_CHARACTERS ||
        (argumentHint?.length ?? 0) > MAX_ARGUMENT_HINT_CHARACTERS
      ) {
        continue
      }

      names.add(name)
      ids.add(id)
      discovered.push({
        descriptor: {
          id,
          revision: createCommandRevision(content),
          name,
          description,
          argumentHint,
          path,
          source: 'workspace',
        },
        template: parsed.template,
      })
    }

    if (this.workspace.getWorkspace()?.path !== workspaceAtStart.path) {
      throw new CommandError({ code: 'WORKSPACE_CHANGED' })
    }

    return discovered.sort(
      (left, right) =>
        left.descriptor.name.localeCompare(right.descriptor.name) ||
        left.descriptor.path.localeCompare(right.descriptor.path),
    )
  }
}
