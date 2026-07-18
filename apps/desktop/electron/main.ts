import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import type * as NodePty from 'node-pty'
import { listCredentialProviders, removeCredential, setCredential } from './lib/auth'
import { getCatalog, ensureCustomProvidersSeeded } from './lib/catalog'
import { addCustomProvider, listCustomProviders, removeCustomProvider, updateCustomProvider } from './lib/custom-providers'
import { detectLocal } from './lib/detect-local'
import { killAll as killAllProcesses, listProcesses, killProcess } from './lib/process-manager'
import { getModelsSnapshot, invalidateModelsSnapshot } from './lib/models'
import { revert as revertSession, unrevert as unrevertSession } from './lib/session/revert'
import { getInitStatus, runProjectInit, type RunInitInput } from './lib/project-init'
import { abortChat, runChat } from './lib/chat-engine'
import { reply as askReply, rejectSession as rejectSessionAsks } from './lib/ask-broker'
import { abortOrchestration, approvePlan, rejectPlan, runOrchestration } from './lib/orchestrator'
import { initMcp, listMcpStatus, readMcpConfig, reconnectMcp, saveMcpConfig } from './lib/mcp'
import { savePlanFile, deletePlanFile, readPlanFile } from './lib/plan-file'
import { registerMediaProtocol } from './lib/media'
import { startCompanionServer, getCompanionStatus, setPairingMode } from './lib/companion-server'
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
import { destroyBrowserWindow } from './lib/tools'
import type { ChatMessage, SendMessageInput, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
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

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'logo.png'),
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#00000000',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      webviewTag: true,
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

function createTerminal(id: string, cols = 80, rows = 24) {
  const isWin = process.platform === 'win32'
  const shellCmd = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')

  const ptyProcess = nodePty.spawn(shellCmd, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME || process.env.USERPROFILE || '/',
    env: process.env as Record<string, string>,
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

    const commits: CommitEntry[] = metaOut
      .split(RECORD_SEP)
      .map(rec => rec.replace(/^\n+/, '').trim())
      .filter(Boolean)
      .map(rec => {
        const [hash, author, date, subject, body = ''] = rec.split(FIELD_SEP)
        return { hash, author, date, message: subject, body: body.trim(), files: filesByHash.get(hash) ?? [] }
      })

    return { ok: true, commits }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
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

  ipcMain.handle('terminal:create', (_event, id: string, cols?: number, rows?: number) => {
    const proc = createTerminal(id, cols, rows)
    terminals.set(id, proc)
    return { pid: proc.pid }
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

  // Storage genérico (sessões, mensagens, pastas) — padrão opencode
  ipcMain.handle('storage:read', (_event, key: string) => readJson(key))
  ipcMain.handle('storage:write', (_event, key: string, value: unknown) => writeJson(key, value))
  ipcMain.handle('storage:remove', (_event, key: string) => removeJson(key))
  ipcMain.handle('storage:list', (_event, prefix: string) => listKeys(prefix))

  /**
   * Busca textual entre todas as sessões (título + mensagens).
   * Retorna hits planos ordenados por recência da sessão.
   */
  ipcMain.handle('search:sessions', async (_event, query: string) => {
    if (!query?.trim()) return []
    const q = query.toLowerCase().trim()

    const keys = await listKeys('session/')
    const all: SessionInfo[] = (
      await Promise.all(keys.map((k) => readJson<SessionInfo>(k)))
    ).filter((s): s is SessionInfo => s !== null)
    all.sort((a, b) => b.updatedAt - a.updatedAt)

    type Hit = { sessionId: string; sessionTitle: string; mode: string; updatedAt: number; snippet: string }

    const results: Hit[] = []

    for (const info of all.slice(0, 40)) {
      const hits: string[] = []

      // Título
      if (info.title.toLowerCase().includes(q)) {
        hits.push(info.title)
      }

      // Mensagens (só carrega se título não já casou)
      if (hits.length < 5) {
        const msgsKey = StorageKeys.messages(info.id)
        const msgs = (await readJson<ChatMessage[]>(msgsKey)) ?? []
        for (const msg of msgs) {
          for (const part of msg.parts) {
            if (part.type === 'text' && part.text.toLowerCase().includes(q)) {
              const idx = part.text.toLowerCase().indexOf(q)
              const start = Math.max(0, idx - 40)
              const end = Math.min(part.text.length, idx + q.length + 40)
              let snippet = part.text.slice(start, end)
              if (start > 0) snippet = '…' + snippet
              if (end < part.text.length) snippet += '…'
              hits.push(snippet)
              if (hits.length >= 5) break
            }
          }
          if (hits.length >= 5) break
        }
      }

      for (const snippet of hits.slice(0, 5)) {
        results.push({
          sessionId: info.id,
          sessionTitle: info.title,
          mode: info.mode,
          updatedAt: info.updatedAt,
          snippet,
        })
      }

      if (results.length >= 50) break
    }

    return results
  })

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
    // Regra de ouro: workers não orquestram nem delegam (sem recursão)
    const session = await readJson<SessionInfo>(StorageKeys.session(input.sessionId))
    if (session?.orchestration?.role === 'worker') {
      input = { ...input, options: { ...input.options, orchestrate: undefined, subagents: false } }
    }
    if (input.options.orchestrate) void runOrchestration(win, input)
    else void runChat(win, input)
  })
  ipcMain.handle('chat:abort', (_event, sessionId: string) => {
    abortChat(sessionId)
    abortOrchestration(sessionId)
    rejectSessionAsks(sessionId)
  })
  ipcMain.handle('chat:askReply', (_event, requestId: string, value: unknown) => askReply(requestId, value))
  ipcMain.handle('chat:approvePlan', (_event, sessionId: string, planId: string, taskIds?: string[]) => {
    if (win) void approvePlan(win, sessionId, planId, taskIds)
  })
  ipcMain.handle('chat:rejectPlan', (_event, sessionId: string) => {
    if (win) void rejectPlan(win, sessionId)
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
  ipcMain.on('panel:register', (_event, id: number | null) => registerPanelWebContents(id))

  // Imagens das respostas do assistente (orbit-media://)
  registerMediaProtocol()

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

  // Processos em background
  ipcMain.handle('process:list', () => listProcesses())
  ipcMain.handle('process:kill', (_event, pid: number) => killProcess(pid))

  app.on('before-quit', () => killAllProcesses())

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

  createWindow()
})
