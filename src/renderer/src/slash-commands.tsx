import { Command, FileText, SearchX } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useI18n } from './i18n'
import './slash-commands.css'

/**
 * Renderer-friendly superset of the serializable command descriptor.
 *
 * The shared descriptor can be passed here directly. Renderer-only properties are optional so
 * commands discovered at runtime do not need to know anything about React.
 */
export interface RuntimeSlashCommand {
  id: string
  name: string
  description: string
  argumentHint?: string | null
  path?: string
  source: string
  category?: string
  aliases?: readonly string[]
  keywords?: readonly string[]
  icon?: ReactNode
  sourceLabel?: string
  disabled?: boolean
  disabledReason?: string
}

export interface SlashCommandInvocation {
  /** Index of the slash in the complete composer value. */
  start: number
  /** End of the command token, excluding any arguments. */
  end: number
  /** Cursor position used while parsing. */
  cursor: number
  /** Complete slash-prefixed command token, including text after the cursor. */
  raw: string
  /** Command name typed before the cursor, without the leading slash. */
  query: string
  /** Text following the first argument separator and preceding the cursor. */
  argumentText: string
  /** True as soon as whitespace is entered after the command name. */
  hasArgumentSeparator: boolean
}

export interface RankedSlashCommand {
  command: RuntimeSlashCommand
  score: number
  originalIndex: number
  matchedOn: 'name' | 'alias' | 'metadata' | 'all'
}

export type SlashCommandKeyAction = 'next' | 'previous' | 'select' | 'dismiss' | null

export interface SlashCommandSelectionResult {
  value: string
  cursor: number
}

export interface ParseSlashInvocationOptions {
  /** Allow a slash after conversational text. Defaults to false to match command execution. */
  allowInline?: boolean
}

const normalizeSearchText = (value: string): string => value.normalize('NFKC').trim().toLowerCase()

export const normalizeSlashCommandName = (name: string): string =>
  normalizeSearchText(name).replace(/^\/+/, '')

/**
 * Finds a slash invocation at the cursor. By default, only the first non-whitespace token can be a
 * command; inline invocations can be enabled explicitly. A slash must still follow whitespace or
 * begin the value, which avoids opening the palette for URLs and filesystem paths.
 */
export const parseSlashInvocation = (
  value: string,
  requestedCursor: number = value.length,
  { allowInline = false }: ParseSlashInvocationOptions = {},
): SlashCommandInvocation | null => {
  const cursor = Math.max(0, Math.min(requestedCursor, value.length))
  const beforeCursor = value.slice(0, cursor)
  let slash = -1
  if (allowInline) {
    for (
      let candidate = beforeCursor.lastIndexOf('/');
      candidate >= 0;
      candidate = beforeCursor.lastIndexOf('/', candidate - 1)
    ) {
      if (candidate === 0 || /\s/u.test(value[candidate - 1] ?? '')) {
        slash = candidate
        break
      }
    }
  } else {
    const firstToken = beforeCursor.search(/\S/u)
    if (firstToken >= 0 && value[firstToken] === '/') slash = firstToken
  }
  if (slash < 0) return null

  const typedBody = beforeCursor.slice(slash + 1)
  if (/[\r\n]/u.test(typedBody)) return null

  const separator = typedBody.search(/\s/u)
  const query = separator < 0 ? typedBody : typedBody.slice(0, separator)
  if (query.includes('/')) return null
  const argumentText = separator < 0 ? '' : typedBody.slice(separator).trimStart()
  let commandEnd = separator < 0 ? cursor : slash + 1 + separator

  if (separator < 0) {
    while (commandEnd < value.length && !/\s/u.test(value[commandEnd] ?? '')) commandEnd += 1
  }

  const raw = value.slice(slash, commandEnd)
  if (raw.slice(1).includes('/')) return null

  return {
    start: slash,
    end: commandEnd,
    cursor,
    raw,
    query,
    argumentText,
    hasArgumentSeparator: separator >= 0,
  }
}

/** Returns a fuzzy subsequence score, or -1 when the query does not match. */
export const scoreFuzzyMatch = (candidateValue: string, queryValue: string): number => {
  const candidate = normalizeSearchText(candidateValue)
  const query = normalizeSearchText(queryValue)
  if (!query) return 0
  if (!candidate) return -1

  let candidateIndex = 0
  let previousMatch = -2
  let score = 0

  for (const queryCharacter of query) {
    const matchIndex = candidate.indexOf(queryCharacter, candidateIndex)
    if (matchIndex < 0) return -1

    const adjacent = matchIndex === previousMatch + 1
    const wordBoundary = matchIndex === 0 || /[:._\-/\s]/u.test(candidate[matchIndex - 1] ?? '')
    score += adjacent ? 9 : 3
    if (wordBoundary) score += 7
    score -= Math.min(matchIndex - candidateIndex, 4)
    previousMatch = matchIndex
    candidateIndex = matchIndex + 1
  }

  return score - Math.max(0, candidate.length - query.length) * 0.08
}

