import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import type * as NodePty from 'node-pty'
import { listCredentialProviders, removeCredential, setCredential } from './lib/auth'
import { getCatalog } from './lib/catalog'
import { abortChat, runChat } from './lib/chat-engine'
import { reply as askReply, rejectSession as rejectSessionAsks } from './lib/ask-broker'
import { abortOrchestration, approvePlan, rejectPlan, runOrchestration } from './lib/orchestrator'
import { initMcp, listMcpStatus, readMcpConfig, reconnectMcp, saveMcpConfig } from './lib/mcp'
import { registerPanelWebContents } from './lib/panel-browser'
import { setupMemoryScheduler } from './lib/memory/scheduler'
import * as memoryService from './lib/memory/service'
import { globalSkillsDir, loadSkills, notifySkillsChanged, setupSkillsWatcher } from './lib/skills'
import { importSkillSelection } from './lib/skills/import'
import { sanitizeSlug, serializeSkill } from './lib/skills/parser'
import { computeAnalytics } from './lib/analytics'
import { approvePendingSkill, discardPendingSkill, listPendingSkills } from './lib/skills/pending'
import { listKeys, readJson, removeJson, writeJson } from './lib/storage'
import { destroyBrowserWindow } from './lib/tools'
import type { SendMessageInput, SessionInfo } from '../shared/chat'
import { StorageKeys } from '../shared/chat'
import type { Memory, MemoryEvent } from '../shared/memory'

const execFileAsync = promisify(execFile)

const _require = createRequire(import.meta.url)
const nodePty = _require('node-pty') as typeof NodePty

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
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      webviewTag: true,
    },
  })

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

  // Catálogo de provedores/modelos (models.dev)
  ipcMain.handle('catalog:get', () => getCatalog())

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

  // Browser do painel direito: o renderer registra o webContents do <webview>
  ipcMain.on('panel:register', (_event, id: number | null) => registerPanelWebContents(id))

  // Memória Brain — a UI fala com o service; mutações chegam de volta via memory:event
  ipcMain.handle('memory:list', () => memoryService.list())
  ipcMain.handle('memory:get', (_event, id: string) => memoryService.getFull(id))
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

  // Analytics: resumo de uso
  ipcMain.handle('analytics:summary', (_event, range: 'total' | '30d' | '7d' | 'today') => computeAnalytics(range))

  // MCP: config + status + reconexão (as tools entram via buildToolSet)
  ipcMain.handle('mcp:config', () => readMcpConfig())
  ipcMain.handle('mcp:status', () => listMcpStatus())
  ipcMain.handle('mcp:save', (_event, config) => saveMcpConfig(config))
  ipcMain.handle('mcp:reconnect', (_event, name?: string) => reconnectMcp(name))
  void initMcp()

  createWindow()
})
