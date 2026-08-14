import { app, BrowserWindow, ipcMain, dialog, shell, Menu, type MenuItemConstructorOptions } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import { chmodSync } from 'node:fs'
import path from 'node:path'
import type * as NodePty from 'node-pty'
import { listCredentialProviders, removeCredential, setCredential } from './lib/auth'
import { getCatalog, ensureCustomProvidersSeeded } from './lib/catalog'
import { addCustomProvider, listCustomProviders, removeCustomProvider, updateCustomProvider } from './lib/custom-providers'
import { detectLocal } from './lib/detect-local'
import { killAll as killAllProcesses, listProcesses, killProcess, getProcessOutput } from './lib/process-manager'
import { getModelsSnapshot, invalidateModelsSnapshot } from './lib/models'
import { revert as revertSession, unrevert as unrevertSession } from './lib/session/revert'
import { getInitStatus, runProjectInit, type RunInitInput } from './lib/project-init'
import { abortChat, compactSession, getRunningSessionIds, runChat } from './lib/chat-engine'
import { runChatWithLoop, abortLoop, getLoopRunningSessionIds } from './lib/loop-engine'
import { reply as askReply, rejectSession as rejectSessionAsks } from './lib/ask-broker'
import { abortOrchestration, approvePlan, getOrchestrationRunningSessionIds, rejectPlan, runOrchestration } from './lib/orchestrator'
import { initMcp, listMcpStatus, readMcpConfig, reconnectMcp, saveMcpConfig } from './lib/mcp'
import { loadTrustRules } from './lib/permission/trust-rules'
import { clearSessionTrust } from './lib/permission'
import { savePlanFile, deletePlanFile, readPlanFile } from './lib/plan-file'
import {
  backfillMedia,
  cleanupScriptMedia,
  deleteManyMedia,
  listMedia,
  mediaDiskUsage,
  registerMediaProtocol,
} from './lib/media'
import { startCompanionServer, getCompanionStatus, setPairingMode, forwardChatEvent, broadcastSessionModels } from './lib/companion-server'
import { setSessionModelsCache } from './lib/companion-http'
import { readJson as readStorageJson } from './lib/storage'
import { registerPanelWebContents } from './lib/panel-browser'
import { setupMemoryScheduler } from './lib/memory/scheduler'
import * as memoryService from './lib/memory/service'
import { globalSkillsDir, loadSkills, notifySkillsChanged, setupSkillsWatcher } from './lib/skills'
import { importSkillSelection } from './lib/skills/import'
import { sanitizeSlug, serializeSkill } from './lib/skills/parser'
import { computeAnalytics } from './lib/analytics'
import { approvePendingSkill, discardPendingSkill, listPendingSkills } from './lib/skills/pending'
import { dataDir, listKeys, readJson, removeJson, writeJson } from './lib/storage'
import { loginShellArgs, userShellEnv } from './lib/shell-env'
import { searchSessions } from './lib/search-sessions'
import { destroyBrowserWindow } from './lib/tools'
import type { SendMessageInput, SessionInfo } from '@shared/chat'
import type { ChatEvent } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import * as esteira from './lib/esteira'
import type { MediaFilter } from '@shared/media'
import type { FaseTemplate, NovaTaskInput } from '@shared/esteira'
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

let win: BrowserWindow | null

// ─── "Abrir com Orbit" (menu de contexto do Explorer) ───────────────────────
// Registra em HKCU (sem admin) as entradas que fazem o botão direito em uma
// pasta oferecer "Abrir com Orbit". Ao clicar, o Windows lança o app com o
// caminho da pasta em argv — o single-instance reencaminha para o renderer.
const OPEN_WITH_COMMAND = "OpenWithOrbit"
const OPEN_WITH_KEYS = [
  `Software\\Classes\\Directory\\shell\\${OPEN_WITH_COMMAND}`,
  `Software\\Classes\\Directory\\Background\\shell\\${OPEN_WITH_COMMAND}`,
]

function openWithLabel(): string {
  return app.getLocale().toLowerCase().startsWith("pt") ? "Abrir com Orbit" : "Open with Orbit"
}

async function registerOpenWith(): Promise<{ ok: boolean; error?: string }> {
  // Só na versão instalada: em dev o execPath é o electron.exe e o comando
  // registrado não abriria o app (faltaria o argumento do diretório do app).
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

// ─── Single instance + abertura de pasta via argv ───────────────────────────
// O lock precisa ser pedido antes do ready; a instância secundária repassa o
// argv (caminho da pasta) para a primária via evento.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

let pendingOpenFolder: string | null = null

async function findFolderArg(argv: string[]): Promise<string | null> {
  for (const raw of argv) {
    if (!raw || raw === "." || raw === ".." || raw.startsWith("-")) continue
    if (!path.isAbsolute(raw)) continue
    // Em dev o vite-plugin-electron lança o electron com o diretório do app:
    // isso não é uma abertura de pasta e não deve disparar o fluxo.
    if (!app.isPackaged && path.resolve(raw) === path.resolve(process.env.APP_ROOT ?? "")) continue
    try {
      const stat = await fs.stat(raw)
      if (stat.isDirectory()) return path.resolve(raw)
    } catch {
      // não é um caminho válido — ignora
    }
  }
  return null
}

/** Encaminha uma pasta ao renderer; se a janela ainda está carregando, deixa
 *  pendente para o renderer buscar via app:consumePendingOpen na montagem. */
function queueOpenFolder(directory: string) {
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
    win.show()
    win.focus()
    win.webContents.send("app:open-folder", directory)
    return
  }
  pendingOpenFolder = directory
}