const scoreField = (candidate: string, query: string, baseScore: number): number => {
  const normalizedCandidate = normalizeSearchText(candidate)
  if (!normalizedCandidate) return -1
  if (normalizedCandidate === query) return baseScore + 320
  if (normalizedCandidate.startsWith(query))
    return baseScore + 230 - normalizedCandidate.length * 0.1

  const segmentMatch = normalizedCandidate
    .split(/[:._\-/\s]+/u)
    .some((segment) => segment.startsWith(query))
  if (segmentMatch) return baseScore + 165

  const containedAt = normalizedCandidate.indexOf(query)
  if (containedAt >= 0) return baseScore + 115 - Math.min(containedAt, 30)

  const fuzzyScore = scoreFuzzyMatch(normalizedCandidate, query)
  return fuzzyScore < 0 ? -1 : baseScore + fuzzyScore
}

/** Scores one command without mutating it. A negative score means it should be filtered out. */
export const scoreSlashCommand = (
  command: RuntimeSlashCommand,
  rawQuery: string,
): Omit<RankedSlashCommand, 'command' | 'originalIndex'> => {
  const query = normalizeSlashCommandName(rawQuery)
  if (!query) return { score: 0, matchedOn: 'all' }

  let bestScore = scoreField(normalizeSlashCommandName(command.name), query, 700)
  let matchedOn: RankedSlashCommand['matchedOn'] = 'name'

  for (const alias of command.aliases ?? []) {
    const aliasScore = scoreField(normalizeSlashCommandName(alias), query, 610)
    if (aliasScore > bestScore) {
      bestScore = aliasScore
      matchedOn = 'alias'
    }
  }

  const metadata = [
    command.description,
    command.category,
    command.source,
    command.sourceLabel,
    command.path,
    ...(command.keywords ?? []),
  ]
    .filter((item): item is string => Boolean(item))
    .join(' ')
  const metadataScore = scoreField(metadata, query, 120)
  if (metadataScore > bestScore) {
    bestScore = metadataScore
    matchedOn = 'metadata'
  }

  return { score: bestScore, matchedOn }
}

/** Stable, deterministic ranking suitable for both the palette and unit tests. */
export const rankSlashCommands = (
  commands: readonly RuntimeSlashCommand[],
  query: string,
): RankedSlashCommand[] =>
  commands
    .map((command, originalIndex) => ({
      command,
      originalIndex,
      ...scoreSlashCommand(command, query),
    }))
    .filter((result) => result.score >= 0)
    .sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex)

export const filterAndRankSlashCommands = (
  commands: readonly RuntimeSlashCommand[],
  query: string,
  limit = 12,
): RuntimeSlashCommand[] =>
  rankSlashCommands(commands, query)
    .slice(0, Math.max(0, limit))
    .map(({ command }) => command)

export const firstEnabledSlashCommandIndex = (
  commands: readonly Pick<RuntimeSlashCommand, 'disabled'>[],
): number => commands.findIndex((command) => !command.disabled)

/** Wraps in either direction and skips disabled options. */
export const nextEnabledSlashCommandIndex = (
  commands: readonly Pick<RuntimeSlashCommand, 'disabled'>[],
  activeIndex: number,
  direction: 1 | -1,
): number => {
  if (commands.length === 0 || commands.every((command) => command.disabled)) return -1

  let index = activeIndex
  if (index < 0 || index >= commands.length) index = direction === 1 ? -1 : 0

  for (let visited = 0; visited < commands.length; visited += 1) {
    index = (index + direction + commands.length) % commands.length
    if (!commands[index]?.disabled) return index
  }

  return -1
}

export const resolveSlashCommandKeyAction = ({
  key,
  open,
  itemCount,
  activeIndex,
  composing = false,
}: {
  key: string
  open: boolean
  itemCount: number
  activeIndex: number
  composing?: boolean
}): SlashCommandKeyAction => {
  if (!open || composing) return null
  if (key === 'Escape') return 'dismiss'
  if (key === 'ArrowDown' && itemCount > 0) return 'next'
  if (key === 'ArrowUp' && itemCount > 0) return 'previous'
  if ((key === 'Enter' || key === 'Tab') && activeIndex >= 0) return 'select'
  return null
}

