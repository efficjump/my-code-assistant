import {
  type BuiltinLocalCommand,
  findBuiltinSlashCommand,
  localizeBuiltinSlashCommands,
  parseSingleCommandArgument,
} from '@shared/builtin-commands'
import {
  type AgentEvent,
  type AgentRunIntent,
  type AppLocale,
  type ApprovalRequest,
  type ApprovalScope,
  type AppSettings,
  type BootstrapState,
  type CommandApprovalRule,
  type ConversationDetail,
  type ConversationMessageRecord,
  type ConversationSummary,
  type CreateGoalInput,
  type FileChangeOperation,
  type FilePreview,
  type GitDiffResult,
  type GitStatusResult,
  type GoalDetail,
  type GoalStatus,
  type GoalSummary,
  MAX_AGENT_RUN_TIMEOUT_MINUTES,
  MAX_TOTAL_TOOL_CALLS,
  type ModelOption,
  type MutateGoalInput,
  type ProviderInput,
  type ProviderSummary,
  type ReadinessActionId,
  type ReadinessItemId,
  type ReadinessItemStatus,
  type ReadinessSnapshot,
  type RunUsage,
  type SkillDescriptor,
  type SlashCommandDescriptor,
  type UndoStatus,
  type WorkspaceApprovalPolicyConfiguration,
  type WorkspaceEntry,
  type WorkspaceSummary,
} from '@shared/contracts'
import { buildReadinessSnapshot } from '@shared/readiness'
import {
  type ClassifiedToolActivity,
  summarizeToolActivity,
  type ToolActivityEvidence,
  type ToolRunStatus,
} from '@shared/tool-activity'
import {
  AlertCircle,
  Archive,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Code2,
  Copy,
  Eye,
  File,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  GitFork,
  History,
  KeyRound,
  LoaderCircle,
  Menu,
  MessageSquareCode,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sun,
  Target,
  Terminal,
  Trash2,
  Undo2,
  Wrench,
  X,
  XCircle,
} from 'lucide-react'
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { GoalsModal } from './goals'
import {
  I18nProvider,
  persistAppLocaleHint,
  readInitialAppLocale,
  type TranslationKey,
  useI18n,
} from './i18n'
import { useModalFocus } from './modal-focus'
import { useRuntimeMessages } from './runtime-messages'
import { useSettingsMessages } from './settings-messages'
import {
  applySlashCommandSelection,
  normalizeSlashCommandName,
  parseSlashInvocation,
  type RuntimeSlashCommand,
  SlashCommandPalette,
  useSlashCommandPalette,
} from './slash-commands'

type RunStatus = ToolRunStatus
type ToolActivity = ToolActivityEvidence

const OPEN_GOAL_STATUSES = ['active', 'paused', 'blocked'] as const satisfies readonly GoalStatus[]

interface UserMessage {
  id: string
  role: 'user'
  content: string
  contextPaths: string[]
}

interface AssistantMessage {
  id: string
  role: 'assistant'
  runId: string | null
  content: string
  tools: ToolActivity[]
  status: RunStatus
  error?: string
  warning?: string
  commandOutputs: CommandOutput[]
  usage?: RunUsage
  changedPaths: string[]
}

interface CommandOutput {
  callId: string
  stdout: string
  stderr: string
}

type ConversationMessage = UserMessage | AssistantMessage

interface Notice {
  type: 'success' | 'error'
  message: string
}

interface PendingApproval {
  runId: string
  request: ApprovalRequest
}

const makeId = (): string => crypto.randomUUID()

const fileIcon = (name: string): ReactNode => {
  const extension = name.split('.').pop()?.toLocaleLowerCase()
  if (extension === 'json' || extension === 'jsonc') return <FileJson size={15} />
  if (
    extension &&
    ['ts', 'tsx', 'js', 'jsx', 'css', 'html', 'py', 'java', 'go', 'rs', 'kt', 'swift'].includes(
      extension,
    )
  ) {
    return <FileCode2 size={15} />
  }
  if (extension && ['md', 'mdx', 'txt', 'rst'].includes(extension)) return <FileText size={15} />
  return <File size={15} />
}

const compactPath = (path: string): string => {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
}

const toPreviewLines = (content: string): Array<{ key: string; content: string }> => {
  let offset = 0
  return content.split('\n').map((line) => {
    const key = `${offset}:${line.slice(0, 24)}`
    offset += line.length + 1
    return { key, content: line }
  })
}

type WorkspaceDirectoryStatus = 'unloaded' | 'loading' | 'loaded' | 'partial' | 'error'

interface WorkspaceDirectoryState {
  status: WorkspaceDirectoryStatus
  entries: WorkspaceEntry[]
  nextCursor: string | null
  retryCursor: string | null
  loadingMore: boolean
  error: string | null
}

type WorkspaceDirectoryStates = Readonly<Record<string, WorkspaceDirectoryState>>

const WORKSPACE_ROOT_KEY = ''

const emptyWorkspaceDirectoryState = (): WorkspaceDirectoryState => ({
  status: 'unloaded',
  entries: [],
  nextCursor: null,
  retryCursor: null,
  loadingMore: false,
  error: null,
})

const workspaceDirectoryKey = (path: string | null): string => path ?? WORKSPACE_ROOT_KEY

const mergeWorkspaceEntries = (
  current: readonly WorkspaceEntry[],
  incoming: readonly WorkspaceEntry[],
): WorkspaceEntry[] => {
  const merged = new Map(current.map((entry) => [entry.path, entry]))
  for (const entry of incoming) merged.set(entry.path, entry)
  return [...merged.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

const loadedWorkspaceFiles = (directories: WorkspaceDirectoryStates): WorkspaceEntry[] => {
  const files = new Map<string, WorkspaceEntry>()
  for (const state of Object.values(directories)) {
    for (const entry of state.entries) {
      if (entry.kind === 'file') files.set(entry.path, entry)
    }
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path))
}

const workspaceSearchPaths = (
  rootEntries: readonly WorkspaceEntry[],
  directories: WorkspaceDirectoryStates,
  query: string,
): ReadonlySet<string> | null => {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return null

  const visible = new Set<string>()
  const visit = (entry: WorkspaceEntry): boolean => {
    const ownMatch = entry.name.toLocaleLowerCase().includes(normalized)
    if (entry.kind === 'file') {
      if (ownMatch) visible.add(entry.path)
      return ownMatch
    }

    const state = directories[entry.path]
    const descendantMatch = state?.entries.some(visit) ?? false
    const mayContainUnloadedMatches =
      entry.hasChildren &&
      (!state ||
        state.status === 'unloaded' ||
        state.status === 'loading' ||
        state.status === 'partial')
    const matches = ownMatch || descendantMatch || mayContainUnloadedMatches
    if (matches) visible.add(entry.path)
    return matches
  }

  for (const entry of rootEntries) visit(entry)
  return visible
}

const toKeyedArguments = (argv: readonly string[]): Array<{ argument: string; key: string }> => {
  const occurrences = new Map<string, number>()
  return argv.map((argument) => {
    const occurrence = occurrences.get(argument) ?? 0
    occurrences.set(argument, occurrence + 1)
    return { argument, key: `${argument}\u0000${occurrence}` }
  })
}

const toRunStatus = (message: ConversationMessageRecord): RunStatus => {
  if (message.status === 'pending') return 'starting'
  return message.status
}

const toConversationMessages = (detail: ConversationDetail): ConversationMessage[] =>
  detail.messages.map((message) =>
    message.role === 'user'
      ? {
          id: message.id,
          role: 'user' as const,
          content: message.content,
          contextPaths: message.contextPaths,
        }
      : {
          id: message.id,
          role: 'assistant' as const,
          runId: message.runId,
          content: message.content,
          tools: message.tools,
          status: toRunStatus(message),
          error: message.status === 'interrupted' ? undefined : (message.error ?? undefined),
          warning: message.status === 'interrupted' ? (message.error ?? undefined) : undefined,
          commandOutputs: [],
          usage: message.usage ?? undefined,
          changedPaths: message.changedPaths,
        },
  )

function IconButton({
  label,
  children,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  )
}

function LoadingScreen() {
  const { t } = useI18n()
  return (
    <main className="splash-screen" aria-busy="true">
      <div className="brand-mark brand-mark-large">
        <Code2 size={25} strokeWidth={2.2} />
      </div>
      <div>
        <h1>Code Assistant</h1>
        <p>{t('app.loading.preparing')}</p>
      </div>
      <LoaderCircle className="spin" size={19} aria-hidden="true" />
    </main>
  )
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n()
  return (
    <main className="center-screen">
      <div className="state-card error-state" role="alert">
        <div className="state-icon danger">
          <AlertCircle size={24} />
        </div>
        <h1>{t('app.error.start')}</h1>
        <p>{message}</p>
        <button type="button" className="primary-button" onClick={onRetry}>
          <RefreshCw size={16} /> {t('app.error.retry')}
        </button>
      </div>
    </main>
  )
}

function ExplorerNode({
  entry,
  depth,
  directories,
  expandedPaths,
  searchPaths,
  selectedPath,
  contextPaths,
  onToggleDirectory,
  onLoadMore,
  onRetryDirectory,
  onOpen,
}: {
  entry: WorkspaceEntry
  depth: number
  directories: WorkspaceDirectoryStates
  expandedPaths: ReadonlySet<string>
  searchPaths: ReadonlySet<string> | null
  selectedPath: string | null
  contextPaths: string[]
  onToggleDirectory: (entry: Extract<WorkspaceEntry, { kind: 'directory' }>) => void
  onLoadMore: (path: string | null, cursor: string) => void
  onRetryDirectory: (path: string | null) => void
  onOpen: (entry: WorkspaceEntry) => void
}) {
  const { t } = useI18n()
  const directory = entry.kind === 'directory'
  const expanded = directory && expandedPaths.has(entry.path)
  const selected = entry.path === selectedPath
  const inContext = contextPaths.includes(entry.path)
  const directoryState = directory
    ? (directories[entry.path] ?? {
        ...emptyWorkspaceDirectoryState(),
        status: entry.hasChildren ? 'unloaded' : 'loaded',
      })
    : null
  const visibleChildren =
    directoryState?.entries.filter((child) => !searchPaths || searchPaths.has(child.path)) ?? []

  const activate = () => {
    if (directory) onToggleDirectory(entry)
    else onOpen(entry)
  }

  return (
    <li>
      <button
        type="button"
        className={`tree-row${selected ? ' selected' : ''}`}
        style={{ paddingInlineStart: `${10 + depth * 14}px` }}
        onClick={activate}
        aria-expanded={directory ? expanded : undefined}
        title={entry.path}
      >
        <span className="tree-chevron" aria-hidden="true">
          {directory ? expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
        </span>
        <span className={`tree-icon${directory ? ' folder' : ''}`} aria-hidden="true">
          {directory ? (
            expanded ? (
              <FolderOpen size={15} />
            ) : (
              <Folder size={15} />
            )
          ) : (
            fileIcon(entry.name)
          )}
        </span>
        <span className="tree-name">{entry.name}</span>
        {inContext && <span className="context-dot" title={t('panel.explorer.inContext')} />}
      </button>
      {directory && expanded && directoryState && (
        <ul className="tree-list">
          {visibleChildren.map((child) => (
            <ExplorerNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              directories={directories}
              expandedPaths={expandedPaths}
              searchPaths={searchPaths}
              selectedPath={selectedPath}
              contextPaths={contextPaths}
              onToggleDirectory={onToggleDirectory}
              onLoadMore={onLoadMore}
              onRetryDirectory={onRetryDirectory}
              onOpen={onOpen}
            />
          ))}
          {directoryState.status === 'loading' && directoryState.entries.length === 0 && (
            <li
              className="tree-branch-state"
              style={{ paddingInlineStart: `${10 + (depth + 1) * 14}px` }}
            >
              <LoaderCircle className="spin" size={12} /> {t('panel.explorer.folderLoading')}
            </li>
          )}
          {directoryState.status === 'loaded' && directoryState.entries.length === 0 && (
            <li
              className="tree-branch-state"
              style={{ paddingInlineStart: `${10 + (depth + 1) * 14}px` }}
            >
              {t('panel.explorer.folderEmpty')}
            </li>
          )}
          {directoryState.status === 'error' && (
            <li
              className="tree-branch-state error"
              style={{ paddingInlineStart: `${10 + (depth + 1) * 14}px` }}
            >
              <AlertCircle size={12} />
              <button type="button" onClick={() => onRetryDirectory(entry.path)}>
                {t('panel.explorer.retryFolder')}
              </button>
            </li>
          )}
          {(directoryState.status === 'partial' || directoryState.loadingMore) &&
            directoryState.nextCursor && (
              <li
                className="tree-more-row"
                style={{ paddingInlineStart: `${10 + (depth + 1) * 14}px` }}
              >
                <button
                  type="button"
                  disabled={directoryState.loadingMore}
                  aria-label={t('panel.explorer.loadMoreFor', { path: entry.path })}
                  onClick={() => onLoadMore(entry.path, directoryState.nextCursor as string)}
                >
                  {directoryState.loadingMore ? (
                    <LoaderCircle className="spin" size={12} />
                  ) : (
                    <ChevronDown size={12} />
                  )}
                  {directoryState.loadingMore
                    ? t('panel.explorer.loadMoreLoading')
                    : t('panel.explorer.loadMore')}
                </button>
              </li>
            )}
        </ul>
      )}
    </li>
  )
}

function WorkspaceExplorer({
  bootstrap,
  directories,
  expandedPaths,
  selectedPath,
  contextPaths,
  onChooseWorkspace,
  onRefresh,
  onToggleDirectory,
  onLoadMore,
  onRetryDirectory,
  onOpenFile,
  onClose,
}: {
  bootstrap: BootstrapState
  directories: WorkspaceDirectoryStates
  expandedPaths: ReadonlySet<string>
  selectedPath: string | null
  contextPaths: string[]
  onChooseWorkspace: () => void
  onRefresh: () => void
  onToggleDirectory: (entry: Extract<WorkspaceEntry, { kind: 'directory' }>) => void
  onLoadMore: (path: string | null, cursor: string) => void
  onRetryDirectory: (path: string | null) => void
  onOpenFile: (entry: WorkspaceEntry) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const rootState = directories[WORKSPACE_ROOT_KEY] ?? emptyWorkspaceDirectoryState()
  const searchPaths = useMemo(
    () => workspaceSearchPaths(rootState.entries, directories, query),
    [directories, query, rootState.entries],
  )
  const filteredEntries = searchPaths
    ? rootState.entries.filter((entry) => searchPaths.has(entry.path))
    : rootState.entries
  const loading = rootState.status === 'loading'
  const blockingError = rootState.status === 'error' && rootState.entries.length === 0

  return (
    <aside
      id="workspace-explorer-panel"
      className="left-panel"
      aria-label={t('panel.explorer.label')}
    >
      <div className="panel-heading explorer-heading">
        <div className="heading-copy">
          <span className="eyebrow">{t('panel.explorer.eyebrow')}</span>
          <strong title={bootstrap.workspace?.path}>
            {bootstrap.workspace?.name ?? t('panel.explorer.none')}
          </strong>
        </div>
        <div className="panel-heading-actions">
          <IconButton
            label={bootstrap.workspace ? t('panel.explorer.change') : t('panel.explorer.open')}
            onClick={onChooseWorkspace}
          >
            <FolderOpen size={16} />
          </IconButton>
          <IconButton
            className="mobile-panel-close"
            label={t('panel.explorer.close')}
            onClick={onClose}
          >
            <PanelLeftClose size={16} />
          </IconButton>
        </div>
      </div>

      {bootstrap.workspace ? (
        <>
          <div className="explorer-tools">
            <label className="search-field">
              <Search size={14} aria-hidden="true" />
              <span className="sr-only">{t('panel.explorer.search')}</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('panel.explorer.search')}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label={t('panel.explorer.clearSearch')}
                >
                  <X size={13} />
                </button>
              )}
            </label>
            <IconButton label={t('panel.explorer.refresh')} onClick={onRefresh} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'spin' : ''} />
            </IconButton>
          </div>

          {query && (
            <p className="explorer-search-scope">
              <Search size={12} aria-hidden="true" />
              <span>{t('panel.explorer.searchScope')}</span>
            </p>
          )}

          <div className="explorer-scroll">
            {blockingError ? (
              <div className="inline-state" role="alert">
                <AlertCircle size={16} />
                <p>{rootState.error}</p>
                <button type="button" onClick={onRefresh}>
                  {t('common.retry')}
                </button>
              </div>
            ) : loading && rootState.entries.length === 0 ? (
              <div className="inline-loading">
                <LoaderCircle className="spin" size={16} /> {t('panel.explorer.loading')}
              </div>
            ) : filteredEntries.length > 0 ? (
              <ul className="tree-list root-tree">
                {filteredEntries.map((entry) => (
                  <ExplorerNode
                    key={entry.path}
                    entry={entry}
                    depth={0}
                    directories={directories}
                    expandedPaths={expandedPaths}
                    searchPaths={searchPaths}
                    selectedPath={selectedPath}
                    contextPaths={contextPaths}
                    onToggleDirectory={onToggleDirectory}
                    onLoadMore={onLoadMore}
                    onRetryDirectory={onRetryDirectory}
                    onOpen={onOpenFile}
                  />
                ))}
                {rootState.status === 'error' && (
                  <li className="tree-branch-state error">
                    <AlertCircle size={12} />
                    <button type="button" onClick={() => onRetryDirectory(null)}>
                      {t('common.retry')}
                    </button>
                  </li>
                )}
                {(rootState.status === 'partial' || rootState.loadingMore) &&
                  rootState.nextCursor && (
                    <li className="tree-more-row">
                      <button
                        type="button"
                        disabled={rootState.loadingMore}
                        aria-label={t('panel.explorer.loadMoreFor', {
                          path: bootstrap.workspace.path,
                        })}
                        onClick={() => onLoadMore(null, rootState.nextCursor as string)}
                      >
                        {rootState.loadingMore ? (
                          <LoaderCircle className="spin" size={12} />
                        ) : (
                          <ChevronDown size={12} />
                        )}
                        {rootState.loadingMore
                          ? t('panel.explorer.loadMoreLoading')
                          : t('panel.explorer.loadMore')}
                      </button>
                    </li>
                  )}
              </ul>
            ) : (
              <div className="inline-empty">
                <Search size={19} />
                <p>{query ? t('panel.explorer.noLoadedMatch') : t('panel.explorer.empty')}</p>
              </div>
            )}
          </div>
          <button type="button" className="workspace-path" onClick={onChooseWorkspace}>
            <Folder size={13} /> <span>{bootstrap.workspace.path}</span>
          </button>
        </>
      ) : (
        <div className="empty-explorer">
          <div className="state-icon subtle">
            <FolderOpen size={22} />
          </div>
          <h2>{t('panel.explorer.openProject')}</h2>
          <p>{t('panel.explorer.openProjectDescription')}</p>
          <button type="button" className="secondary-button" onClick={onChooseWorkspace}>
            <FolderOpen size={15} /> {t('panel.explorer.chooseFolder')}
          </button>
        </div>
      )}
    </aside>
  )
}

