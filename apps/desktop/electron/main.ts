import { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, globalShortcut, nativeImage, nativeTheme, ClipboardItem, session, powerMonitor, type MenuItemConstructorOptions } from 'electron'
import {
  disposeOverlay,
  hideOverlay,
  markOverlayReady,
  openOverlay,
  overlayShortcutStatus,
  prewarmOverlay,
  resizeOverlay,
  setupOverlay,
  syncOverlayShortcut,
  toggleOverlay,
  watchOverlaySettings,
} from './lib/overlay/window'
import { audioIdFrom, readAudio, registerAudioProtocol } from './lib/audio-store'
import { registerVideoProtocol } from './lib/video/store'
import {
  MOTION_PROGRESS_CHANNEL,
  getMotion,
  motionAudioUrl,
  motionIdForName,
  motionIdForPath,
  motionOutputName,
  registerMotionProtocol,
  registeredMotionUrl,
  renderRegisteredMotion,
  type MotionRenderRequest,
} from './lib/video/motion-store'
import { measureMotionLayers } from './lib/video/motion-layers'
import { listMotionBundles } from './lib/video/motion-files'
import { exportMotionProject } from './lib/video/motion-project'
import { motionAudioTracks } from './lib/video/motion-audio'
import { motionVideoAudioTracks } from './lib/video/motion-video-audio'
import { reopenMotion } from './lib/video/motion-open'
import {
  designIdForName,
  designIdForPath,
  readDesignBoard,
  registerDesignProtocol,
  updateDesignBoard,
  writeDesignBoard,
} from './lib/design/design-store'
import { reopenDesign } from './lib/design/design-open'
import {
  getSlides,
  registerSlidesProtocol,
  slidesIdForName,
  slidesIdForPath,
} from './lib/slides/slides-store'
import { reopenSlides } from './lib/slides/slides-open'
import { renderSlidesPdf } from './lib/slides/slides-export'
import {
  addSessionMaterial,
  adoptDraftMaterials,
  listSessionMaterials,
  setMaterialShared,
  type MaterialInput,
} from './lib/session-materials'
import { registerBundledFfmpeg } from './lib/video/ffmpeg'
import { registerYtdlpOnPath } from './lib/ytdlp/binary'
import sharp from 'sharp'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import type * as NodePty from 'node-pty'
import { listCredentialProviders, removeCredential, setCredential } from './lib/auth'
import { getCatalog, ensureCustomProvidersSeeded, onCatalogRefreshed } from './lib/catalog'
import { saveExport } from './lib/export-dialog'
import { checkWritePath } from './lib/file-write-guard'
import {
  invalidateIndex,
  matchNames,
  replaceInFiles,
  searchText,
  workspaceIndex,
} from './lib/workspace-search'
import { recordManualSave } from './lib/manual-saves'
import { lintFile, stopLintWorkers } from './lib/eslint-service'
import { addCustomProvider, listCustomProviders, removeCustomProvider, updateCustomProvider } from './lib/custom-providers'
import { detectLocal, discoverProviderModels, refreshProviderModels } from './lib/detect-local'
import { discoverModels, type DiscoverOptions } from './lib/discover-models'
import type { CustomProviderInput, CustomProviderPatch } from '@shared/chat'
import { killAll as killAllProcesses, listProcesses, killProcess, getProcessOutput } from './lib/process-manager'
import { getModelsSnapshot, invalidateModelsSnapshot } from './lib/models'
import {
  revert as revertSession,
  revertUncertain as revertUncertainSession,
  unrevert as unrevertSession,
} from './lib/session/revert'
import { abortProjectInit, getInitStatus, runProjectInit, type RunInitInput } from './lib/project-init'
import { compactSession, continuationBrief, getRunningSessionIds } from './lib/chat-engine'
import { startPerf } from './lib/perf'
import { getLoopRunningSessionIds } from './lib/loop-engine'
import { replyOrResume } from './lib/ask-resume'
import {
  approvePlan,
  getOrchestrationRunningSessionIds,
  mergeAgain,
  recoverInterruptedPlans,
  rejectPlan,
  resumePlan,
} from './lib/orchestrator'
import { authorizeMcp, initMcp, listMcpStatus, mcpDescriptionsState, oauthRedirectUrl, optimizeMcpServer, readMcpConfig, reconnectMcp, saveMcpConfig } from './lib/mcp'
import { connectNodara, disconnectNodara, discoverNodara, stopWatchingNodaraBridge, watchNodaraBridge } from './lib/nodara'
import { connectFracta, disconnectFracta, discoverFracta, stopWatchingFractaSettings, watchFractaSettings } from './lib/fracta'
import { forgetApprovals, listLearnedRules, loadApprovalLearning } from './lib/permission/learning'
import { addTrust, listTrustRules, loadTrustRules, removeTrust } from './lib/permission/trust-rules'
import { addHook, listHooks, loadHooks, onHooksChanged, removeHook, setHookEnabled, updateHook } from './lib/hooks/store'
import type { HookInput } from '@shared/hooks'
import { abortSession, dispatchSend, lastSendInput } from './lib/send-dispatch'
import { setupComputerPanels } from './lib/computer/panels'
import { shotView } from './lib/computer/shots'
import {
  computerStatus,
  disposeComputerUse,
  focusShotApp,
  getComputerActivity,
  requestAccessibility,
  requestScreenRecording,
  setComputerStopHandler,
  stopComputer,
  testComputer,
} from './lib/computer'
import { savePlanFile, deletePlanFile, readPlanFile } from './lib/plan-file'
import {
  backfillMedia,
  cleanupScriptMedia,
  deleteManyMedia,
  documentInfo,
  ensureDocumentRender,
  saveDocumentEdit,
  getMediaEntry,
  linkMediaSessions,
  listMedia,
  mediaDiskUsage,
  mediaIdFromUrl,
  readArtifact,
  readDocumentSource,
  registerArtifactProtocol,
  registerSchemePrivileges,
  readMedia,
  registerMediaProtocol,
} from './lib/media'
import {
  fontFaceCss,
  listFonts,
  registerFontProtocol,
} from './lib/fonts/store'
import { listSystemFonts } from './lib/fonts/system'
import type { AppPreferences, MessageQueueSnapshot, ReasoningPrefsMap, SessionModeOverrides, SessionPrefsSnapshot, WorkerConfigSnapshot } from '@shared/companion'
import { startCompanionServer, getCompanionStatus, setPairingMode, forwardChatEvent, broadcastSessionModels, broadcastSessionModes, broadcastSessionPrefs, broadcastWorkerConfig, broadcastAppPreferences, broadcastRotationConfig, broadcastReasoningPrefs, broadcastMessageQueue } from './lib/companion-server'
import { setSessionModelsCache, setSessionModesCache, setSessionPrefsCache, setWorkerConfigCache, setRotationHttpCache, setReasoningPrefsCache } from './lib/companion-http'
import { setSessionModes } from './lib/permission/global-mode'
import { setRotationConfigCache } from './lib/model-rotation'
import { readJson as readStorageJson } from './lib/storage'
import { registerPanelWebContents, unregisterPanelWebContents } from './lib/panel-browser'
import { registerPanelStateIpc } from './lib/panel-state'
import { registerVoiceIpc, syncWhisperServer } from './lib/voice'
import { registerGitIpc } from './lib/git'
import { setupMemoryScheduler } from './lib/memory/scheduler'
import { startSessionIndex } from './lib/session-index'
import { getAppSettings, loadAppSettings, onAppSettingsChange, setAppSettings } from './lib/app-settings'
import { applyLaunchAtLogin } from './lib/autostart'
import { createTray, destroyTray, hasTray, refreshTray } from './lib/tray'
import { setupAutoArchive } from './lib/auto-archive'
import { BROWSER_PARTITION } from './lib/browser-script'
import { clearBrowserPermissions, setupBrowserPermissions } from './lib/browser-permissions'
import * as memoryService from './lib/memory/service'
import { globalSkillsDir, loadSkills, notifySkillsChanged, setupSkillsWatcher } from './lib/skills'
import { importSkillSelection } from './lib/skills/import'
import { sanitizeSlug, serializeSkill } from './lib/skills/parser'
import { computeAnalytics } from './lib/analytics'
import type { AnalyticsRange } from '@shared/analytics'
import { approvePendingSkill, discardPendingSkill, listPendingSkills } from './lib/skills/pending'
import { dataDir, listKeys, readJson, removeJson, writeJson } from './lib/storage'
import {
  adoptDraftDocuments,
  addSessionDocument,
  addSessionText,
  addSessionUrl,
  deleteFolderDocuments,
  deleteSessionDocuments,
  listSessionSources,
  removeSessionDocument,
  sessionDocumentThumb,
  setDraftFolder,
  setSessionDocumentShared,
} from './lib/session-documents'
import { viewExport, viewHtml, viewPrint, viewRender, viewText } from './lib/document-view'
import { documentForSource, isDocumentSource, useDocumentAsSource } from './lib/document-source'
import { renderDiagrams } from './lib/mermaid-render'
import { loadMainLocale, setMainLocale, t as tMain } from './lib/i18n'
import { loginShellArgs, userShellEnv } from './lib/shell-env'
import { searchSessions } from './lib/search-sessions'
import { playSound, soundPath } from './lib/sound'
import { setupAutoUpdater } from './lib/updater'
import { destroyBrowserWindow } from './lib/tools'
import type { QueuedMessage, SendMessageInput } from '@shared/chat'
import type { ChatEvent } from '@shared/chat'
import type { RotationConfig } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { pruneMediaJournals } from './lib/session/media-journal'
import * as pipeline from './lib/pipeline'
import { createChatWorktree, listWorktrees, removeChatWorktree, validateWorktreesFolder } from './lib/worktrees/service'
import { folderInMainRepository } from './lib/worktrees/main'
import * as routines from './lib/routines'
import { installBackgroundAgent } from './lib/routines/background'
import { approvePendingRoutine, discardPendingRoutine, listPendingRoutines } from './lib/routines/pending'
import type { DocumentDownload, MediaFilter } from '@shared/media'
import { documentFileName } from '@shared/media'
import type { NewPipelineInput, NewTaskInput, PhaseTemplate } from '@shared/pipeline'
import type { NewRoutineInput, Routine, RoutineModel } from '@shared/routines'
import type { Memory, MemoryEvent } from '@shared/memory'

const execFileAsync = promisify(execFile)

const _require = createRequire(import.meta.url)
const nodePty = _require('node-pty') as typeof NodePty
const JSZip = _require('jszip') as typeof import('jszip')

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

/**
 * Window icon.
 *
 * On Windows the taskbar asks for the SMALL size (16/32px). With a large PNG
 * and only it, Chromium has nothing to deliver at that size and falls back to the
 * default Electron icon — it was what showed up in dev mode. The .ico brings the
 * seven sizes already rasterized (build/icon.ico, generated by
 * scripts/make-ico.mjs).
 *
 * In the packaged app the .ico does not go along (the builder `files` carries only dist and
 * dist-electron) and it is not even needed: there the executable itself carries the icon. That is
 * why the choice is by EXISTENCE of the file, not by environment.
 */
const PROD_APP_USER_MODEL_ID = 'com.fragmentslabs.orbit.code'
const DEV_APP_USER_MODEL_ID = 'com.fragmentslabs.orbit.code.dev'

/**
 * The shortcut that gives Orbit a face in dev mode, on the Windows taskbar.
 *
 * Windows draws the button of an app by the Start Menu SHORTCUT that has the
 * same AppUserModelID as the process, and not by the window icon. Without any, the
 * Chromium creates its own at the first notification — an "Electron.lnk" pointing
 * to node_modules/electron/dist/electron.exe, with the Electron logo. The separate dev
 * id already prevents that shortcut from hijacking the installed app; but the
 * dev still kept the face of Electron.
 *
 * So dev keeps its own shortcut, with the Orbit icon. Existing it, the
 * Chromium does not create its own. And the Electron.lnk it may have created goes away —
 * but only when it carries OUR dev id: an Electron.lnk from another project
 * on the same machine is not ours to delete.
 *
 * The shortcut stays in the Start Menu as "Orbit (Dev)" because that is where Windows
 * looks for it; opening it from there runs electron.exe over this folder, without the
 * Vite server — it exists for the identity, not to be launched.
 */
function ensureDevShortcut(): void {
  try {
    const icon = path.join(process.env.APP_ROOT, 'build', 'icon.ico')
    if (!existsSync(icon)) return
    const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    const link = path.join(programs, 'Orbit (Dev).lnk')
    shell.writeShortcutLink(link, existsSync(link) ? 'update' : 'create', {
      target: process.execPath,
      args: `"${process.env.APP_ROOT}"`,
      appUserModelId: DEV_APP_USER_MODEL_ID,
      icon,
      iconIndex: 0,
      description: 'Orbit (development mode)',
    })

    const chromium = path.join(programs, 'Electron.lnk')
    if (existsSync(chromium) && shell.readShortcutLink(chromium).appUserModelId === DEV_APP_USER_MODEL_ID) {
      unlinkSync(chromium)
    }
  } catch (err) {
    // Visual identity of dev: if it fails, the app goes on — with the wrong icon,
    // which is what was already happening.
    console.warn('[dev] could not adjust the Orbit (Dev) shortcut:', err)
  }
}

function windowIconPath(): string {
  if (process.platform === 'win32') {
    const ico = path.join(process.env.APP_ROOT, 'build', 'icon.ico')
    if (existsSync(ico)) return ico
  }
  return path.join(process.env.VITE_PUBLIC, 'logo.png')
}

// Privileges of ALL schemes of the app (artifact, audio, video, motion,
// design and fonts) — it HAS to happen here, at the top of the module: after
// app.whenReady() the Chromium has already fixed the scheme table and the page would load
// as an opaque origin, without running script. And it is a SINGLE call: a second list
// cancels the first (that is how design stopped loading). The protocols
// themselves are registered further down, with the app ready.
registerSchemePrivileges()