export const applySlashCommandSelection = (
  value: string,
  invocation: SlashCommandInvocation,
  command: Pick<RuntimeSlashCommand, 'name' | 'argumentHint'>,
  options: { appendSpace?: boolean } = {},
): SlashCommandSelectionResult => {
  const commandText = `/${normalizeSlashCommandName(command.name)}`
  const appendSpace = options.appendSpace ?? Boolean(command.argumentHint)
  const suffix = appendSpace && !/^\s/u.test(value.slice(invocation.end)) ? ' ' : ''
  const nextValue = `${value.slice(0, invocation.start)}${commandText}${suffix}${value.slice(invocation.end)}`

  return {
    value: nextValue,
    cursor: invocation.start + commandText.length + suffix.length,
  }
}

export const formatSlashCommandBadge = (value: string): string =>
  value
    .trim()
    .split(/[-_:]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')

export interface SlashCommandPaletteProps {
  commands: readonly RuntimeSlashCommand[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelect: (command: RuntimeSlashCommand) => void
  listboxId: string
  query?: string
  className?: string
  emptyMessage?: ReactNode
}

export function SlashCommandPalette({
  commands,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  listboxId,
  query = '',
  className = '',
  emptyMessage,
}: SlashCommandPaletteProps) {
  const { t, formatNumber } = useI18n()
  const optionsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (activeIndex < 0) return
    const activeOption = optionsRef.current?.querySelector<HTMLElement>(
      `[data-option-index="${activeIndex}"]`,
    )
    activeOption?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <section
      className={`slash-command-palette${className ? ` ${className}` : ''}`}
      aria-label={t('slash.palette')}
      onMouseDown={(event) => event.preventDefault()}
    >
      <header className="slash-command-header">
        <div>
          <Command size={14} aria-hidden="true" />
          <strong>{t('slash.commands')}</strong>
          <span>{formatNumber(commands.length)}</span>
        </div>
        <div className="slash-command-key-hints" aria-hidden="true">
          <kbd>↑↓</kbd>
          <span>{t('slash.move')}</span>
          <kbd>Enter</kbd>
          <span>{t('slash.select')}</span>
          <kbd>Esc</kbd>
          <span>{t('slash.close')}</span>
        </div>
      </header>

      <div
        ref={optionsRef}
        id={listboxId}
        className="slash-command-options"
        role="listbox"
        aria-label={t('slash.availableCommands')}
      >
        {commands.length > 0 ? (
          commands.map((command, index) => {
            const active = index === activeIndex
            const commandName = normalizeSlashCommandName(command.name)
            const optionId = `${listboxId}-option-${index}`
            const sourceLabel = command.sourceLabel ?? formatSlashCommandBadge(command.source)

            return (
              <button
                type="button"
                role="option"
                id={optionId}
                key={command.id}
                className="slash-command-option"
                aria-selected={active}
                aria-disabled={command.disabled || undefined}
                disabled={command.disabled}
                data-active={active}
                data-option-index={index}
                tabIndex={-1}
                title={command.disabledReason ?? command.path}
                onPointerMove={() => {
                  if (!command.disabled && !active) onActiveIndexChange(index)
                }}
                onClick={() => onSelect(command)}
              >
                <span className="slash-command-icon" aria-hidden="true">
                  {command.icon ??
                    (command.source === 'workspace' ? (
                      <FileText size={16} />
                    ) : (
                      <Command size={16} />
                    ))}
                </span>
                <span className="slash-command-copy">
                  <span className="slash-command-title-row">
                    <code>/{commandName}</code>
                    {command.argumentHint && (
                      <span className="slash-command-argument">{command.argumentHint}</span>
                    )}
                  </span>
                  <span className="slash-command-description">
                    {command.disabledReason ?? command.description}
                  </span>
                </span>
                <span className="slash-command-badges">
                  {command.category && (
                    <span className="slash-command-badge category">{command.category}</span>
                  )}
                  <span className="slash-command-badge source">{sourceLabel}</span>
                </span>
              </button>
            )
          })
        ) : (
          <div className="slash-command-empty" role="status">
            {emptyMessage ?? (
              <>
                <span className="slash-command-empty-icon" aria-hidden="true">
                  <SearchX size={19} />
                </span>
                <div>
                  <strong>{t('slash.empty.title')}</strong>
                  <p>
                    {query ? (
                      <>
                        <code>/{query}</code>
                        {t('slash.empty.querySuffix')}
                      </>
                    ) : (
                      t('slash.empty.unavailable')
                    )}
                  </p>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

export interface UseSlashCommandPaletteOptions {
  value: string
  commands: readonly RuntimeSlashCommand[]
  onSelect: (command: RuntimeSlashCommand, invocation: SlashCommandInvocation) => void
  cursor?: number
  disabled?: boolean
  maxResults?: number
}

export interface SlashCommandInputAriaProps {
  role: 'combobox'
  'aria-autocomplete': 'list'
  'aria-haspopup': 'listbox'
  'aria-expanded': boolean
  'aria-controls'?: string
  'aria-activedescendant'?: string
}

export interface UseSlashCommandPaletteResult {
  invocation: SlashCommandInvocation | null
  query: string
  commands: RuntimeSlashCommand[]
  activeIndex: number
  activeCommand: RuntimeSlashCommand | null
  isOpen: boolean
  listboxId: string
  inputProps: SlashCommandInputAriaProps
  setActiveIndex: (index: number) => void
  dismiss: () => void
  selectCommand: (command: RuntimeSlashCommand) => void
  handleKeyDown: (event: KeyboardEvent<HTMLElement>) => boolean
  paletteProps: SlashCommandPaletteProps
}

/**
 * Owns filtering, active-option state, dismissal, keyboard controls and combobox ARIA wiring.
 * Call handleKeyDown before the composer's normal Enter-to-send behavior.
 */
export function useSlashCommandPalette({
  value,
  commands,
  onSelect,
  cursor = value.length,
  disabled = false,
  maxResults = 12,
}: UseSlashCommandPaletteOptions): UseSlashCommandPaletteResult {
  const generatedId = useId()
  const listboxId = `slash-command-listbox-${generatedId.replace(/:/g, '')}`
  const invocation = useMemo(() => parseSlashInvocation(value, cursor), [cursor, value])
  const query = invocation?.query ?? ''
  const filteredCommands = useMemo(
    () => filterAndRankSlashCommands(commands, query, maxResults),
    [commands, maxResults, query],
  )
  const invocationSignature = invocation
    ? `${invocation.start}:${invocation.end}:${invocation.raw}`
    : null
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null)
  const selectionSignature = `${query}\u001f${filteredCommands
    .map((command) => `${command.id}:${Boolean(command.disabled)}`)
    .join('\u001e')}`
  const [activeSelection, setActiveSelection] = useState<{ signature: string; index: number }>(
    () => ({
      signature: selectionSignature,
      index: firstEnabledSlashCommandIndex(filteredCommands),
    }),
  )
  const activeIndex =
    activeSelection.signature === selectionSignature
      ? activeSelection.index
      : firstEnabledSlashCommandIndex(filteredCommands)
  const setActiveIndex = useCallback(
    (index: number) => setActiveSelection({ signature: selectionSignature, index }),
    [selectionSignature],
  )
  const canOpen = Boolean(invocation && !invocation.hasArgumentSeparator && !disabled)
  const isOpen = canOpen && invocationSignature !== dismissedSignature

  const dismiss = useCallback(() => {
    setDismissedSignature(invocationSignature)
  }, [invocationSignature])

  const selectCommand = useCallback(
    (command: RuntimeSlashCommand) => {
      if (!invocation || command.disabled) return
      setDismissedSignature(invocationSignature)
      onSelect(command, invocation)
    },
    [invocation, invocationSignature, onSelect],
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): boolean => {
      const action = resolveSlashCommandKeyAction({
        key: event.key,
        open: isOpen,
        itemCount: filteredCommands.length,
        activeIndex,
        composing: event.nativeEvent.isComposing,
      })
      if (!action) return false

      event.preventDefault()
      event.stopPropagation()

      if (action === 'dismiss') {
        dismiss()
      } else if (action === 'next' || action === 'previous') {
        setActiveIndex(
          nextEnabledSlashCommandIndex(filteredCommands, activeIndex, action === 'next' ? 1 : -1),
        )
      } else {
        const activeCommand = filteredCommands[activeIndex]
        if (activeCommand) selectCommand(activeCommand)
      }

      return true
    },
    [activeIndex, dismiss, filteredCommands, isOpen, selectCommand, setActiveIndex],
  )

  const activeCommand = filteredCommands[activeIndex] ?? null
  const activeDescendant =
    isOpen && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
  const inputProps: SlashCommandInputAriaProps = {
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-haspopup': 'listbox',
    'aria-expanded': isOpen,
    'aria-controls': isOpen ? listboxId : undefined,
    'aria-activedescendant': activeDescendant,
  }

  return {
    invocation,
    query,
    commands: filteredCommands,
    activeIndex,
    activeCommand,
    isOpen,
    listboxId,
    inputProps,
    setActiveIndex,
    dismiss,
    selectCommand,
    handleKeyDown,
    paletteProps: {
      commands: filteredCommands,
      activeIndex,
      onActiveIndexChange: setActiveIndex,
      onSelect: selectCommand,
      listboxId,
      query,
    },
  }
}