function ToolActivityRow({ activity }: { activity: ClassifiedToolActivity }) {
  const { t } = useI18n()
  const icon =
    activity.displayStatus === 'running' ? (
      <LoaderCircle className="spin" size={15} />
    ) : activity.displayStatus === 'completed' ? (
      <CheckCircle2 size={15} />
    ) : activity.displayStatus === 'recovered' ? (
      <RefreshCw size={14} />
    ) : (
      <XCircle size={15} />
    )

  const statusLabel =
    activity.displayStatus === 'running'
      ? t('tool.status.running')
      : activity.displayStatus === 'completed'
        ? t('tool.status.completed')
        : activity.displayStatus === 'recovered'
          ? t('tool.status.recovered')
          : t('tool.status.error')

  return (
    <li className={`tool-activity-row ${activity.displayStatus}`}>
      <span className="tool-activity-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="tool-activity-main">
        <strong>{activity.tool}</strong>
        <p>{activity.summary}</p>
      </div>
      <span className="tool-activity-status">{statusLabel}</span>
    </li>
  )
}

function ToolActivityDisclosure({
  activities,
  runStatus,
  changedPaths,
}: {
  activities: ToolActivity[]
  runStatus: RunStatus
  changedPaths: string[]
}) {
  const { t, formatNumber } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const detailId = useId()
  const summary = summarizeToolActivity(activities, runStatus, changedPaths)
  const statusParts = [
    summary.appliedFileCount > 0
      ? t('tool.count.filesApplied', {
          count: summary.appliedFileCount,
          formattedCount: formatNumber(summary.appliedFileCount),
        })
      : '',
    summary.runningCount > 0
      ? t('tool.count.running', { count: formatNumber(summary.runningCount) })
      : '',
    summary.unresolvedErrorCount > 0
      ? t('tool.count.error', { count: formatNumber(summary.unresolvedErrorCount) })
      : '',
    summary.recoveredCount > 0
      ? t('tool.count.recovered', { count: formatNumber(summary.recoveredCount) })
      : '',
    summary.completedCount > 0
      ? t('tool.count.completed', { count: formatNumber(summary.completedCount) })
      : '',
  ].filter(Boolean)
  const statusSummary = `${t('tool.count.total', {
    count: formatNumber(activities.length),
  })} · ${statusParts.join(' · ')}`
  const latestSummary = activities.at(-1)?.summary ?? ''
  const statusIcon =
    summary.outcome === 'running' ? (
      <LoaderCircle className="spin" size={14} />
    ) : summary.outcome === 'error' ? (
      <XCircle size={14} />
    ) : summary.outcome === 'warning' || summary.outcome === 'interrupted' ? (
      <AlertCircle size={14} />
    ) : summary.outcome === 'cancelled' ? (
      <CircleStop size={14} />
    ) : summary.outcome === 'recovered' ? (
      <RefreshCw size={14} />
    ) : (
      <CheckCircle2 size={14} />
    )
  const outcomeLabel = t(`tool.outcome.${summary.outcome}`)

  return (
    <div
      className={`tool-activity-disclosure ${summary.outcome}`}
      aria-busy={summary.outcome === 'running'}
    >
      <button
        type="button"
        className="tool-activity-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={detailId}
        aria-label={t('tool.history.toggle', {
          action: t(expanded ? 'tool.history.collapse' : 'tool.history.expand'),
          summary: statusSummary,
        })}
      >
        <span className="tool-activity-toggle-icon" aria-hidden="true">
          {statusIcon}
        </span>
        <strong>{t('tool.activity.outcome', { outcome: outcomeLabel })}</strong>
        <span className="tool-activity-count">{statusSummary}</span>
        <span className="tool-activity-preview" title={latestSummary}>
          {latestSummary}
        </span>
        <span className="tool-activity-chevron" aria-hidden="true">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {expanded && (
        <ol id={detailId} className="tool-activity-list" aria-label={t('tool.activity.details')}>
          {summary.activities.map((activity) => (
            <ToolActivityRow key={activity.callId} activity={activity} />
          ))}
        </ol>
      )}
    </div>
  )
}