let win: BrowserWindow | null
let entranceWindowCreated = false
// --hidden (background LaunchAgent): the window is ready but invisible — the
// routines fire in the background and whoever brings the window back is the
// Dock/menu, like any closed window.
const oculto = process.argv.includes('--hidden')

/**
 * Is the app really LEAVING? The `close` of the window consults this before
 * deciding: on a real exit (menu, tray, Cmd+Q) the event follows the normal
 * path; outside of it, with "close to tray" on, the X only hides.
 */
let quitting = false

// ─── System tray ──────────────────────────────────────────────────────────────

/** Tray labels in the app's language (the main has its own i18n — lib/i18n). */
async function trayLabels() {
  return {
    open: await tMain('tray.open'),
    quit: await tMain('tray.quit'),
    tooltip: await tMain('tray.tooltip'),
  }
}

/** Brings the window back, recreating it if it no longer exists. */
function showMainWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Quits for real: marks the exit so the `close` of the window does not hide it. */
function quitApp(): void {
  quitting = true
  app.quit()
}

function trayHandlers() {
  return { onOpen: showMainWindow, onQuit: quitApp }
}

/**
 * Turns the tray on/off according to the preference. It exists exactly to
 * host the app without a window: off, the X goes back to quitting and the icon goes
 * with it — leaving it would be an icon of an app that does not stay alive.
 *
 * On macOS it does not exist: closing the window already leaves the app alive in the Dock (see
 * `window-all-closed`), which is the way back — the icon would be a second
 * door to the same thing, occupying the menu bar.
 *
 * If the tray cannot be created (no icon), `hasTray()` stays false and the
 * close keeps quitting: hiding the window would be losing the app.
 */
async function syncTray(): Promise<void> {
  if (process.platform === 'darwin') {
    destroyTray()
    return
  }
  if (!getAppSettings().closeToTray) {
    destroyTray()
    // Preference off with the window hidden: without a tray there would be no
    // way back, so it reappears.
    if (win && !win.isDestroyed() && !win.isVisible()) showMainWindow()
    return
  }
  const labels = await trayLabels()
  if (hasTray()) refreshTray(labels, trayHandlers())
  else createTray(labels, trayHandlers())
}

// ─── "Open with Orbit" (Explorer context menu) ──────────────────────────────
// Registers in HKCU (no admin) the entries that make the right button on a
// folder offer "Open with Orbit". On click, Windows launches the app with the
// folder path in argv — single-instance forwards it to the renderer.
const OPEN_WITH_COMMAND = "OpenWithOrbit"
const OPEN_WITH_KEYS = [
  `Software\\Classes\\Directory\\shell\\${OPEN_WITH_COMMAND}`,
  `Software\\Classes\\Directory\\Background\\shell\\${OPEN_WITH_COMMAND}`,
]

function openWithLabel(): string {
  return app.getLocale().toLowerCase().startsWith("pt") ? "Abrir com Orbit" : "Open with Orbit"
}

async function registerOpenWith(): Promise<{ ok: boolean; error?: string }> {
  // Only in the installed version: in dev the execPath is electron.exe and the command
  // registered would not open the app (the app directory argument would be missing).
  if (process.platform !== "win32" || !app.isPackaged) {
    return { ok: false, error: "unsupported" }
  }
  const exe = process.execPath
  try {
    for (const key of OPEN_WITH_KEYS) {
      await execFileAsync("reg.exe", ["add", `HKCU\\${key}`, "/ve", "/d", openWithLabel(), "/f"])
      await execFileAsync("reg.exe", ["add", `HKCU\\${key}`, "/v", "Icon", "/d", exe, "/f"])
      await execFileAsync("reg.exe", ["add", `HKCU\\${key}\\command`, "/ve", "/d", `"${exe}" "%V"`, "/f"])
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

async function unregisterOpenWith(): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== "win32") return { ok: true }
  try {
    for (const key of OPEN_WITH_KEYS) {
      await execFileAsync("reg.exe", ["delete", `HKCU\\${key}`, "/f"]).catch(() => {})
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

async function getOpenWithStatus(): Promise<{ supported: boolean; registered: boolean; error?: string }> {
  if (process.platform !== "win32" || !app.isPackaged) return { supported: false, registered: false }
  try {
    await execFileAsync("reg.exe", ["query", `HKCU\\${OPEN_WITH_KEYS[0]}`, "/ve"])
    return { supported: true, registered: true }
  } catch {
    return { supported: true, registered: false }
  }
}

// ─── Single instance + folder opening via argv ──────────────────────────────
// In dev the app name (package.json inside the asar) is the same as in the build, so
// both would resolve the same userData and the lock would bring the second instance down.
// Here dev gets its own database, auth and lock, and coexists with the installed app.
if (!app.isPackaged) {
  const devProfile = path.join(app.getPath('appData'), 'Orbit Dev')
  mkdirSync(devProfile, { recursive: true })
  app.setPath('userData', devProfile)
}

// The lock has to be requested before ready; the secondary instance hands the
// argv (folder path) to the primary via event.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

let pendingOpenFolder: string | null = null

async function findFolderArg(argv: string[]): Promise<string | null> {
  for (const raw of argv) {
    if (!raw || raw === "." || raw === ".." || raw.startsWith("-")) continue
    if (!path.isAbsolute(raw)) continue
    // In dev vite-plugin-electron launches electron with the app directory:
    // that is not a folder opening and must not trigger the flow.
    if (!app.isPackaged && path.resolve(raw) === path.resolve(process.env.APP_ROOT ?? "")) continue
    try {
      const stat = await fs.stat(raw)
      if (stat.isDirectory()) return path.resolve(raw)
    } catch {
      // is not a valid path — ignore
    }
  }
  return null
}

/** Forwards a folder to the renderer; if the window is still loading, leaves it
 *  pending for the renderer to fetch via app:consumePendingOpen on mount. */
function queueOpenFolder(directory: string) {
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
    win.show()
    win.focus()
    win.webContents.send("app:open-folder", directory)
    return
  }
  // The folder stays pending for the renderer to fetch on mount — but on macOS there may
  // be no window at all to mount: once the last one is closed, the app stays alive in the
  // Dock, and whoever opens the folder must be able to bring it back.
  pendingOpenFolder = directory
  ensureWindow()
}

app.on("second-instance", (_event, argv) => {
  // Born from the LaunchAgent (--hidden): it comes from launchd, not from someone
  // opening the app, so it must not pull the window to the front.
  if (argv.includes('--hidden')) return
  // Relaunching the app is a per-window request: on macOS it may have been closed
  // (the app stays alive in the Dock), and without this the relaunch would do nothing.
  showMainWindow()
  void findFolderArg(argv).then((dir) => {
    if (dir) queueOpenFolder(dir)
  })
})

function createWindow() {
  const isInitialWindow = !entranceWindowCreated
  entranceWindowCreated = true
  win = new BrowserWindow({
    icon: windowIconPath(),
    minWidth: 720,
    minHeight: 480,
    // It is born hidden and only appears on the renderer's first frame (ready-to-
    // show): the white flash came from the unpainted content + default light theme
    // of the CSS before React applies the dark class.
    show: false,
    // Native dark background (zinc-950, the --background of the dark theme): covers the
    // window before the first paint and during resize, so no white shows up.
    backgroundColor: '#09090b',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 10 } as const }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      webviewTag: true,
      // The agent runs in the main process, but the browser tools and the
      // renderer synchronization cannot be frozen when the window
      // loses focus or goes to the background.
      backgroundThrottling: false,
    },
  })

  // Custom frame: the native menu is gone (Alt would still invoke it on win/linux)
  win.setMenuBarVisibility(false)

  // Whatever breaks in the renderer shows up in the TERMINAL. Before, a React error or
  // a crash of the page process only existed in the window's DevTools — the log
  // people paste showed the main process calm while the screen was
  // black, and there was no way to reach the cause without opening the inspector.
  win.webContents.on('console-message', (details) => {
    if (details.level !== 'error') return
    const at = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : ''
    console.error(`[renderer] ${details.message}${at}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer] window process exited: ${details.reason} (code ${details.exitCode})`)
  })

  // Opens filling the screen: maximized (not native full screen), so the menu bar
  // and the traffic lights stay in place. The maximize is applied to the frame while the
  // window is still hidden — the first frame already comes out at the size of the usable
  // area, with no growth animation and no flash at the default size (800x600).
  win.maximize()

  // Shows the window only when the renderer has already painted the first frame — no
  // white startup flash. (The entrance sound now runs in the renderer:
  // it schedules playback on the same tick as the persona waking up — see
  // src/lib/entrance-sound.ts.)
  const showWindow = () => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show()
  }
  // --hidden: ready-to-show shows nothing — the app runs only for the routines.
  if (!oculto) {
    win.once('ready-to-show', showWindow)
    setTimeout(showWindow, 5000)
  }

  win.on('maximize', () => win?.webContents.send('window:maximized-change', true))
  win.on('unmaximize', () => win?.webContents.send('window:maximized-change', false))

  // Full screen: on macOS the traffic lights disappear, so the 80px padding that
  // accommodates them in the titlebar has to go too — otherwise a hole is left on the left.
  win.on('enter-full-screen', () => win?.webContents.send('window:fullscreen-change', true))
  win.on('leave-full-screen', () => win?.webContents.send('window:fullscreen-change', false))

  // Close to tray: the X hides the app instead of quitting it — it is what
  // keeps it alive serving the apps connected over MCP while there is no window in
  // sight. Without a tray created, close follows the normal path: hiding with no way
  // back would be losing the app — which is what happens on macOS, where there is no tray
  // and the Dock is what brings the window back (see `window-all-closed`).
  win.on('close', (event) => {
    if (quitting || !getAppSettings().closeToTray || !hasTray()) return
    event.preventDefault()
    win?.hide()
  })

  // The window really died (macOS: the X closes it and the app stays alive in the Dock):
  // the reference has to die with it. A destroyed `win` would make every
  // `win?.webContents.send` of the main process talk to the void, and `showMainWindow`
  // would stop recreating the window, thinking it was still there.
  const created = win
  created.on('closed', () => {
    // Reopened before this point, there already is another one in place — this reference is not it.
    if (win === created) win = null
  })

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  // Links clicked in the app (sources, citations, markdown) never open a new
  // window: they go to the built-in browser — the renderer decides the tab, because it is
  // the one that knows which conversation is open — or to the system browser,
  // according to Preferences → Browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      if (getAppSettings().browser.links === 'integrated') win?.webContents.send('link:open', url)
      else void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (VITE_DEV_SERVER_URL) {
    const separator = VITE_DEV_SERVER_URL.includes('?') ? '&' : '?'
    win.loadURL(isInitialWindow ? `${VITE_DEV_SERVER_URL}${separator}entrance=1` : VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'), isInitialWindow ? { query: { entrance: '1' } } : undefined)
  }
}

/** The live window, recreating it if there is none. `null` only if creation fails. */
function ensureWindow(): BrowserWindow | null {
  if (win && !win.isDestroyed()) return win
  createWindow()
  return win && !win.isDestroyed() ? win : null
}

/**
 * Delivers a menu event to the renderer, creating the window if needed. On macOS
 * the menu bar survives the window — the X really closes it and the app stays alive
 * in the Dock —, so an action from it (Cmd+N, Preferences…) has to bring the window
 * back. Just created, it is still loading, and sending now would lose the
 * message: hence waiting for the load to finish.
 */
function sendToWindow(channel: string, payload: string): void {
  const target = ensureWindow()
  if (!target) return
  if (target.webContents.isLoading()) {
    target.webContents.once('did-finish-load', () => {
      if (!target.isDestroyed()) target.webContents.send(channel, payload)
    })
    return
  }
  target.webContents.send(channel, payload)
}