app.on("second-instance", (_event, argv) => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  void findFolderArg(argv).then((dir) => {
    if (dir) queueOpenFolder(dir)
  })
})

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'logo.png'),
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#00000000',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 10 } as const }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      webviewTag: true,
      // O agente roda no processo main, mas as ferramentas de browser e a
      // sincronização do renderer não podem ser congeladas quando a janela
      // perde foco ou fica em segundo plano.
      backgroundThrottling: false,
    },
  })

  // Frame customizado: some o menu nativo (Alt ainda o invocaria em win/linux)
  win.setMenuBarVisibility(false)

  win.on('maximize', () => win?.webContents.send('window:maximized-change', true))
  win.on('unmaximize', () => win?.webContents.send('window:maximized-change', false))

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  // Links de fontes/citações abrem no browser do sistema, não em nova janela
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// Menu nativo do macOS: no Mac a barra de menus fica no topo da tela, então as
// ações do hamburger (que o renderer esconde nesse SO) migram para cá, com
// atalhos nativos (Cmd+N, Cmd+Shift+N, Cmd+O, Cmd+,). Em win/linux nada muda:
// o menu bar continua escondido e o hamburger segue no app.
function createAppMenu() {
  if (process.platform !== 'darwin') return
  const send = (action: string) => win?.webContents.send('menu:action', action)
  const openFolder = async () => {
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return
    win?.webContents.send('app:open-folder', result.filePaths[0])
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Orbit',
      submenu: [
        { role: 'about', label: 'Sobre o Orbit' },
        { type: 'separator' },
        { label: 'Preferências…', accelerator: 'Cmd+,', click: () => send('settings') },
        { type: 'separator' },
        { role: 'services', label: 'Serviços' },
        { type: 'separator' },
        { role: 'hide', label: 'Esconder o Orbit' },
        { role: 'hideOthers', label: 'Esconder Outros' },
        { role: 'unhide', label: 'Mostrar Tudo' },
        { type: 'separator' },
        { role: 'quit', label: 'Sair do Orbit' },
      ],
    },
    {
      label: 'Arquivo',
      submenu: [
        { label: 'Novo Chat', accelerator: 'Cmd+N', click: () => send('new-chat') },
        { label: 'Nova Sessão de Código', accelerator: 'Cmd+Shift+N', click: () => send('new-code') },
        { label: 'Abrir Pasta…', accelerator: 'Cmd+O', click: openFolder },
        { type: 'separator' },
        { role: 'close', label: 'Fechar Janela' },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer' },
        { role: 'redo', label: 'Refazer' },
        { type: 'separator' },
        { role: 'cut', label: 'Recortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Colar' },
        { role: 'selectAll', label: 'Selecionar Tudo' },
      ],
    },
    {
      label: 'Exibir',
      submenu: [
        { label: 'Chats', click: () => send('view-chats') },
        { label: 'Memórias', click: () => send('view-memories') },
        { label: 'Modelos', click: () => send('view-models') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tela Cheia' },
        { role: 'reload', label: 'Recarregar' },
        { role: 'toggleDevTools', label: 'Ferramentas do Desenvolvedor' },
      ],
    },
    {
      label: 'Janela',
      submenu: [
        { role: 'minimize', label: 'Minimizar' },
        { role: 'zoom', label: 'Zoom' },
      ],
    },
    {
      label: 'Ajuda',
      submenu: [{ label: 'Como funciona', click: () => send('how-to') }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

const terminals = new Map<string, NodePty.IPty>()

/**
 * O node-pty@1.1.0 publica o `spawn-helper` (macOS) sem o bit de execução no
 * tarball; sem +x o posix_spawn falha com EACCES e o terminal nunca abre.
 * Ajusta o modo do binário do prebuild atual (idempotente). No app empacotado
 * o binário vive em app.asar.unpacked, então repetimos o dance do node-pty.
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
    console.warn('[terminal] não foi possível ajustar permissões do spawn-helper:', (err as Error).message)
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

const IGNORED_DIR_NAMES = new Set(['node_modules', '.git'])

interface DirEntryInfo {
  name: string
  path: string
  isDirectory: boolean
}

async function listDirectory(dirPath: string): Promise<DirEntryInfo[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const result: DirEntryInfo[] = entries
    .filter(e => !(e.name.startsWith('.') || IGNORED_DIR_NAMES.has(e.name)))
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

async function readTextFile(filePath: string): Promise<{ content: string } | { error: string }> {
  try {
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_FILE_SIZE) {
      return { error: `Arquivo muito grande (${(stat.size / 1024 / 1024).toFixed(1)}MB)` }
    }
    const buffer = await fs.readFile(filePath)
    if (buffer.subarray(0, 8000).includes(0)) {
      return { error: 'Arquivo binário' }
    }
    return { content: buffer.toString('utf8') }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

async function listFilesRecursive(dirPath: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const results: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_DIR_NAMES.has(entry.name)) continue
    const fullPath = path.join(dirPath, entry.name)
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      results.push(...await listFilesRecursive(fullPath, relPath))
    } else {
      results.push(relPath)
    }
  }
  return results
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

interface CommitFileEntry {
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  path: string
}

interface CommitEntry {
  hash: string
  author: string
  date: string
  message: string
  body: string
  files: CommitFileEntry[]
  /** Refs (branches locais/remotas e tags) que apontam exatamente para este commit. */
  refs: string[]
  /** Commit é ancestral da branch principal (main/master). */
  onDefault: boolean
  /** Commit é alcançável a partir do upstream da branch atual (já está no remoto). */
  pushed: boolean
}

const STATUS_MAP: Record<string, CommitFileEntry['status']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
}

const FIELD_SEP = '\x1f'
const RECORD_SEP = '\x1e'

async function getGitLog(repoPath: string): Promise<{ ok: true; commits: CommitEntry[] } | { ok: false; error: string }> {
  try {
    const [{ stdout: metaOut }, { stdout: filesOut }] = await Promise.all([
      execFileAsync(
        'git',
        ['log', '-n', '30', `--pretty=format:%H${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`],
        { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
      ),
      execFileAsync(
        'git',
        ['log', '-n', '30', '--name-status', '--pretty=format:COMMIT|%H'],
        { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
      ),
    ])

    const filesByHash = new Map<string, CommitFileEntry[]>()
    let currentHash: string | null = null
    for (const rawLine of filesOut.split('\n')) {
      const line = rawLine.trimEnd()
      if (!line) continue
      const commitMatch = line.match(/^COMMIT\|([0-9a-f]+)$/)
      if (commitMatch) {
        currentHash = commitMatch[1]
        filesByHash.set(currentHash, [])
        continue
      }
      const fileMatch = line.match(/^([AMDR])\d*\t(.+)$/)
      if (fileMatch && currentHash) {
        const parts = fileMatch[2].split('\t')
        filesByHash.get(currentHash)!.push({ status: STATUS_MAP[fileMatch[1]] ?? 'modified', path: parts[parts.length - 1] })
      }
    }

    // ── Contexto de branches para badges/regiões no log ────────────────
    // Mapa hash -> refs completas (refs/heads, refs/remotes, refs/tags)
    const refsByHash = new Map<string, string[]>()
    try {
      const { stdout: refsOut } = await execFileAsync(
        'git',
        ['for-each-ref', '--format=%(refname)%1F%(objectname)%1F%(*objectname)', 'refs/heads', 'refs/remotes', 'refs/tags'],
        { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
      )
      for (const line of refsOut.split('\n')) {
        const parts = line.split('\x1f')
        if (parts.length < 2 || !parts[0]) continue
        const ref = parts[0]
        // Tags anotadas: %(objectname) é o objeto da tag; %(*objectname) é o
        // commit alvo (peeled). Para branches/remotes/lightweight tags o
        // peeled vem vazio e usamos o objectname direto.
        const hash = (parts[2] || parts[1]).trim()
        if (!hash) continue
        const arr = refsByHash.get(hash) ?? []
        arr.push(ref)
        refsByHash.set(hash, arr)
      }
    } catch {
      // repo sem refs
    }

    let currentBranch: string | null = null
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoPath })
      currentBranch = stdout.trim() || null
    } catch {
      // detached/erro
    }

    // Branch principal: origin/HEAD -> fallback main/master local
    let defaultBranch: string | null = null
    try {
      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoPath })
      defaultBranch = stdout.trim().replace(/^origin\//, '') || null
    } catch {
      for (const candidate of ['main', 'master']) {
        try {
          await execFileAsync('git', ['rev-parse', '--verify', '--quiet', candidate], { cwd: repoPath })
          defaultBranch = candidate
          break
        } catch {
          // candidato não existe
        }
      }
    }

    // Upstream da branch atual (ex.: origin/feature)
    let upstream: string | null = null
    if (currentBranch) {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
          { cwd: repoPath },
        )
        upstream = stdout.trim() || null
      } catch {
        // sem upstream ainda
      }
    }

    // Conjuntos de hashes alcançáveis (limite 60 cobre o log de 30)
    const pushedSet = new Set<string>()
    if (upstream) {
      try {
        const { stdout } = await execFileAsync('git', ['rev-list', '-n', '60', upstream], { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 })
        for (const h of stdout.split('\n')) pushedSet.add(h.trim())
      } catch {
        // upstream inválido
      }
    }
    const defaultSet = new Set<string>()
    if (defaultBranch) {
      try {
        const { stdout } = await execFileAsync('git', ['rev-list', '-n', '60', defaultBranch], { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 })
        for (const h of stdout.split('\n')) defaultSet.add(h.trim())
      } catch {
        // branch principal inválida
      }
    }

    const commits: CommitEntry[] = metaOut
      .split(RECORD_SEP)
      .map(rec => rec.replace(/^\n+/, '').trim())
      .filter(Boolean)
      .map(rec => {
        const [hash, author, date, subject, body = ''] = rec.split(FIELD_SEP)
        return {
          hash,
          author,
          date,
          message: subject,
          body: body.trim(),
          files: filesByHash.get(hash) ?? [],
          refs: refsByHash.get(hash) ?? [],
          onDefault: defaultSet.has(hash),
          pushed: pushedSet.has(hash),
        }
      })

    return { ok: true, commits }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Executa git com prompt de terminal desabilitado (falha rápido em vez de
 *  travar pedindo credencial) e sem abrir editor de merge. */
function runGit(repoPath: string, args: string[], timeout = 120_000) {
  return execFileAsync('git', args, {
    cwd: repoPath,
    maxBuffer: 10 * 1024 * 1024,
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
  })
}

function gitError(err: unknown): { message: string; kind: 'auth' | 'noUpstream' | 'noRemote' | 'other' } {
  const e = err as { message?: string; stderr?: string }
  const message = (e.stderr?.trim() || e.message || String(err)).replace(/\s+/g, ' ').trim()
  const lower = message.toLowerCase()
  if (/authentication failed|could not read username|could not read password|permission denied|publickey|401|403/.test(lower)) {
    return { message, kind: 'auth' }
  }
  if (/no tracking information|no upstream/i.test(lower)) {
    return { message, kind: 'noUpstream' }
  }
  return { message, kind: 'other' }
}

interface BranchSyncInfo {
  current: string | null
  defaultBranch: string | null
  ahead: number
  behind: number
  upstream: string | null
  hasRemote: boolean
  dirty: boolean
}

/** Indicador estilo VS Code: branch atual vs branch principal (main/master),
 *  à frente/atrás, upstream, sujo (mudanças não commitadas). */
async function getBranchInfo(repoPath: string): Promise<BranchSyncInfo> {
  const info: BranchSyncInfo = {
    current: null,
    defaultBranch: null,
    ahead: 0,
    behind: 0,
    upstream: null,
    hasRemote: false,
    dirty: false,
  }
  try {
    const [{ stdout: branchOut }, { stdout: remoteOut }, { stdout: statusOut }] = await Promise.all([
      runGit(repoPath, ['branch', '--show-current'], 15_000),
      runGit(repoPath, ['remote'], 15_000),
      runGit(repoPath, ['status', '--porcelain'], 15_000),
    ])
    info.current = branchOut.trim() || null
    info.hasRemote = remoteOut.trim().length > 0
    info.dirty = statusOut.trim().length > 0

    // Branch principal: origin/HEAD (remote) -> fallback para main/master local
    try {
      const { stdout: headOut } = await runGit(
        repoPath,
        ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        15_000,
      )
      info.defaultBranch = headOut.trim().replace(/^origin\//, '') || null
    } catch {
      for (const candidate of ['main', 'master']) {
        try {
          await runGit(repoPath, ['rev-parse', '--verify', '--quiet', candidate], 15_000)
          info.defaultBranch = candidate
          break
        } catch {
          // candidato não existe
        }
      }
    }

    if (info.current) {
      try {
        const { stdout: upOut } = await runGit(
          repoPath,
          ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
          15_000,
        )
        info.upstream = upOut.trim() || null
      } catch {
        // sem upstream
      }
      if (info.defaultBranch && info.defaultBranch !== info.current) {
        try {
          const { stdout } = await runGit(
            repoPath,
            ['rev-list', '--left-right', '--count', `${info.defaultBranch}...HEAD`],
            15_000,
          )
          const [left, right] = stdout.trim().split(/\s+/).map(Number)
          info.behind = left || 0
          info.ahead = right || 0
        } catch {
          // branch principal sem ref local ou repo sem commits
        }
      }
    }
  } catch {
    // repo inválido/inacessível — devolve o mínimo
  }
  return info
}

async function getFileAtCommit(
  repoPath: string,
  hash: string,
  relPath: string,
  deleted: boolean,
): Promise<{ content: string } | { error: string }> {
  try {
    const ref = deleted ? `${hash}^:${relPath}` : `${hash}:${relPath}`
    const { stdout } = await execFileAsync('git', ['show', ref], {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    })
    return { content: stdout }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

app.whenReady().then(() => {
  // Instância secundária: o lock não foi obtido e o app já está saindo.
  if (!gotSingleInstanceLock) return

  createAppMenu()

  // Controles da titlebar customizada (frame: false em win/linux)
  ipcMain.handle('window:minimize', () => win?.minimize())
  ipcMain.handle('window:maximize', () => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window:close', () => win?.close())
  ipcMain.handle('window:isMaximized', () => win?.isMaximized() ?? false)
  ipcMain.handle('window:toggleFullscreen', () => win?.setFullScreen(!win.isFullScreen()))

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
      console.error('[terminal] falha ao criar PTY:', (err as Error).message)
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

  ipcMain.handle('fs:listFilesRecursive', async (_event, dirPath: string) => {
    try {
      const files = await listFilesRecursive(dirPath)
      return { ok: true, files }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Stat de caminho (ex.: validar pasta solta por drag & drop)
  ipcMain.handle('fs:stat', async (_event, filePath: string) => {
    try {
      const stat = await fs.stat(filePath)
      return { ok: true, isDirectory: stat.isDirectory(), isFile: stat.isFile(), size: stat.size }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Integração "Abrir com Orbit" no menu de contexto do Explorer
  ipcMain.handle('openwith:status', () => getOpenWithStatus())
  ipcMain.handle('openwith:register', () => registerOpenWith())
  ipcMain.handle('openwith:unregister', () => unregisterOpenWith())

  // Pasta pendente (app iniciado via "Abrir com Orbit"): o renderer busca na
  // montagem para não perder o evento enviado antes do React subir.
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
        return { error: `Arquivo muito grande (${(stat.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_FILE_SIZE_MB}MB)` }
      }
      const buffer = await fs.readFile(filePath)
      const ext = path.extname(filePath).toLowerCase()
      const mime = MIME_MAP[ext] ?? 'application/octet-stream'
      return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}` }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('shell:showItemInFolder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('git:log', async (_event, repoPath: string) => {
    return getGitLog(repoPath)
  })

  ipcMain.handle('git:showFile', async (_event, repoPath: string, hash: string, relPath: string, deleted: boolean) => {
    return getFileAtCommit(repoPath, hash, relPath, deleted)
  })

  ipcMain.handle('git:branches', async (_event, repoPath: string) => {
    try {
      const [{ stdout: list }, { stdout: current }] = await Promise.all([
        execFileAsync('git', ['branch', '--list', '--format=%(refname:short)'], { cwd: repoPath }),
        execFileAsync('git', ['branch', '--show-current'], { cwd: repoPath }),
      ])
      const branches = list.trim().split('\n').filter(Boolean)
      return { ok: true as const, branches, current: current.trim() }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('git:checkout', async (_event, repoPath: string, branch: string) => {
    try {
      await execFileAsync('git', ['checkout', branch], { cwd: repoPath })
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('git:createBranch', async (_event, repoPath: string, branch: string) => {
    try {
      await execFileAsync('git', ['checkout', '-b', branch], { cwd: repoPath })
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('git:commitAll', async (_event, repoPath: string, message: string) => {
    try {
      await execFileAsync('git', ['add', '-A'], { cwd: repoPath })
      await execFileAsync('git', ['commit', '-m', message], { cwd: repoPath })
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('git:branchInfo', async (_event, repoPath: string) => {
    try {
      return { ok: true as const, info: await getBranchInfo(repoPath) }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('git:pull', async (_event, repoPath: string) => {
    try {
      await runGit(repoPath, ['pull', '--no-edit'])
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, ...gitError(err) }
    }
  })

  ipcMain.handle('git:push', async (_event, repoPath: string) => {
    try {
      const { stdout: branchOut } = await runGit(repoPath, ['branch', '--show-current'], 15_000)
      const branch = branchOut.trim()
      if (!branch) {
        return { ok: false as const, message: 'No current branch', kind: 'other' as const }
      }

      let upstream: string | null = null
      try {
        const { stdout: upOut } = await runGit(
          repoPath,
          ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
          15_000,
        )
        upstream = upOut.trim() || null
      } catch {
        // sem upstream ainda
      }

      if (upstream) {
        await runGit(repoPath, ['push'])
        return { ok: true as const, created: false }
      }

      const { stdout: remoteOut } = await runGit(repoPath, ['remote'], 15_000)
      if (!remoteOut.trim()) {
        return { ok: false as const, message: 'No remote configured', kind: 'noRemote' as const }
      }
      // Sem branch remota: cria via -u origin <branch> (autenticado pelas
      // credenciais já configuradas no git — token/SSH; nunca pede no terminal)
      await runGit(repoPath, ['push', '-u', 'origin', branch])
      return { ok: true as const, created: true }
    } catch (err) {
      return { ok: false as const, ...gitError(err) }
    }
  })

  // Storage genérico (sessões, mensagens, pastas) — padrão opencode
  ipcMain.handle('storage:read', (_event, key: string) => readJson(key))
  ipcMain.handle('storage:write', (_event, key: string, value: unknown) => writeJson(key, value))
  ipcMain.handle('storage:remove', (_event, key: string) => removeJson(key))
  ipcMain.handle('storage:list', (_event, prefix: string) => listKeys(prefix))

  /**
   * Busca textual entre todas as sessões (título + mensagens).
   * Retorna hits planos ordenados por recência da sessão.
   */
  ipcMain.handle('search:sessions', (_event, query: string) => searchSessions(query))

  // Catálogo de provedores/modelos (models.dev)
  ipcMain.handle('catalog:get', () => getCatalog())

  // Catálogo unificado da aba Models (OpenRouter + Artificial Analysis)
  ipcMain.handle('models:list', () => getModelsSnapshot())
  ipcMain.handle('models:refresh', () => {
    invalidateModelsSnapshot()
    return getModelsSnapshot(true)
  })

  // Revert per-message (snapshots git do modo código)
  ipcMain.handle('session:revert', (_event, sessionId: string, messageId: string) =>
    revertSession(sessionId, messageId))
  ipcMain.handle('session:unrevert', (_event, sessionId: string) => unrevertSession(sessionId))

  // /init — análise do projeto e geração de memórias por área
  ipcMain.handle('init:run', (_event, input: RunInitInput) => {
    // runProjectInit lança em falha; o erro já sai via init:event — só evita
    // rejection não tratada quando disparado por IPC (sem sessão de chat)
    void runProjectInit(input).catch(() => {})
  })
  ipcMain.handle('init:status', (_event, directory: string) => getInitStatus(directory))

  // Credenciais de provedores (as chaves nunca voltam ao renderer)
  ipcMain.handle('auth:set', (_event, providerId: string, key: string) => setCredential(providerId, key))
  ipcMain.handle('auth:remove', (_event, providerId: string) => removeCredential(providerId))
  ipcMain.handle('auth:list', () => listCredentialProviders())

  // Chat
  ipcMain.handle('chat:send', async (_event, input: SendMessageInput) => {
    if (!win) return
    // Regra de ouro: workers não orquestram (sem recursão infinita).
    // Workers podem usar subagentes (limite de profundidade gerenciado pelo subagent tool).
    const session = await readJson<SessionInfo>(StorageKeys.session(input.sessionId))
    if (session?.orchestration?.role === 'worker') {
      input = { ...input, options: { ...input.options, orchestrate: undefined } }
    }
    // Orquestração é exclusiva do modo code
    if (input.options.orchestrate && input.mode !== 'code') {
      input = { ...input, options: { ...input.options, orchestrate: undefined } }
    }
    // Orquestração: desativa plano (incompatível), ativa loop e subagentes por padrão
    if (input.options.orchestrate) {
      input = {
        ...input,
        options: {
          ...input.options,
          plan: undefined,
          loop: input.options.loop !== false,
          subagents: input.options.subagents !== false,
        },
      }
      void runOrchestration(win, input)
    } else if (input.options.loop) {
      void runChatWithLoop(win, input, input.loopConfig ?? { maxIterations: 3, maxTokensPerIter: 4000, autoReview: true })
    } else {
      void runChat(win, input)
    }
  })
  ipcMain.handle('chat:abort', (_event, sessionId: string) => {
    abortChat(sessionId)
    abortLoop(sessionId)
    abortOrchestration(sessionId)
    rejectSessionAsks(sessionId)
    clearSessionTrust(sessionId)
  })
  // Sessões ainda rodando no main (engine vive aqui) — o renderer consulta
  // após um reload para re-exibir spinner/botão de parar imediatamente.
  ipcMain.handle('chat:running', () => [
    ...getRunningSessionIds(),
    ...getLoopRunningSessionIds(),
    ...getOrchestrationRunningSessionIds(),
  ])
  ipcMain.handle('chat:askReply', (_event, requestId: string, value: unknown) => askReply(requestId, value))
  ipcMain.handle('chat:approvePlan', (_event, sessionId: string, planId: string, taskIds?: string[]) => {
    if (win) void approvePlan(win, sessionId, planId, taskIds)
  })
  ipcMain.handle('chat:rejectPlan', (_event, sessionId: string) => {
    if (win) void rejectPlan(win, sessionId)
  })
  ipcMain.handle('chat:compact', (_event, sessionId: string) => {
    if (win) void compactSession(win, sessionId)
  })
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

  // Browser do painel direito: o renderer registra o webContents do <webview>
  // por sessão de chat (panel:register) — cada chat tem seu próprio browser.
  ipcMain.on('panel:register', (_event, sessionId: string | null, id: number | null) =>
    registerPanelWebContents(sessionId, id),
  )

  // Eventos de sessão/pasta emitidos pelo renderer (novo chat, renomear, pin,
  // arquivar, mover, deletar...). O remetente já aplicou a mudança no store
  // local — aqui o evento segue para as OUTRAS janelas e para os companions
  // (mobile), mantendo a sincronização em tempo real nos dois sentidos.
  ipcMain.on('chat:event:emit', (event, chatEvent: ChatEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents.id !== event.sender.id) {
        win.webContents.send('chat:event', chatEvent)
      }
    }
    forwardChatEvent(chatEvent)
  })

  // Modelos por sessão: o renderer empurra o mapa (seleção em qualquer chat)
  // e o main mantém o cache HTTP (GET /api/session-models, usado pelo mobile
  // no connect) + repassa aos companions em tempo real ('session:model-change').
  ipcMain.on('companion:session-models', (_event, overrides: Record<string, { providerId: string; modelId: string }>) => {
    setSessionModelsCache(overrides)
    broadcastSessionModels(overrides)
  })

  // Imagens das respostas do assistente (orbit-media://)
  registerMediaProtocol()

  // Modo esteira: board de projetos/esteiras/tasks e o engine de execução.
  // As mutações voltam ao renderer por 'esteira:event' (o engine emite).
  ipcMain.handle('esteira:carregar', () => esteira.carregarTudo())
  ipcMain.handle('esteira:templates', () => esteira.listarTemplates())
  ipcMain.handle('esteira:salvarTemplate', (_e, template: FaseTemplate) => esteira.salvarTemplate(template))
  ipcMain.handle('esteira:removerTemplate', (_e, id: string) => esteira.removerTemplate(id))
  ipcMain.handle('esteira:criarProjeto', (_e, nome: string, pastas: string[]) =>
    esteira.criarProjeto(nome, pastas),
  )
  ipcMain.handle('esteira:atualizarProjeto', (_e, id: string, patch: Record<string, unknown>) =>
    esteira.atualizarProjeto(id, patch),
  )
  ipcMain.handle('esteira:removerProjeto', (_e, id: string) => esteira.removerProjeto(id))
  ipcMain.handle('esteira:criar', (_e, input: esteira.NovaEsteiraInput) => esteira.criarEsteira(input))
  ipcMain.handle('esteira:atualizar', (_e, id: string, patch: Record<string, unknown>) =>
    esteira.atualizarEsteira(id, patch),
  )
  ipcMain.handle('esteira:remover', (_e, id: string) => esteira.removerEsteira(id))
  ipcMain.handle('esteira:criarTask', (_e, input: NovaTaskInput) => esteira.criarTask(input))
  ipcMain.handle('esteira:atualizarTask', (_e, esteiraId: string, taskId: string, patch: Record<string, unknown>) =>
    esteira.atualizarTaskCampos(esteiraId, taskId, patch),
  )
  ipcMain.handle('esteira:removerTask', (_e, esteiraId: string, taskId: string) =>
    esteira.removerTask(esteiraId, taskId),
  )
  ipcMain.handle('esteira:iniciarTask', (_e, esteiraId: string, taskId: string, fase?: number) =>
    esteira.iniciarTask(esteiraId, taskId, fase ?? 0),
  )
  ipcMain.handle('esteira:pausarTask', (_e, esteiraId: string, taskId: string) =>
    esteira.pausarTask(esteiraId, taskId),
  )
  ipcMain.handle('esteira:retomarTask', (_e, esteiraId: string, taskId: string) =>
    esteira.retomarTask(esteiraId, taskId),
  )
  ipcMain.handle('esteira:ligarFila', (_e, esteiraId: string, ligar: boolean) => {
    if (ligar) esteira.ligarFila(esteiraId)
    else esteira.desligarFila(esteiraId)
    return esteira.filaLigada(esteiraId)
  })
  ipcMain.handle('esteira:relatorio', (_e, esteiraId: string) => esteira.relatorio(esteiraId))

  // Galeria de mídia (aba "Mídia" do painel direito)
  ipcMain.handle('media:list', (_event, filter?: MediaFilter) => listMedia(filter))
  ipcMain.handle('media:usage', () => mediaDiskUsage())
  ipcMain.handle('media:delete', (_event, ids: string[]) => deleteManyMedia(ids))
  ipcMain.handle('media:cleanupScripts', () => cleanupScriptMedia())
  // Indexa imagens anteriores ao registry (roda na primeira abertura da galeria)
  ipcMain.handle('media:backfill', () => backfillMedia())

  // Memória Brain — a UI fala com o service; mutações chegam de volta via memory:event
  ipcMain.handle('memory:list', () => memoryService.list())
  ipcMain.handle('memory:get', (_event, id: string) => memoryService.getFull(id))
  // Criação manual (drop de arquivo no grafo de memórias)
  ipcMain.handle('memory:create', (_event, input: memoryService.SaveMemoryInput) =>
    memoryService.save(input))
  ipcMain.handle('memory:update', (_event, id: string, patch: Partial<Pick<Memory, 'text' | 'tags' | 'weight'>>) =>
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

  // Skills: lista, cria, watcher da pasta global avisa o renderer
  ipcMain.handle('skills:list', (_event, directory?: string) => loadSkills(directory))
  ipcMain.handle('skills:create', async (_event, { name, description, content, slug, oldSlug }) => {
    const safeSlug = slug ? sanitizeSlug(slug) : sanitizeSlug(name)
    if (!safeSlug) return { error: 'Slug inválido — use apenas letras minúsculas, números e underscores' }
    const dir = globalSkillsDir()
    await fs.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, `${safeSlug}.skill`)
    // Se o slug mudou na edição, remove o arquivo antigo
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
    // Skill pode ser arquivo plano (.skill/.md) ou bundle (pasta com scripts)
    await fs.unlink(path.join(dir, `${safe}.skill`)).catch(() => {})
    await fs.unlink(path.join(dir, `${safe}.md`)).catch(() => {})
    await fs.rm(path.join(dir, safe), { recursive: true, force: true }).catch(() => {})
  })

  // Importa skill via dialog: .skill/.md texto (+ extras = bundle) OU .skill
  // zipado do Claude (SKILL.md + scripts extraídos como bundle)
  ipcMain.handle('skills:import', async () => {
    if (!win) return { imported: false }
    const result = await dialog.showOpenDialog(win, {
      title: 'Importar skill',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Skill (.skill, .md)', extensions: ['skill', 'md'] },
        { name: 'Todos os arquivos', extensions: ['*'] },
      ],
    })
    if (result.canceled) return { imported: false }
    const outcome = await importSkillSelection(result.filePaths)
    if (outcome.imported) notifySkillsChanged()
    return outcome
  })

  // Propostas do agente (tool create_skill): staging até o card ser aprovado
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

  // Export/Import de dados
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

    // Auth (chaves de API — opcional)
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

    const result = await dialog.showSaveDialog(win, {
      title: 'Exportar dados do Orbit',
      defaultPath: `orbit-backup-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: 'Arquivo ZIP', extensions: ['zip'] }],
    })
    if (result.canceled || !result.filePath) return { cancelled: true }
    await fs.writeFile(result.filePath, buffer)
    return { cancelled: false, filePath: result.filePath }
  })

  ipcMain.handle('import:data', async () => {
    if (!win) return { cancelled: true, error: 'No window' }
    const result = await dialog.showOpenDialog(win, {
      title: 'Importar dados do Orbit',
      properties: ['openFile'],
      filters: [{ name: 'Arquivo ZIP', extensions: ['zip'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return { cancelled: true }

    const zipPath = result.filePaths[0]
    const buffer = await fs.readFile(zipPath)
    const zip = await JSZip.loadAsync(buffer)

    // Validate manifest — exigimos ao menos um arquivo storage/
    const hasStorage = Object.keys(zip.files).some((f) => f.startsWith('storage/'))
    if (!hasStorage) return { cancelled: true, error: 'Arquivo ZIP inválido: nenhum dado de storage encontrado.' }

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

  // Analytics: resumo de uso
  ipcMain.handle('analytics:summary', (_event, range: 'total' | '30d' | '7d' | 'today') => computeAnalytics(range))

  // MCP: config + status + reconexão (as tools entram via buildToolSet)
  ipcMain.handle('mcp:config', () => readMcpConfig())
  ipcMain.handle('mcp:status', () => listMcpStatus())
  ipcMain.handle('mcp:save', (_event, config) => saveMcpConfig(config))
  ipcMain.handle('mcp:reconnect', (_event, name?: string) => reconnectMcp(name))
  void initMcp()
  void loadTrustRules()

  // Processos em background
  ipcMain.handle('process:list', (_event, sessionId?: string) => listProcesses(sessionId))
  ipcMain.handle('process:kill', (_event, pid: number, sessionId?: string) => killProcess(pid, sessionId))
  ipcMain.handle('process:output', (_event, pid: number, sessionId?: string) => getProcessOutput(pid, sessionId))

  app.on('before-quit', () => {
    killAllProcesses()
    // Esteira roda fora de qualquer sessão: sem isto, uma fase em execução
    // continuaria escrevendo no repositório com o app fechando.
    esteira.abortarTudo()
  })

  // Provedores locais pré-cadastrados (Ollama, LM Studio)
  void ensureCustomProvidersSeeded()

  // Companion Server (WebSocket para controle remoto via celular)
  const companion = startCompanionServer()
  ipcMain.handle('companion:status', () => getCompanionStatus())
  ipcMain.handle('companion:pin', () => companion.pin)
  ipcMain.handle('companion:setPairingMode', (_event, active: boolean) => setPairingMode(!!active))

  // Companion preferences (sincronização renderer ↔ HTTP server)
  ipcMain.handle('companion:getPreferences', () => readStorageJson('companion/preferences'))
  ipcMain.handle('companion:setPreferences', (_event, prefs: Record<string, unknown>) =>
    writeJson('companion/preferences', prefs))

  // Custom providers (locais / user-defined)
  ipcMain.handle('custom-providers:list', () => listCustomProviders())
  ipcMain.handle('custom-providers:add', (_event, id: string, name: string, baseURL: string, apiKey?: string) =>
    addCustomProvider(id, name, baseURL, apiKey))
  ipcMain.handle('custom-providers:remove', (_event, id: string) => removeCustomProvider(id))
  ipcMain.handle('custom-providers:update', (_event, id: string, patch: { name?: string; baseURL?: string; apiKey?: string }) =>
    updateCustomProvider(id, patch))
  ipcMain.handle('custom-providers:detect', () => detectLocal())

  // Abertura fria via "Abrir com Orbit": a pasta chega em argv e fica pendente
  // até o renderer montar (a janela ainda está carregando aqui).
  void findFolderArg(process.argv).then((dir) => {
    if (dir) queueOpenFolder(dir)
  })

  // Mantém o menu de contexto do Explorer sempre apontando para o exe atual
  // (o caminho muda a cada instalação/atualização).
  if (app.isPackaged) void registerOpenWith()

  createWindow()
})
