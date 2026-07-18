import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, nativeTheme, net, protocol, session, shell } from 'electron'
import { registerIpc } from './ipc'
import { AgentService } from './services/agent'
import { CommandService } from './services/commands'
import { ConversationRepository } from './services/conversations'
import { StructuredProcessRunner } from './services/execution'
import { GitService } from './services/git'
import { hostMessages, RecoveryNoticeQueue } from './services/host-messages'
import { InstructionService } from './services/instructions'
import { McpService } from './services/mcp'
import { MutationService } from './services/mutation'
import { SettingsStore } from './services/settings'
import { SkillsService } from './services/skills'
import { TrustStore } from './services/trust'
import { WorkspaceService } from './services/workspace'

let mainWindow: BrowserWindow | null = null
let disposeIpc: (() => void) | null = null
let disposeServices: (() => Promise<void>) | null = null
let shutdownStarted = false
const SHUTDOWN_GRACE_PERIOD_MS = 10_000

async function disposeWithinShutdownGracePeriod(dispose: () => Promise<void>): Promise<void> {
  let timeout: NodeJS.Timeout | null = null
  try {
    await Promise.race([
      dispose().catch(() => undefined),
      new Promise<void>((resolveTimeout) => {
        timeout = setTimeout(resolveTimeout, SHUTDOWN_GRACE_PERIOD_MS)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()

if (app.isPackaged) {
  app.commandLine.removeSwitch('remote-debugging-port')
  app.commandLine.removeSwitch('remote-debugging-pipe')
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      stream: true,
      codeCache: true,
    },
  },
])

const rendererFilePath = join(__dirname, '../renderer/index.html')
const rendererDirectory = dirname(rendererFilePath)
const packagedRendererUrl = 'app://renderer/index.html'

function getDevelopmentRendererUrl(): string | null {
  if (app.isPackaged || !process.env.ELECTRON_RENDERER_URL) return null
  try {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (!loopback || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

const developmentRendererUrl = getDevelopmentRendererUrl()

function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  )
}

function isTrustedRendererUrl(value: string): boolean {
  try {
    const candidate = new URL(value)
    if (developmentRendererUrl) {
      return candidate.origin === new URL(developmentRendererUrl).origin
    }
    return (
      candidate.protocol === 'app:' &&
      candidate.hostname === 'renderer' &&
      candidate.pathname === '/index.html' &&
      !candidate.search &&
      !candidate.hash
    )
  } catch {
    return false
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101113' : '#f4f5f7',
    title: 'Code Assistant',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const externalUrl = new URL(url)
      if (externalUrl.protocol === 'https:' && !externalUrl.username && !externalUrl.password) {
        void shell.openExternal(externalUrl.toString())
      }
    } catch {
      // Invalid and non-HTTPS links stay inside the denied path below.
    }
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })

  if (developmentRendererUrl) {
    void window.loadURL(developmentRendererUrl)
  } else {
    void window.loadURL(packagedRendererUrl)
  }

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  return window
}

async function bootstrap(): Promise<void> {
  const userDataPath = app.getPath('userData')
  const settings = new SettingsStore({ userDataPath })
  const startupLocale = (await settings.getSettings()).locale
  const workspace = new WorkspaceService({ settingsStore: settings })
  await workspace.restoreLastWorkspace().catch(() => null)
  const trust = new TrustStore({ userDataPath })
  const conversations = new ConversationRepository({ userDataPath })
  const recoveryMessages = hostMessages(startupLocale).recovery
  conversations.recoverInterruptedRuns(recoveryMessages.interruptedRunReason)
  conversations.recoverInterruptedSubagentRuns(recoveryMessages.interruptedSubagentReason)
  const instructions = new InstructionService(workspace, trust)
  const skills = new SkillsService(workspace)
  const git = new GitService(workspace)
  const mutations = new MutationService(workspace, {
    journalDirectory: join(userDataPath, 'mutation-journal'),
  })
  const recoveryNotices = new RecoveryNoticeQueue()
  const reportRecoveryNotice = (notice: unknown): void => {
    recoveryNotices.add(notice)
  }
  if (conversations.recoveryNotice) reportRecoveryNotice(conversations.recoveryNotice)
  const recoverWorkspaceMutations = async (): Promise<void> => {
    const selected = workspace.getWorkspace()
    if (!selected) return
    try {
      const recovery = await mutations.recoverPending()
      if (recovery.restoredPaths.length > 0) {
        reportRecoveryNotice({
          type: 'file-mutations-recovered',
          actionCount: recovery.actionHashes.length,
          paths: recovery.restoredPaths,
        })
      }
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : typeof error === 'string' ? error : null
      reportRecoveryNotice({ type: 'file-mutation-recovery-failed', reason })
    }
  }
  await recoverWorkspaceMutations()
  const execution = new StructuredProcessRunner(workspace)
  const mcp = new McpService({ userDataPath })
  const agent = new AgentService(settings, workspace, {
    conversations,
    execution,
    git,
    instructions,
    mcp,
    mutations,
    skills,
    trust,
  })
  const commands = new CommandService(workspace)

  let releaseStartup: (() => void) | undefined
  const startupReady = new Promise<void>((resolveStartup) => {
    releaseStartup = resolveStartup
  })
  disposeIpc = registerIpc({
    getWindow: () => mainWindow,
    isTrustedRendererUrl,
    settings,
    startupReady,
    workspace,
    agent,
    commands,
    conversations,
    git,
    mutations,
    recoverWorkspaceMutations,
    takeRecoveryNotice: async () => {
      const locale = await settings
        .getSettings()
        .then((current) => current.locale)
        .catch(() => startupLocale)
      return recoveryNotices.take(locale)
    },
    skills,
    trust,
  })
  mainWindow = createWindow()
  if (!mainWindow.isVisible()) {
    await new Promise<void>((resolveReady) => {
      mainWindow?.once('ready-to-show', resolveReady)
    })
  }
  try {
    await settings.migrateProviderCredentialsAtStartup()
  } catch {
    // The store caches the typed failure to prevent a second Keychain attempt in this process.
    reportRecoveryNotice({ type: 'credential-migration-incomplete' })
  } finally {
    releaseStartup?.()
  }
  disposeServices = async () => {
    await agent.shutdown()
    await mcp.close()
    conversations.close()
  }

  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'renderer' || url.username || url.password || url.search || url.hash) {
        return new Response('Not found', { status: 404 })
      }
      const requestedPath = resolve(rendererDirectory, `.${decodeURIComponent(url.pathname)}`)
      if (!isPathInside(rendererDirectory, requestedPath)) {
        return new Response('Forbidden', { status: 403 })
      }
      return net.fetch(pathToFileURL(requestedPath).toString())
    } catch {
      return new Response('Bad request', { status: 400 })
    }
  })

  const permissionAllowed = (webContents: Electron.WebContents | null, permission: string) =>
    permission === 'clipboard-sanitized-write' &&
    Boolean(mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents)

  session.defaultSession.setPermissionCheckHandler((webContents, permission) =>
    permissionAllowed(webContents, permission),
  )
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permissionAllowed(webContents, permission))
  })

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        ],
      },
    })
  })

  await bootstrap()

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownStarted || !disposeServices) return
  event.preventDefault()
  shutdownStarted = true
  disposeIpc?.()
  disposeIpc = null
  const dispose = disposeServices
  disposeServices = null
  void disposeWithinShutdownGracePeriod(dispose).finally(() => app.exit(0))
})