// macOS native menu: on the Mac the menu bar is at the top of the screen, so the
// hamburger actions (which the renderer hides on that OS) migrate here, with
// native shortcuts (Cmd+N, Cmd+Shift+N, Cmd+O, Cmd+,). On win/linux nothing changes:
// the menu bar stays hidden and the hamburger stays in the app.
function createAppMenu() {
  if (process.platform !== 'darwin') return
  const send = (action: string) => sendToWindow('menu:action', action)
  const openFolder = async () => {
    // The chosen folder needs a live window to go to — with the window
    // closed, the dialog is what makes it come to life.
    const target = ensureWindow()
    if (!target) return
    const result = await dialog.showOpenDialog(target, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return
    sendToWindow('app:open-folder', result.filePaths[0])
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Orbit',
      submenu: [
        { role: 'about', label: 'About Orbit' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('settings') },
        { type: 'separator' },
        { role: 'services', label: 'Services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Orbit' },
        { role: 'hideOthers', label: 'Hide Others' },
        { role: 'unhide', label: 'Show All' },
        { type: 'separator' },
        // ⌘Q closes the window and the app stays in the Dock — routines run with
        // no window, so this is NOT the way out. Leaving is the item below, which
        // sets `quitting` and goes through the `before-quit` for real.
        {
          label: 'Close Window',
          accelerator: 'Cmd+Q',
          click: () => {
            if (win && !win.isDestroyed()) win.close()
          },
        },
        { label: 'Quit Orbit…', accelerator: 'Cmd+Shift+Q', click: quitApp },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'Cmd+N', click: () => send('new-chat') },
        { label: 'New Code Session', accelerator: 'Cmd+Shift+N', click: () => send('new-code') },
        { label: 'Open Folder…', accelerator: 'Cmd+O', click: openFolder },
        { type: 'separator' },
        { role: 'close', label: 'Close Window' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select All' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Chats', click: () => send('view-chats') },
        { label: 'Memories', click: () => send('view-memories') },
        { label: 'Models', click: () => send('view-models') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Toggle Full Screen' },
        { role: 'reload', label: 'Reload' },
        { role: 'toggleDevTools', label: 'Developer Tools' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize', label: 'Minimize' },
        { role: 'zoom', label: 'Zoom' },
      ],
    },
    {
      label: 'Help',
      submenu: [{ label: 'How it works', click: () => send('how-to') }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // With the tray active the app stays alive without a window — quitting from here would destroy
    // the icon along with it and the app would become unreachable.
    if (getAppSettings().closeToTray && hasTray()) return
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On macOS the app stays alive without windows, and the Dock click is the way
  // back. Asking `getAllWindows()` is no good: the auxiliary windows
  // stay alive hidden — the Computer Use panel keeps existing
  // after being used, and the overlay is born pre-warmed at boot — so the list
  // never goes back to empty. The Dock click brought no window and the
  // app looked closed while it was open.
  showMainWindow()
})

const terminals = new Map<string, NodePty.IPty>()

/**
 * node-pty@1.1.0 publishes the `spawn-helper` (macOS) without the execute bit in the
 * tarball; without +x posix_spawn fails with EACCES and the terminal never opens.
 * Adjusts the mode of the current prebuild binary (idempotent). In the packaged app
 * the binary lives in app.asar.unpacked, so we repeat the node-pty dance.
 */
function ensurePtyHelperExecutable() {
  if (process.platform !== 'darwin') return
  try {
    let helper = path.join(
      path.dirname(_require.resolve('node-pty/package.json')),
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    )
    if (helper.includes('app.asar')) helper = helper.replace('app.asar', 'app.asar.unpacked')
    chmodSync(helper, 0o755)
  } catch (err) {
    console.warn('[terminal] could not fix the spawn-helper permissions:', (err as Error).message)
  }
}

function createTerminal(id: string, cols = 80, rows = 24, cwd?: string) {
  ensurePtyHelperExecutable()
  const isWin = process.platform === 'win32'
  const shellCmd = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')

  const ptyProcess = nodePty.spawn(shellCmd, loginShellArgs(), {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwd ?? process.env.HOME ?? process.env.USERPROFILE ?? '/',
    env: userShellEnv(),
  })

  ptyProcess.onData((data) => {
    win?.webContents.send('terminal:output', { id, data })
  })

  ptyProcess.onExit(({ exitCode }) => {
    terminals.delete(id)
    win?.webContents.send('terminal:exit', { id, code: exitCode })
  })

  return ptyProcess
}

/**
 * The list of what a recursive scan walks through lives in `workspace-search`:
 * it is the SAME filter that the panel search, the `@` palette and the text scan
 * use. Two lists would diverge, and the one lagging behind would scan
 * node_modules or hide the code behind `.whisper-build`.
 */

interface DirEntryInfo {
  name: string
  path: string
  isDirectory: boolean
}

async function listDirectory(dirPath: string): Promise<DirEntryInfo[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  // Everything shows up, including what starts with a dot. Hiding "hidden" ones removed
  // the .env, the .gitignore and the .github folder from the tree — files that are edited
  // every week. Protecting a secret is the job of the agent permission (the .env asks
  // for approval for it), not of hiding the file from its owner.
  const result: DirEntryInfo[] = entries
    .map(e => ({
      name: e.name,
      path: path.join(dirPath, e.name),
      isDirectory: e.isDirectory(),
    }))
  result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return result
}

const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2MB

/** `mtimeMs` comes back too: it is the reference the panel returns on save to
 *  detect that the file changed on disk since it was opened. */
async function readTextFile(
  filePath: string,
): Promise<{ content: string; mtimeMs: number } | { error: string }> {
  try {
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_FILE_SIZE) {
      return { error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB)` }
    }
    const buffer = await fs.readFile(filePath)
    if (buffer.subarray(0, 8000).includes(0)) {
      return { error: 'Binary file' }
    }
    return { content: buffer.toString('utf8'), mtimeMs: stat.mtimeMs }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.scss': 'text/x-scss',
  '.sass': 'text/x-sass',
  '.less': 'text/x-less',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.xml': 'text/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
'.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.csv': 'text/csv',
  '.env': 'text/plain',
  '.sh': 'text/x-shellscript',
  '.bat': 'text/x-bat',
  '.ps1': 'text/x-powershell',
  '.sql': 'text/x-sql',
  '.graphql': 'text/graphql',
  '.prisma': 'text/x-prisma',
  '.vue': 'text/x-vue',
  '.svelte': 'text/x-svelte',
  '.astro': 'text/x-astro',
  '.lock': 'text/plain',
  '.log': 'text/plain',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
}

/**
 * Image extensions, derived from MIME_MAP itself so the two lists do not
 * drift apart over time.
 */
const IMAGE_EXTENSIONS = new Set(
  Object.entries(MIME_MAP)
    .filter(([, mime]) => mime.startsWith('image/'))
    .map(([ext]) => ext),
)

/** Cap of figures resolved per Markdown — a document with hundreds of them
 *  would fill the renderer memory with base64 without anyone asking. */
const MAX_MARKDOWN_IMAGES = 60

app.whenReady().then(() => {
  // Electron's WM_CLASS comes from the package.json desktopName ("orbit.desktop"),
  // and electron-builder names the .desktop and the StartupWMClass from the
  // SAME field (linux.syncDesktopName). That match is what makes the environment
  // tie the open window to the installed shortcut — without it the dock does not
  // find the icon and falls back to the generic one.
  app.setName('Orbit')

  // App identity on Windows. Without it the system treats the window as belonging
  // to electron.exe in dev mode, and the taskbar shows its icon.
  //
  // In dev the identity is ANOTHER one, on purpose. Windows resolves the taskbar
  // button through the AppUserModelID: it looks for a Start Menu shortcut
  // with that id and uses the icon and name OF THE SHORTCUT, not the window's. And
  // the first native notification makes Chromium create that shortcut by itself —
  // in dev, pointing to node_modules/electron/dist/electron.exe. With the
  // same id on both sides, that "Electron.lnk" hijacks the identity of the
  // installed app: the .exe and the window icon stay right and even so
  // the taskbar shows the Electron logo.
  if (process.platform === 'win32') {
    app.setAppUserModelId(app.isPackaged ? PROD_APP_USER_MODEL_ID : DEV_APP_USER_MODEL_ID)
    if (!app.isPackaged) ensureDevShortcut()
  }

  // On macOS the dev dock shows the Electron bundle icon. The packaged
  // app brings its own (build/icon.icns); in dev, the icon comes in here — already in
  // the macOS format (rounded corners and margin), otherwise it becomes a square
  // larger than its neighbors in the dock.
  if (process.platform === 'darwin' && !app.isPackaged) {
    const dockIcon = path.join(process.env.APP_ROOT, 'build', 'icon-dock.png')
    if (existsSync(dockIcon)) app.dock?.setIcon(dockIcon)
  }

  // Secondary instance: the lock was not obtained and the app is already quitting.
  if (!gotSingleInstanceLock) return

  // Persisted renderer language: loaded before any native notification, which
  // can fire (scheduled routine) without any request coming from the UI.
  void loadMainLocale()

  // Memory/timing instrumentation (ORBIT_PERF=1): samples the main process, the
  // Electron helpers and the children a check starts (tsc/vitest), which is where
  // an orchestra night actually spends its gigabytes.
  startPerf()

  // Media journals (the revert of pieces and gallery): those of deleted conversations
  // and those older than 30 days come out. In the background — nothing depends on it.
  void pruneMediaJournals(30 * 24 * 60 * 60 * 1000, async (id) => (await readJson(StorageKeys.session(id))) !== null).catch(() => 0)

  createAppMenu()

  // Custom titlebar controls (frame: false on win/linux)
  ipcMain.handle('window:minimize', () => win?.minimize())
  ipcMain.handle('window:maximize', () => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window:close', () => win?.close())
  ipcMain.handle('window:isMaximized', () => win?.isMaximized() ?? false)
  ipcMain.handle('window:toggleFullscreen', () => win?.setFullScreen(!win.isFullScreen()))
  ipcMain.handle('window:isFullscreen', () => win?.isFullScreen() ?? false)

  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('terminal:create', (_event, id: string, cols?: number, rows?: number, cwd?: string) => {
    try {
      const proc = createTerminal(id, cols, rows, cwd)
      terminals.set(id, proc)
      return { pid: proc.pid }
    } catch (err) {
      console.error('[terminal] failed to create the PTY:', (err as Error).message)
      throw err
    }
  })

  ipcMain.handle('terminal:write', (_event, id: string, data: string) => {
    terminals.get(id)?.write(data)
  })

  ipcMain.handle('terminal:resize', (_event, id: string, cols: number, rows: number) => {
    terminals.get(id)?.resize(cols, rows)
  })

  ipcMain.handle('terminal:kill', (_event, id: string) => {
    const proc = terminals.get(id)
    if (proc) {
      proc.kill()
      terminals.delete(id)
    }
  })

  ipcMain.handle('fs:readdir', async (_event, dirPath: string) => {
    try {
      return { ok: true, entries: await listDirectory(dirPath) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
    return readTextFile(filePath)
  })

  /**
   * Write from the file panel. The only path through which the renderer writes to
   * disk — the agent tools go through `resolveSafePath`, not through here.
   *
   * The panel EDITS, it does not create: the target has to be a text file that
   * already exists. That, plus the refusal of `.git`, is what limits the damage of a
   * wrong path — the containment in the roots is a net against bugs, since the one
   * that provides the roots is the renderer itself (see file-write-guard).
   */
  ipcMain.handle(
    'fs:writeFile',
    async (
      _event,
      input: { filePath: string; content: string; roots: string[]; expectedMtimeMs?: number },
    ) => {
      const verdict = checkWritePath(input.filePath, input.roots)
      if (!verdict.ok) return { ok: false as const, reason: verdict.reason }
      const file = verdict.resolved
      try {
        const stat = await fs.stat(file)
        if (!stat.isFile()) return { ok: false as const, reason: 'not-a-file' as const }
        if (Buffer.byteLength(input.content, 'utf8') > MAX_FILE_SIZE) {
          return { ok: false as const, reason: 'too-large' as const }
        }
        // Changed on disk since the panel opened: it may be the agent, it may be
        // another editor. Overwriting here would erase work nobody saw,
        // so we return the new content and the person decides.
        // Is the target binary? The panel only opens text (readTextFile refuses
        // binary), so getting here means a wrong path — and overwriting
        // a .png with text is the damage these guards exist to avoid.
        const head = await fs.open(file, 'r')
        try {
          const probe = Buffer.alloc(Math.min(8000, stat.size))
          if (probe.length > 0) await head.read(probe, 0, probe.length, 0)
          if (probe.includes(0)) return { ok: false as const, reason: 'binary' as const }
        } finally {
          await head.close()
        }
        if (input.expectedMtimeMs != null && stat.mtimeMs !== input.expectedMtimeMs) {
          const current = await readTextFile(file)
          return {
            ok: false as const,
            reason: 'stale' as const,
            ...('content' in current
              ? { content: current.content, mtimeMs: current.mtimeMs }
              : {}),
          }
        }
        await fs.writeFile(file, input.content, 'utf8')
        const after = await fs.stat(file)
        // The turn in progress has to know this file belongs to the user,
        // otherwise the folder snapshot credits it to the agent.
        recordManualSave(file)
        return { ok: true as const, mtimeMs: after.mtimeMs }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return { ok: false as const, reason: 'not-a-file' as const }
        return { ok: false as const, reason: 'failed' as const, error: (err as Error).message }
      }
    },
  )

  /**
   * Lint of the file open in the panel. The content comes from the BUFFER, not from disk:
   * the value is in pointing the error out while typing, before saving.
   */
  ipcMain.handle(
    'lint:file',
    async (_event, input: { root: string; filePath: string; content: string }) =>
      lintFile(input.root, input.filePath, input.content),
  )

  ipcMain.handle('fs:listFilesRecursive', async (_event, dirPath: string) => {
    try {
      // The shared index: same ignore as the search, already sorted and cached.
      const index = await workspaceIndex(dirPath)
      return { ok: true, files: index.files }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ---- Workspace search: panel, modal and the `@` palette -------------------
  /** Live text scans, by request id — what cancel aborts. */
  const textSearches = new Map<string, AbortController>()

  ipcMain.handle(
    'ws:names',
    async (_event, input: { root: string; query: string; refresh?: boolean }) => {
      try {
        const index = await workspaceIndex(input.root, { refresh: input.refresh })
        return {
          ok: true as const,
          hits: matchNames(index.files, input.query),
          total: index.files.length,
          truncated: index.truncated,
        }
      } catch (err) {
        return { ok: false as const, error: (err as Error).message }
      }
    },
  )

  ipcMain.handle(
    'ws:text',
    async (
      _event,
      input: {
        id: string
        root: string
        query: string
        caseSensitive?: boolean
        regex?: boolean
        wholeWord?: boolean
      },
    ) => {
      // A new request in the same field kills the previous one: what the user has
      // abandoned cannot keep reading disk and occupying the queue.
      textSearches.get(input.id)?.abort()
      const controller = new AbortController()
      textSearches.set(input.id, controller)
      try {
        const index = await workspaceIndex(input.root)
        const result = await searchText(
          input.root,
          index.files,
          input.query,
          {
            caseSensitive: input.caseSensitive,
            regex: input.regex,
            wholeWord: input.wholeWord,
          },
          controller.signal,
        )
        return { ok: true as const, ...result }
      } catch (err) {
        return { ok: false as const, error: (err as Error).message }
      } finally {
        if (textSearches.get(input.id) === controller) textSearches.delete(input.id)
      }
    },
  )

  ipcMain.handle('ws:cancel', (_event, id: string) => {
    textSearches.get(id)?.abort()
    textSearches.delete(id)
    return true
  })

  /**
   * Bulk replace. The targets come from the list of occurrences, so the
   * scope (the workspace, the folder) is a UI decision; here we only write, with the SAME
   * path guard as `fs:writeFile` — including the refusal of `.git`.
   */
  ipcMain.handle(
    'ws:replace',
    async (
      _event,
      input: {
        root: string
        targets: string[]
        query: string
        replacement: string
        caseSensitive?: boolean
        regex?: boolean
        wholeWord?: boolean
        preserveCase?: boolean
      },
    ) => {
      const result = await replaceInFiles(
        input.root,
        input.targets,
        input.query,
        input.replacement,
        {
          caseSensitive: input.caseSensitive,
          regex: input.regex,
          wholeWord: input.wholeWord,
          preserveCase: input.preserveCase,
        },
        (absolute) => {
          const verdict = checkWritePath(absolute, [input.root])
          return verdict.ok
            ? { ok: true as const }
            : { ok: false as const, reason: verdict.reason }
        },
      )
      for (const file of result.written) recordManualSave(file)
      invalidateIndex(input.root)
      return { ok: true as const, ...result }
    },
  )

  // Path stat (e.g. validating a loose folder from drag & drop)
  ipcMain.handle('fs:stat', async (_event, filePath: string) => {
    try {
      const stat = await fs.stat(filePath)
      return { ok: true, isDirectory: stat.isDirectory(), isFile: stat.isFile(), size: stat.size }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Which of these paths are still folders — in batch, a single round trip. It exists for the
  // revalidation of folders that vanished from disk (renamed/moved/deleted):
  // each reference is a string, and checking them one by one would cost one round trip to the main
  // process per path. An unreadable path counts as absent (which is what it is, for
  // whoever was going to use it); who decides what to do with that is the UI.
  ipcMain.handle('fs:existDirs', async (_event, dirs: string[]) => {
    const result: Record<string, boolean> = {}
    await Promise.all(
      dirs.map(async (dir) => {
        try {
          result[dir] = (await fs.stat(dir)).isDirectory()
        } catch {
          result[dir] = false
        }
      }),
    )
    return result
  })

  // "Open with Orbit" integration in the Explorer context menu
  ipcMain.handle('openwith:status', () => getOpenWithStatus())
  ipcMain.handle('openwith:register', () => registerOpenWith())
  ipcMain.handle('openwith:unregister', () => unregisterOpenWith())

  // App version (package.json packaged by electron-builder) — the About
  // screen shows the same string as the artifacts and the companion handshake.
  ipcMain.handle('app:version', () => app.getVersion())

  // Pending folder (app started via "Open with Orbit"): the renderer fetches it on
  // mount so as not to lose the event sent before React comes up.
  ipcMain.handle('app:consumePendingOpen', () => {
    const dir = pendingOpenFolder
    pendingOpenFolder = null
    return dir
  })

  const MAX_FILE_SIZE_MB = 10
  const MAX_BINARY_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024

  ipcMain.handle('fs:readFileAsDataUrl', async (_event, filePath: string) => {
    try {
      const stat = await fs.stat(filePath)
      if (stat.size > MAX_BINARY_SIZE) {
        return { error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_FILE_SIZE_MB}MB)` }
      }
      const buffer = await fs.readFile(filePath)
      const ext = path.extname(filePath).toLowerCase()
      const mime = MIME_MAP[ext] ?? 'application/octet-stream'
      return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}` }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  /**
   * The images of a Markdown, resolved against ITS OWN FOLDER.
   *
   * The preview runs in the renderer, whose origin is the app — a `./images/x.png`
   * would resolve against that origin, and not against the open file, so the
   * image showed up broken in every document that references a figure.
   * Resolving here is the only place where the file folder is known.
   *
   * Returns a map from the ORIGINAL path to the data URL: it is the original that the
   * renderer has to replace in the text, and what did not resolve simply does not
   * enter the map and stays as it was.
   */
  ipcMain.handle(
    'fs:markdownImages',
    async (_event, markdownPath: string, sources: string[]) => {
      const dir = path.dirname(markdownPath)
      const out: Record<string, string> = {}
      // File cap: a document with hundreds of figures would fill the
      // renderer memory with base64 without anyone asking for it.
      for (const src of sources.slice(0, MAX_MARKDOWN_IMAGES)) {
        // Markdown escapes space as %20; without decoding, the path does not
        // exist on disk.
        let relative = src
        try {
          relative = decodeURI(src)
        } catch {
          // path with a stray %: worth trying as it came
        }
        const ext = path.extname(relative).toLowerCase()
        // Image only: the target comes from the file content, so it cannot
        // serve to read anything from disk and hand it back to the renderer.
        if (!IMAGE_EXTENSIONS.has(ext)) continue
        const resolved = path.resolve(dir, relative)
        try {
          const stat = await fs.stat(resolved)
          if (!stat.isFile() || stat.size > MAX_BINARY_SIZE) continue
          const buffer = await fs.readFile(resolved)
          out[src] = `data:${MIME_MAP[ext] ?? 'application/octet-stream'};base64,${buffer.toString('base64')}`
        } catch {
          // figure missing in the repository: stays as it was
        }
      }
      return out
    },
  )

  ipcMain.handle('shell:showItemInFolder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  // Git (log, status, diffs, branches, push/pull/commit) vive em ./lib/git.
  registerGitIpc()


  // Worktrees in the chats (header selector): list with state, create and
  // remove. The same service as the agent's worktree_* tools.
  ipcMain.handle('worktree:list', (_event, folder: string) => listWorktrees(folder))
  ipcMain.handle('worktree:create', (_event, folder: string, name: string, base?: string) =>
    createChatWorktree({ folder, name, base }),
  )
  ipcMain.handle('worktree:remove', (_event, folder: string, worktreePath: string, deleteBranch?: boolean) =>
    removeChatWorktree({ folder, path: worktreePath, deleteBranch }),
  )
  ipcMain.handle('worktree:main', (_event, folder: string) => folderInMainRepository(folder))
  ipcMain.handle('worktree:validateFolder', (_event, folder: string) => validateWorktreesFolder(folder))

  // Product sounds (app entrance, notifications)
  ipcMain.handle('sound:play', (_event, name: string) => playSound(name))
  // Bytes of the entrance WAV for the renderer (WebAudio) — decoding and
  // scheduling happen over there, on the same tick as the persona waking up.
  ipcMain.handle('sound:entrance-data', async () => {
    const file = soundPath('entrance')
    if (!existsSync(file)) return null
    return new Uint8Array(await fs.readFile(file))
  })

  // Generic storage (sessions, messages, folders) — opencode default
  ipcMain.handle('storage:read', (_event, key: string) => readJson(key))
  ipcMain.handle('storage:write', (_event, key: string, value: unknown) => writeJson(key, value))
  ipcMain.handle('storage:remove', (_event, key: string) => removeJson(key))
  ipcMain.handle('storage:list', (_event, prefix: string) => listKeys(prefix))

  /**
   * Text search across all sessions (title + messages).
   * Returns flat hits ordered by session recency.
   */
  ipcMain.handle('search:sessions', (_event, query: string) => searchSessions(query))

  // Voice core: local TTS (streaming) and the catalog/status of the voice models.
  registerVoiceIpc()

  // Provider/model catalog (models.dev)
  ipcMain.handle('catalog:get', () => getCatalog())
  onCatalogRefreshed(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('catalog:updated')
    }
  })

  // Unified catalog of the Models tab (OpenRouter + Artificial Analysis)
  ipcMain.handle('models:list', () => getModelsSnapshot())
  ipcMain.handle('models:refresh', () => {
    invalidateModelsSnapshot()
    return getModelsSnapshot(true)
  })

  // Per-message revert (git snapshots of code mode)
  ipcMain.handle('session:revert', (_event, sessionId: string, messageId: string) =>
    revertSession(sessionId, messageId))
  ipcMain.handle('session:unrevert', (_event, sessionId: string) => unrevertSession(sessionId))
  // "Revert too" the files of uncertain author of the active revert.
  ipcMain.handle('session:revertUncertain', (_event, sessionId: string) => revertUncertainSession(sessionId))

  // /init — project analysis and generation of memories by area
  ipcMain.handle('init:run', (_event, input: RunInitInput) => {
    // runProjectInit throws on failure; the error already leaves via init:event — this only avoids
    // an unhandled rejection when it is triggered over IPC (no chat session)
    void runProjectInit(input).catch(() => {})
  })
  // App language: the renderer publishes it, the main process reads it when it
  // fires something without a renderer request (scheduled routines).
  ipcMain.handle('app:setLanguage', (_event, language: string) => {
    // The language also applies to the native notifications, which are born here
    // (see lib/i18n.ts) — and to the tray labels, which are text of the main process.
    setMainLocale(language)
    void syncTray()
    return writeJson(StorageKeys.appLanguage, language)
  })
  ipcMain.handle('init:status', (_event, directory: string) => getInitStatus(directory))
  // Stops the analysis triggered by the project card, which runs outside any
  // chat session (the /init one is canceled together with the session, in chat:abort).
  ipcMain.handle('init:stop', (_event, directory: string) => abortProjectInit(directory))

  // Provider credentials (the keys never go back to the renderer)
  ipcMain.handle('auth:set', (_event, providerId: string, key: string) => setCredential(providerId, key))
  ipcMain.handle('auth:remove', (_event, providerId: string) => removeCredential(providerId))
  ipcMain.handle('auth:list', () => listCredentialProviders())

  // Chat
  ipcMain.handle('chat:send', async (_event, input: SendMessageInput) => {
    if (!win) return
    await dispatchSend(win, input)
  })
  ipcMain.handle('chat:abort', (_event, sessionId: string) => abortSession(sessionId))
  // Sessions still running in the main process (the engine lives here) — the renderer asks
  // after a reload to re-show the spinner/stop button immediately.
  ipcMain.handle('chat:running', () => [
    ...getRunningSessionIds(),
    ...getLoopRunningSessionIds(),
    ...getOrchestrationRunningSessionIds(),
  ])
  // A live request answers directly; a card surviving a finished run
  // goes back to the conversation as a message (see ask-resume).
  ipcMain.handle('chat:askReply', (_event, requestId: string, value: unknown) =>
    replyOrResume(win, requestId, value))
  // "Bring together again": the accepted work of the workers that stayed out of the chat
  // (uncommitted change on the path, conflict resolved later).
  ipcMain.handle('chat:mergeOrchestration', (_event, sessionId: string) => (win ? mergeAgain(win, sessionId) : undefined))
  ipcMain.handle('chat:approvePlan', (_event, sessionId: string, planId: string, taskIds?: string[]) => {
    if (win) void approvePlan(win, sessionId, planId, taskIds)
  })
  // "Continue" on the card of a plan that was interrupted: runs again the tasks it
  // did not accept, in their own worker sessions (see resumePlan).
  ipcMain.handle('chat:resumePlan', (_event, input: SendMessageInput) => {
    if (win) void resumePlan(win, input)
  })
  ipcMain.handle('chat:rejectPlan', (_event, sessionId: string) => {
    if (win) void rejectPlan(win, sessionId)
  })
  ipcMain.handle('chat:compact', (_event, sessionId: string) => {
    if (win) void compactSession(win, sessionId)
  })
  // Continuity brief for the new chat (compaction card). It is generated in the
  // auxiliary model and returns the text already with the summary header.
  ipcMain.handle('chat:continuationBrief', (_event, sessionId: string) => continuationBrief(sessionId))
  ipcMain.handle('chat:closeBrowser', (_event, sessionId: string) => destroyBrowserWindow(sessionId))
  ipcMain.handle('plan:saveFile', async (_event, directory: string, content: string) => {
    await savePlanFile(directory, content)
  })
  ipcMain.handle('plan:deleteFile', async (_event, directory: string) => {
    await deletePlanFile(directory)
  })
  ipcMain.handle('plan:readFile', async (_event, directory: string) => {
    return await readPlanFile(directory)
  })

  // Right panel browser: the renderer registers the webContents of the <webview>
  // per chat session (panel:register) — each chat has its own browser.
  ipcMain.on('panel:register', (_event, sessionId: string | null, id: number | null) =>
    registerPanelWebContents(sessionId, id),
  )

  // Discarded <webview> (tab unmounted): release the record only if it is the
  // webContents that died — the session agent's browser is another one and stays.
  ipcMain.on('panel:unregister', (_event, sessionId: string | null, id: number | null) =>
    unregisterPanelWebContents(sessionId, id),
  )

  // Snapshot of the side panel that the renderer pushes on every tab change
  // (tool read_open_panel: what the user is looking at right now).
  registerPanelStateIpc()

  // Session/folder events emitted by the renderer (new chat, rename, pin,
  // archive, move, delete...). The sender has already applied the change to the local
  // store — here the event goes on to the OTHER windows and to the companions
  // (mobile), keeping the real-time sync in both directions.
  ipcMain.on('chat:event:emit', (event, chatEvent: ChatEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents.id !== event.sender.id) {
        win.webContents.send('chat:event', chatEvent)
      }
    }
    forwardChatEvent(chatEvent)
  })

  // Models per session: the renderer pushes the map (selection in any chat)
  // and the main process keeps the HTTP cache (GET /api/session-models, used by mobile
  // on connect) + forwards them to the companions in real time ('session:model-change').
  ipcMain.on('companion:session-models', (_event, overrides: Record<string, { providerId: string; modelId: string }>) => {
    setSessionModelsCache(overrides)
    broadcastSessionModels(overrides)
  })

  // Active modes per chat: same path as the models (HTTP cache for the connect +
  // 'session:mode-change' event for whoever is already connected).
  ipcMain.on('companion:session-modes', (_event, overrides: SessionModeOverrides) => {
    setSessionModesCache(overrides)
    broadcastSessionModes(overrides)
  })

  // Thinking and autonomy per chat: same path as the modes. Besides the HTTP cache and
  // the event, the permission map feeds the tool gate — each
  // turn consults the level of its OWN chat, not a global mode of the app.
  ipcMain.on('companion:session-prefs', (_event, prefs: SessionPrefsSnapshot) => {
    setSessionPrefsCache(prefs)
    setSessionModes(prefs?.permission ?? {})
    broadcastSessionPrefs(prefs)
  })

  // Thinking per model: same path (HTTP cache for the connect + event
  // 'reasoning:change' for whoever is already connected).
  ipcMain.on('companion:reasoning-prefs', (_event, prefs: ReasoningPrefsMap) => {
    setReasoningPrefsCache(prefs)
    broadcastReasoningPrefs(prefs)
  })

  // App preferences (mode defaults, permission, automatic folders):
  // same path, with the renderer as the source of truth.
  ipcMain.on('companion:preferences', (_event, prefs: AppPreferences) => {
    broadcastAppPreferences(prefs)
  })

  // Message queue: the renderer owns it (it is the one that sends the next item)
  // and pushes the whole queue on every change; the phone reads and operates on it.
  ipcMain.on('companion:message-queue', (_event, queues: MessageQueueSnapshot) => {
    broadcastMessageQueue(queues)
  })

  // Config of the delegated modes (workers + vision), by the same path.
  ipcMain.on('companion:worker-config', (_event, config: WorkerConfigSnapshot) => {
    setWorkerConfigCache(config)
    broadcastWorkerConfig(config)
  })

  // Model rotation: the renderer pushes the state (list of rotations +
  // choice per chat) and the main process caches it — the engine resolves the
  // sequence of the turn at call time. The same state feeds the
  // HTTP cache (GET /api/rotations, read by the phone on connect) and goes to
  // the companions in real time ('rotation:change').
  ipcMain.on('rotation:sync', (_event, config: RotationConfig) => {
    setRotationConfigCache(config)
    setRotationHttpCache(config)
    broadcastRotationConfig(config)
  })

  // Images of the assistant answers (orbit-media://)
  registerMediaProtocol()
  // Attached and generated audio (orbit-audio://)
  registerAudioProtocol()
  // Videos the agent showed (orbit-video://) and the app's ffmpeg in the PATH
  // of the agent shells.
  registerVideoProtocol()
  registerBundledFfmpeg()
  // yt-dlp downloaded by the app itself (ytdlp_install) also enters the PATH of the
  // agent shells — it is the `bash` that does what the EDL does not cover.
  registerYtdlpOnPath()
  // HTML artifacts of the answers (orbit-artifact://) — the privileges of the
  // scheme were already declared at the top of the module.
  registerArtifactProtocol()
  // Motion compositions of the preview (orbit-motion://, see video/motion-store):
  // serves the registered FOLDER and the runtime script that the render also uses.
  registerMotionProtocol()

  // Design canvas (orbit-design://, see lib/design/design-store): serves a
  // registered folder (canvas.json + artboards), with no runtime injected — the
  // content is static HTML.
  registerDesignProtocol()

  // Slide decks (orbit-slides://, see lib/slides/slides-store): serves a
  // registered folder and injects the navigation runtime — the deck itself is static
  // content, with no script of its own.
  registerSlidesProtocol()

  // Fonts installed by the font_use tool (orbit-font://<hash>.woff2).
  registerFontProtocol()

  // Reopening a piece that is already in the registry: the chat card and the Media tile
  // send only the id. The composition (folder + entry) comes from the main process registry — the
  // renderer has no reason to know any project path.
  ipcMain.handle(
    'motion:open',
    async (_event, ref: { id?: string; path?: string; sessionId?: string; name?: string }) => {
      // The gallery card sends the id (its link is the motionId); the chat card
      // sends what the tool left in `input` — the project folder path
      // (motion_preview, code mode) or the NAME of the conversation composition
      // (motion_write/motion_edit, chat mode) — and the registry translates. In this order:
      // the id already is the answer, the path is more precise than the name.
      let id = ref.id ?? null
      if (!id && ref.path) id = await motionIdForPath(ref.path)
      if (!id && ref.sessionId && ref.name) id = await motionIdForName(ref.sessionId, ref.name)
      return id ? reopenMotion(id) : false
    },
  )

  // Reopening a deck by id: the gallery card sends the id; the chat card sends
  // the path (code mode, slides_preview) or the NAME of the deck with the session
  // (chat mode, slides_write), and the registry translates.
  ipcMain.handle('slides:open', async (_event, ref: { id?: string; path?: string; sessionId?: string; name?: string }) => {
    let id = ref.id ?? null
    if (!id && ref.path) id = await slidesIdForPath(ref.path)
    if (!id && ref.sessionId && ref.name) id = await slidesIdForName(ref.sessionId, ref.name)
    return id ? reopenSlides(id) : false
  })

  // Resolve the deck WITHOUT opening a tab: the chat card shows the deck itself inline
  // (as the artifact does with the HTML) and only needs the id and the relative entry
  // to build the iframe. Same resolution as `slides:open`, without the effect of
  // opening — the one that orders it to open is the sidebar button.
  ipcMain.handle('slides:resolve', async (_event, ref: { id?: string; path?: string; sessionId?: string; name?: string }) => {
    let id = ref.id ?? null
    if (!id && ref.path) id = await slidesIdForPath(ref.path)
    if (!id && ref.sessionId && ref.name) id = await slidesIdForName(ref.sessionId, ref.name)
    if (!id) return null
    const deck = await getSlides(id)
    if (!deck) return null
    return { id, entry: path.relative(deck.folder, deck.entry).split(path.sep).join('/') }
  })

  // Download the deck as PDF. The printing happens in the main process (slides-export) — the
  // renderer does not write files — and the PDF is born from the index.html itself, with no
  // intermediate format. Canceling in the dialog is not an error.
  ipcMain.handle('slides:export', async (_event, id: string, suggestedName?: string) => {
    const deck = await getSlides(id)
    if (!deck) return { ok: false as const, error: 'Deck not found.' }
    const pdf = await renderSlidesPdf(id)
    if (!pdf) return { ok: false as const, error: 'Could not generate the PDF for this deck.' }
    const name = (suggestedName ?? path.basename(deck.folder)).replace(/\.pdf$/i, '').trim() || 'deck'
    const target = await saveExport(null, {
      fileName: `${name}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (!target) return { ok: false as const, canceled: true as const }
    await fs.writeFile(target, pdf)
    return { ok: true as const, path: target }
  })

  // Fonts of the design inspector selector: the Orbit library (with the CSS
  // ready — the app window also needs the @font-face to draw the
  // preview of each family) and the families installed on the computer.
  ipcMain.handle('fonts:list', async () => {
    const orbit = await listFonts()
    return {
      orbit: orbit.map((font) => ({
        id: font.id,
        family: font.family,
        category: font.category,
        variable: font.variable,
        weights: font.weights,
        license: font.license?.type,
      })),
      system: await listSystemFonts(),
      css: fontFaceCss(orbit),
    }
  })

  // Reopening a canvas by id: the gallery card sends the id; the chat card
  // sends the folder path (code mode, design_preview) or the NAME of the canvas
  // with the session (chat mode, design_write/design_edit), and the registry translates.
  ipcMain.handle('design:open', async (_event, ref: { id?: string; path?: string; sessionId?: string; name?: string }) => {
    let id = ref.id ?? null
    if (!id && ref.path) id = await designIdForPath(ref.path)
    if (!id && ref.sessionId && ref.name) id = await designIdForName(ref.sessionId, ref.name)
    return id ? reopenDesign(id) : false
  })

  // Edit made by the PERSON in the canvas (properties, text, code, moving and
  // resizing artboards). The renderer sends the id + file name; the folder and
  // the name lock stay in the main process (see design-store).
  ipcMain.handle('design:readBoard', (_event, input: { id: string; file: string }) => readDesignBoard(input.id, input.file))
  ipcMain.handle('design:writeBoard', (_event, input: { id: string; file: string; html: string }) =>
    writeDesignBoard(input.id, input.file, input.html),
  )
  ipcMain.handle(
    'design:updateBoard',
    (_event, input: { id: string; file: string; patch: { title?: string; x?: number; y?: number; w?: number; h?: number } }) =>
      updateDesignBoard(input.id, input.file, input.patch),
  )

  // Render of a REGISTERED composition, requested by the motion tab of the panel. The
  // renderer sends only the id and the format; the entry path is revalidated in the
  // main process (resolveSafePath) and the progress comes back through 'motion:render:progress'.
  ipcMain.handle('motion:render', async (event, input: { id: string } & MotionRenderRequest) => {
    const { id, ...req } = input
    // The render of the tab is a request from the PERSON, not from the agent: the file is born where
    // they say, already with the name of the composition. Without this dialog the video landed
    // always in the piece's internal folder, with a fixed name, and finding it later became
    // treasure hunt. The chosen path enters through `saveAs` and therefore does NOT go
    // through resolveSafePath — it is the only render output that can land outside the
    // project folders, and precisely because there was an explicit choice in a
    // system dialog.
    const fileName = await motionOutputName(id, req.format)
    if (!fileName) {
      // Unknown composition: no dialog, so the real error surfaces ("unknown
      // motion composition") instead of the person choosing a file in vain.
      return renderRegisteredMotion(id, req, (frame, total) => {
        if (!event.sender.isDestroyed()) event.sender.send(MOTION_PROGRESS_CHANNEL, { id, frame, total })
      })
    }
    const ext = path.extname(fileName).replace(/^\./, '') || 'mp4'
    const labels: Record<string, string> = {
      mov: 'QuickTime (ProRes 4444, with alpha)',
      webm: 'WebM (VP9, with alpha)',
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const picked = await saveExport(win, {
      title: 'Save the video',
      fileName,
      filters: [{ name: labels[ext] ?? 'MP4 video (H.264)', extensions: [ext] }],
    })
    if (!picked) return { canceled: true }
    return renderRegisteredMotion(id, { ...req, saveAs: picked }, (frame, total) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(MOTION_PROGRESS_CHANNEL, { id, frame, total })
      }
    })
  })

  // The FILES of the compositions of this conversation, for the piece card in the chat:
  // name, size, type and whether the composition references each one (used / discarded).
  // The list comes from the FOLDER — the renderer knows no piece path at all, and the
  // card updates when the folder changes, without anything being written into the message.
  ipcMain.handle('motion:bundles', async (_event, sessionId: string) => listMotionBundles(sessionId))

  // "Save project": the whole composition folder into a .zip (HTML, media,
  // fonts, audio.json) with an orbit.json manifest at the root — it is what the chat
  // recognizes on the way back to import the piece into another conversation. The file is born
  // where the person says, through the same dialog as the deck export.
  ipcMain.handle('motion:export', async (event, id: string) => {
    let project: Awaited<ReturnType<typeof exportMotionProject>>
    try {
      project = await exportMotionProject(id)
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const target = await saveExport(win, {
      title: 'Save the composition project',
      fileName: project.name,
      filters: [{ name: 'Orbit project (zip)', extensions: ['zip'] }],
    })
    if (!target) return { ok: false as const, canceled: true as const }
    try {
      await fs.writeFile(target, project.buffer)
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
    return { ok: true as const, path: target, files: project.files }
  })

  // Layers of the composition (who enters and leaves, and when), measured in an
  // offscreen window through the same scheme as the preview, and the piece TRACK together with them. The tab
  // asks on load and on every change of the file; an error here is the "did not load"
  // with the reason.
  ipcMain.handle('motion:layers', async (_event, id: string) => {
    const url = await registeredMotionUrl(id)
    if (!url) throw new Error('this composition is no longer registered — ask the agent to open it again (motion_preview)')
    const measured = await measureMotionLayers(id, url)
    const entry = await getMotion(id)
    // The tracks come out of the SAME resolution the render uses (motion-audio): what the
    // tab draws and plays is, by construction, what the render will mix — at
    // the same instants. A broken manifest does NOT bring down the layer measurement:
    // it becomes an error track, because a piece silent with no explanation is worse than one
    // that says what happened.
    const audio = await (async () => {
      if (!entry) return null
      try {
        const tracks = await motionAudioTracks(entry.folder, undefined, await motionVideoAudioTracks(entry.folder, measured.videos))
        if (!tracks.length) return null
        return {
          tracks: tracks.map((track) => ({
            name: track.name,
            url: motionAudioUrl(id, track.path),
            start: track.start,
            end: track.end ?? null,
            offset: track.offset ?? 0,
          })),
          error: null,
        }
      } catch (err) {
        return { tracks: [], error: err instanceof Error ? err.message : String(err) }
      }
    })()
    return { ...measured, audio }
  })

  // Pipeline mode: projects/pipelines/tasks board and the execution engine.
  // Mutations come back to the renderer through 'pipeline:event' (the engine emits).
  ipcMain.handle('pipeline:load', () => pipeline.loadAll())
  ipcMain.handle('pipeline:templates', () => pipeline.listTemplates())
  ipcMain.handle('pipeline:saveTemplate', (_e, template: PhaseTemplate) => pipeline.saveTemplate(template))
  ipcMain.handle('pipeline:removeTemplate', (_e, id: string) => pipeline.removeTemplate(id))
  ipcMain.handle('pipeline:createProject', (_e, name: string, folders: string[]) =>
    pipeline.createProject(name, folders),
  )
  ipcMain.handle('pipeline:updateProject', (_e, id: string, patch: Record<string, unknown>) =>
    pipeline.updateProject(id, patch),
  )
  ipcMain.handle('pipeline:removeProject', (_e, id: string) => pipeline.removeProject(id))
  ipcMain.handle('pipeline:create', (_e, input: NewPipelineInput) => pipeline.createPipeline(input))
  ipcMain.handle('pipeline:update', (_e, id: string, patch: Record<string, unknown>) =>
    pipeline.updatePipeline(id, patch),
  )
  ipcMain.handle('pipeline:remove', (_e, id: string) => pipeline.removePipeline(id))
  ipcMain.handle('pipeline:createTask', (_e, input: NewTaskInput) => pipeline.createTask(input))
  ipcMain.handle('pipeline:updateTask', (_e, pipelineId: string, taskId: string, patch: Record<string, unknown>) =>
    pipeline.updateTaskFields(pipelineId, taskId, patch),
  )
  ipcMain.handle('pipeline:removeTask', (_e, pipelineId: string, taskId: string) =>
    pipeline.removeTask(pipelineId, taskId),
  )
  ipcMain.handle('pipeline:startTask', (_e, pipelineId: string, taskId: string, phase?: number) =>
    pipeline.startTask(pipelineId, taskId, phase ?? 0),
  )
  ipcMain.handle('pipeline:pauseTask', (_e, pipelineId: string, taskId: string) =>
    pipeline.pauseTask(pipelineId, taskId),
  )
  ipcMain.handle('pipeline:resumeTask', (_e, pipelineId: string, taskId: string, instruction?: string) =>
    pipeline.resumeTask(pipelineId, taskId, instruction),
  )
  ipcMain.handle('pipeline:returnTask', (_e, pipelineId: string, taskId: string, text: string, phase?: number) =>
    pipeline.returnTask(pipelineId, taskId, text, phase ?? 0),
  )
  ipcMain.handle('pipeline:toggleQueue', (_e, pipelineId: string, enabled: boolean) => {
    if (enabled) pipeline.enableQueue(pipelineId)
    else pipeline.disableQueue(pipelineId)
    return pipeline.isQueueEnabled(pipelineId)
  })
  ipcMain.handle('pipeline:report', (_e, pipelineId: string) => pipeline.report(pipelineId))
  // The engine's `running` map lives in memory: a task left in progress by an
  // abrupt shutdown would keep "running" on the board forever.
  void pipeline.reconcileExecutions().catch((err) => console.error('[pipeline] reconciliation failed:', err))

  // Routines: scheduled chats (chat and code modes). The CRUD lives in
  // orbit-data/routines; the firing reuses the 'chat:send' path above, and the
  // mutations go back to the renderer through 'routines:event'.
  ipcMain.handle('routines:load', () => routines.loadAll())
  ipcMain.handle('routines:create', (_e, input: NewRoutineInput) => routines.createRoutine(input))
  ipcMain.handle('routines:update', (_e, id: string, patch: Partial<Routine>) =>
    routines.updateRoutineFields(id, patch),
  )
  ipcMain.handle('routines:remove', (_e, id: string) => routines.removeRoutineCompletely(id))
  ipcMain.handle('routines:runNow', (_e, id: string) => routines.runNow(id))
  ipcMain.handle('routines:pruneRuns', (_e, sessionIds: string[]) => routines.pruneOrphanRuns(sessionIds))
  ipcMain.handle(
    'routines:generate',
    (_e, description: string, model: RoutineModel, folders: string[], language?: string, mode?: 'chat' | 'code', visionAvailable?: boolean) =>
      routines.generateRoutine(description, model, folders, language, mode, visionAvailable),
  )
  // Agent proposals (tool routines_manage): the conversation card lists,
  // approves and discards them. Approval creates the actual routine (with the
  // proposal id) and the 'routine' event comes out of it, like any creation.
  ipcMain.handle('routines:pending', () => listPendingRoutines())
  ipcMain.handle('routines:approvePending', (_e, id: string) => approvePendingRoutine(id))
  ipcMain.handle('routines:discardPending', (_e, id: string) => discardPendingRoutine(id))
  routines.startScheduler()
  // Residency (macOS): the LaunchAgent that brings the app back at login and
  // after a crash, hidden. Routines are what it exists for.
  void installBackgroundAgent()

  // Media gallery ("Media" tab of the right panel)
  ipcMain.handle('media:list', (_event, filter?: MediaFilter) => listMedia(filter))
  ipcMain.handle('media:usage', () => mediaDiskUsage())
  ipcMain.handle('media:delete', (_event, ids: string[]) => deleteManyMedia(ids))
  ipcMain.handle('media:cleanupScripts', () => cleanupScriptMedia())
  // Fork: links the cloned assets to the new session, so that "In this chat" in
  // the gallery finds them without duplicating anything on disk (see linkMediaSessions).
  ipcMain.handle('media:linkSessions', (_event, ids: string[], sessionId: string) =>
    linkMediaSessions(ids, sessionId),
  )
  // Indexes images older than the registry (runs on the first opening of the gallery)
  ipcMain.handle('media:backfill', () => backfillMedia())

  // Sources of the conversation ("Sources" tab of the right panel). The scope is resolved
  // in the main process from the session — the renderer sends only the sessionId and gets
  // the folder back, when there is one, to say that the sources are shared.
  ipcMain.handle('docs:list', (_event, sessionId: string) => listSessionSources(sessionId))
  // Thumbnail per document, and not together with docs:list: the PDF one goes through
  // rasterizing the page, and embedding that in the listing would make the whole tab
  // wait for the slowest file before showing any line.
  ipcMain.handle('docs:thumb', (_event, sessionId: string, docId: string) =>
    sessionDocumentThumb(sessionId, docId),
  )
  ipcMain.handle(
    'docs:add',
    async (
      _event,
      sessionId: string,
      files: { filename: string; data: string }[],
      shared: boolean,
    ) => {
      const errors: string[] = []
      let added = 0
      for (const file of files) {
        const result = await addSessionDocument(
          sessionId,
          file.filename,
          Buffer.from(file.data, 'base64'),
          shared,
        )
        if (result.ok) added += 1
        else errors.push(result.error)
      }
      return { added, errors }
    },
  )
  // Not every source is a file: a pasted snippet and a web page come in through the same
  // path, already as text.
  ipcMain.handle(
    'docs:addText',
    (_event, sessionId: string, title: string, text: string, shared: boolean) =>
      addSessionText(sessionId, title, text, shared),
  )
  ipcMain.handle('docs:addUrl', (_event, sessionId: string, url: string, shared: boolean) =>
    addSessionUrl(sessionId, url, shared),
  )
  // Dragging from one area to the other in the tab: a conversation attachment becomes a folder
  // source and vice versa. The id changes along (docN ↔ srcN), because it is the prefix that
  // says in which scope the file lives.
  ipcMain.handle('docs:setShared', (_event, sessionId: string, docId: string, shared: boolean) =>
    setSessionDocumentShared(sessionId, docId, shared),
  )
  // The whole document as text: the panel SCROLLS, unlike the model
  // reading, which is paginated because each page costs context.
  ipcMain.handle('docs:text', (_event, sessionId: string, docId: string) =>
    viewText(sessionId, docId),
  )
  // Pages rendered with the snippet highlighted: Chromium's native
  // viewer is closed, so highlighting inside the PDF requires drawing the page.
  ipcMain.handle(
    'docs:render',
    (
      _event,
      sessionId: string,
      docId: string,
      from: number,
      count: number,
      options?: { scale?: number; includeText?: boolean; includeOutline?: boolean },
    ) => viewRender(sessionId, docId, from, count, options ?? {}),
  )
  ipcMain.handle('docs:print', (_event, sessionId: string, docId: string) =>
    viewPrint(sessionId, docId),
  )
  // The .docx as a document: the panel does not draw Word, so the file arrives
  // converted to HTML — with headings, tables and images, and nothing active.
  ipcMain.handle('docs:html', (_event, sessionId: string, docId: string) =>
    viewHtml(sessionId, docId),
  )
  ipcMain.handle('docs:export', (_event, sessionId: string, docId: string) =>
    viewExport(sessionId, docId),
  )
  ipcMain.handle('docs:remove', (_event, sessionId: string, docId: string) =>
    removeSessionDocument(sessionId, docId),
  )
  // Cleanup: the chat and the folder are deleted by the renderer, which is the one that knows the
  // cascade — what is left here is deleting what that scope kept on disk.
  // New chat: the session is only born on the first message, so what was
  // attached before that lives in a draft scope and is adopted here.
  // The folder the new chat will inherit: without it the draft opened by the "+" of
  // a folder would show the shared area empty.
  ipcMain.handle('docs:setDraftFolder', (_event, folderId: string | null) =>
    setDraftFolder(folderId),
  )
  ipcMain.handle('docs:adoptDraft', async (_event, sessionId: string) => {
    // The materials (photo, GIF, audio, video) brought in the draft come along.
    const [docs] = await Promise.all([adoptDraftDocuments(sessionId), adoptDraftMaterials(sessionId)])
    return docs
  })

  // Materials of the Sources tab: photo, GIF, audio and video. The file is an item of the
  // media gallery; the tab only lists it in the right scope (conversation or folder).
  ipcMain.handle('materials:list', (_event, scope: string) => listSessionMaterials(scope))
  ipcMain.handle('materials:add', async (_event, scope: string, files: MaterialInput[], shared: boolean) => {
    const errors: string[] = []
    let added = 0
    for (const file of files) {
      const result = await addSessionMaterial(scope, file, shared)
      if (result.ok) added += 1
      else errors.push(result.error)
    }
    return { added, errors }
  })
  ipcMain.handle('materials:setShared', (_event, scope: string, id: string, shared: boolean) =>
    setMaterialShared(scope, id, shared),
  )
  ipcMain.handle('docs:clearSession', (_event, sessionId: string) =>
    deleteSessionDocuments(sessionId),
  )
  ipcMain.handle('docs:clearFolder', (_event, folderId: string) => deleteFolderDocuments(folderId))

  // HTML artifacts: the renderer never reads the file directly (it is served by
  // orbit-artifact://) — it only needs the content to export.
  ipcMain.handle('artifact:read', async (_event, id: string) => {
    const artifact = await readArtifact(id)
    return artifact ? artifact.html : null
  })
  // Documents: export the rendering (PDF/DOCX) out of Orbit.
  // The canvas needs the REVISION together with the text: it is what it hands back on
  // save, so a write by the agent in between can be detected.
  ipcMain.handle('document:source', async (_event, id: string) => {
    const found = await readDocumentSource(id)
    return found ? { markdown: found.markdown, revision: found.entry.revision ?? 1 } : null
  })
  // User edit in the panel canvas. Only the source and the preview are
  // rewritten: PDF/DOCX are rebuilt on the next download.
  ipcMain.handle(
    'document:saveSource',
    (_event, id: string, markdown: string, baseRevision?: number) =>
      saveDocumentEdit(id, markdown, baseRevision),
  )
  // Which tab the document opens in: a requested file goes to the viewer,
  // a live document goes to the canvas.
  ipcMain.handle('document:info', (_event, id: string) => documentInfo(id))
  // Promote the source of the conversation: the agent output becomes reading material
  // for it. It is an explicit act of the user, never automatic.
  ipcMain.handle('document:useAsSource', (_event, sessionId: string, id: string) =>
    useDocumentAsSource(sessionId, id),
  )
  // The button needs to know the CURRENT state: the source may have been removed in the
  // Sources tab after being promoted, and then promoting again is the right thing.
  ipcMain.handle('document:isSource', (_event, sessionId: string, id: string) =>
    isDocumentSource(sessionId, id),
  )
  // The way back: clicking the promoted source has to open the document,
  // and not the file viewer — it is the same text, in the place where it
  // is edited.
  ipcMain.handle('document:forSource', (_event, sourceId: string) =>
    documentForSource(sourceId),
  )
  // The document is born only in Markdown: the PDF/DOCX is rendered HERE, on the
  // first download, and is cached for the next ones.
  ipcMain.handle('document:export', async (_event, id: string, format: DocumentDownload) => {
    const entry = await getMediaEntry(id)
    // The .md is not rendered: it IS the document, and it comes out as it is on disk.
    const source =
      format === 'md' ? (entry?.path ?? null) : await ensureDocumentRender(id, format)
    if (!source) {
      return { ok: false as const, error: `Could not generate the ${format.toUpperCase()} for this document.` }
    }
    const target = await saveExport(null, {
      fileName: documentFileName(entry?.name ?? 'document', format),
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    })
    if (!target) return { ok: false as const, canceled: true as const }
    await fs.copyFile(source, target)
    return { ok: true as const, path: target }
  })

  /**
   * Bytes of an image, whatever the form the renderer knows it by.
   *
   * There are three, and the UI should not have to know the difference: the
   * orbit-media:// URL of the gallery images, the raw id, and the data URL of an attachment
   * that has not gone anywhere yet. The last case is what allows copying
   * and saving the image the user has just dragged into the chat.
   */
  const bytesOfImageRef = async (
    ref: string,
  ): Promise<{ buffer: Buffer; contentType: string; ext?: string } | null> => {
    const dataUrl = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(ref)
    if (dataUrl) {
      return { buffer: Buffer.from(dataUrl[2], 'base64'), contentType: dataUrl[1] }
    }
    const id = mediaIdFromUrl(ref)
    return id ? readMedia(id) : null
  }

  /**
   * Extension from the content type.
   *
   * It is not just taking what comes after the slash: `image/svg+xml` would become
   * ".svg+xml", a file the system does not open. The map covers what the
   * gallery accepts and the rest falls back to png, which is the default output format.
   */
  const extensionOf = (contentType: string): string =>
    ({
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/svg+xml': 'svg',
    })[contentType] ?? 'png'

  /**
   * Save the image to disk, through the system dialog.
   *
   * The renderer does not write files: the image lives in Orbit's storage and comes out
   * here, the same way as the artifact and the document. Accepts the
   * orbit-media:// URL or the raw id — and also a data URL, which is how an
   * image that has not gone to the gallery yet arrives.
   */
  /** Save a chat audio (attached or generated) through the system dialog. */
  ipcMain.handle('audio:export', async (_event, ref: string, suggestedName?: string) => {
    const id = audioIdFrom(String(ref ?? ''))
    const audio = id ? await readAudio(id) : null
    if (!id || !audio) return { ok: false as const, error: 'audio not found' }
    const ext = id.split('.').pop() ?? 'wav'
    const base = (suggestedName || audio.name || 'audio').replace(/\.[a-z0-9]+$/i, '').slice(0, 60)
    const target = await saveExport(null, {
      fileName: `${base}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    })
    if (!target) return { ok: false as const, canceled: true as const }
    await fs.writeFile(target, audio.buffer)
    return { ok: true as const, path: target }
  })

  ipcMain.handle('media:export', async (_event, ref: string, suggestedName?: string) => {
    const bytes = await bytesOfImageRef(ref)
    if (!bytes) return { ok: false as const, error: 'Image not found' }
    const ext = bytes.ext || extensionOf(bytes.contentType)
    // Without a suggested name the file comes out with the MEDIA name in the collection — the id of the
    // item is the file name in the gallery. "imagem.png" did not say which
    // image it was after being downloaded.
    const fromRef = ref.startsWith('orbit-media://') ? decodeURIComponent(ref.slice('orbit-media://'.length)) : ''
    const base = (suggestedName || path.parse(fromRef).name || 'imagem').slice(0, 60)
    const target = await saveExport(null, {
      fileName: base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    })
    if (!target) return { ok: false as const, canceled: true as const }
    await fs.writeFile(target, bytes.buffer)
    return { ok: true as const, path: target }
  })

  /**
   * Copy the image to the clipboard.
   *
   * It goes through the main process because the Electron clipboard writes the image in the
   * platform's native format — and that is what makes Ctrl+V paste the IMAGE in Word,
   * in Paint or in a chat, instead of a file path.
   *
   * The PNG is converted to a bitmap first: the clipboard accepts the PNG blob,
   * but several Windows apps only read the bitmap format, and pasting "nothing"
   * would be worse than not having the button.
   */
  ipcMain.handle('media:copy', async (_event, ref: string) => {
    const bytes = await bytesOfImageRef(ref)
    if (!bytes) return { ok: false as const, error: 'Image not found' }
    // nativeImage does not read SVG: copying the raw vector would paste nothing. sharp
    // rasterizes it at a size useful for pasting into another app — the vector file
    // stays whole in the gallery and comes out through the save button.
    const raw =
      bytes.contentType === 'image/svg+xml'
        ? await sharp(bytes.buffer).resize({ width: 1024, withoutEnlargement: false }).png().toBuffer()
        : bytes.buffer
    const image = nativeImage.createFromBuffer(raw)
    if (image.isEmpty()) return { ok: false as const, error: 'Unsupported image format' }
    await clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) }),
    ])
    return { ok: true as const }
  })

  ipcMain.handle('artifact:export', async (_event, id: string) => {
    const artifact = await readArtifact(id)
    if (!artifact) return { ok: false as const, error: 'Artifact not found' }
    const suggested = `${(artifact.entry.name || 'artefato').slice(0, 60)}.html`
    const target = await saveExport(null, {
      fileName: suggested,
      filters: [{ name: 'HTML', extensions: ['html'] }],
    })
    if (!target) return { ok: false as const, canceled: true as const }
    await fs.writeFile(target, artifact.html, 'utf8')
    return { ok: true as const, path: target }
  })

  /**
   * Download a Mermaid diagram shown in the chat. It is the same drawing that comes out in the
   * documents (renderDiagrams): vector SVG, 2x PNG or the `.mmd` code.
   * It lives in the main process because the PNG needs the hidden window with a DOM that PDF/DOCX
   * already use — and because the save dialog belongs here.
   */
  ipcMain.handle('diagram:export', async (_event, source: string, format: 'svg' | 'png' | 'mmd') => {
    const code = String(source ?? '').trim()
    if (!code || !['svg', 'png', 'mmd'].includes(format)) return { ok: false as const, error: 'invalid' }
    let data: Buffer | string = code
    if (format !== 'mmd') {
      const lookup = await renderDiagrams([{ type: 'code', lang: 'mermaid', lines: code.split('\n') }])
      const diagram = lookup(code)
      if (!diagram) return { ok: false as const, error: 'render' }
      data = format === 'svg' ? diagram.svg : diagram.png
    }
    const target = await saveExport(null, {
      fileName: `diagram.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    })
    if (!target) return { ok: false as const, canceled: true as const }
    await fs.writeFile(target, data)
    return { ok: true as const, path: target }
  })

  // Brain memory — the UI talks to the service; mutations come back via memory:event
  ipcMain.handle('memory:list', () => memoryService.list())
  ipcMain.handle('memory:get', (_event, id: string) => memoryService.getFull(id))
  // Manual creation (file drop on the memory graph)
  ipcMain.handle('memory:create', (_event, input: memoryService.SaveMemoryInput) =>
    memoryService.save(input))
  ipcMain.handle('memory:update', (_event, id: string, patch: Partial<Pick<Memory, 'text' | 'tags' | 'weight' | 'proposed'>>) =>
    memoryService.update(id, patch),
  )
  ipcMain.handle('memory:delete', (_event, id: string) => memoryService.remove(id))
  ipcMain.handle('memory:promote', (_event, id: string) => memoryService.promote(id))
  ipcMain.handle('memory:link', (_event, sourceId: string, targetId: string) =>
    memoryService.link(sourceId, targetId),
  )
  memoryService.memoryEvents.on('event', (event: MemoryEvent) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('memory:event', event)
    }
  })
  setupMemoryScheduler()
  // Text index of past conversations (search + chat_search): built in the background once the
  // window has had its first paint, so it never competes with the boot.
  setTimeout(startSessionIndex, 3000).unref()

  // General settings: the renderer pushes on every change (see app-settings).
  ipcMain.on('settings:sync', (_event, raw: unknown) => void setAppSettings(raw))

  // Overlay (⇧⌘space): the bottom panel. The shortcut is global (it works with
  // Orbit behind), and the panel renderer opens/closes through the same path as
  // Preferences and the menu.
  // The panel renderer reports that it has mounted: only from then on can an `overlay:open`
  // arrive without getting lost.
  ipcMain.on('overlay:ready', () => markOverlayReady())
  ipcMain.handle('overlay:toggle', () => toggleOverlay())
  ipcMain.handle('overlay:open', (_event, call?: boolean) => openOverlay({ call }))
  ipcMain.handle('overlay:close', () => hideOverlay())
  ipcMain.handle('overlay:resize', (_event, height: number) => resizeOverlay(height))
  ipcMain.handle('overlay:status', () => overlayShortcutStatus())
  ipcMain.handle('overlay:settings', () => getAppSettings().overlay)
  // "Copy" of the panel: navigator.clipboard depends on a gesture/permission of the
  // page; the main process writes directly.
  ipcMain.handle('clipboard:write', (_event, text: string) => clipboard.writeText(String(text ?? '')))

  // What depends on the SYSTEM reacts to the preference, instead of being read at boot:
  // the tray exists while "close to tray" is on, and the
  // auto start is registered/removed at the moment the person decides.
  onAppSettingsChange((next, prev) => {
    if (next.closeToTray !== prev.closeToTray) void syncTray()
    if (next.launchAtLogin !== prev.launchAtLogin) void applyLaunchAtLogin(next.launchAtLogin)
    // A change made IN THE MAIN PROCESS — today the agent's `set_user_name` tool — has to
    // go back to the renderer, which is the source of truth: without this the Preference
    // would show the old name and the next `settings:sync` would erase what the
    // agent wrote. The renderer discards the echo of what it sent itself.
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('settings:changed', next)
    }
  })

  // App theme → NATIVE appearance (tray menus, system dialogs) and
  // to the OTHER windows. The renderer decides the theme; here it is only mirrored.
  //
  // The forwarding exists because each window is its own page: the overlay one is
  // pre-warmed at boot and lives the whole session, so without this notice it
  // would keep the theme class from the moment it was born — changing the theme in
  // Preferences left the panel white in the middle of a dark app (and the persona
  // white on top of it). Whoever changed it does not get the echo: it has already applied it.
  ipcMain.on('theme:sync', (event, theme: unknown) => {
    const next = theme === 'light' || theme === 'dark' ? theme : 'system'
    nativeTheme.themeSource = next
    if (hasTray()) void syncTray()
    for (const other of BrowserWindow.getAllWindows()) {
      if (other.isDestroyed() || other.webContents.id === event.sender.id) continue
      other.webContents.send('theme:apply', next)
    }
  })

  ipcMain.handle('browser:clear-data', () => clearBrowserData())
  // Link the renderer had nowhere to open (no conversation open).
  ipcMain.on('link:open-external', (_event, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) void shell.openExternal(url)
  })

  // Skills: list, create, and the watcher of the global folder notifies the renderer
  ipcMain.handle('skills:list', (_event, directory?: string) => loadSkills(directory))
  ipcMain.handle('skills:create', async (_event, { name, description, content, slug, oldSlug }) => {
    const safeSlug = slug ? sanitizeSlug(slug) : sanitizeSlug(name)
    if (!safeSlug) return { error: 'Invalid slug — use only lowercase letters, numbers and underscores' }
    const dir = globalSkillsDir()
    await fs.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, `${safeSlug}.skill`)
    // If the slug changed on edit, removes the old file
    if (oldSlug && oldSlug !== safeSlug) {
      const oldPath = path.join(dir, `${oldSlug}.skill`)
      await fs.unlink(oldPath).catch(() => {})
    }
    await fs.writeFile(
      filePath,
      serializeSkill({ name, description: description ?? '', slug: safeSlug, content }),
      'utf8',
    )
    return { filePath }
  })
  ipcMain.handle('skills:remove', async (_event, slug: string) => {
    const dir = globalSkillsDir()
    const safe = sanitizeSlug(slug)
    if (!safe) return
    // A skill can be a flat file (.skill/.md) or a bundle (folder with scripts)
    await fs.unlink(path.join(dir, `${safe}.skill`)).catch(() => {})
    await fs.unlink(path.join(dir, `${safe}.md`)).catch(() => {})
    await fs.rm(path.join(dir, safe), { recursive: true, force: true }).catch(() => {})
  })

  // Imports a skill via dialog: .skill/.md text (+ extras = bundle) OR a zipped
  // .skill from Claude (SKILL.md + scripts extracted as a bundle)
  ipcMain.handle('skills:import', async () => {
    if (!win) return { imported: false }
    const result = await dialog.showOpenDialog(win, {
      title: 'Import skill',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Skill (.skill, .md)', extensions: ['skill', 'md'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled) return { imported: false }
    const outcome = await importSkillSelection(result.filePaths)
    if (outcome.imported) notifySkillsChanged()
    return outcome
  })

  // Agent proposals (tool create_skill): staging until the card is approved
  ipcMain.handle('skills:pending', () => listPendingSkills())
  ipcMain.handle('skills:approve', async (_event, slug: string) => {
    const ok = await approvePendingSkill(slug)
    notifySkillsChanged()
    return ok
  })
  ipcMain.handle('skills:discard', async (_event, slug: string) => {
    await discardPendingSkill(slug)
    notifySkillsChanged()
  })
  setupSkillsWatcher(() => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('skills:changed')
    }
  })

  // Export/Import of data
  ipcMain.handle('export:data', async (_event, includeAuth: boolean, localStorage: Record<string, string>) => {
    if (!win) return { cancelled: true }
    const dir = dataDir()
    const zip = new JSZip()

    // Manifest
    zip.file('manifest.json', JSON.stringify({ version: 1, exportedAt: new Date().toISOString() }, null, 2))

    // Storage keys
    const storageKeys = await listKeys('')
    for (const key of storageKeys) {
      const data = await readJson<unknown>(key)
      if (data !== null) zip.file(`storage/${key}.json`, JSON.stringify(data, null, 2))
    }

    // Auth (API keys — optional)
    if (includeAuth) {
      const authPath = path.join(dir, 'auth.json')
      try {
        const authData = await fs.readFile(authPath, 'utf8')
        zip.file('auth.json', authData)
      } catch { /* auth.json may not exist */ }
    }

    // MCP config
    const mcpPath = path.join(dir, 'mcp-config.json')
    try {
      const mcpData = await fs.readFile(mcpPath, 'utf8')
      zip.file('mcp-config.json', mcpData)
    } catch { /* mcp-config may not exist */ }

    // Skills
    const skillsDir = globalSkillsDir()
    try {
      const skills = await fs.readdir(skillsDir)
      for (const file of skills) {
        const fullPath = path.join(skillsDir, file)
        const stat = await fs.stat(fullPath)
        if (stat.isDirectory()) continue // ignore skill bundles
        zip.file(`skills/${file}`, await fs.readFile(fullPath, 'utf8'))
      }
    } catch { /* skills dir may not exist */ }

    // Media
    const mediaDir = path.join(dir, 'media')
    try {
      const mediaFiles = await fs.readdir(mediaDir)
      for (const file of mediaFiles) {
        const fullPath = path.join(mediaDir, file)
        const buffer = await fs.readFile(fullPath)
        zip.file(`media/${file}`, buffer)
      }
    } catch { /* media dir may not exist */ }

    // UI state (localStorage) sent from renderer
    if (Object.keys(localStorage).length > 0) {
      zip.file('localStorage.json', JSON.stringify(localStorage, null, 2))
    }

    const buffer = await zip.generateAsync({ type: 'nodebuffer' })

    const target = await saveExport(win, {
      title: 'Export Orbit data',
      fileName: `orbit-backup-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: 'ZIP file', extensions: ['zip'] }],
    })
    if (!target) return { cancelled: true }
    await fs.writeFile(target, buffer)
    return { cancelled: false, filePath: target }
  })

  ipcMain.handle('import:data', async () => {
    if (!win) return { cancelled: true, error: 'No window' }
    const result = await dialog.showOpenDialog(win, {
      title: 'Import Orbit data',
      properties: ['openFile'],
      filters: [{ name: 'ZIP file', extensions: ['zip'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return { cancelled: true }

    const zipPath = result.filePaths[0]
    const buffer = await fs.readFile(zipPath)
    const zip = await JSZip.loadAsync(buffer)

    // Validate manifest — we require at least one file in storage/
    const hasStorage = Object.keys(zip.files).some((f) => f.startsWith('storage/'))
    if (!hasStorage) return { cancelled: true, error: 'Invalid ZIP file: no storage data found.' }

    const dir = dataDir()

    // Write all files back
    for (const [relativePath, file] of Object.entries(zip.files)) {
      if (file.dir) continue
      if (relativePath === 'auth.json') continue // auth only restored via export opt-in
      const targetPath = path.join(dir, relativePath)
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      const content = await file.async('nodebuffer')
      await fs.writeFile(targetPath, content)
    }

    // Collect localStorage from the zip (if present)
    const localState: Record<string, string> = {}
    const lsFile = zip.files['localStorage.json']
    if (lsFile && !lsFile.dir) {
      const parsed = JSON.parse(await lsFile.async('text'))
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') localState[k] = v
        }
      }
    }

    return { cancelled: false, localStorage: localState }
  })

  // Analytics: usage summary
  ipcMain.handle('analytics:summary', (_event, range: AnalyticsRange) => computeAnalytics(range))

  // MCP: config + status + reconnection (the tools come in via buildToolSet)
  ipcMain.handle('mcp:config', () => readMcpConfig())
  ipcMain.handle('mcp:status', () => listMcpStatus())
  ipcMain.handle('mcp:save', (_event, config) => saveMcpConfig(config))
  ipcMain.handle('mcp:reconnect', (_event, name?: string) => reconnectMcp(name))
  ipcMain.handle('mcp:optimize', (_event, name: string) => optimizeMcpServer(name))
  ipcMain.handle('mcp:descriptions', (_event, name: string) => mcpDescriptionsState(name))
  // OAuth authorization: opens the browser for the login and completes the flow
  ipcMain.handle('mcp:auth', (_event, name: string) => authorizeMcp(name))
  // at the loopback redirect_uri — the user has to register it in the provider's OAuth app
  ipcMain.handle('mcp:oauth-redirect', () => oauthRedirectUrl())
  // Nodara: official integration — registers the MCP server and keeps the token up to date
  ipcMain.handle('nodara:discover', () => discoverNodara())
  ipcMain.handle('nodara:connect', () => connectNodara())
  ipcMain.handle('nodara:disconnect', () => disconnectNodara())
  // Fracta: official integration (beta) — same flow, from Fracta's mcp.json
  ipcMain.handle('fracta:discover', () => discoverFracta())
  ipcMain.handle('fracta:connect', () => connectFracta())
  ipcMain.handle('fracta:disconnect', () => disconnectFracta())
  void initMcp().then(() => {
    watchNodaraBridge()
    watchFractaSettings()
  })
  void loadTrustRules()
  void loadApprovalLearning()

  // Permission rules (Preferences → Rules): the permanent ones the user allowed
  // ("Always") and the ones only being counted, which can be promoted from there
  // instead of waiting for the next request to show the dropdown.
  ipcMain.handle('permissions:rules', () => ({
    trusted: listTrustRules(),
    learned: listLearnedRules(),
  }))
  ipcMain.handle('permissions:rules:add', async (_event, ruleId: string, label?: string) => {
    if (typeof ruleId !== 'string' || !ruleId) return
    await addTrust(ruleId, label)
    // Settled from the screen: the counter belongs to what is still being asked.
    await forgetApprovals(ruleId)
  })
  ipcMain.handle('permissions:rules:remove', (_event, ruleId: string) =>
    typeof ruleId === 'string' && ruleId ? removeTrust(ruleId) : undefined,
  )

  // Shell hooks (Tools → Hooks): what the user writes on the screen is active right
  // away; what an agent writes already went through its permission card.
  void loadHooks()
  onHooksChanged(() => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('hooks:changed')
    }
  })
  ipcMain.handle('hooks:list', () => listHooks())
  ipcMain.handle('hooks:add', (_event, input: HookInput) => addHook(input, 'user'))
  ipcMain.handle('hooks:update', (_event, id: string, input: HookInput) => updateHook(id, input))
  ipcMain.handle('hooks:toggle', (_event, id: string, enabled: boolean) => setHookEnabled(id, enabled === true))
  ipcMain.handle('hooks:remove', async (_event, id: string) => {
    await removeHook(id)
  })

  // Background processes
  ipcMain.handle('process:list', (_event, sessionId?: string) => listProcesses(sessionId))
  ipcMain.handle('process:kill', (_event, pid: number, sessionId?: string) => killProcess(pid, sessionId))
  ipcMain.handle('process:output', (_event, pid: number, sessionId?: string) => getProcessOutput(pid, sessionId))

  // Computer Use: Stop (chip, Preferences or ⌘⇧.) aborts the whole turn —
  // the abort kills the bridge in progress and clears the approvals of the conversation.
  setComputerStopHandler((sessionId) => abortSession(sessionId))
  // Floating panels (conversation + actions) while Orbit is out of focus:
  // same preload and same bundle as the app windows, their own entry.
  setupComputerPanels({
    preload: path.join(__dirname, 'preload.mjs'),
    load: (panels, query) => {
      if (VITE_DEV_SERVER_URL) {
        const url = new URL('computer-panels.html', VITE_DEV_SERVER_URL.endsWith('/') ? VITE_DEV_SERVER_URL : `${VITE_DEV_SERVER_URL}/`)
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
        void panels.loadURL(url.toString())
      } else {
        void panels.loadFile(path.join(RENDERER_DIST, 'computer-panels.html'), { query })
      }
    },
  })
  ipcMain.handle('computer:status', () => computerStatus())
  ipcMain.handle('computer:test', () => testComputer())
  ipcMain.handle('computer:activity', () => getComputerActivity())
  ipcMain.handle('computer:shot', (_event, sessionId: string) => shotView(sessionId))
  ipcMain.handle('computer:focus-app', (_event, sessionId: string) => focusShotApp(sessionId))
  // Answer typed in the Computer Use floating panel: it enters the queue of the
  // conversation with the options of its last send. The queue lives in the renderer of the
  // main window (it is the one that sends when the session becomes free) — the same
  // path as the messages that arrive from the phone.
  ipcMain.handle('computer:reply', (_event, sessionId: string, text: string) => {
    const last = lastSendInput(sessionId)
    const body = typeof text === 'string' ? text.trim() : ''
    if (!last || !body) return false
    const msg: QueuedMessage = {
      id: `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text: body,
      options: { ...last.options, voiceCall: undefined },
      mode: last.mode,
      sessionId,
      directory: last.directory,
      extraDirectories: last.extraDirectories,
      createdAt: Date.now(),
    }
    for (const target of BrowserWindow.getAllWindows()) {
      if (!target.isDestroyed()) target.webContents.send('companion:queue-op', { op: 'enqueue', sessionId, msg })
    }
    return true
  })
  ipcMain.handle('computer:stop', (_event, sessionId?: string) => stopComputer(sessionId))
  ipcMain.handle('computer:request-accessibility', () => requestAccessibility())
  ipcMain.handle('computer:request-screen', () => requestScreenRecording())
  ipcMain.handle('computer:open-pane', (_event, pane: 'accessibility' | 'screen') =>
    shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${pane === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility'}`,
    ),
  )

  app.on('before-quit', (event) => {
    // Resident by design: on macOS closing the window is not the app leaving —
    // routines fire with no window at all, and ⌘Q or the Dock taking the process
    // down would take the scheduler with it. A real exit is asked for explicitly
    // (`quitApp`: the menu item and the tray) or by the system, which warns here
    // through `powerMonitor` on the way out.
    if (process.platform === 'darwin' && !quitting) {
      event.preventDefault()
      if (win && !win.isDestroyed()) win.close()
      return
    }
    // The real exit starts here: from here on the window `close` can no longer
    // be converted into hiding.
    quitting = true
    // Restores the accessibility flags turned on in the apps and releases the global
    // shortcuts (⇧⌘space of the overlay and the panic one of Computer Use).
    globalShortcut.unregisterAll()
    disposeOverlay()
    void disposeComputerUse()
    destroyTray()
    killAllProcesses()
    stopWatchingNodaraBridge()
    stopWatchingFractaSettings()
    // Pipeline mode runs outside any session: without this, a phase in flight
    // would keep writing to the repository while the app shuts down.
    pipeline.abortAll()
    routines.stopScheduler()
    stopLintWorkers()
  })

  // Logout or restart: the system is asking. Marking the exit here is what lets
  // the `before-quit` above go through instead of holding the shutdown.
  powerMonitor.on('shutdown', () => {
    quitting = true
  })

  // Pre-registered local providers (Ollama, LM Studio)
  void ensureCustomProvidersSeeded()

  // Companion Server (WebSocket for remote control from the phone)
  const companion = startCompanionServer()
  ipcMain.handle('companion:status', () => getCompanionStatus())
  ipcMain.handle('companion:pin', () => companion.pin)
  ipcMain.handle('companion:setPairingMode', (_event, active: boolean) => setPairingMode(!!active))

  // Companion preferences (renderer ↔ HTTP server sync)
  ipcMain.handle('companion:getPreferences', () => readStorageJson('companion/preferences'))
  ipcMain.handle('companion:setPreferences', (_event, prefs: Record<string, unknown>) =>
    writeJson('companion/preferences', prefs))

  // Custom providers (locais / user-defined)
  ipcMain.handle('custom-providers:list', () => listCustomProviders())
  ipcMain.handle('custom-providers:add', (_event, input: CustomProviderInput) =>
    addCustomProvider(input))
  ipcMain.handle('custom-providers:remove', (_event, id: string) => removeCustomProvider(id))
  ipcMain.handle('custom-providers:update', (_event, id: string, patch: CustomProviderPatch) =>
    updateCustomProvider(id, patch))
  ipcMain.handle('custom-providers:detect', () => detectLocal())
  // Discovery without writing: the dialog shows the models and only persists on save.
  // With `providerId`, reuses the key already saved in the provider.
  ipcMain.handle('custom-providers:discover', (_event, opts: DiscoverOptions) =>
    opts.providerId ? discoverProviderModels(opts.providerId, opts) : discoverModels(opts))
  // Discovery + write to the provider ("fetch models" button of the card).
  ipcMain.handle('custom-providers:refresh', (_event, id: string) =>
    refreshProviderModels(id))

  // Cold start via "Open with Orbit": the folder arrives in argv and stays pending
  // until the renderer mounts (the window is still loading here).
  void findFolderArg(process.argv).then((dir) => {
    if (dir) queueOpenFolder(dir)
  })

  // The entrance sound is started on did-finish-load, before the window is
  // shown and before the persona wake-up timer.

  // Keeps the Explorer context menu always pointing to the current exe
  // (the path changes on every install/update).
  if (app.isPackaged) void registerOpenWith()

  // Auto-update via GitHub (ignored on MAS/Windows Store/linux-deb)
  setupAutoUpdater({
    onBeforeInstallQuit: () => {
      quitting = true
    },
  })

  // The on-disk copy of the settings is worth before the renderer pushes its
  // own: "cookies until quit" clears here, before any browser tab
  // opens — clearing on close would depend on the app quitting cleanly.
  void loadAppSettings().then(async (settings) => {
    if (settings.browser.cookies === 'until-quit') await clearBrowserData().catch(() => {})
    setupAutoArchive()
    // Tray and auto start are worth before any renderer mounts —
    // that is the case of the app started at system login, with nobody asking anything.
    void syncTray()
    if (settings.launchAtLogin) await applyLaunchAtLogin(true)
    // Dictation through Whisper: its server comes up together with the app.
    syncWhisperServer(settings)
    // Overlay shortcut and the pre-warmed window: only after the preferences,
    // because that is where the switch is.
    syncOverlayShortcut()
    prewarmOverlay()
  })

  // Camera, microphone, location etc. of the built-in browser sites:
  // asks the user per site (before, Electron approved everything silently).
  setupBrowserPermissions(BROWSER_PARTITION)

  // Overlay (⇧⌘space): the window is born hidden — the shortcut cannot pay for the
  // renderer loading the first time. It is a page of its own (like the
  // Computer Use panels) so as not to drag the main window synchronizers along.
  setupOverlay({
    preload: path.join(__dirname, 'preload.mjs'),
    load: (target) => {
      if (VITE_DEV_SERVER_URL) void target.loadURL(`${VITE_DEV_SERVER_URL}/overlay.html`)
      else void target.loadFile(path.join(RENDERER_DIST, 'overlay.html'))
    },
  })
  // Opacity/persona changing in Preferences with the panel open, and the
  // shortcut following the switch.
  watchOverlaySettings()

  // A plan left "running" by a crash is settled BEFORE the window: the renderer
  // reads the plan as soon as it opens a conversation, and a stale one would come
  // back as "in progress" with nothing running (see recoverInterruptedPlans).
  recoverInterruptedPlans()
    .catch(() => 0)
    .finally(() => createWindow())
})

/** Clears cookies, logins, localStorage, cache and permissions of the built-in browser. */
async function clearBrowserData(): Promise<void> {
  const browser = session.fromPartition(BROWSER_PARTITION)
  await browser.clearStorageData()
  await browser.clearCache()
  await clearBrowserPermissions()
}