function CommandOutputCard({ output }: { output: CommandOutput }) {
  const { t } = useI18n()
  const hasStderr = Boolean(output.stderr)
  const [expanded, setExpanded] = useState(false)
  const combined = [
    output.stdout ? `stdout\n${output.stdout}` : '',
    output.stderr ? `stderr\n${output.stderr}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  return (
    <div className={`command-output-card${hasStderr ? ' has-stderr' : ''}`}>
      <button
        type="button"
        className="command-output-heading"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <Terminal size={14} />
        <strong>{t('command.output.title')}</strong>
        <span>{output.callId}</span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {expanded && <pre>{combined}</pre>}
    </div>
  )
}

function RunMetadata({ message }: { message: AssistantMessage }) {
  const { t, formatNumber } = useI18n()
  if (!message.usage && message.changedPaths.length === 0) return null

  return (
    <div className="run-metadata">
      {message.changedPaths.length > 0 && (
        <span className="run-metadata-applied" title={message.changedPaths.join('\n')}>
          <FileCode2 size={12} />{' '}
          {t('run.filesChanged', {
            count: message.changedPaths.length,
            formattedCount: formatNumber(message.changedPaths.length),
          })}
        </span>
      )}
      {message.usage && (
        <span
          title={t('run.usage.title', {
            input: formatNumber(message.usage.inputTokens),
            output: formatNumber(message.usage.outputTokens),
            reasoning: formatNumber(message.usage.reasoningTokens),
          })}
        >
          <Sparkles size={12} />{' '}
          {t('run.tokens', {
            count: formatNumber(message.usage.totalTokens, {
              notation: message.usage.totalTokens >= 10_000 ? 'compact' : 'standard',
            }),
          })}
        </span>
      )}
    </div>
  )
}

function CopyAnswerButton({ content }: { content: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 1_800)
    return () => window.clearTimeout(timeout)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      className={`copy-answer-button${copied ? ' copied' : ''}`}
      onClick={() => void copy()}
      aria-label={t(copied ? 'conversation.answerCopied' : 'conversation.copyAnswer')}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      <span>{t(copied ? 'conversation.answerCopied' : 'conversation.copyAnswer')}</span>
    </button>
  )
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => <pre className="markdown-code-block">{children}</pre>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function Conversation({
  messages,
  running,
  readiness,
  onReadinessAction,
}: {
  messages: ConversationMessage[]
  running: boolean
  readiness: ReadinessSnapshot
  onReadinessAction: (actionId: ReadinessActionId) => void
}) {
  const { t } = useI18n()
  const endRef = useRef<HTMLDivElement>(null)
  const latestMessage = messages.at(-1)

  useEffect(() => {
    if (latestMessage) endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [latestMessage])

  if (messages.length === 0) {
    const statusDescriptionKeys: Record<ReadinessSnapshot['status'], TranslationKey> = {
      'action-required': 'readiness.description.actionRequired',
      restricted: 'readiness.description.restricted',
      ready: 'readiness.description.ready',
    }
    const itemTitleKeys: Record<ReadinessItemId, TranslationKey> = {
      provider: 'readiness.item.provider',
      model: 'readiness.item.model',
      workspace: 'readiness.item.workspace',
      trust: 'readiness.item.trust',
    }
    const itemDescriptionKeys: Record<ReadinessItemId, TranslationKey> = {
      provider: 'readiness.item.provider.description',
      model: 'readiness.item.model.description',
      workspace: 'readiness.item.workspace.description',
      trust: 'readiness.item.trust.description',
    }
    const itemStatusKeys: Record<ReadinessItemStatus, TranslationKey> = {
      blocked: 'readiness.status.blocked',
      required: 'readiness.status.required',
      recommended: 'readiness.status.recommended',
      restricted: 'readiness.status.restricted',
      complete: 'readiness.status.complete',
    }
    const actionLabelKeys: Record<ReadinessActionId, TranslationKey> = {
      'settings.open-provider': 'readiness.action.openProvider',
      'settings.select-model': 'readiness.action.selectModel',
      'workspace.choose': 'readiness.action.chooseWorkspace',
      'workspace.trust': 'readiness.action.trustWorkspace',
      'conversation.start': 'readiness.action.startConversation',
    }
    const availableActions = readiness.actions
      .filter(({ availability }) => availability === 'available')
      .sort((left, right) => {
        if (left.id === readiness.primaryActionId) return -1
        if (right.id === readiness.primaryActionId) return 1
        return 0
      })
      .slice(0, 3)
    const completedItemCount = readiness.items.filter(({ status }) => status === 'complete').length
    const remainingItemCount = readiness.items.length - completedItemCount
    const primaryItem = readiness.items.find(
      ({ actionId }) => actionId === readiness.primaryActionId,
    )

    return (
      <div className="conversation-empty">
        <div className="readiness-hub">
          <div className="readiness-mark" aria-hidden="true">
            <Sparkles size={20} />
          </div>
          <h1>{t('conversation.empty.title')}</h1>
          <p className="readiness-description">{t(statusDescriptionKeys[readiness.status])}</p>

          {readiness.status !== 'ready' && (
            <div
              className="readiness-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={readiness.items.length}
              aria-valuenow={completedItemCount}
              aria-valuetext={t('readiness.progress', {
                completed: completedItemCount,
                remaining: remainingItemCount,
              })}
              aria-label={t('readiness.progress', {
                completed: completedItemCount,
                remaining: remainingItemCount,
              })}
            >
              <CheckCircle2 size={14} />
              {t('readiness.progress', {
                completed: completedItemCount,
                remaining: remainingItemCount,
              })}
            </div>
          )}

          {primaryItem && (
            <section className={`readiness-next-step ${primaryItem.status}`}>
              <span className="readiness-next-icon" aria-hidden="true">
                {primaryItem.status === 'restricted' ? (
                  <ShieldAlert size={17} />
                ) : (
                  <AlertCircle size={17} />
                )}
              </span>
              <span className="readiness-next-copy">
                <small>{t('readiness.nextStep')}</small>
                <strong>{t(itemTitleKeys[primaryItem.id])}</strong>
                <span>{t(itemDescriptionKeys[primaryItem.id])}</span>
              </span>
              <span className="readiness-status">{t(itemStatusKeys[primaryItem.status])}</span>
            </section>
          )}

          <div className={`readiness-actions ${readiness.status}`}>
            {availableActions.map((action) => (
              <button
                type="button"
                className={
                  action.id === readiness.primaryActionId ? 'primary-button' : 'ghost-button'
                }
                key={`${action.id}:${action.revision}`}
                onClick={() => onReadinessAction(action.id)}
              >
                {action.id.startsWith('settings.') ? (
                  <Settings size={15} />
                ) : action.id === 'workspace.choose' ? (
                  <FolderOpen size={15} />
                ) : action.id === 'workspace.trust' ? (
                  <ShieldCheck size={15} />
                ) : (
                  <MessageSquareCode size={15} />
                )}
                {t(actionLabelKeys[action.id])}
              </button>
            ))}
          </div>
          <p className="readiness-privacy-note">{t('readiness.privacy')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="conversation-scroll" aria-live="polite" aria-busy={running}>
      <div className="conversation-list">
        {messages.map((message) =>
          message.role === 'user' ? (
            <article
              className="message user-message"
              key={message.id}
              aria-label={t('conversation.userLabel')}
            >
              <div className="user-bubble">
                <p>{message.content}</p>
                {message.contextPaths.length > 0 && (
                  <div className="message-contexts">
                    {message.contextPaths.map((path) => (
                      <span key={path} title={path}>
                        <Paperclip size={12} /> {compactPath(path)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </article>
          ) : (
            <article
              className="message assistant-message"
              key={message.id}
              aria-label={t('conversation.assistantLabel')}
              aria-busy={message.status === 'running' || message.status === 'starting'}
            >
              <div className="assistant-content">
                {message.tools.length > 0 && (
                  <ToolActivityDisclosure
                    activities={message.tools}
                    runStatus={message.status}
                    changedPaths={message.changedPaths}
                  />
                )}
                {message.commandOutputs.length > 0 && (
                  <div className="command-output-stack">
                    {message.commandOutputs.map((output) => (
                      <CommandOutputCard key={output.callId} output={output} />
                    ))}
                  </div>
                )}
                {message.content ? (
                  <MarkdownContent content={message.content} />
                ) : message.status === 'starting' || message.status === 'running' ? (
                  <div className="thinking-row">
                    <span /> <span /> <span />
                  </div>
                ) : null}
                {message.status === 'cancelled' && (
                  <div className="response-note">{t('conversation.cancelled')}</div>
                )}
                {message.error && (
                  <div className="response-error" role="alert">
                    <AlertCircle size={15} /> {message.error}
                  </div>
                )}
                {(message.warning || message.status === 'interrupted') && (
                  <div className="response-warning" role="status">
                    <AlertCircle size={15} /> {message.warning ?? t('conversation.interrupted')}
                  </div>
                )}
                <div className="assistant-response-footer">
                  {message.content &&
                    message.status !== 'starting' &&
                    message.status !== 'running' && <CopyAnswerButton content={message.content} />}
                  <RunMetadata message={message} />
                </div>
              </div>
            </article>
          ),
        )}
        <div ref={endRef} />
      </div>
    </div>
  )
}

function Composer({
  models,
  activeModelId,
  contextPaths,
  selectedFile,
  commands,
  running,
  disabledReason,
  onModelChange,
  onRemoveContext,
  onAddSelectedContext,
  onSend,
  onCancel,
}: {
  models: ModelOption[]
  activeModelId: string | null
  contextPaths: string[]
  selectedFile: FilePreview | null
  commands: RuntimeSlashCommand[]
  running: boolean
  disabledReason: string | null
  onModelChange: (modelId: string) => void
  onRemoveContext: (path: string) => void
  onAddSelectedContext: () => void
  onSend: (message: string) => Promise<void>
  onCancel: () => Promise<void>
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [cursor, setCursor] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const setDraftAndCursor = (value: string, nextCursor = value.length) => {
    setDraft(value)
    setCursor(nextCursor)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  const slash = useSlashCommandPalette({
    value: draft,
    cursor,
    commands,
    maxResults: 40,
    disabled: running || !draft.trimStart().startsWith('/'),
    onSelect: (command, invocation) => {
      const selection = applySlashCommandSelection(draft, invocation, command)
      setDraftAndCursor(selection.value, selection.cursor)
    },
  })

  const submit = async () => {
    const message = draft.trim()
    if (!message || running || (disabledReason && !message.startsWith('/'))) return
    setDraft('')
    setCursor(0)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    try {
      await onSend(message)
    } catch {
      setDraftAndCursor(message)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const exactCommandSelected = Boolean(
      slash.isOpen &&
        slash.invocation?.query &&
        slash.activeCommand &&
        !slash.activeCommand.argumentHint &&
        normalizeSlashCommandName(slash.activeCommand.name) ===
          normalizeSlashCommandName(slash.invocation.query),
    )
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      exactCommandSelected
    ) {
      event.preventDefault()
      slash.dismiss()
      void submit()
      return
    }
    if (slash.handleKeyDown(event)) return
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value)
    setCursor(event.target.selectionStart)
    event.target.style.height = 'auto'
    event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`
  }

  const selectedAlreadyAdded = selectedFile ? contextPaths.includes(selectedFile.path) : false
  const trimmedDraft = draft.trim()
  const sendDisabled = !trimmedDraft || (Boolean(disabledReason) && !trimmedDraft.startsWith('/'))

  return (
    <div className="composer-wrap">
      {slash.isOpen && <SlashCommandPalette {...slash.paletteProps} />}
      <div className={`composer${running ? ' running' : ''}`}>
        {contextPaths.length > 0 && (
          <ul className="context-strip" aria-label={t('composer.context.label')}>
            {contextPaths.map((path) => (
              <li className="context-chip" key={path} title={path}>
                {fileIcon(path)}
                <span>{compactPath(path)}</span>
                <button
                  type="button"
                  onClick={() => onRemoveContext(path)}
                  aria-label={t('composer.context.remove', { path })}
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          id="assistant-composer-input"
          ref={textareaRef}
          value={draft}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onClick={(event) => setCursor(event.currentTarget.selectionStart)}
          onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          placeholder={
            disabledReason
              ? t('composer.disabledPlaceholder', { reason: disabledReason })
              : t('composer.placeholder')
          }
          rows={1}
          disabled={running}
          aria-label={t('composer.inputLabel')}
          {...slash.inputProps}
        />
        <div className="composer-footer">
          <div className="composer-actions">
            {selectedFile && !selectedAlreadyAdded && (
              <button
                type="button"
                className="attach-button"
                onClick={onAddSelectedContext}
                title={selectedFile.path}
              >
                <Paperclip size={14} /> {t('composer.addCurrentFile')}
              </button>
            )}
            <label className="model-select">
              <Sparkles size={13} aria-hidden="true" />
              <span className="sr-only">{t('composer.model')}</span>
              <select
                value={activeModelId ?? ''}
                onChange={(event) => onModelChange(event.target.value)}
                disabled={running || models.length === 0}
                title={t('composer.model')}
              >
                {models.length === 0 ? (
                  <option value="">{t('composer.model.none')}</option>
                ) : (
                  <>
                    {!activeModelId && <option value="">{t('composer.model.select')}</option>}
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </>
                )}
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </label>
          </div>
          {running ? (
            <button type="button" className="send-button stop" onClick={() => void onCancel()}>
              <CircleStop size={17} /> <span>{t('composer.stop')}</span>
            </button>
          ) : (
            <button
              type="button"
              className="send-button"
              onClick={() => void submit()}
              disabled={sendDisabled}
            >
              <Send size={17} /> <span>{t('composer.send')}</span>
            </button>
          )}
        </div>
      </div>
      <p className="composer-hint">{t('composer.hint')}</p>
    </div>
  )
}

function FilePreviewPanel({
  preview,
  loading,
  error,
  inContext,
  onToggleContext,
  onClose,
}: {
  preview: FilePreview | null
  loading: boolean
  error: string | null
  inContext: boolean
  onToggleContext: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const previewLines = useMemo(() => toPreviewLines(preview?.content ?? ''), [preview?.content])

  const copyContent = async () => {
    if (!preview) return
    try {
      await navigator.clipboard.writeText(preview.content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <aside id="file-preview-panel" className="right-panel" aria-label={t('panel.preview.label')}>
      <div className="panel-heading preview-heading">
        <div className="heading-copy">
          <span className="eyebrow">{t('panel.preview.eyebrow')}</span>
          <strong>{preview?.name ?? t('panel.preview.label')}</strong>
        </div>
        <IconButton
          className="mobile-panel-close"
          label={t('panel.preview.close')}
          onClick={onClose}
        >
          <PanelRightClose size={16} />
        </IconButton>
      </div>

      {loading ? (
        <div className="preview-state">
          <LoaderCircle className="spin" size={19} />
          <p>{t('panel.preview.loading')}</p>
        </div>
      ) : error ? (
        <div className="preview-state danger-text" role="alert">
          <AlertCircle size={20} />
          <p>{error}</p>
        </div>
      ) : preview ? (
        <>
          <div className="preview-toolbar">
            <span className="language-badge">{preview.language || 'text'}</span>
            <div>
              <IconButton label={t('panel.preview.copy')} onClick={() => void copyContent()}>
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </IconButton>
              <button
                type="button"
                className={`context-toggle${inContext ? ' active' : ''}`}
                onClick={onToggleContext}
              >
                {inContext ? <Check size={14} /> : <Plus size={14} />}
                {inContext ? t('panel.preview.inContext') : t('panel.preview.addContext')}
              </button>
            </div>
          </div>
          <div className="preview-path" title={preview.path}>
            {preview.path}
          </div>
          <div className="code-preview">
            <ol>
              {previewLines.map((line) => (
                <li key={line.key}>
                  <code>{line.content || ' '}</code>
                </li>
              ))}
            </ol>
          </div>
          {preview.truncated && (
            <div className="truncated-note">
              <AlertCircle size={13} /> {t('panel.preview.truncated')}
            </div>
          )}
        </>
      ) : (
        <div className="preview-state empty">
          <div className="state-icon subtle">
            <Eye size={21} />
          </div>
          <h2>{t('panel.preview.emptyTitle')}</h2>
          <p>{t('panel.preview.emptyDescription')}</p>
        </div>
      )}
    </aside>
  )
}

function WorkspaceTrustBanner({
  trusted,
  updating,
  disabled,
  onChange,
}: {
  trusted: boolean
  updating: boolean
  disabled: boolean
  onChange: (trusted: boolean) => Promise<void>
}) {
  const { t } = useI18n()
  return (
    <section
      className={`workspace-trust-banner ${trusted ? 'trusted' : 'untrusted'}`}
      aria-label={t('trust.label')}
    >
      <span className="trust-icon" aria-hidden="true">
        {trusted ? <ShieldCheck size={17} /> : <ShieldAlert size={17} />}
      </span>
      <div>
        <strong>{t(trusted ? 'trust.trusted.title' : 'trust.restricted.title')}</strong>
        <p>{t(trusted ? 'trust.trusted.description' : 'trust.restricted.description')}</p>
      </div>
      <button
        type="button"
        className={trusted ? 'ghost-button' : 'secondary-button'}
        onClick={() => void onChange(!trusted)}
        disabled={updating || disabled}
      >
        {updating ? <LoaderCircle className="spin" size={14} /> : null}
        {t(trusted ? 'trust.untrust' : 'trust.trust')}
      </button>
    </section>
  )
}

function ApprovalModal({
  pending,
  resolving,
  error,
  onResolve,
}: {
  pending: PendingApproval
  resolving: boolean
  error: string | null
  onResolve: (decision: 'approved' | 'denied') => Promise<void>
}) {
  const { t, formatDateTime, formatNumber } = useI18n()
  const modalRef = useRef<HTMLElement>(null)
  const denyButtonRef = useRef<HTMLButtonElement>(null)
  const [now, setNow] = useState(Date.now())
  const { request } = pending
  const expired = now >= request.expiresAt

  useModalFocus({ dialogRef: modalRef, initialFocusRef: denyButtonRef })

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [])

  return (
    <div className="modal-backdrop approval-backdrop" role="presentation">
      <section
        ref={modalRef}
        className="approval-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        aria-describedby="approval-description"
        tabIndex={-1}
      >
        <header className="approval-header">
          <span className="approval-icon">
            {request.kind === 'file-change' ? (
              <FileCode2 size={19} />
            ) : request.kind === 'command' ? (
              <Terminal size={19} />
            ) : request.kind === 'mcp-server' ? (
              <Server size={19} />
            ) : (
              <Wrench size={19} />
            )}
          </span>
          <div>
            <span className="eyebrow">{t('approval.eyebrow')}</span>
            <h1 id="approval-title">
              {request.kind === 'file-change'
                ? t('approval.title.fileChange')
                : request.kind === 'command'
                  ? t('approval.title.command')
                  : request.kind === 'mcp-server'
                    ? t('approval.title.mcpServer')
                    : t('approval.title.mcpTool')}
            </h1>
            <p id="approval-description">{request.summary}</p>
          </div>
        </header>

        <div className="approval-body">
          {request.kind === 'file-change' ? (
            <div className="approval-changes">
              {request.changes.map((change) => (
                <section className="approval-change" key={`${change.path}:${change.afterHash}`}>
                  <header>
                    <strong>{change.path}</strong>
                    <span className={`change-kind ${change.kind}`}>
                      {t(`approval.file.kind.${change.kind}`)}
                    </span>
                    <span className="diff-count additions">+{formatNumber(change.additions)}</span>
                    <span className="diff-count deletions">−{formatNumber(change.deletions)}</span>
                  </header>
                  <pre>{change.diff || t('approval.file.diffUnavailable')}</pre>
                </section>
              ))}
            </div>
          ) : request.kind === 'command' ? (
            <div className="command-approval-details">
              <dl>
                <div>
                  <dt>{t('approval.field.cwd')}</dt>
                  <dd title={request.cwd}>{JSON.stringify(request.cwd)}</dd>
                </div>
                <div>
                  <dt>{t('approval.field.isolation')}</dt>
                  <dd>{t('approval.isolation.structuredProcess')}</dd>
                </div>
                <div>
                  <dt>{t('approval.field.network')}</dt>
                  <dd>{t('approval.network.host')}</dd>
                </div>
                <div>
                  <dt>{t('approval.field.timeout')}</dt>
                  <dd>{formatNumber(request.timeoutMs)} ms</dd>
                </div>
              </dl>
              <div className="command-argv">
                <strong>{t('approval.arguments.command')}</strong>
                <ol>
                  {toKeyedArguments(request.argv).map(({ argument, key }, index) => (
                    <li className="command-argument-row" key={key}>
                      <span>{index}</span>
                      <code>{JSON.stringify(argument)}</code>
                    </li>
                  ))}
                </ol>
              </div>
              {request.network === 'host' && (
                <div className="network-warning">
                  <ShieldAlert size={15} /> {t('approval.warning.hostProcess')}
                </div>
              )}
            </div>
          ) : request.kind === 'mcp-server' ? (
            <div className="command-approval-details">
              <dl>
                <div>
                  <dt>{t('approval.field.configFile')}</dt>
                  <dd title={request.configPath}>{request.configPath}</dd>
                </div>
                <div>
                  <dt>{t('approval.field.configRevision')}</dt>
                  <dd title={request.configurationRevision}>
                    {request.configurationRevision.slice(0, 16)}
                  </dd>
                </div>
                <div>
                  <dt>{t('approval.field.isolation')}</dt>
                  <dd>{t('approval.isolation.structuredProcess')}</dd>
                </div>
                <div>
                  <dt>{t('approval.field.network')}</dt>
                  <dd>{t('approval.network.host')}</dd>
                </div>
              </dl>
              <div className="approval-changes">
                {request.servers.map((server) => (
                  <section className="approval-change" key={server.id}>
                    <header>
                      <strong>{server.name}</strong>
                      <span className="change-kind update">{server.id}</span>
                    </header>
                    <div className="command-argv">
                      <strong>{t('approval.arguments.server')}</strong>
                      <ol>
                        {toKeyedArguments(server.argv).map(({ argument, key }, index) => (
                          <li className="command-argument-row" key={key}>
                            <span>{index}</span>
                            <code>{JSON.stringify(argument)}</code>
                          </li>
                        ))}
                      </ol>
                    </div>
                    <small>
                      {t('approval.field.cwd')}:{' '}
                      {server.cwd ? JSON.stringify(server.cwd) : t('approval.workspaceRoot')}
                    </small>
                    {server.environment.length > 0 && (
                      <div className="command-argv">
                        <strong>{t('approval.environment')}</strong>
                        <ol>
                          {server.environment.map(({ key, value }) => (
                            <li className="command-argument-row" key={key}>
                              <span>{key}</span>
                              <code>{JSON.stringify(value)}</code>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </section>
                ))}
              </div>
              <div className="network-warning">
                <ShieldAlert size={15} /> {t('approval.warning.mcpServer')}
              </div>
            </div>
          ) : (
            <div className="command-approval-details">
              <dl>
                <div>
                  <dt>{t('approval.field.server')}</dt>
                  <dd>{request.serverName}</dd>
                </div>
                <div>
                  <dt>{t('approval.field.tool')}</dt>
                  <dd>{request.toolName}</dd>
                </div>
                <div>
                  <dt>{t('approval.field.capabilities')}</dt>
                  <dd>
                    {request.capabilities
                      .map((capability) => t(`approval.capability.${capability}`))
                      .join(', ')}
                  </dd>
                </div>
                <div>
                  <dt>{t('approval.field.network')}</dt>
                  <dd>{t('approval.network.host')}</dd>
                </div>
              </dl>
              <div className="command-argv">
                <strong>{t('approval.arguments.exactJson')}</strong>
                <pre>{request.argumentsJson}</pre>
              </div>
              <div className="network-warning">
                <ShieldAlert size={15} /> {t('approval.warning.mcpTool')}
              </div>
            </div>
          )}
        </div>

        <footer className="approval-footer">
          <div>
            <span title={request.actionHash}>
              {t('approval.fingerprint', { hash: request.actionHash.slice(0, 12) })}
            </span>
            <small>
              {expired
                ? t('approval.expired')
                : t('approval.validUntil', {
                    timestamp: formatDateTime(request.expiresAt, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                  })}
            </small>
          </div>
          {error && (
            <p className="approval-error" role="alert">
              <AlertCircle size={14} /> {error}
            </p>
          )}
          <div className="approval-actions">
            <button
              ref={denyButtonRef}
              type="button"
              className="secondary-button"
              onClick={() => void onResolve('denied')}
              disabled={resolving}
            >
              {t('approval.deny')}
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => void onResolve('approved')}
              disabled={resolving || expired}
            >
              {resolving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
              {t('approval.approveExact')}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function ConversationHistoryModal({
  conversations,
  activeConversationId,
  search,
  archived,
  loading,
  error,
  busyId,
  onSearchChange,
  onArchivedChange,
  onRefresh,
  onOpen,
  onFork,
  onArchive,
  onDelete,
  onClose,
}: {
  conversations: ConversationSummary[]
  activeConversationId: string
  search: string
  archived: boolean
  loading: boolean
  error: string | null
  busyId: string | null
  onSearchChange: (value: string) => void
  onArchivedChange: (value: boolean) => void
  onRefresh: () => void
  onOpen: (conversation: ConversationSummary) => Promise<void>
  onFork: (conversation: ConversationSummary) => Promise<void>
  onArchive: (conversation: ConversationSummary) => Promise<void>
  onDelete: (conversation: ConversationSummary) => Promise<void>
  onClose: () => void
}) {
  const { t, formatDateTime } = useI18n()
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const dialogRef = useRef<HTMLElement>(null)

  useModalFocus({ dialogRef, onEscape: onClose })

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="history-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{t('history.eyebrow')}</span>
            <h1 id="history-title">{t('history.title')}</h1>
            <p>{t('history.description')}</p>
          </div>
          <IconButton label={t('history.close')} onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>

        <div className="history-toolbar">
          <label className="search-field">
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">{t('history.search')}</span>
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={t('history.searchPlaceholder')}
            />
            {search && (
              <button
                type="button"
                onClick={() => onSearchChange('')}
                aria-label={t('history.clearSearch')}
              >
                <X size={13} />
              </button>
            )}
          </label>
          <button
            type="button"
            className={`history-filter${archived ? ' selected' : ''}`}
            onClick={() => onArchivedChange(!archived)}
            aria-pressed={archived}
          >
            <Archive size={14} />
            {t(archived ? 'history.filter.archived' : 'history.filter.active')}
          </button>
          <IconButton label={t('history.refresh')} onClick={onRefresh} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </IconButton>
        </div>

        <div className="history-list" aria-busy={loading}>
          {error ? (
            <div className="modal-inline-state danger-text" role="alert">
              <AlertCircle size={20} />
              <p>{error}</p>
              <button type="button" className="secondary-button" onClick={onRefresh}>
                {t('common.retry')}
              </button>
            </div>
          ) : loading && conversations.length === 0 ? (
            <div className="modal-inline-state">
              <LoaderCircle className="spin" size={20} />
              <p>{t('history.loading')}</p>
            </div>
          ) : conversations.length === 0 ? (
            <div className="modal-inline-state">
              <History size={22} />
              <p>{t(search ? 'history.empty.search' : 'history.empty.all')}</p>
            </div>
          ) : (
            conversations.map((conversation) => {
              const busy = busyId === conversation.id
              const active = activeConversationId === conversation.id
              const confirmingDelete = confirmDeleteId === conversation.id
              return (
                <article className={`history-item${active ? ' active' : ''}`} key={conversation.id}>
                  <button
                    type="button"
                    className="history-item-main"
                    onClick={() => void onOpen(conversation)}
                    disabled={Boolean(busyId)}
                  >
                    <span className="history-glyph">
                      {busy ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <MessageSquareCode size={16} />
                      )}
                    </span>
                    <span>
                      <strong>{conversation.title || t('history.untitled')}</strong>
                      <small>
                        {conversation.workspaceName ?? t('history.noWorkspace')} ·{' '}
                        {conversation.modelId ?? t('history.noModel')}
                      </small>
                    </span>
                    <time dateTime={new Date(conversation.updatedAt).toISOString()}>
                      {formatDateTime(conversation.updatedAt, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </button>
                  <div className="history-item-actions">
                    <IconButton
                      label={t('history.fork')}
                      onClick={() => void onFork(conversation)}
                      disabled={Boolean(busyId)}
                    >
                      <GitFork size={14} />
                    </IconButton>
                    {conversation.status === 'active' && (
                      <IconButton
                        label={t('history.archive')}
                        onClick={() => void onArchive(conversation)}
                        disabled={Boolean(busyId)}
                      >
                        <Archive size={14} />
                      </IconButton>
                    )}
                    <button
                      type="button"
                      className={`history-delete${confirmingDelete ? ' confirming' : ''}`}
                      onClick={() => {
                        if (confirmingDelete) void onDelete(conversation)
                        else setConfirmDeleteId(conversation.id)
                      }}
                      onBlur={() => setConfirmDeleteId(null)}
                      disabled={Boolean(busyId)}
                      aria-label={t(confirmingDelete ? 'history.deleteConfirm' : 'history.delete')}
                      title={t(confirmingDelete ? 'history.deleteConfirmHint' : 'history.delete')}
                    >
                      <Trash2 size={14} />
                      {confirmingDelete && <span>{t('history.confirm')}</span>}
                    </button>
                  </div>
                </article>
              )
            })
          )}
        </div>
      </section>
    </div>
  )
}

type WorkspaceTab = 'status' | 'diff' | 'skills'

function WorkspaceDetailsModal({
  tab,
  trusted,
  status,
  diff,
  skills,
  staged,
  loading,
  error,
  onTabChange,
  onStagedChange,
  onRefresh,
  onClose,
}: {
  tab: WorkspaceTab
  trusted: boolean
  status: GitStatusResult | null
  diff: GitDiffResult | null
  skills: SkillDescriptor[]
  staged: boolean
  loading: boolean
  error: string | null
  onTabChange: (tab: WorkspaceTab) => void
  onStagedChange: (staged: boolean) => void
  onRefresh: () => void
  onClose: () => void
}) {
  const { t, formatNumber } = useI18n()
  const dialogRef = useRef<HTMLElement>(null)

  useModalFocus({ dialogRef, onEscape: onClose })

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="workspace-details-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-details-title"
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{t('workspaceDetails.eyebrow')}</span>
            <h1 id="workspace-details-title">{t('workspaceDetails.title')}</h1>
            <p>{t('workspaceDetails.description')}</p>
          </div>
          <IconButton label={t('workspaceDetails.close')} onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>

        <div
          className="workspace-tabs"
          role="tablist"
          aria-label={t('workspaceDetails.tabs.label')}
        >
          {(
            [
              ['status', 'workspaceDetails.tabs.status', GitBranch],
              ['diff', 'workspaceDetails.tabs.diff', GitCompareArrows],
              ['skills', 'workspaceDetails.tabs.skills', Sparkles],
            ] as const
          ).map(([value, label, TabIcon]) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={tab === value ? 'selected' : ''}
              key={value}
              onClick={() => onTabChange(value)}
            >
              <TabIcon size={14} /> {t(label)}
            </button>
          ))}
          <IconButton label={t('workspaceDetails.refresh')} onClick={onRefresh} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </IconButton>
        </div>

        {tab === 'diff' && (
          <div className="diff-options">
            <label>
              <input
                type="checkbox"
                checked={staged}
                onChange={(event) => onStagedChange(event.target.checked)}
              />
              {t('workspaceDetails.diff.stagedOnly')}
            </label>
            {diff?.truncated && <span>{t('workspaceDetails.diff.truncated')}</span>}
          </div>
        )}

        <div className="workspace-details-body" aria-busy={loading}>
          {!trusted && tab === 'skills' ? (
            <div className="modal-inline-state">
              <ShieldAlert size={22} />
              <p>{t('workspaceDetails.skills.trustedOnly')}</p>
            </div>
          ) : error ? (
            <div className="modal-inline-state danger-text" role="alert">
              <AlertCircle size={20} />
              <p>{error}</p>
              <button type="button" className="secondary-button" onClick={onRefresh}>
                {t('common.retry')}
              </button>
            </div>
          ) : loading ? (
            <div className="modal-inline-state">
              <LoaderCircle className="spin" size={20} />
              <p>{t('workspaceDetails.loading')}</p>
            </div>
          ) : tab === 'status' ? (
            status?.repository ? (
              <div className="git-status-content">
                <div className="git-summary">
                  <span>
                    <GitBranch size={14} />
                    {status.branch ?? t('workspaceDetails.git.detachedHead')}
                  </span>
                  <code>{status.head?.slice(0, 12) ?? t('workspaceDetails.git.noHead')}</code>
                  <span>
                    {t('workspaceDetails.git.changeCount', {
                      count: formatNumber(status.entries.length),
                    })}
                  </span>
                </div>
                {status.entries.length > 0 ? (
                  <ul className="git-status-list">
                    {status.entries.map((entry) => (
                      <li
                        className="git-status-entry"
                        key={`${entry.path}:${entry.originalPath ?? ''}`}
                      >
                        <span className="git-code" title={t('workspaceDetails.git.statusColumn')}>
                          {entry.indexStatus}
                          {entry.worktreeStatus}
                        </span>
                        <code>{entry.path}</code>
                        {entry.originalPath && <small>← {entry.originalPath}</small>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="clean-worktree">
                    <CheckCircle2 size={18} /> {t('workspaceDetails.git.clean')}
                  </div>
                )}
                {status.truncated && (
                  <p className="truncated-note">{t('workspaceDetails.git.truncated')}</p>
                )}
              </div>
            ) : (
              <div className="modal-inline-state">
                <GitBranch size={22} />
                <p>{t('workspaceDetails.git.notRepository')}</p>
              </div>
            )
          ) : tab === 'diff' ? (
            <pre className="git-diff-view">{diff?.patch || t('workspaceDetails.diff.empty')}</pre>
          ) : skills.length > 0 ? (
            <div className="skills-list">
              {skills.map((skill) => (
                <article key={skill.id}>
                  <span className="skill-glyph">
                    <Sparkles size={15} />
                  </span>
                  <div>
                    <strong>{skill.name}</strong>
                    <p>{skill.description || t('workspaceDetails.skills.noDescription')}</p>
                    <code>{skill.path}</code>
                    <div className="skill-badges">
                      {skill.hasScripts && <span>scripts</span>}
                      {skill.hasReferences && <span>references</span>}
                      {skill.hasAssets && <span>assets</span>}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="modal-inline-state">
              <Sparkles size={22} />
              <p>{t('workspaceDetails.skills.empty')}</p>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function UndoConfirmationModal({
  status,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  status: UndoStatus | null
  busy: boolean
  error: string | null
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const { t, formatNumber } = useI18n()
  const dialogRef = useRef<HTMLElement>(null)

  useModalFocus({ dialogRef, onEscape: busy ? undefined : onClose })

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="confirmation-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="undo-title"
        tabIndex={-1}
      >
        <span className="confirmation-icon">
          <Undo2 size={21} />
        </span>
        <h1 id="undo-title">{t('undo.title')}</h1>
        <p>
          {status?.summary
            ? t('undo.summary', { summary: status.summary })
            : t('undo.defaultSummary')}
        </p>
        {status && (
          <div className="undo-preview">
            <strong>{t('undo.pathCount', { count: formatNumber(status.paths.length) })}</strong>
            <ul>
              {status.paths.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
            {status.actionHash && (
              <small title={status.actionHash}>
                {t('undo.fingerprint', { hash: status.actionHash.slice(0, 16) })}
              </small>
            )}
          </div>
        )}
        {error && (
          <div className="confirmation-error" role="alert">
            <AlertCircle size={14} /> {error}
          </div>
        )}
        <div>
          <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="danger-button"
            onClick={() => void onConfirm()}
            disabled={busy}
          >
            {busy ? <LoaderCircle className="spin" size={15} /> : <Undo2 size={15} />}{' '}
            {t('undo.confirm')}
          </button>
        </div>
      </section>
    </div>
  )
}

interface FileApprovalRuleDraft {
  id: string
  pathPrefix: string
  operations: FileChangeOperation[]
}

interface CommandApprovalRuleDraft extends CommandApprovalRule {
  id: string
  argumentPrefixText: string
}

const DEFAULT_FILE_APPROVAL_LIMITS = {
  maxFilesPerRequest: 20,
  maxChangedLinesPerRequest: 2_000,
  maxChangedBytesPerRequest: 5_000_000,
} as const

const createFileApprovalRuleDraft = (): FileApprovalRuleDraft => ({
  id: makeId(),
  pathPrefix: '.',
  operations: ['create', 'update'],
})

const createCommandApprovalRuleDraft = (): CommandApprovalRuleDraft => ({
  id: makeId(),
  executable: '',
  argumentPrefix: [],
  argumentPrefixText: '',
  allowAdditionalArguments: false,
  workingDirectoryPrefix: '.',
  maxTimeoutMs: 120_000,
  allowHostNetwork: false,
})

const cloneApprovalPolicyConfiguration = (
  policy: WorkspaceApprovalPolicyConfiguration | null,
): WorkspaceApprovalPolicyConfiguration => {
  if (!policy) {
    return {
      fileChanges: { mode: 'manual' },
      commands: { mode: 'manual' },
    }
  }
  return {
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
            ...policy.commands,
            rules: policy.commands.rules.map((rule) => ({
              ...rule,
              argumentPrefix: [...rule.argumentPrefix],
            })),
          },
  }
}

interface SettingsModalProps {
  initialSettings: AppSettings
  initialApprovalPolicy: WorkspaceApprovalPolicyConfiguration | null
  workspace: WorkspaceSummary | null
  workspaceTrusted: boolean
  forced: boolean
  onClose: () => void
  onSettingsChange: (settings: AppSettings) => void
  onApprovalPolicyChange: (policy: WorkspaceApprovalPolicyConfiguration) => void
  onModelsLoaded: (models: ModelOption[]) => void
}

function SettingsModal({
  initialSettings,
  initialApprovalPolicy,
  workspace,
  workspaceTrusted,
  forced,
  onClose,
  onSettingsChange,
  onApprovalPolicyChange,
  onModelsLoaded,
}: SettingsModalProps) {
  const { t } = useI18n()
  const sm = useSettingsMessages()
  const startingApprovalPolicy = cloneApprovalPolicyConfiguration(initialApprovalPolicy)
  const startingFilePolicy = startingApprovalPolicy.fileChanges
  const startingCommandPolicy = startingApprovalPolicy.commands
  const [settings, setSettings] = useState(initialSettings)
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    initialSettings.activeProviderId ?? initialSettings.providers[0]?.id ?? null,
  )
  const [editingNew, setEditingNew] = useState(initialSettings.providers.length === 0)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelId, setModelId] = useState(initialSettings.activeModelId ?? '')
  const [theme, setTheme] = useState<AppSettings['theme']>(initialSettings.theme)
  const [locale, setLocale] = useState<AppLocale>(initialSettings.locale)
  const [maxToolIterations, setMaxToolIterations] = useState(initialSettings.maxToolIterations)
  const [maxTotalToolCalls, setMaxTotalToolCalls] = useState(initialSettings.maxTotalToolCalls)
  const [runTimeoutMinutes, setRunTimeoutMinutes] = useState(initialSettings.runTimeoutMinutes)
  const [savingProvider, setSavingProvider] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [savingLocale, setSavingLocale] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [fileApprovalMode, setFileApprovalMode] = useState(startingFilePolicy.mode)
  const [fileApprovalScope, setFileApprovalScope] = useState<ApprovalScope>(
    startingFilePolicy.mode === 'auto' ? startingFilePolicy.scope : 'goals-only',
  )
  const [fileApprovalRules, setFileApprovalRules] = useState<FileApprovalRuleDraft[]>(
    startingFilePolicy.mode === 'auto'
      ? startingFilePolicy.rules.map((rule) => ({ ...rule, id: makeId() }))
      : [createFileApprovalRuleDraft()],
  )
  const [maxFilesPerRequest, setMaxFilesPerRequest] = useState(
    startingFilePolicy.mode === 'auto'
      ? startingFilePolicy.maxFilesPerRequest
      : DEFAULT_FILE_APPROVAL_LIMITS.maxFilesPerRequest,
  )
  const [maxChangedLinesPerRequest, setMaxChangedLinesPerRequest] = useState(
    startingFilePolicy.mode === 'auto'
      ? startingFilePolicy.maxChangedLinesPerRequest
      : DEFAULT_FILE_APPROVAL_LIMITS.maxChangedLinesPerRequest,
  )
  const [maxChangedBytesPerRequest, setMaxChangedBytesPerRequest] = useState(
    startingFilePolicy.mode === 'auto'
      ? startingFilePolicy.maxChangedBytesPerRequest
      : DEFAULT_FILE_APPROVAL_LIMITS.maxChangedBytesPerRequest,
  )
  const [commandApprovalMode, setCommandApprovalMode] = useState(startingCommandPolicy.mode)
  const [commandApprovalScope, setCommandApprovalScope] = useState<ApprovalScope>(
    startingCommandPolicy.mode === 'auto' ? startingCommandPolicy.scope : 'goals-only',
  )
  const [commandApprovalRules, setCommandApprovalRules] = useState<CommandApprovalRuleDraft[]>(
    startingCommandPolicy.mode === 'auto'
      ? startingCommandPolicy.rules.map((rule) => ({
          ...rule,
          id: makeId(),
          argumentPrefixText: rule.argumentPrefix.join('\n'),
        }))
      : [createCommandApprovalRuleDraft()],
  )
  const [savingApprovalPolicy, setSavingApprovalPolicy] = useState(false)
  const [approvalPolicyDirty, setApprovalPolicyDirty] = useState(false)
  const [approvalPolicyError, setApprovalPolicyError] = useState<string | null>(null)
  const [approvalPolicySaved, setApprovalPolicySaved] = useState(false)
  const dialogRef = useRef<HTMLElement>(null)
  const settingsRef = useRef(settings)
  const modelsLoadFailedRef = useRef(sm.modelsLoadFailed)

  settingsRef.current = settings
  modelsLoadFailedRef.current = sm.modelsLoadFailed

  useModalFocus({ dialogRef, onEscape: forced ? undefined : onClose })

  const selectedProvider = settings.providers.find((provider) => provider.id === selectedProviderId)
  const quickFileApprovalEnabled =
    fileApprovalMode === 'auto' &&
    fileApprovalScope === 'all-act-runs' &&
    fileApprovalRules.length === 1 &&
    fileApprovalRules[0]?.pathPrefix === '.' &&
    fileApprovalRules[0].operations.length === 2 &&
    fileApprovalRules[0].operations.includes('create') &&
    fileApprovalRules[0].operations.includes('update')

  const markApprovalPolicyChanged = () => {
    setApprovalPolicyDirty(true)
    setApprovalPolicySaved(false)
    setApprovalPolicyError(null)
  }

  const updateFileApprovalRule = (
    id: string,
    update: (rule: FileApprovalRuleDraft) => FileApprovalRuleDraft,
  ) => {
    setFileApprovalRules((current) => current.map((rule) => (rule.id === id ? update(rule) : rule)))
    markApprovalPolicyChanged()
  }

  const updateCommandApprovalRule = (
    id: string,
    update: (rule: CommandApprovalRuleDraft) => CommandApprovalRuleDraft,
  ) => {
    setCommandApprovalRules((current) =>
      current.map((rule) => (rule.id === id ? update(rule) : rule)),
    )
    markApprovalPolicyChanged()
  }

  const populateProvider = useCallback((provider: ProviderSummary | undefined) => {
    setName(provider?.name ?? '')
    setBaseUrl(provider?.baseUrl ?? '')
    setApiKey('')
    setClearApiKey(false)
    setConfirmRemove(false)
  }, [])

  const refreshModels = useCallback(
    async (providerId: string, preserveSelection = true) => {
      setLoadingModels(true)
      setError(null)
      try {
        const result = await window.assistant.listModels({ providerId })
        setModels(result)
        onModelsLoaded(result)
        setModelId((current) =>
          !preserveSelection || !result.some((model) => model.id === current)
            ? (result[0]?.id ?? '')
            : current,
        )
      } catch (cause) {
        setModels([])
        setError(cause instanceof Error ? cause.message : modelsLoadFailedRef.current)
      } finally {
        setLoadingModels(false)
      }
    },
    [onModelsLoaded],
  )

  useEffect(() => {
    const provider = settingsRef.current.providers.find(
      (candidate) => candidate.id === selectedProviderId,
    )
    populateProvider(provider)
    if (provider && !editingNew) void refreshModels(provider.id)
    else setModels([])
  }, [editingNew, populateProvider, refreshModels, selectedProviderId])

  const selectProvider = (provider: ProviderSummary) => {
    setEditingNew(false)
    setSelectedProviderId(provider.id)
    setError(null)
  }

  const startAdding = () => {
    setEditingNew(true)
    setSelectedProviderId(null)
    setModelId('')
    setError(null)
  }

  const saveProvider = async (event: FormEvent) => {
    event.preventDefault()
    if (savingProvider || savingLocale || savingSettings || savingApprovalPolicy) return
    setSavingProvider(true)
    setError(null)
    const input: ProviderInput = {
      ...(editingNew || !selectedProviderId ? {} : { id: selectedProviderId }),
      name,
      baseUrl,
      ...(apiKey.trim() ? { apiKey } : {}),
      ...(clearApiKey ? { clearApiKey: true } : {}),
    }

    try {
      const previousProviderIds = new Set(settings.providers.map((provider) => provider.id))
      const nextSettings = await window.assistant.saveProvider(input)
      setSettings(nextSettings)
      onSettingsChange(nextSettings)
      const savedProvider =
        nextSettings.providers.find((provider) => provider.id === input.id) ??
        nextSettings.providers.find((provider) => !previousProviderIds.has(provider.id)) ??
        nextSettings.providers.find(
          (provider) =>
            provider.name === name.trim() && provider.baseUrl === baseUrl.replace(/\/+$/, ''),
        ) ??
        nextSettings.providers.at(-1)

      if (savedProvider) {
        setEditingNew(false)
        setSelectedProviderId(savedProvider.id)
        setApiKey('')
        setClearApiKey(false)
        await refreshModels(savedProvider.id, false)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : sm.providerSaveFailed)
    } finally {
      setSavingProvider(false)
    }
  }

  const removeProvider = async () => {
    if (
      !selectedProviderId ||
      savingProvider ||
      savingLocale ||
      savingSettings ||
      savingApprovalPolicy
    )
      return
    if (!confirmRemove) {
      setConfirmRemove(true)
      return
    }

    setSavingProvider(true)
    setError(null)
    try {
      const nextSettings = await window.assistant.removeProvider({ providerId: selectedProviderId })
      setSettings(nextSettings)
      onSettingsChange(nextSettings)
      const nextProvider = nextSettings.providers[0]
      setSelectedProviderId(nextProvider?.id ?? null)
      setEditingNew(!nextProvider)
      setModels([])
      setModelId(nextSettings.activeModelId ?? '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : sm.providerRemoveFailed)
    } finally {
      setSavingProvider(false)
    }
  }

  const saveAll = async () => {
    if (savingSettings || savingLocale || savingProvider || savingApprovalPolicy) return
    if (!selectedProviderId) {
      setError(t('settings.error.providerRequired'))
      return
    }
    if (!modelId) {
      setError(t('settings.error.modelRequired'))
      return
    }

    setSavingSettings(true)
    setError(null)
    try {
      const nextSettings = await window.assistant.saveSettings({
        activeProviderId: selectedProviderId,
        activeModelId: modelId,
        theme,
        locale,
        maxToolIterations,
        maxTotalToolCalls,
        runTimeoutMinutes,
      })
      onSettingsChange(nextSettings)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.error.save'))
    } finally {
      setSavingSettings(false)
    }
  }

  const changeLocale = async (nextLocale: AppLocale) => {
    if (
      nextLocale === locale ||
      savingLocale ||
      savingProvider ||
      savingSettings ||
      savingApprovalPolicy
    )
      return
    const previousLocale = locale
    setLocale(nextLocale)
    setSavingLocale(true)
    setError(null)
    try {
      const nextSettings = await window.assistant.saveSettings({
        activeProviderId: settings.activeProviderId,
        activeModelId: settings.activeModelId,
        theme: settings.theme,
        locale: nextLocale,
        maxToolIterations: settings.maxToolIterations,
        maxTotalToolCalls: settings.maxTotalToolCalls,
        runTimeoutMinutes: settings.runTimeoutMinutes,
      })
      setSettings(nextSettings)
      onSettingsChange(nextSettings)
    } catch (cause) {
      setLocale(previousLocale)
      setError(cause instanceof Error ? cause.message : t('settings.error.save'))
    } finally {
      setSavingLocale(false)
    }
  }

  const saveApprovalPolicy = async () => {
    if (savingApprovalPolicy || savingLocale || savingProvider || savingSettings) return
    if (!workspace) {
      setApprovalPolicyError(sm.workspaceRequiredError)
      return
    }
    if (!workspaceTrusted) {
      setApprovalPolicyError(sm.trustedWorkspaceRequiredError)
      return
    }
    if (
      fileApprovalMode === 'auto' &&
      (fileApprovalRules.length === 0 ||
        fileApprovalRules.some((rule) => !rule.pathPrefix || rule.operations.length === 0))
    ) {
      setApprovalPolicyError(sm.fileRuleRequiredError)
      return
    }
    if (
      commandApprovalMode === 'auto' &&
      (commandApprovalRules.length === 0 ||
        commandApprovalRules.some((rule) => !rule.executable || !rule.workingDirectoryPrefix))
    ) {
      setApprovalPolicyError(sm.commandRuleRequiredError)
      return
    }

    const configuration: WorkspaceApprovalPolicyConfiguration = {
      fileChanges:
        fileApprovalMode === 'manual'
          ? { mode: 'manual' }
          : {
              mode: 'auto',
              scope: fileApprovalScope,
              rules: fileApprovalRules.map(({ pathPrefix, operations }) => ({
                pathPrefix,
                operations: [...operations],
              })),
              maxFilesPerRequest,
              maxChangedLinesPerRequest,
              maxChangedBytesPerRequest,
            },
      commands:
        commandApprovalMode === 'manual'
          ? { mode: 'manual' }
          : {
              mode: 'auto',
              scope: commandApprovalScope,
              rules: commandApprovalRules.map(
                ({
                  executable,
                  argumentPrefixText,
                  allowAdditionalArguments,
                  workingDirectoryPrefix,
                  maxTimeoutMs,
                  allowHostNetwork,
                }) => ({
                  executable,
                  argumentPrefix: argumentPrefixText
                    .split('\n')
                    .filter((argument) => argument.length > 0),
                  allowAdditionalArguments,
                  workingDirectoryPrefix,
                  maxTimeoutMs,
                  allowHostNetwork,
                }),
              ),
            },
    }

    setSavingApprovalPolicy(true)
    setApprovalPolicyError(null)
    setApprovalPolicySaved(false)
    try {
      const saved = await window.assistant.saveWorkspaceApprovalPolicy(configuration)
      onApprovalPolicyChange(cloneApprovalPolicyConfiguration(saved))
      setApprovalPolicyDirty(false)
      setApprovalPolicySaved(true)
    } catch (cause) {
      setApprovalPolicyError(cause instanceof Error ? cause.message : sm.approvalPolicySaveFailed)
    } finally {
      setSavingApprovalPolicy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{sm.eyebrow}</span>
            <h1 id="settings-title">{sm.title}</h1>
            <p>{sm.description}</p>
          </div>
          {!forced && (
            <IconButton label={sm.close} onClick={onClose}>
              <X size={18} />
            </IconButton>
          )}
        </header>

        <div className="modal-body">
          <nav className="provider-list" aria-label={sm.providerNavigation}>
            <div className="provider-list-heading">
              <span>{sm.providers}</span>
              <IconButton label={sm.addProvider} onClick={startAdding}>
                <Plus size={15} />
              </IconButton>
            </div>
            <div className="provider-list-scroll">
              {settings.providers.map((provider) => (
                <button
                  type="button"
                  key={provider.id}
                  className={`provider-item${
                    !editingNew && provider.id === selectedProviderId ? ' selected' : ''
                  }`}
                  onClick={() => selectProvider(provider)}
                >
                  <span className="provider-glyph">
                    <Server size={16} />
                  </span>
                  <span>
                    <strong>{provider.name}</strong>
                    <small>{provider.baseUrl}</small>
                  </span>
                  {provider.id === settings.activeProviderId && (
                    <span className="active-check" title={sm.currentProvider}>
                      <Check size={12} />
                    </span>
                  )}
                </button>
              ))}
              {editingNew && (
                <button type="button" className="provider-item selected new-provider-item">
                  <span className="provider-glyph">
                    <Plus size={16} />
                  </span>
                  <span>
                    <strong>{sm.newProvider}</strong>
                    <small>{sm.enterConnectionDetails}</small>
                  </span>
                </button>
              )}
            </div>
          </nav>

          <div className="settings-content">
            <form className="provider-form" onSubmit={saveProvider}>
              <div className="section-title-row">
                <div>
                  <h2>{editingNew ? sm.addProviderHeading : sm.providerInformationHeading}</h2>
                  <p>{sm.endpointDescription}</p>
                </div>
                {!editingNew && selectedProvider && (
                  <span className="key-status">
                    <KeyRound size={13} />
                    {selectedProvider.apiKeyConfigured ? sm.keyStored : sm.noKey}
                  </span>
                )}
              </div>

              <div className="form-grid">
                <label>
                  <span>{sm.displayName}</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={sm.displayNamePlaceholder}
                    required
                    maxLength={80}
                  />
                </label>
                <label className="full-field">
                  <span>Base URL</span>
                  <div className="input-with-icon">
                    <Server size={15} />
                    <input
                      type="url"
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder="https://api.example.com/v1"
                      required
                    />
                  </div>
                </label>
                <label className="full-field">
                  <span>API Key</span>
                  <div className="input-with-icon">
                    <KeyRound size={15} />
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(event) => {
                        setApiKey(event.target.value)
                        setClearApiKey(false)
                      }}
                      placeholder={
                        selectedProvider?.apiKeyConfigured
                          ? sm.newKeyPlaceholder
                          : sm.apiKeyPlaceholder
                      }
                      autoComplete="off"
                      disabled={clearApiKey}
                    />
                  </div>
                  <small>{sm.apiKeyStorageDescription}</small>
                  {selectedProvider?.apiKeyConfigured && (
                    <button
                      type="button"
                      className={`stored-key-action${clearApiKey ? ' selected' : ''}`}
                      onClick={() => {
                        setClearApiKey((current) => !current)
                        setApiKey('')
                      }}
                    >
                      <Trash2 size={13} />
                      {clearApiKey ? sm.keyWillBeRemoved : sm.removeStoredKey}
                    </button>
                  )}
                </label>
              </div>

              <div className="form-actions">
                {!editingNew && (
                  <button
                    type="button"
                    className={`danger-button${confirmRemove ? ' confirm' : ''}`}
                    onClick={() => void removeProvider()}
                    disabled={
                      savingProvider || savingLocale || savingSettings || savingApprovalPolicy
                    }
                  >
                    <Trash2 size={14} /> {confirmRemove ? sm.confirmRemove : sm.remove}
                  </button>
                )}
                <button
                  type="submit"
                  className="secondary-button"
                  disabled={
                    savingProvider || savingLocale || savingSettings || savingApprovalPolicy
                  }
                >
                  {savingProvider ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Pencil size={15} />
                  )}
                  {editingNew ? sm.addProviderHeading : sm.saveProviderChanges}
                </button>
              </div>
            </form>

            <div className="settings-divider" />

            <section className="preferences-section">
              <div className="section-title-row">
                <div>
                  <h2>{t('settings.modelEnvironment')}</h2>
                  <p>{t('settings.modelEnvironment.description')}</p>
                </div>
              </div>
              <div className="preference-grid">
                <label>
                  <span>{t('settings.language')}</span>
                  <select
                    value={locale}
                    onChange={(event) => void changeLocale(event.target.value as AppLocale)}
                    disabled={
                      savingLocale || savingProvider || savingSettings || savingApprovalPolicy
                    }
                  >
                    <option value="ko">{t('settings.language.ko')}</option>
                    <option value="en">{t('settings.language.en')}</option>
                  </select>
                  <small>{t('settings.language.description')}</small>
                </label>
                <label className="model-field">
                  <span>{t('settings.defaultModel')}</span>
                  <div className="model-input-row">
                    <select
                      value={modelId}
                      onChange={(event) => setModelId(event.target.value)}
                      disabled={!selectedProviderId || loadingModels}
                    >
                      {models.length === 0 ? (
                        <option value="">
                          {loadingModels
                            ? t('settings.models.loading')
                            : t('settings.models.empty')}
                        </option>
                      ) : (
                        models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.id}
                          </option>
                        ))
                      )}
                    </select>
                    <IconButton
                      label={t('settings.models.refresh')}
                      onClick={() =>
                        selectedProviderId && void refreshModels(selectedProviderId, false)
                      }
                      disabled={!selectedProviderId || loadingModels}
                    >
                      <RefreshCw size={15} className={loadingModels ? 'spin' : ''} />
                    </IconButton>
                  </div>
                </label>

                <label>
                  <span>{t('settings.toolRounds')}</span>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={maxToolIterations}
                    onChange={(event) => setMaxToolIterations(Number(event.target.value))}
                  />
                </label>

                <label>
                  <span>{t('settings.totalToolCalls')}</span>
                  <input
                    type="number"
                    min={1}
                    max={MAX_TOTAL_TOOL_CALLS}
                    value={maxTotalToolCalls}
                    onChange={(event) => setMaxTotalToolCalls(Number(event.target.value))}
                  />
                </label>

                <label>
                  <span>{t('settings.runTimeout')}</span>
                  <input
                    type="number"
                    min={1}
                    max={MAX_AGENT_RUN_TIMEOUT_MINUTES}
                    value={runTimeoutMinutes}
                    onChange={(event) => setRunTimeoutMinutes(Number(event.target.value))}
                  />
                </label>

                <fieldset className="theme-field full-field">
                  <legend>{t('settings.theme')}</legend>
                  <div className="theme-options">
                    {(
                      [
                        ['system', t('settings.theme.system'), Monitor],
                        ['dark', t('settings.theme.dark'), Moon],
                        ['light', t('settings.theme.light'), Sun],
                      ] as const
                    ).map(([value, label, ThemeIcon]) => (
                      <button
                        type="button"
                        key={value}
                        className={theme === value ? 'selected' : ''}
                        onClick={() => setTheme(value)}
                        aria-pressed={theme === value}
                      >
                        <ThemeIcon size={15} /> {label}
                      </button>
                    ))}
                  </div>
                </fieldset>
              </div>
            </section>

            <div className="settings-divider" />

            <section className="preferences-section approval-policy-section">
              <div className="section-title-row approval-policy-title-row">
                <div>
                  <h2>{sm.approvalAutomation}</h2>
                  <p>{sm.approvalAutomationDescription}</p>
                </div>
                {workspace && (
                  <span className={`workspace-policy-badge${workspaceTrusted ? '' : ' untrusted'}`}>
                    {workspaceTrusted ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
                    {workspace.name}
                  </span>
                )}
              </div>

              {!workspace ? (
                <div className="policy-unavailable" role="status">
                  <FolderOpen size={16} />
                  <div>
                    <strong>{sm.workspaceRequired}</strong>
                    <span>{sm.workspaceRequiredDescription}</span>
                  </div>
                </div>
              ) : !workspaceTrusted ? (
                <div className="policy-unavailable warning" role="status">
                  <ShieldAlert size={16} />
                  <div>
                    <strong>{sm.restrictedMode}</strong>
                    <span>{sm.restrictedModeDescription}</span>
                  </div>
                </div>
              ) : (
                <div className="policy-workspace-scope">
                  <Folder size={14} />
                  <span>
                    <strong>{workspace.name}</strong>
                    <small title={workspace.path}>{workspace.path}</small>
                  </span>
                </div>
              )}

              <fieldset
                className="approval-policy-controls"
                disabled={!workspace || !workspaceTrusted || savingApprovalPolicy}
              >
                <legend className="sr-only">{sm.workspacePolicyLegend}</legend>

                <label className="quick-file-approval">
                  <input
                    type="checkbox"
                    checked={quickFileApprovalEnabled}
                    onChange={(event) => {
                      if (event.target.checked) {
                        setFileApprovalMode('auto')
                        setFileApprovalScope('all-act-runs')
                        setFileApprovalRules([createFileApprovalRuleDraft()])
                      } else {
                        setFileApprovalMode('manual')
                      }
                      markApprovalPolicyChanged()
                    }}
                  />
                  <span>
                    <strong>{sm.quickFileApproval}</strong>
                    <small>{sm.quickFileApprovalDescription}</small>
                  </span>
                </label>

                <section className="approval-policy-group">
                  <div className="approval-policy-group-heading">
                    <div>
                      <FileCode2 size={16} />
                      <span>
                        <strong>{sm.fileChanges}</strong>
                        <small>{sm.fileChangesDescription}</small>
                      </span>
                    </div>
                    <fieldset className="approval-mode-options" aria-label={sm.fileApprovalMode}>
                      <button
                        type="button"
                        className={fileApprovalMode === 'manual' ? 'selected' : ''}
                        aria-pressed={fileApprovalMode === 'manual'}
                        onClick={() => {
                          setFileApprovalMode('manual')
                          markApprovalPolicyChanged()
                        }}
                      >
                        {sm.alwaysConfirm}
                      </button>
                      <button
                        type="button"
                        className={fileApprovalMode === 'auto' ? 'selected' : ''}
                        aria-pressed={fileApprovalMode === 'auto'}
                        onClick={() => {
                          setFileApprovalMode('auto')
                          markApprovalPolicyChanged()
                        }}
                      >
                        {sm.autoApprove}
                      </button>
                    </fieldset>
                  </div>

                  {fileApprovalMode === 'auto' && (
                    <div className="approval-policy-details">
                      <label className="policy-select-field">
                        <span>{sm.applicableRuns}</span>
                        <select
                          value={fileApprovalScope}
                          onChange={(event) => {
                            setFileApprovalScope(event.target.value as ApprovalScope)
                            markApprovalPolicyChanged()
                          }}
                        >
                          <option value="goals-only">{sm.goalRunsOnly}</option>
                          <option value="all-act-runs">{sm.allActRuns}</option>
                        </select>
                        <small>{sm.fileScopeDescription}</small>
                      </label>

                      <div className="policy-subheading">
                        <span>
                          {sm.pathRules}
                          <small>{sm.workspaceRootPathDescription}</small>
                        </span>
                        <button
                          type="button"
                          className="ghost-button compact-button"
                          onClick={() => {
                            setFileApprovalRules((current) => [
                              ...current,
                              createFileApprovalRuleDraft(),
                            ])
                            markApprovalPolicyChanged()
                          }}
                        >
                          <Plus size={13} /> {sm.addPath}
                        </button>
                      </div>

                      <div className="policy-rule-list">
                        {fileApprovalRules.map((rule) => (
                          <div className="file-policy-rule" key={rule.id}>
                            <label>
                              <span>{sm.workspaceRelativePath}</span>
                              <input
                                value={rule.pathPrefix}
                                placeholder={sm.workspaceRelativePathPlaceholder}
                                onChange={(event) =>
                                  updateFileApprovalRule(rule.id, (current) => ({
                                    ...current,
                                    pathPrefix: event.target.value,
                                  }))
                                }
                              />
                            </label>
                            <fieldset
                              className="file-operation-options"
                              aria-label={sm.allowedFileOperations}
                            >
                              {(
                                [
                                  ['create', sm.fileOperationCreate],
                                  ['update', sm.fileOperationUpdate],
                                  ['delete', sm.fileOperationDelete],
                                ] as const
                              ).map(([operation, label]) => (
                                <label
                                  className={operation === 'delete' ? 'danger-option' : ''}
                                  key={operation}
                                >
                                  <input
                                    type="checkbox"
                                    checked={rule.operations.includes(operation)}
                                    onChange={(event) =>
                                      updateFileApprovalRule(rule.id, (current) => ({
                                        ...current,
                                        operations: event.target.checked
                                          ? [...current.operations, operation]
                                          : current.operations.filter((item) => item !== operation),
                                      }))
                                    }
                                  />
                                  <span>{label}</span>
                                </label>
                              ))}
                            </fieldset>
                            <IconButton
                              label={sm.removePathRule}
                              onClick={() => {
                                setFileApprovalRules((current) =>
                                  current.filter((item) => item.id !== rule.id),
                                )
                                markApprovalPolicyChanged()
                              }}
                              disabled={fileApprovalRules.length === 1}
                            >
                              <Trash2 size={14} />
                            </IconButton>
                          </div>
                        ))}
                      </div>

                      <div className="policy-limit-grid">
                        <label>
                          <span>{sm.maximumFilesPerRequest}</span>
                          <input
                            type="number"
                            min={1}
                            max={1_000}
                            value={maxFilesPerRequest}
                            onChange={(event) => {
                              setMaxFilesPerRequest(Number(event.target.value))
                              markApprovalPolicyChanged()
                            }}
                          />
                        </label>
                        <label>
                          <span>{sm.maximumChangedLines}</span>
                          <input
                            type="number"
                            min={1}
                            max={1_000_000}
                            value={maxChangedLinesPerRequest}
                            onChange={(event) => {
                              setMaxChangedLinesPerRequest(Number(event.target.value))
                              markApprovalPolicyChanged()
                            }}
                          />
                        </label>
                        <label>
                          <span>{sm.maximumChangedBytes}</span>
                          <input
                            type="number"
                            min={1}
                            max={1_000_000_000}
                            value={maxChangedBytesPerRequest}
                            onChange={(event) => {
                              setMaxChangedBytesPerRequest(Number(event.target.value))
                              markApprovalPolicyChanged()
                            }}
                          />
                        </label>
                      </div>
                      {fileApprovalRules.some((rule) => rule.operations.includes('delete')) && (
                        <div className="policy-warning">
                          <ShieldAlert size={14} /> {sm.deleteWarning}
                        </div>
                      )}
                    </div>
                  )}
                </section>

                <section className="approval-policy-group">
                  <div className="approval-policy-group-heading">
                    <div>
                      <Terminal size={16} />
                      <span>
                        <strong>{sm.commandExecution}</strong>
                        <small>{sm.commandExecutionDescription}</small>
                      </span>
                    </div>
                    <fieldset className="approval-mode-options" aria-label={sm.commandApprovalMode}>
                      <button
                        type="button"
                        className={commandApprovalMode === 'manual' ? 'selected' : ''}
                        aria-pressed={commandApprovalMode === 'manual'}
                        onClick={() => {
                          setCommandApprovalMode('manual')
                          markApprovalPolicyChanged()
                        }}
                      >
                        {sm.alwaysConfirm}
                      </button>
                      <button
                        type="button"
                        className={commandApprovalMode === 'auto' ? 'selected' : ''}
                        aria-pressed={commandApprovalMode === 'auto'}
                        onClick={() => {
                          setCommandApprovalMode('auto')
                          markApprovalPolicyChanged()
                        }}
                      >
                        {sm.autoApprove}
                      </button>
                    </fieldset>
                  </div>

                  {commandApprovalMode === 'auto' && (
                    <div className="approval-policy-details">
                      <label className="policy-select-field">
                        <span>{sm.applicableRuns}</span>
                        <select
                          value={commandApprovalScope}
                          onChange={(event) => {
                            setCommandApprovalScope(event.target.value as ApprovalScope)
                            markApprovalPolicyChanged()
                          }}
                        >
                          <option value="goals-only">{sm.goalRunsOnly}</option>
                          <option value="all-act-runs">{sm.allActRuns}</option>
                        </select>
                        <small>{sm.commandScopeDescription}</small>
                      </label>

                      <div className="policy-subheading">
                        <span>
                          {sm.allowedCommands}
                          <small>{sm.executablePathDescription}</small>
                        </span>
                        <button
                          type="button"
                          className="ghost-button compact-button"
                          onClick={() => {
                            setCommandApprovalRules((current) => [
                              ...current,
                              createCommandApprovalRuleDraft(),
                            ])
                            markApprovalPolicyChanged()
                          }}
                        >
                          <Plus size={13} /> {sm.addCommand}
                        </button>
                      </div>

                      <div className="policy-rule-list">
                        {commandApprovalRules.map((rule, index) => (
                          <section className="command-policy-rule" key={rule.id}>
                            <header>
                              <strong>{sm.commandRule(index + 1)}</strong>
                              <IconButton
                                label={sm.removeCommandRule}
                                onClick={() => {
                                  setCommandApprovalRules((current) =>
                                    current.filter((item) => item.id !== rule.id),
                                  )
                                  markApprovalPolicyChanged()
                                }}
                                disabled={commandApprovalRules.length === 1}
                              >
                                <Trash2 size={14} />
                              </IconButton>
                            </header>
                            <div className="command-rule-grid">
                              <label className="full-field">
                                <span>{sm.absoluteExecutablePath}</span>
                                <input
                                  value={rule.executable}
                                  placeholder={sm.absoluteExecutablePathPlaceholder}
                                  onChange={(event) =>
                                    updateCommandApprovalRule(rule.id, (current) => ({
                                      ...current,
                                      executable: event.target.value,
                                    }))
                                  }
                                />
                              </label>
                              <label className="full-field">
                                <span>{sm.requiredArgumentPrefix}</span>
                                <textarea
                                  value={rule.argumentPrefixText}
                                  placeholder={sm.argumentPrefixPlaceholder}
                                  rows={3}
                                  onChange={(event) =>
                                    updateCommandApprovalRule(rule.id, (current) => ({
                                      ...current,
                                      argumentPrefixText: event.target.value,
                                      argumentPrefix: event.target.value
                                        .split('\n')
                                        .filter((argument) => argument.length > 0),
                                    }))
                                  }
                                />
                              </label>
                              <label>
                                <span>{sm.workingDirectoryPrefix}</span>
                                <input
                                  value={rule.workingDirectoryPrefix}
                                  placeholder="."
                                  onChange={(event) =>
                                    updateCommandApprovalRule(rule.id, (current) => ({
                                      ...current,
                                      workingDirectoryPrefix: event.target.value,
                                    }))
                                  }
                                />
                              </label>
                              <label>
                                <span>{sm.maximumRuntime}</span>
                                <input
                                  type="number"
                                  min={1}
                                  max={3_600_000}
                                  value={rule.maxTimeoutMs}
                                  onChange={(event) =>
                                    updateCommandApprovalRule(rule.id, (current) => ({
                                      ...current,
                                      maxTimeoutMs: Number(event.target.value),
                                    }))
                                  }
                                />
                              </label>
                            </div>
                            <div className="command-rule-options">
                              <label>
                                <input
                                  type="checkbox"
                                  checked={rule.allowAdditionalArguments}
                                  onChange={(event) =>
                                    updateCommandApprovalRule(rule.id, (current) => ({
                                      ...current,
                                      allowAdditionalArguments: event.target.checked,
                                    }))
                                  }
                                />
                                <span>{sm.allowAdditionalArguments}</span>
                              </label>
                              <label className="danger-option">
                                <input
                                  type="checkbox"
                                  checked={rule.allowHostNetwork}
                                  onChange={(event) =>
                                    updateCommandApprovalRule(rule.id, (current) => ({
                                      ...current,
                                      allowHostNetwork: event.target.checked,
                                    }))
                                  }
                                />
                                <span>{sm.allowHostNetwork}</span>
                              </label>
                            </div>
                          </section>
                        ))}
                      </div>
                      <div className="policy-warning">
                        <ShieldAlert size={14} /> {sm.commandWarning}
                      </div>
                    </div>
                  )}
                </section>
              </fieldset>

              <div className="mcp-manual-notice">
                <Wrench size={15} />
                <span>
                  <strong>{sm.mcpManualApproval}</strong>
                  <small>{sm.mcpManualApprovalDescription}</small>
                </span>
              </div>

              {approvalPolicyError && (
                <div className="policy-save-message error" role="alert">
                  <AlertCircle size={14} /> {approvalPolicyError}
                </div>
              )}
              {approvalPolicySaved && (
                <div className="policy-save-message success" role="status">
                  <CheckCircle2 size={14} /> {sm.approvalPolicySaved}
                </div>
              )}
              <div className="approval-policy-actions">
                <span>
                  {approvalPolicyDirty ? sm.unsavedPolicyChanges : sm.manualApprovalDefault}
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void saveApprovalPolicy()}
                  disabled={
                    !workspace ||
                    !workspaceTrusted ||
                    savingApprovalPolicy ||
                    savingLocale ||
                    savingProvider ||
                    savingSettings ||
                    !approvalPolicyDirty
                  }
                >
                  {savingApprovalPolicy ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <ShieldCheck size={14} />
                  )}
                  {sm.savePolicy}
                </button>
              </div>
            </section>

            {error && (
              <div className="settings-error" role="alert">
                <AlertCircle size={15} /> {error}
              </div>
            )}
          </div>
        </div>

        <footer className="modal-footer">
          <span>
            {forced ? t('settings.footer.required') : t('settings.footer.nextConversation')}
          </span>
          <div>
            {!forced && (
              <button type="button" className="ghost-button" onClick={onClose}>
                {t('common.cancel')}
              </button>
            )}
            <button
              type="button"
              className="primary-button"
              onClick={() => void saveAll()}
              disabled={
                savingSettings ||
                savingLocale ||
                savingProvider ||
                savingApprovalPolicy ||
                !selectedProviderId ||
                !modelId
              }
            >
              {savingSettings ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
              {t('settings.save')}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function AppContent({ onLocaleChange }: { onLocaleChange: (locale: AppLocale) => void }) {
  const { locale, t } = useI18n()
  const rt = useRuntimeMessages()
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null)
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  const [workspaceDirectories, setWorkspaceDirectories] = useState<WorkspaceDirectoryStates>({})
  const [expandedWorkspacePaths, setExpandedWorkspacePaths] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [contextPaths, setContextPaths] = useState<string[]>([])
  const [workspaceCommands, setWorkspaceCommands] = useState<SlashCommandDescriptor[]>([])
  const [skills, setSkills] = useState<SkillDescriptor[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [startingRun, setStartingRun] = useState(false)
  const [executingCommand, setExecutingCommand] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [trustUpdating, setTrustUpdating] = useState(false)
  const [approvalQueue, setApprovalQueue] = useState<PendingApproval[]>([])
  const [approvalResolving, setApprovalResolving] = useState(false)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [undoAvailable, setUndoAvailable] = useState(false)
  const [undoStatus, setUndoStatus] = useState<UndoStatus | null>(null)
  const [undoOpen, setUndoOpen] = useState(false)
  const [undoBusy, setUndoBusy] = useState(false)
  const [undoError, setUndoError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historySearch, setHistorySearch] = useState('')
  const [historyArchived, setHistoryArchived] = useState(false)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyBusyId, setHistoryBusyId] = useState<string | null>(null)
  const [goalsOpen, setGoalsOpen] = useState(false)
  const [showAllGoals, setShowAllGoals] = useState(false)
  const [goals, setGoals] = useState<GoalSummary[]>([])
  const [goalDetail, setGoalDetail] = useState<GoalDetail | null>(null)
  const [goalsLoading, setGoalsLoading] = useState(false)
  const [goalsError, setGoalsError] = useState<string | null>(null)
  const [goalBusyId, setGoalBusyId] = useState<string | null>(null)
  const [workspaceDetailsOpen, setWorkspaceDetailsOpen] = useState(false)
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('status')
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null)
  const [gitDiff, setGitDiff] = useState<GitDiffResult | null>(null)
  const [gitDiffStaged, setGitDiffStaged] = useState(false)
  const [workspaceDetailsLoading, setWorkspaceDetailsLoading] = useState(false)
  const [workspaceDetailsError, setWorkspaceDetailsError] = useState<string | null>(null)
  const conversationIdRef = useRef(makeId())
  const pendingAssistantIdRef = useRef<string | null>(null)
  const historyRequestRef = useRef(0)
  const goalsListRequestRef = useRef(0)
  const goalDetailRequestRef = useRef(0)
  const goalOperationSequenceRef = useRef(0)
  const goalOperationRef = useRef<{ id: string; sequence: number } | null>(null)
  const workspaceDetailsRequestRef = useRef(0)
  const initializeStartedRef = useRef(false)
  const workspaceDirectoriesRef = useRef<WorkspaceDirectoryStates>({})
  const expandedWorkspacePathsRef = useRef<ReadonlySet<string>>(new Set())
  const workspaceLoadGenerationRef = useRef(0)
  const workspaceDirectoryRequestRef = useRef(new Map<string, number>())

  const commitWorkspaceDirectories = useCallback(
    (update: (current: WorkspaceDirectoryStates) => WorkspaceDirectoryStates) => {
      const next = update(workspaceDirectoriesRef.current)
      workspaceDirectoriesRef.current = next
      setWorkspaceDirectories(next)
    },
    [],
  )

  const updateExpandedWorkspacePaths = useCallback(
    (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => {
      const next = update(expandedWorkspacePathsRef.current)
      expandedWorkspacePathsRef.current = next
      setExpandedWorkspacePaths(next)
    },
    [],
  )

  const loadWorkspaceDirectory = useCallback(
    async (path: string | null, cursor: string | null, generation: number): Promise<boolean> => {
      const key = workspaceDirectoryKey(path)
      const requestId = (workspaceDirectoryRequestRef.current.get(key) ?? 0) + 1
      workspaceDirectoryRequestRef.current.set(key, requestId)
      commitWorkspaceDirectories((current) => {
        const previous = current[key] ?? emptyWorkspaceDirectoryState()
        return {
          ...current,
          [key]: {
            ...previous,
            status: cursor ? previous.status : 'loading',
            loadingMore: Boolean(cursor),
            retryCursor: null,
            error: null,
          },
        }
      })

      try {
        const page = await window.assistant.listWorkspace({ path, cursor })
        if (
          generation !== workspaceLoadGenerationRef.current ||
          workspaceDirectoryRequestRef.current.get(key) !== requestId
        ) {
          return false
        }
        commitWorkspaceDirectories((current) => {
          const previous = current[key] ?? emptyWorkspaceDirectoryState()
          return {
            ...current,
            [key]: {
              status: page.complete ? 'loaded' : 'partial',
              entries: cursor
                ? mergeWorkspaceEntries(previous.entries, page.entries)
                : [...page.entries],
              nextCursor: page.nextCursor,
              retryCursor: null,
              loadingMore: false,
              error: null,
            },
          }
        })
        return true
      } catch (cause) {
        if (
          generation !== workspaceLoadGenerationRef.current ||
          workspaceDirectoryRequestRef.current.get(key) !== requestId
        ) {
          return false
        }
        commitWorkspaceDirectories((current) => {
          const previous = current[key] ?? emptyWorkspaceDirectoryState()
          return {
            ...current,
            [key]: {
              ...previous,
              status: 'error',
              retryCursor: cursor,
              loadingMore: false,
              error: cause instanceof Error ? cause.message : rt('workspaceLoadFailed'),
            },
          }
        })
        return false
      }
    },
    [commitWorkspaceDirectories, rt],
  )

  const loadWorkspace = useCallback(async (): Promise<boolean> => {
    const generation = workspaceLoadGenerationRef.current + 1
    workspaceLoadGenerationRef.current = generation
    const expandedPaths = [...expandedWorkspacePathsRef.current]
    const rootLoaded = await loadWorkspaceDirectory(null, null, generation)
    if (!rootLoaded || generation !== workspaceLoadGenerationRef.current) return false

    await Promise.all(expandedPaths.map((path) => loadWorkspaceDirectory(path, null, generation)))
    return generation === workspaceLoadGenerationRef.current
  }, [loadWorkspaceDirectory])

  const toggleWorkspaceDirectory = useCallback(
    (entry: Extract<WorkspaceEntry, { kind: 'directory' }>) => {
      const expanded = expandedWorkspacePathsRef.current.has(entry.path)
      updateExpandedWorkspacePaths((current) => {
        const next = new Set(current)
        if (expanded) next.delete(entry.path)
        else next.add(entry.path)
        return next
      })
      if (expanded) return

      if (!entry.hasChildren) {
        commitWorkspaceDirectories((current) => ({
          ...current,
          [entry.path]: {
            ...emptyWorkspaceDirectoryState(),
            status: 'loaded',
          },
        }))
        return
      }

      const state = workspaceDirectoriesRef.current[entry.path]
      if (!state || state.status === 'unloaded') {
        void loadWorkspaceDirectory(entry.path, null, workspaceLoadGenerationRef.current)
      }
    },
    [commitWorkspaceDirectories, loadWorkspaceDirectory, updateExpandedWorkspacePaths],
  )

  const loadMoreWorkspaceDirectory = useCallback(
    (path: string | null, cursor: string) => {
      void loadWorkspaceDirectory(path, cursor, workspaceLoadGenerationRef.current)
    },
    [loadWorkspaceDirectory],
  )

  const retryWorkspaceDirectory = useCallback(
    (path: string | null) => {
      const state = workspaceDirectoriesRef.current[workspaceDirectoryKey(path)]
      void loadWorkspaceDirectory(
        path,
        state?.retryCursor ?? null,
        workspaceLoadGenerationRef.current,
      )
    },
    [loadWorkspaceDirectory],
  )

  const loadSlashCommands = useCallback(
    async (silent = false, trusted = true): Promise<number | null> => {
      if (!trusted) {
        setWorkspaceCommands([])
        return 0
      }
      try {
        const commands = await window.assistant.listSlashCommands()
        setWorkspaceCommands(commands)
        return commands.length
      } catch (cause) {
        setWorkspaceCommands([])
        if (!silent) {
          setNotice({
            type: 'error',
            message: cause instanceof Error ? cause.message : rt('slashCommandsLoadFailed'),
          })
        }
        return null
      }
    },
    [rt],
  )

  const loadSkills = useCallback(
    async (silent = false, trusted = true): Promise<number | null> => {
      if (!trusted) {
        setSkills([])
        return 0
      }
      try {
        const result = await window.assistant.listSkills()
        setSkills(result)
        return result.length
      } catch (cause) {
        setSkills([])
        if (!silent) {
          setNotice({
            type: 'error',
            message: cause instanceof Error ? cause.message : rt('skillsLoadFailed'),
          })
        }
        return null
      }
    },
    [rt],
  )

  const loadUndoStatus = useCallback(async (trusted: boolean) => {
    if (!trusted) {
      setUndoAvailable(false)
      setUndoStatus(null)
      return null
    }
    try {
      const status = await window.assistant.getUndoStatus()
      setUndoAvailable(status.available)
      setUndoStatus(status.available ? status : null)
      return status
    } catch {
      setUndoAvailable(false)
      setUndoStatus(null)
      return null
    }
  }, [])

  const loadConversations = useCallback(
    async (search = '', archived = false) => {
      const requestId = ++historyRequestRef.current
      setHistoryLoading(true)
      setHistoryError(null)
      try {
        const result = await window.assistant.listConversations({
          archived,
          limit: 100,
          ...(search.trim() ? { search: search.trim() } : {}),
        })
        if (requestId === historyRequestRef.current) setConversations(result)
      } catch (cause) {
        if (requestId === historyRequestRef.current) {
          setConversations([])
          setHistoryError(cause instanceof Error ? cause.message : rt('historyLoadFailed'))
        }
      } finally {
        if (requestId === historyRequestRef.current) setHistoryLoading(false)
      }
    },
    [rt],
  )

  const loadGoals = useCallback(
    async (preferredGoalId?: string, preserveError = false, includeTerminal = false) => {
      const listRequestId = ++goalsListRequestRef.current
      const detailRequestId = ++goalDetailRequestRef.current
      setGoalsLoading(true)
      if (!preserveError) setGoalsError(null)
      try {
        const result = await window.assistant.listGoals({
          limit: 200,
          ...(includeTerminal ? {} : { statuses: [...OPEN_GOAL_STATUSES] }),
        })
        if (listRequestId !== goalsListRequestRef.current) return
        setGoals(result)
        const preferredGoalAvailable =
          preferredGoalId !== undefined && result.some((goal) => goal.id === preferredGoalId)
        const selectedId =
          (preferredGoalAvailable ? preferredGoalId : undefined) ??
          (goalDetail && result.some((goal) => goal.id === goalDetail.summary.id)
            ? goalDetail.summary.id
            : result[0]?.id)
        if (!selectedId) {
          setGoalDetail(null)
          return
        }
        const detail = await window.assistant.readGoal({ goalId: selectedId })
        if (
          listRequestId === goalsListRequestRef.current &&
          detailRequestId === goalDetailRequestRef.current
        ) {
          setGoalDetail(detail)
        }
      } catch (cause) {
        if (listRequestId === goalsListRequestRef.current) {
          setGoalsError(cause instanceof Error ? cause.message : rt('goalsLoadFailed'))
        }
      } finally {
        if (listRequestId === goalsListRequestRef.current) setGoalsLoading(false)
      }
    },
    [goalDetail, rt],
  )

  const loadWorkspaceDetails = useCallback(
    async (tab: WorkspaceTab, trusted: boolean, staged = false) => {
      const requestId = ++workspaceDetailsRequestRef.current
      setWorkspaceDetailsError(null)
      if (!trusted && tab === 'skills') {
        setWorkspaceDetailsLoading(false)
        return
      }
      setWorkspaceDetailsLoading(true)
      try {
        if (tab === 'status') {
          const result = await window.assistant.getGitStatus()
          if (requestId === workspaceDetailsRequestRef.current) setGitStatus(result)
        } else if (tab === 'diff') {
          const result = await window.assistant.getGitDiff({ staged })
          if (requestId === workspaceDetailsRequestRef.current) setGitDiff(result)
        } else {
          const result = await window.assistant.listSkills()
          if (requestId === workspaceDetailsRequestRef.current) setSkills(result)
        }
      } catch (cause) {
        if (requestId === workspaceDetailsRequestRef.current) {
          setWorkspaceDetailsError(
            cause instanceof Error ? cause.message : rt('workspaceDetailsLoadFailed'),
          )
        }
      } finally {
        if (requestId === workspaceDetailsRequestRef.current) {
          setWorkspaceDetailsLoading(false)
        }
      }
    },
    [rt],
  )

  const loadModels = useCallback(
    async (providerId: string) => {
      setModelsLoading(true)
      try {
        setModels(await window.assistant.listModels({ providerId }))
      } catch (cause) {
        setModels([])
        setNotice({
          type: 'error',
          message: cause instanceof Error ? cause.message : rt('modelsLoadFailed'),
        })
      } finally {
        setModelsLoading(false)
      }
    },
    [rt],
  )

  const initialize = useCallback(async () => {
    setBootstrapError(null)
    try {
      const state = await window.assistant.bootstrap()
      onLocaleChange(state.settings.locale)
      setBootstrap(state)
      if (state.recoveryNotice) setNotice({ type: 'error', message: state.recoveryNotice })
      setSettingsOpen(state.settings.providers.length === 0)
      if (state.workspace) {
        void Promise.all([
          loadWorkspace(),
          loadSlashCommands(true, state.workspaceTrusted),
          loadSkills(true, state.workspaceTrusted),
          loadUndoStatus(state.workspaceTrusted),
        ])
      } else {
        setWorkspaceCommands([])
        setSkills([])
      }
      if (state.settings.activeProviderId) void loadModels(state.settings.activeProviderId)
    } catch (cause) {
      setBootstrapError(cause instanceof Error ? cause.message : rt('bootstrapLoadFailed'))
    }
  }, [loadModels, loadSkills, loadSlashCommands, loadUndoStatus, loadWorkspace, onLocaleChange, rt])

  useEffect(() => {
    if (initializeStartedRef.current) return
    initializeStartedRef.current = true
    void initialize()
  }, [initialize])

  useEffect(() => {
    if (!bootstrap) return
    const root = document.documentElement
    root.dataset.platform = bootstrap.platform
    root.lang = bootstrap.settings.locale
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      const resolved =
        bootstrap.settings.theme === 'system'
          ? media.matches
            ? 'dark'
            : 'light'
          : bootstrap.settings.theme
      root.dataset.theme = resolved
      root.style.colorScheme = resolved
    }
    applyTheme()
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [bootstrap])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(null), 4200)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    if (!historyOpen) return
    const timeout = window.setTimeout(
      () => void loadConversations(historySearch, historyArchived),
      220,
    )
    return () => window.clearTimeout(timeout)
  }, [historyArchived, historyOpen, historySearch, loadConversations])

  useEffect(() => {
    if (!workspaceDetailsOpen || !bootstrap) return
    void loadWorkspaceDetails(workspaceTab, bootstrap.workspaceTrusted, gitDiffStaged)
  }, [bootstrap, gitDiffStaged, loadWorkspaceDetails, workspaceDetailsOpen, workspaceTab])

  useEffect(() => {
    return window.assistant.onAgentEvent((event: AgentEvent) => {
      if (event.type === 'started') setActiveRunId(event.runId)
      if (event.type === 'conversation-title') {
        setConversations((current) =>
          current.map((conversation) =>
            conversation.id === event.conversationId
              ? { ...conversation, title: event.title }
              : conversation,
          ),
        )
      }
      if (event.type === 'approval-requested') {
        setApprovalError(null)
        setApprovalQueue((current) => [
          ...current.filter((item) => item.request.approvalId !== event.request.approvalId),
          { runId: event.runId, request: event.request },
        ])
      }
      if (event.type === 'approval-resolved') {
        setApprovalResolving(false)
        setApprovalError(null)
        setApprovalQueue((current) =>
          current.filter((item) => item.request.approvalId !== event.approvalId),
        )
      }
      if (event.type === 'files-changed') {
        setUndoAvailable(event.undoAvailable)
        void loadUndoStatus(true)
        setNotice({
          type: 'success',
          message: rt('filesChanged', {
            count: event.paths.length,
            undoAvailable: event.undoAvailable,
          }),
        })
        void loadWorkspace()
      }

      setMessages((current) => {
        const targetIndex = current.findIndex(
          (message) =>
            message.role === 'assistant' &&
            (message.runId === event.runId || message.id === pendingAssistantIdRef.current),
        )
        if (targetIndex < 0) return current

        const target = current[targetIndex]
        if (target.role !== 'assistant') return current
        const nextTarget: AssistantMessage = { ...target, runId: event.runId }

        switch (event.type) {
          case 'started':
            nextTarget.status = 'running'
            break
          case 'conversation-title':
            break
          case 'text-delta':
            nextTarget.status = 'running'
            nextTarget.content += event.delta
            break
          case 'tool-started':
            nextTarget.status = 'running'
            nextTarget.tools = [
              ...nextTarget.tools.filter((tool) => tool.callId !== event.callId),
              {
                callId: event.callId,
                tool: event.tool,
                summary: event.summary,
                status: 'running',
              },
            ]
            break
          case 'tool-completed':
            nextTarget.tools = nextTarget.tools.some((tool) => tool.callId === event.callId)
              ? nextTarget.tools.map((tool) =>
                  tool.callId === event.callId
                    ? {
                        ...tool,
                        tool: event.tool,
                        summary: event.summary,
                        status: event.ok ? 'completed' : 'error',
                      }
                    : tool,
                )
              : [
                  ...nextTarget.tools,
                  {
                    callId: event.callId,
                    tool: event.tool,
                    summary: event.summary,
                    status: event.ok ? 'completed' : 'error',
                  },
                ]
            break
          case 'command-output': {
            const existing = nextTarget.commandOutputs.find(
              (output) => output.callId === event.callId,
            ) ?? { callId: event.callId, stdout: '', stderr: '' }
            const updated = {
              ...existing,
              [event.stream]: existing[event.stream] + event.delta,
            }
            nextTarget.commandOutputs = nextTarget.commandOutputs.some(
              (output) => output.callId === event.callId,
            )
              ? nextTarget.commandOutputs.map((output) =>
                  output.callId === event.callId ? updated : output,
                )
              : [...nextTarget.commandOutputs, updated]
            break
          }
          case 'usage':
            nextTarget.usage = event.usage
            break
          case 'files-changed':
            nextTarget.changedPaths = [...new Set([...nextTarget.changedPaths, ...event.paths])]
            break
          case 'approval-requested':
          case 'approval-resolved':
            break
          case 'completed':
            nextTarget.status = 'completed'
            break
          case 'interrupted':
            nextTarget.status = 'interrupted'
            nextTarget.warning = event.message
            break
          case 'cancelled':
            nextTarget.status = 'cancelled'
            break
          case 'error':
            nextTarget.status = 'error'
            nextTarget.error = event.message
            break
        }

        const next = [...current]
        next[targetIndex] = nextTarget
        return next
      })

      if (
        event.type === 'completed' ||
        event.type === 'interrupted' ||
        event.type === 'cancelled' ||
        event.type === 'error'
      ) {
        setActiveRunId(null)
        setStartingRun(false)
        setApprovalResolving(false)
        setApprovalError(null)
        setApprovalQueue((current) => current.filter((item) => item.runId !== event.runId))
        pendingAssistantIdRef.current = null
      }
    })
  }, [loadUndoStatus, loadWorkspace, rt])

  const chooseWorkspace = async () => {
    try {
      const workspace = await window.assistant.chooseWorkspace()
      if (!workspace || !bootstrap) return
      const refreshed = await window.assistant.bootstrap()
      setBootstrap({ ...refreshed, workspace: refreshed.workspace ?? workspace })
      if (refreshed.recoveryNotice) {
        setNotice({ type: 'error', message: refreshed.recoveryNotice })
      }
      workspaceLoadGenerationRef.current += 1
      workspaceDirectoryRequestRef.current.clear()
      workspaceDirectoriesRef.current = {}
      setWorkspaceDirectories({})
      expandedWorkspacePathsRef.current = new Set()
      setExpandedWorkspacePaths(new Set())
      setWorkspaceCommands([])
      setSkills([])
      setPreview(null)
      setContextPaths([])
      setMessages([])
      setApprovalQueue([])
      setUndoAvailable(false)
      setUndoStatus(null)
      setGitStatus(null)
      setGitDiff(null)
      goalsListRequestRef.current += 1
      goalDetailRequestRef.current += 1
      goalOperationSequenceRef.current += 1
      goalOperationRef.current = null
      setGoalsOpen(false)
      setShowAllGoals(false)
      setGoals([])
      setGoalDetail(null)
      setGoalsLoading(false)
      setGoalsError(null)
      setGoalBusyId(null)
      conversationIdRef.current = makeId()
      setRightOpen(true)
      await Promise.all([
        loadWorkspace(),
        loadSlashCommands(false, refreshed.workspaceTrusted),
        loadSkills(true, refreshed.workspaceTrusted),
        loadUndoStatus(refreshed.workspaceTrusted),
      ])
    } catch (cause) {
      setNotice({
        type: 'error',
        message: cause instanceof Error ? cause.message : rt('workspaceOpenFailed'),
      })
    }
  }

  const openFile = async (entry: WorkspaceEntry) => {
    setPreviewLoading(true)
    setPreviewError(null)
    setRightOpen(true)
    try {
      setPreview(await window.assistant.readWorkspaceFile({ path: entry.path }))
    } catch (cause) {
      setPreview(null)
      setPreviewError(cause instanceof Error ? cause.message : rt('fileReadFailed'))
    } finally {
      setPreviewLoading(false)
    }
  }

  const togglePreviewContext = () => {
    if (!preview) return
    setContextPaths((current) =>
      current.includes(preview.path)
        ? current.filter((path) => path !== preview.path)
        : current.length < 20
          ? [...current, preview.path]
          : current,
    )
    if (!contextPaths.includes(preview.path) && contextPaths.length >= 20) {
      setNotice({ type: 'error', message: rt('contextLimit') })
    }
  }

  const changeModel = async (modelId: string): Promise<boolean> => {
    if (!bootstrap || !modelId) return false
    try {
      const settings = await window.assistant.saveSettings({
        activeProviderId: bootstrap.settings.activeProviderId,
        activeModelId: modelId,
        theme: bootstrap.settings.theme,
        locale: bootstrap.settings.locale,
        maxToolIterations: bootstrap.settings.maxToolIterations,
        maxTotalToolCalls: bootstrap.settings.maxTotalToolCalls,
      })
      setBootstrap({ ...bootstrap, settings })
      if (bootstrap.settings.activeModelId !== settings.activeModelId) {
        conversationIdRef.current = makeId()
        setMessages([])
      }
      return true
    } catch (cause) {
      setNotice({
        type: 'error',
        message: cause instanceof Error ? cause.message : rt('modelSaveFailed'),
      })
      return false
    }
  }

  const sendMessage = async (
    content: string,
    displayContent = content,
    intent: AgentRunIntent = 'act',
    goalId?: string,
    runContextPaths: string[] = contextPaths,
  ) => {
    if (!bootstrap?.settings.activeModelId || !bootstrap.settings.activeProviderId) return
    const userId = makeId()
    const assistantId = makeId()
    pendingAssistantIdRef.current = assistantId
    setStartingRun(true)
    setMessages((current) => [
      ...current,
      { id: userId, role: 'user', content: displayContent, contextPaths: [...runContextPaths] },
      {
        id: assistantId,
        role: 'assistant',
        runId: null,
        content: '',
        tools: [],
        status: 'starting',
        commandOutputs: [],
        changedPaths: [],
      },
    ])

    try {
      const { runId } = await window.assistant.startRun({
        conversationId: conversationIdRef.current,
        userMessageId: userId,
        assistantMessageId: assistantId,
        message: content,
        displayMessage: displayContent,
        contextPaths: runContextPaths,
        intent,
        ...(goalId ? { goalId } : {}),
        trigger: {
          providerId: 'builtin:user-message',
          type: goalId ? 'goal-manual-continue' : 'user-message',
          dedupeKey: userId,
        },
      })
      setActiveRunId(runId)
      setMessages((current) =>
        current.map((message) =>
          message.role === 'assistant' && message.id === assistantId
            ? { ...message, runId, status: 'running' }
            : message,
        ),
      )
    } catch (cause) {
      pendingAssistantIdRef.current = null
      setStartingRun(false)
      const message = cause instanceof Error ? cause.message : rt('runStartFailed')
      setMessages((current) =>
        current.map((item) =>
          item.role === 'assistant' && item.id === assistantId
            ? { ...item, status: 'error', error: message }
            : item,
        ),
      )
      throw cause
    }
  }

  const cancelRun = async () => {
    if (!activeRunId) return
    try {
      await window.assistant.cancelRun({ runId: activeRunId })
    } catch (cause) {
      setNotice({
        type: 'error',
        message: cause instanceof Error ? cause.message : rt('runCancelFailed'),
      })
    }
  }

  const changeWorkspaceTrust = async (trusted: boolean) => {
    if (!bootstrap?.workspace) return
    setTrustUpdating(true)
    try {
      const result = await window.assistant.setWorkspaceTrust({ trusted })
      setBootstrap((current) =>
        current ? { ...current, workspaceTrusted: result.trusted } : current,
      )
      if (result.trusted) {
        const [commandCount, skillCount] = await Promise.all([
          loadSlashCommands(true, true),
          loadSkills(true, true),
          loadUndoStatus(true),
        ])
        if (commandCount === null || skillCount === null) {
          setNotice({
            type: 'error',
            message: rt('trustPartialLoadFailed'),
          })
        } else {
          setNotice({
            type: 'success',
            message: rt('workspaceTrusted', { commandCount, skillCount }),
          })
        }
      } else {
        setWorkspaceCommands([])
        setSkills([])
        setUndoAvailable(false)
        setUndoStatus(null)
        setNotice({
          type: 'success',
          message: rt('restrictedModeEnabled'),
        })
      }
    } catch (cause) {
      setNotice({
        type: 'error',
        message: cause instanceof Error ? cause.message : rt('trustChangeFailed'),
      })
    } finally {
      setTrustUpdating(false)
    }
  }

  const resolveCurrentApproval = useCallback(
    async (decision: 'approved' | 'denied') => {
      const pending = approvalQueue[0]
      if (!pending || approvalResolving) return
      setApprovalResolving(true)
      setApprovalError(null)
      try {
        await window.assistant.resolveApproval({
          runId: pending.runId,
          approvalId: pending.request.approvalId,
          decision,
        })
        setApprovalQueue((current) =>
          current.filter((item) => item.request.approvalId !== pending.request.approvalId),
        )
      } catch (cause) {
        setApprovalError(cause instanceof Error ? cause.message : rt('approvalResolveFailed'))
      } finally {
        setApprovalResolving(false)
      }
    },
    [approvalQueue, approvalResolving, rt],
  )

  const restoreConversation = (detail: ConversationDetail) => {
    const restoredMessages = toConversationMessages(detail)
    const latestUser = [...restoredMessages]
      .reverse()
      .find((message): message is UserMessage => message.role === 'user')
    conversationIdRef.current = detail.summary.id
    pendingAssistantIdRef.current = null
    setActiveRunId(null)
    setStartingRun(false)
    setMessages(restoredMessages)
    setContextPaths(latestUser?.contextPaths ?? [])
    setHistoryOpen(false)
  }

  const openConversation = async (conversation: ConversationSummary) => {
    if (activeRunId || startingRun) return
    setHistoryBusyId(conversation.id)
    setHistoryError(null)
    try {
      const detail = await window.assistant.readConversation({ conversationId: conversation.id })
      if (!detail) throw new Error(rt('conversationMissing'))
      restoreConversation(detail)
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : rt('conversationOpenFailed'))
    } finally {
      setHistoryBusyId(null)
    }
  }

  const forkConversation = async (conversation: ConversationSummary) => {
    if (activeRunId || startingRun) return
    setHistoryBusyId(conversation.id)
    setHistoryError(null)
    try {
      const detail = await window.assistant.forkConversation({ conversationId: conversation.id })
      restoreConversation(detail)
      setNotice({ type: 'success', message: rt('conversationForked') })
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : rt('conversationForkFailed'))
    } finally {
      setHistoryBusyId(null)
    }
  }

  const archiveConversation = async (conversation: ConversationSummary) => {
    setHistoryBusyId(conversation.id)
    setHistoryError(null)
    try {
      await window.assistant.archiveConversation({ conversationId: conversation.id })
      if (conversationIdRef.current === conversation.id) {
        conversationIdRef.current = makeId()
        setMessages([])
      }
      await loadConversations(historySearch, historyArchived)
      setNotice({ type: 'success', message: rt('conversationArchived') })
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : rt('conversationArchiveFailed'))
    } finally {
      setHistoryBusyId(null)
    }
  }

  const deleteConversation = async (conversation: ConversationSummary) => {
    setHistoryBusyId(conversation.id)
    setHistoryError(null)
    try {
      await window.assistant.deleteConversation({ conversationId: conversation.id })
      if (conversationIdRef.current === conversation.id) {
        conversationIdRef.current = makeId()
        setMessages([])
      }
      await loadConversations(historySearch, historyArchived)
      setNotice({ type: 'success', message: rt('conversationDeleted') })
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : rt('conversationDeleteFailed'))
    } finally {
      setHistoryBusyId(null)
    }
  }

  const openGoal = async (goalId: string) => {
    if (goalOperationRef.current) return
    const operationSequence = ++goalOperationSequenceRef.current
    goalOperationRef.current = { id: goalId, sequence: operationSequence }
    const requestId = ++goalDetailRequestRef.current
    setGoalBusyId(goalId)
    setGoalsError(null)
    try {
      const detail = await window.assistant.readGoal({ goalId })
      if (requestId === goalDetailRequestRef.current) setGoalDetail(detail)
    } catch (cause) {
      if (requestId === goalDetailRequestRef.current) {
        setGoalsError(cause instanceof Error ? cause.message : rt('goalLoadFailed'))
      }
    } finally {
      if (goalOperationRef.current?.sequence === operationSequence) {
        goalOperationRef.current = null
        setGoalBusyId(null)
      }
    }
  }

  const createGoal = async (input: CreateGoalInput) => {
    if (goalOperationRef.current) throw new Error(rt('goalOperationBusy'))
    const operationSequence = ++goalOperationSequenceRef.current
    goalOperationRef.current = { id: 'new', sequence: operationSequence }
    setGoalBusyId('new')
    setGoalsError(null)
    try {
      const detail = await window.assistant.createGoal(input)
      setGoalDetail(detail)
      await loadGoals(detail.summary.id, false, showAllGoals)
      setNotice({ type: 'success', message: rt('goalCreated') })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : rt('goalCreateFailed')
      setGoalsError(message)
      throw cause
    } finally {
      if (goalOperationRef.current?.sequence === operationSequence) {
        goalOperationRef.current = null
        setGoalBusyId(null)
      }
    }
  }

  const mutateGoal = async (input: MutateGoalInput) => {
    if (goalOperationRef.current) throw new Error(rt('goalOperationBusy'))
    const operationSequence = ++goalOperationSequenceRef.current
    goalOperationRef.current = { id: input.goalId, sequence: operationSequence }
    setGoalBusyId(input.goalId)
    setGoalsError(null)
    try {
      const detail = await window.assistant.mutateGoal(input)
      setGoalDetail(detail)
      await loadGoals(detail.summary.id, false, showAllGoals)
      setNotice({ type: 'success', message: rt('goalUpdated') })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : rt('goalUpdateFailed')
      await loadGoals(input.goalId, true, showAllGoals).catch(() => undefined)
      setGoalsError(message)
      throw cause
    } finally {
      if (goalOperationRef.current?.sequence === operationSequence) {
        goalOperationRef.current = null
        setGoalBusyId(null)
      }
    }
  }

  const continueGoal = async (goal: GoalSummary) => {
    if (!bootstrap?.workspaceTrusted) {
      setGoalsError(rt('goalTrustRequired'))
      return
    }
    if (activeRunId || startingRun) {
      setGoalsError(rt('goalWaitRequired'))
      return
    }
    const previousConversationId = conversationIdRef.current
    const previousMessages = messages
    const previousContextPaths = contextPaths
    conversationIdRef.current = makeId()
    pendingAssistantIdRef.current = null
    setMessages([])
    setContextPaths([])
    setGoalsOpen(false)
    try {
      await sendMessage(
        'Continue the attached durable goal. Re-read its current state, inspect current repository evidence, advance the plan safely, verify any work, and record a checkpoint before yielding if the goal remains active.',
        rt('goalContinueDisplay', { objective: goal.objective }),
        'act',
        goal.id,
        [],
      )
    } catch (cause) {
      conversationIdRef.current = previousConversationId
      pendingAssistantIdRef.current = null
      setMessages(previousMessages)
      setContextPaths(previousContextPaths)
      setGoalsOpen(true)
      setGoalsError(cause instanceof Error ? cause.message : rt('goalStartFailed'))
    }
  }

  const undoLastMutation = async () => {
    setUndoBusy(true)
    setUndoError(null)
    try {
      if (!undoStatus?.actionHash || !undoStatus.journalId) {
        throw new Error(rt('undoReloadRequired'))
      }
      const result = await window.assistant.undoLastMutation({
        actionHash: undoStatus.actionHash,
        journalId: undoStatus.journalId,
      })
      setUndoAvailable(false)
      setUndoStatus(null)
      setUndoOpen(false)
      await loadWorkspace()
      if (workspaceDetailsOpen && bootstrap) {
        await loadWorkspaceDetails(workspaceTab, bootstrap.workspaceTrusted, gitDiffStaged)
      }
      setNotice({
        type: 'success',
        message:
          result.restoredPaths.length > 0
            ? rt('filesRestored', { count: result.restoredPaths.length })
            : rt('noFileChangesToUndo'),
      })
    } catch (cause) {
      setUndoError(cause instanceof Error ? cause.message : rt('undoFailed'))
    } finally {
      setUndoBusy(false)
    }
  }

  const applySettings = (settings: AppSettings) => {
    const identityChanged = Boolean(
      bootstrap &&
        (bootstrap.settings.activeProviderId !== settings.activeProviderId ||
          bootstrap.settings.activeModelId !== settings.activeModelId),
    )
    setBootstrap((current) => (current ? { ...current, settings } : current))
    onLocaleChange(settings.locale)
    if (identityChanged) {
      conversationIdRef.current = makeId()
      setMessages([])
    }
    if (settings.activeProviderId) void loadModels(settings.activeProviderId)
  }

  const applyApprovalPolicy = (policy: WorkspaceApprovalPolicyConfiguration) => {
    setBootstrap((current) =>
      current
        ? { ...current, workspaceApprovalPolicy: cloneApprovalPolicyConfiguration(policy) }
        : current,
    )
  }

  const startNewConversation = ({ clearContext = false } = {}) => {
    if (activeRunId || startingRun) return
    conversationIdRef.current = makeId()
    pendingAssistantIdRef.current = null
    setMessages([])
    if (clearContext) setContextPaths([])
  }

  if (!bootstrap && !bootstrapError) return <LoadingScreen />
  if (!bootstrap && bootstrapError)
    return <ErrorScreen message={bootstrapError} onRetry={initialize} />
  if (!bootstrap) return null

  const readiness = buildReadinessSnapshot({
    providerSelected: Boolean(bootstrap.settings.activeProviderId),
    modelSelected: Boolean(bootstrap.settings.activeModelId),
    workspaceSelected: Boolean(bootstrap.workspace),
    workspaceTrusted: bootstrap.workspaceTrusted,
  })
  const running = Boolean(activeRunId) || startingRun || executingCommand
  const disabledReason = !bootstrap.settings.activeProviderId
    ? rt('providerRequired')
    : modelsLoading
      ? rt('modelsLoading')
      : !bootstrap.settings.activeModelId
        ? rt('modelRequired')
        : null

  const workspaceFiles = loadedWorkspaceFiles(workspaceDirectories)
  const lastAssistantMessage = [...messages]
    .reverse()
    .find(
      (message): message is AssistantMessage =>
        message.role === 'assistant' && Boolean(message.content),
    )

  const runtimeCommands: RuntimeSlashCommand[] = [
    ...localizeBuiltinSlashCommands(locale).map((command): RuntimeSlashCommand => {
      let description = command.description
      let unavailableReason: string | undefined

      if (command.kind === 'prompt') {
        unavailableReason =
          disabledReason ?? (bootstrap.workspace ? undefined : rt('analysisWorkspaceRequired'))
      } else {
        if (command.action === 'model' && bootstrap.settings.activeModelId) {
          description = rt('currentModel', { model: bootstrap.settings.activeModelId })
        } else if (command.action === 'context') {
          description = rt('contextDescription', { count: contextPaths.length })
        } else if (command.action === 'commands') {
          description = bootstrap.workspaceTrusted
            ? rt('commandsDescription', { count: workspaceCommands.length })
            : rt('commandsRestrictedDescription')
        }

        if (
          (command.action === 'commands' || command.action === 'skills') &&
          !bootstrap.workspaceTrusted
        ) {
          unavailableReason = rt('workspaceTrustRequired')
        } else if (
          [
            'commands',
            'context',
            'context-clear',
            'git-diff',
            'git-status',
            'refresh',
            'skills',
            'undo',
          ].includes(command.action) &&
          !bootstrap.workspace
        ) {
          unavailableReason = rt('workspaceRequired')
        } else if (command.action === 'context-clear' && contextPaths.length === 0) {
          unavailableReason = rt('noContextToRemove')
        } else if (command.action === 'undo' && !undoAvailable) {
          unavailableReason = rt('noApprovedChangesToUndo')
        } else if (command.action === 'copy' && !lastAssistantMessage) {
          unavailableReason = rt('noAnswerToCopy')
        }
      }

      return {
        ...command,
        description,
        sourceLabel: command.source === 'workflow' ? 'AI' : rt('sourceApp'),
        disabled: Boolean(unavailableReason),
        disabledReason: unavailableReason,
      }
    }),
    ...workspaceCommands.map(
      (command): RuntimeSlashCommand => ({
        ...command,
        description:
          command.description || rt('workspacePromptDescription', { path: command.path }),
        category: rt('userPromptCategory'),
        keywords: [command.path, 'workspace', 'prompt'],
        sourceLabel: rt('sourceWorkspace'),
        disabled: !bootstrap.workspaceTrusted || Boolean(disabledReason),
        disabledReason: !bootstrap.workspaceTrusted
          ? rt('workspacePromptsRestricted')
          : (disabledReason ?? undefined),
      }),
    ),
  ]

  const requireAiReady = (): void => {
    if (disabledReason) throw new Error(disabledReason)
  }

  const addContextFromCommand = async (rawPath: string): Promise<void> => {
    if (!bootstrap.workspace) throw new Error(rt('workspaceRequired'))

    const requestedPath = parseSingleCommandArgument(rawPath, locale)
    let file: FilePreview
    if (!requestedPath) {
      if (!preview) {
        throw new Error(rt('contextPathRequired'))
      }
      file = preview
    } else {
      const exact = workspaceFiles.find((entry) => entry.path === requestedPath)
      const foldedRequested = requestedPath.toLocaleLowerCase()
      const fallbackMatches = exact
        ? []
        : workspaceFiles.filter(
            (entry) =>
              entry.path.toLocaleLowerCase() === foldedRequested ||
              entry.name.toLocaleLowerCase() === foldedRequested,
          )
      if (fallbackMatches.length > 1) {
        throw new Error(rt('ambiguousFile', { path: requestedPath }))
      }
      const resolvedPath = exact?.path ?? fallbackMatches[0]?.path ?? requestedPath
      file = await window.assistant.readWorkspaceFile({ path: resolvedPath })
    }

    if (contextPaths.includes(file.path)) {
      setNotice({ type: 'success', message: rt('fileAlreadyInContext', { path: file.path }) })
      return
    }
    if (contextPaths.length >= 20) {
      throw new Error(rt('contextLimit'))
    }

    setContextPaths((current) => [...current, file.path])
    setPreview(file)
    setRightOpen(true)
    setNotice({ type: 'success', message: rt('fileAddedToContext', { path: file.path }) })
  }

  const executeLocalCommand = async (
    command: BuiltinLocalCommand,
    rawArguments: string,
  ): Promise<void> => {
    const argumentsText = rawArguments.trim()
    if (!command.argumentHint && argumentsText) {
      throw new Error(rt('commandTakesNoArguments', { command: command.name }))
    }

    const handlers: Record<BuiltinLocalCommand['action'], () => Promise<void>> = {
      new: async () => {
        startNewConversation({ clearContext: true })
        setNotice({ type: 'success', message: rt('newConversationStarted') })
      },
      clear: async () => {
        startNewConversation()
        setNotice({ type: 'success', message: rt('conversationCleared') })
      },
      copy: async () => {
        if (!lastAssistantMessage) throw new Error(rt('noAnswerToCopy'))
        await navigator.clipboard.writeText(lastAssistantMessage.content)
        setNotice({ type: 'success', message: rt('lastAnswerCopied') })
      },
      workspace: async () => {
        await chooseWorkspace()
      },
      refresh: async () => {
        const [workspaceLoaded, commandCount, skillCount] = await Promise.all([
          loadWorkspace(),
          loadSlashCommands(true, bootstrap.workspaceTrusted),
          loadSkills(true, bootstrap.workspaceTrusted),
        ])
        if (!workspaceLoaded || commandCount === null || skillCount === null) {
          throw new Error(rt('workspaceRefreshFailed'))
        }
        setNotice({
          type: 'success',
          message: rt('workspaceRefreshed', { commandCount, skillCount }),
        })
      },
      commands: async () => {
        if (!bootstrap.workspaceTrusted) {
          throw new Error(rt('workspaceTrustRequired'))
        }
        const commandCount = await loadSlashCommands(true, true)
        if (commandCount === null) throw new Error(rt('commandsRefreshFailed'))
        setNotice({
          type: 'success',
          message: rt('commandsFound', { count: commandCount }),
        })
      },
      context: async () => {
        await addContextFromCommand(argumentsText)
      },
      'context-clear': async () => {
        setContextPaths([])
        setNotice({ type: 'success', message: rt('contextCleared') })
      },
      'git-status': async () => {
        if (!bootstrap.workspace) throw new Error(rt('workspaceRequired'))
        setWorkspaceTab('status')
        setWorkspaceDetailsOpen(true)
        await loadWorkspaceDetails('status', bootstrap.workspaceTrusted)
      },
      'git-diff': async () => {
        if (!bootstrap.workspace) throw new Error(rt('workspaceRequired'))
        const path = parseSingleCommandArgument(argumentsText, locale)
        setWorkspaceTab('diff')
        setGitDiffStaged(false)
        setWorkspaceDetailsOpen(true)
        setWorkspaceDetailsLoading(true)
        setWorkspaceDetailsError(null)
        try {
          setGitDiff(
            await window.assistant.getGitDiff({
              staged: false,
              ...(path ? { path } : {}),
            }),
          )
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : rt('gitDiffLoadFailed')
          setWorkspaceDetailsError(message)
          throw cause
        } finally {
          setWorkspaceDetailsLoading(false)
        }
      },
      skills: async () => {
        if (!bootstrap.workspaceTrusted) {
          throw new Error(rt('skillsTrustRequired'))
        }
        setWorkspaceTab('skills')
        setWorkspaceDetailsOpen(true)
        await loadWorkspaceDetails('skills', true)
      },
      undo: async () => {
        if (!undoAvailable) throw new Error(rt('noApprovedChangesToUndo'))
        setUndoOpen(true)
      },
      history: async () => {
        setHistoryOpen(true)
        await loadConversations('', false)
      },
      model: async () => {
        const requestedModel = parseSingleCommandArgument(argumentsText, locale)
        if (!requestedModel) {
          setNotice({
            type: 'success',
            message: bootstrap.settings.activeModelId
              ? rt('currentModel', { model: bootstrap.settings.activeModelId })
              : rt('noCurrentModel'),
          })
          return
        }

        const exact = models.filter((model) => model.id === requestedModel)
        const caseInsensitive =
          exact.length > 0
            ? []
            : models.filter(
                (model) => model.id.toLocaleLowerCase() === requestedModel.toLocaleLowerCase(),
              )
        const partial =
          exact.length > 0 || caseInsensitive.length > 0
            ? []
            : models.filter((model) =>
                model.id.toLocaleLowerCase().includes(requestedModel.toLocaleLowerCase()),
              )
        const matches =
          exact.length > 0 ? exact : caseInsensitive.length > 0 ? caseInsensitive : partial
        if (matches.length === 0) {
          throw new Error(rt('modelNotFound', { model: requestedModel }))
        }
        if (matches.length > 1) {
          const examples = matches
            .slice(0, 4)
            .map((model) => model.id)
            .join(', ')
          throw new Error(rt('ambiguousModel', { examples, hasMore: matches.length > 4 }))
        }
        const selectedModel = matches[0]
        if (!selectedModel) throw new Error(rt('modelSwitchTargetMissing'))
        if (selectedModel.id === bootstrap.settings.activeModelId) {
          setNotice({
            type: 'success',
            message: rt('modelAlreadyActive', { model: selectedModel.id }),
          })
          return
        }
        if (!(await changeModel(selectedModel.id))) throw new Error(rt('modelSwitchFailed'))
        setNotice({
          type: 'success',
          message: rt('modelSwitched', { model: selectedModel.id }),
        })
      },
      theme: async () => {
        const requestedTheme = parseSingleCommandArgument(argumentsText, locale).toLocaleLowerCase()
        if (!requestedTheme) {
          setNotice({
            type: 'success',
            message: rt('currentTheme', { theme: bootstrap.settings.theme }),
          })
          return
        }
        if (!['system', 'dark', 'light'].includes(requestedTheme)) {
          throw new Error(rt('invalidTheme'))
        }
        const settings = await window.assistant.saveSettings({
          activeProviderId: bootstrap.settings.activeProviderId,
          activeModelId: bootstrap.settings.activeModelId,
          theme: requestedTheme as AppSettings['theme'],
          locale: bootstrap.settings.locale,
          maxToolIterations: bootstrap.settings.maxToolIterations,
          maxTotalToolCalls: bootstrap.settings.maxTotalToolCalls,
        })
        setBootstrap({ ...bootstrap, settings })
        setNotice({
          type: 'success',
          message: rt('themeSwitched', { theme: requestedTheme as AppSettings['theme'] }),
        })
      },
      settings: async () => {
        setSettingsOpen(true)
      },
      status: async () => {
        setNotice({
          type: 'success',
          message: rt('statusSummary', {
            workspace: bootstrap.workspace?.name ?? null,
            model: bootstrap.settings.activeModelId,
            contextCount: contextPaths.length,
            commandCount: workspaceCommands.length,
            skillCount: skills.length,
            trusted: bootstrap.workspaceTrusted,
          }),
        })
      },
    }

    await handlers[command.action]()
  }

  const executeSlashCommand = async (source: string): Promise<void> => {
    const invocation = parseSlashInvocation(source)
    const commandName = invocation ? normalizeSlashCommandName(invocation.query) : ''
    if (invocation?.start !== 0 || !commandName) {
      throw new Error(rt('invalidSlashCommand'))
    }

    const builtin = findBuiltinSlashCommand(commandName)
    if (builtin) {
      if (builtin.kind === 'local') {
        await executeLocalCommand(builtin, invocation.argumentText)
      } else {
        requireAiReady()
        if (!bootstrap.workspace) throw new Error(rt('analysisWorkspaceRequired'))
        await sendMessage(builtin.buildPrompt(invocation.argumentText), source, builtin.intent)
      }
      return
    }

    const workspaceCommand = workspaceCommands.find(
      (command) => normalizeSlashCommandName(command.name) === commandName,
    )
    if (!workspaceCommand) {
      throw new Error(rt('unknownCommand', { command: commandName }))
    }

    if (!bootstrap.workspaceTrusted) {
      throw new Error(rt('workspacePromptTrustRequired'))
    }
    requireAiReady()
    const expansion = await window.assistant.expandSlashCommand({
      id: workspaceCommand.id,
      revision: workspaceCommand.revision,
      arguments: invocation.argumentText,
    })
    await sendMessage(expansion.prompt, source)
  }

  const submitMessage = async (content: string): Promise<void> => {
    const slashCommand = content.startsWith('/')
    if (slashCommand) setExecutingCommand(true)
    try {
      if (slashCommand) await executeSlashCommand(content)
      else {
        requireAiReady()
        await sendMessage(content)
      }
    } catch (cause) {
      setNotice({
        type: 'error',
        message: cause instanceof Error ? cause.message : rt('commandExecutionFailed'),
      })
      throw cause
    } finally {
      if (slashCommand) setExecutingCommand(false)
    }
  }

  return (
    <div className={`app-shell${leftOpen ? ' left-open' : ''}${rightOpen ? ' right-open' : ''}`}>
      <header className="titlebar">
        <div className="titlebar-left">
          <div className="traffic-light-space" aria-hidden="true" />
          <IconButton
            label={leftOpen ? t('header.explorer.collapse') : t('header.explorer.expand')}
            onClick={() => setLeftOpen((value) => !value)}
            aria-controls="workspace-explorer-panel"
            aria-expanded={leftOpen}
          >
            {leftOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </IconButton>
          <div className="title-brand">
            <span className="brand-mark">
              <Code2 size={15} />
            </span>
            <strong>Code Assistant</strong>
          </div>
          <button
            type="button"
            className="new-conversation-button"
            onClick={() => startNewConversation({ clearContext: true })}
            disabled={running}
            aria-label={t('header.newConversationStart')}
            title={t('header.newConversationStart')}
          >
            <MessageSquareCode size={14} />
            <span>{t('header.newConversation')}</span>
          </button>
        </div>
        <div className="titlebar-actions">
          <IconButton
            label={t('header.goals')}
            onClick={() => {
              setShowAllGoals(false)
              setGoalsOpen(true)
              void loadGoals(undefined, false, false)
            }}
            disabled={!bootstrap.workspace}
          >
            <Target size={17} />
          </IconButton>
          <IconButton
            label={t('header.history')}
            onClick={() => setHistoryOpen(true)}
            disabled={running}
          >
            <History size={17} />
          </IconButton>
          <IconButton label={t('header.settings')} onClick={() => setSettingsOpen(true)}>
            <Settings size={17} />
          </IconButton>
          <IconButton
            label={rightOpen ? t('header.preview.collapse') : t('header.preview.expand')}
            onClick={() => setRightOpen((value) => !value)}
            aria-controls="file-preview-panel"
            aria-expanded={rightOpen}
          >
            {rightOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </IconButton>
        </div>
      </header>

      <div className="workbench">
        <WorkspaceExplorer
          bootstrap={bootstrap}
          directories={workspaceDirectories}
          expandedPaths={expandedWorkspacePaths}
          selectedPath={preview?.path ?? null}
          contextPaths={contextPaths}
          onChooseWorkspace={() => void chooseWorkspace()}
          onRefresh={() =>
            void Promise.all([
              loadWorkspace(),
              loadSlashCommands(false, bootstrap.workspaceTrusted),
              loadSkills(true, bootstrap.workspaceTrusted),
            ])
          }
          onToggleDirectory={toggleWorkspaceDirectory}
          onLoadMore={loadMoreWorkspaceDirectory}
          onRetryDirectory={retryWorkspaceDirectory}
          onOpenFile={(entry) => void openFile(entry)}
          onClose={() => setLeftOpen(false)}
        />

        <main className="chat-panel">
          <div className="mobile-chat-header">
            <IconButton
              label={t('header.explorer.open')}
              onClick={() => setLeftOpen(true)}
              aria-controls="workspace-explorer-panel"
              aria-expanded={leftOpen}
            >
              <Menu size={17} />
            </IconButton>
            <strong>{bootstrap.workspace?.name ?? 'Code Assistant'}</strong>
            <div>
              <IconButton
                label={t('header.goals')}
                onClick={() => {
                  setShowAllGoals(false)
                  setGoalsOpen(true)
                  void loadGoals(undefined, false, false)
                }}
                disabled={!bootstrap.workspace}
              >
                <Target size={17} />
              </IconButton>
              <IconButton
                label={t('header.history')}
                onClick={() => setHistoryOpen(true)}
                disabled={running}
              >
                <History size={17} />
              </IconButton>
              <IconButton label={t('header.settings')} onClick={() => setSettingsOpen(true)}>
                <Settings size={17} />
              </IconButton>
              <IconButton
                label={rightOpen ? t('header.preview.collapse') : t('header.preview.expand')}
                onClick={() => setRightOpen((value) => !value)}
                aria-controls="file-preview-panel"
                aria-expanded={rightOpen}
              >
                {rightOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
              </IconButton>
            </div>
          </div>
          {bootstrap.workspace && messages.length > 0 && (
            <WorkspaceTrustBanner
              trusted={bootstrap.workspaceTrusted}
              updating={trustUpdating}
              disabled={running}
              onChange={changeWorkspaceTrust}
            />
          )}
          <Conversation
            messages={messages}
            running={running}
            readiness={readiness}
            onReadinessAction={(actionId) => {
              switch (actionId) {
                case 'settings.open-provider':
                case 'settings.select-model':
                  setSettingsOpen(true)
                  break
                case 'workspace.choose':
                  void chooseWorkspace()
                  break
                case 'workspace.trust':
                  void changeWorkspaceTrust(true)
                  break
                case 'conversation.start':
                  document.querySelector<HTMLTextAreaElement>('#assistant-composer-input')?.focus()
                  break
              }
            }}
          />
          <Composer
            models={models}
            activeModelId={bootstrap.settings.activeModelId}
            contextPaths={contextPaths}
            selectedFile={preview}
            commands={runtimeCommands}
            running={running}
            disabledReason={disabledReason}
            onModelChange={(modelId) => void changeModel(modelId)}
            onRemoveContext={(path) =>
              setContextPaths((current) => current.filter((item) => item !== path))
            }
            onAddSelectedContext={togglePreviewContext}
            onSend={submitMessage}
            onCancel={cancelRun}
          />
        </main>

        <FilePreviewPanel
          preview={preview}
          loading={previewLoading}
          error={previewError}
          inContext={Boolean(preview && contextPaths.includes(preview.path))}
          onToggleContext={togglePreviewContext}
          onClose={() => setRightOpen(false)}
        />
      </div>

      {settingsOpen && (
        <SettingsModal
          initialSettings={bootstrap.settings}
          initialApprovalPolicy={bootstrap.workspaceApprovalPolicy}
          workspace={bootstrap.workspace}
          workspaceTrusted={bootstrap.workspaceTrusted}
          forced={bootstrap.settings.providers.length === 0}
          onClose={() => setSettingsOpen(false)}
          onSettingsChange={applySettings}
          onApprovalPolicyChange={applyApprovalPolicy}
          onModelsLoaded={setModels}
        />
      )}

      {historyOpen && (
        <ConversationHistoryModal
          conversations={conversations}
          activeConversationId={conversationIdRef.current}
          search={historySearch}
          archived={historyArchived}
          loading={historyLoading}
          error={historyError}
          busyId={historyBusyId}
          onSearchChange={setHistorySearch}
          onArchivedChange={setHistoryArchived}
          onRefresh={() => void loadConversations(historySearch, historyArchived)}
          onOpen={openConversation}
          onFork={forkConversation}
          onArchive={archiveConversation}
          onDelete={deleteConversation}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {goalsOpen && (
        <GoalsModal
          goals={goals}
          showAll={showAllGoals}
          detail={goalDetail}
          loading={goalsLoading}
          error={goalsError}
          busyId={goalBusyId}
          running={running}
          onRefresh={() => void loadGoals(undefined, false, showAllGoals)}
          onShowAllChange={(showAll) => {
            setShowAllGoals(showAll)
            void loadGoals(undefined, false, showAll)
          }}
          onSelect={openGoal}
          onCreate={createGoal}
          onMutate={mutateGoal}
          onRun={continueGoal}
          onClose={() => setGoalsOpen(false)}
        />
      )}

      {workspaceDetailsOpen && (
        <WorkspaceDetailsModal
          tab={workspaceTab}
          trusted={bootstrap.workspaceTrusted}
          status={gitStatus}
          diff={gitDiff}
          skills={skills}
          staged={gitDiffStaged}
          loading={workspaceDetailsLoading}
          error={workspaceDetailsError}
          onTabChange={setWorkspaceTab}
          onStagedChange={setGitDiffStaged}
          onRefresh={() =>
            void loadWorkspaceDetails(workspaceTab, bootstrap.workspaceTrusted, gitDiffStaged)
          }
          onClose={() => setWorkspaceDetailsOpen(false)}
        />
      )}

      {undoOpen && (
        <UndoConfirmationModal
          status={undoStatus}
          busy={undoBusy}
          error={undoError}
          onConfirm={undoLastMutation}
          onClose={() => setUndoOpen(false)}
        />
      )}

      {approvalQueue[0] && (
        <ApprovalModal
          pending={approvalQueue[0]}
          resolving={approvalResolving}
          error={approvalError}
          onResolve={resolveCurrentApproval}
        />
      )}

      {notice && (
        <div className={`toast ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>
          {notice.type === 'error' ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
          <span>{notice.message}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label={t('common.closeNotification')}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [locale, setLocale] = useState<AppLocale>(readInitialAppLocale)
  const applyLocale = useCallback((nextLocale: AppLocale) => {
    persistAppLocaleHint(nextLocale)
    setLocale(nextLocale)
  }, [])

  useLayoutEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  return (
    <I18nProvider locale={locale}>
      <AppContent onLocaleChange={applyLocale} />
    </I18nProvider>
  )
}
