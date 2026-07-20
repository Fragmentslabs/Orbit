/**
 * Servidor HTTP REST para o Orbit Companion.
 *
 * Roda na porta 3848 (0.0.0.0) e fornece endpoints simples request/response
 * para operações de preferências, modelos e catálogo — complementando o
 * WebSocket (porta 3847) que é usado para streaming e notificações.
 *
 * Segurança:
 * - Autenticação via header `Authorization: Bearer {pin}`
 * - Reutiliza a mesma validação de PIN do companion-server
 * - CORS habilitado para desenvolvimento local
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
import { hostname } from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'
import { readJson, writeJson, listKeys } from './storage'
import { getCatalog } from './catalog'
import { listCredentialProviders } from './auth'
import { globalSkillsDir, loadSkills, notifySkillsChanged } from './skills'
import { importSkillSelection } from './skills/import'
import { sanitizeSlug, serializeSkill } from './skills/parser'
import { approvePendingSkill, discardPendingSkill, listPendingSkills } from './skills/pending'
import { listMcpStatus, readMcpConfig, reconnectMcp, saveMcpConfig } from './mcp'

export const HTTP_PORT = 3848

let httpServer: Server | null = null

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Valida o header Authorization: Bearer {token/pin}.
 * Tenta token persistente primeiro, depois PIN (5 min TTL).
 */
function validateAuth(
  req: IncomingMessage,
  validatePin: (pin: string, ip: string) => boolean,
  validateToken: (token: string) => Promise<boolean>,
): Promise<boolean> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return Promise.resolve(false)

  const credential = authHeader.slice(7).trim()
  if (!credential) return Promise.resolve(false)

  const ip = req.socket.remoteAddress ?? 'unknown'

  // Tenta como token persistente primeiro (64 hex chars)
  if (credential.length === 64 && /^[a-f0-9]+$/i.test(credential)) {
    return validateToken(credential)
  }

  // Fallback: PIN (5 min TTL)
  return Promise.resolve(validatePin(credential, ip))
}

// ─── Response Helpers ─────────────────────────────────────────────────────────

function jsonResponse(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PATCH, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  })
  res.end(JSON.stringify(data))
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(new Error('JSON inválido'))
      }
    })
    req.on('error', reject)
  })
}

// ─── Storage Keys for Companion Preferences ──────────────────────────────────

const PREFS_KEY = 'companion/preferences'
const SELECTED_MODEL_KEY = 'companion/selected-model'

interface CompanionPreferences {
  brain: boolean
  brainContext: boolean
  permissionMode: 'ask' | 'approve' | 'full'
  reasoning: boolean
  reasoningLevel: 'off' | 'low' | 'medium' | 'high'
  simple: boolean
}

interface SelectedModel {
  providerId: string
  modelId: string
}

const DEFAULT_PREFS: CompanionPreferences = {
  brain: true,
  brainContext: true,
  permissionMode: 'ask',
  reasoning: false,
  reasoningLevel: 'medium',
  simple: false,
}

async function getPreferences(): Promise<CompanionPreferences> {
  const stored = await readJson<CompanionPreferences>(PREFS_KEY)
  return { ...DEFAULT_PREFS, ...stored }
}

async function savePreferences(patch: Partial<CompanionPreferences>): Promise<CompanionPreferences> {
  const current = await getPreferences()
  const updated = { ...current, ...patch }
  await writeJson(PREFS_KEY, updated)

  // Sincronizar com o renderer via IPC
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('companion:preferences-changed', updated)
    }
  }

  return updated
}

async function getSelectedModel(): Promise<SelectedModel> {
  const stored = await readJson<SelectedModel>(SELECTED_MODEL_KEY)
  return stored ?? { providerId: 'openai', modelId: 'gpt-4o' }
}

async function saveSelectedModel(model: SelectedModel): Promise<SelectedModel> {
  await writeJson(SELECTED_MODEL_KEY, model)

  // Broadcast para o renderer atualizar
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('companion:model-select', {
        providerId: model.providerId,
        modelId: model.modelId,
      })
    }
  }

  return model
}

// ─── Route Handlers ──────────────────────────────────────────────────────────

async function handleGetPreferences(_req: IncomingMessage, res: ServerResponse) {
  const prefs = await getPreferences()
  jsonResponse(res, 200, prefs)
}

async function handlePatchPreferences(req: IncomingMessage, res: ServerResponse) {
  try {
    const patch = await readBody(req)
    const allowed: Partial<CompanionPreferences> = {}

    // Apenas campos permitidos
    if (typeof patch.brain === 'boolean') allowed.brain = patch.brain
    if (typeof patch.brainContext === 'boolean') allowed.brainContext = patch.brainContext
    if (typeof patch.permissionMode === 'string' && ['ask', 'approve', 'full'].includes(patch.permissionMode)) {
      allowed.permissionMode = patch.permissionMode as CompanionPreferences['permissionMode']
    }
    if (typeof patch.reasoning === 'boolean') allowed.reasoning = patch.reasoning
    if (typeof patch.reasoningLevel === 'string' && ['off', 'low', 'medium', 'high'].includes(patch.reasoningLevel)) {
      allowed.reasoningLevel = patch.reasoningLevel as CompanionPreferences['reasoningLevel']
    }
    if (typeof patch.simple === 'boolean') allowed.simple = patch.simple

    const updated = await savePreferences(allowed)
    jsonResponse(res, 200, updated)
  } catch (err) {
    jsonResponse(res, 400, { error: (err as Error).message })
  }
}

async function handleGetSelectedModel(_req: IncomingMessage, res: ServerResponse) {
  const model = await getSelectedModel()
  jsonResponse(res, 200, model)
}

async function handlePutSelectedModel(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req)

    if (typeof body.providerId !== 'string' || typeof body.modelId !== 'string') {
      jsonResponse(res, 400, { error: 'providerId e modelId são obrigatórios' })
      return
    }

    const model = await saveSelectedModel({
      providerId: body.providerId,
      modelId: body.modelId,
    })
    jsonResponse(res, 200, model)
  } catch (err) {
    jsonResponse(res, 400, { error: (err as Error).message })
  }
}

async function handleGetCatalog(_req: IncomingMessage, res: ServerResponse) {
  const catalog = await getCatalog()
  jsonResponse(res, 200, catalog)
}

async function handleGetConnectedProviders(_req: IncomingMessage, res: ServerResponse) {
  const providers = await listCredentialProviders()
  jsonResponse(res, 200, providers)
}

async function handleGetSkills(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const directory = url.searchParams.get('directory') || undefined
  const skills = await loadSkills(directory)
  jsonResponse(res, 200, skills)
}

async function handleGetMcpStatus(_req: IncomingMessage, res: ServerResponse) {
  const status = listMcpStatus()
  jsonResponse(res, 200, status)
}

async function handleGetStatus(_req: IncomingMessage, res: ServerResponse) {
  const keys = await listKeys('session/')
  const status = {
    online: true,
    activeSessions: keys.length,
    uptime: process.uptime(),
    port: HTTP_PORT,
    version: app.getVersion(),
  }
  jsonResponse(res, 200, status)
}

// ─── Skills Handlers ──────────────────────────────────────────────────────────

async function handleCreateSkill(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req)
    if (typeof body.name !== 'string' || typeof body.content !== 'string') {
      jsonResponse(res, 400, { error: 'name e content são obrigatórios' })
      return
    }
    const safeSlug = slugify(body.slug as string | undefined) ?? sanitizeSlug(body.name)
    if (!safeSlug) {
      jsonResponse(res, 400, { error: 'Slug inválido — use apenas letras minúsculas, números e underscores' })
      return
    }
    const dir = globalSkillsDir()
    await fs.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, `${safeSlug}.skill`)
    if (body.oldSlug && body.oldSlug !== safeSlug) {
      await fs.unlink(path.join(dir, `${body.oldSlug}.skill`)).catch(() => {})
    }
    await fs.writeFile(filePath, serializeSkill({
      name: body.name,
      description: (body.description as string) ?? '',
      slug: safeSlug,
      content: body.content as string,
    }), 'utf8')
    notifySkillsChanged()
    jsonResponse(res, 200, { filePath })
  } catch (err) {
    jsonResponse(res, 400, { error: (err as Error).message })
  }
}

async function handleDeleteSkill(_req: IncomingMessage, res: ServerResponse, slug: string) {
  const safe = sanitizeSlug(slug)
  if (!safe) {
    jsonResponse(res, 400, { error: 'Slug inválido' })
    return
  }
  const dir = globalSkillsDir()
  await fs.unlink(path.join(dir, `${safe}.skill`)).catch(() => {})
  await fs.unlink(path.join(dir, `${safe}.md`)).catch(() => {})
  await fs.rm(path.join(dir, safe), { recursive: true, force: true }).catch(() => {})
  notifySkillsChanged()
  jsonResponse(res, 200, { deleted: true })
}

async function handleImportSkill(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req)
    if (typeof body.content !== 'string' || typeof body.filename !== 'string') {
      jsonResponse(res, 400, { error: 'content (base64) e filename são obrigatórios' })
      return
    }
    const tmpDir = app.getPath('temp')
    const tmpFile = path.join(tmpDir, `orbit-import-${Date.now()}-${body.filename}`)
    const buf = Buffer.from(body.content as string, 'base64')
    await fs.writeFile(tmpFile, buf)
    const outcome = await importSkillSelection([tmpFile])
    await fs.unlink(tmpFile).catch(() => {})
    if (outcome.imported) notifySkillsChanged()
    jsonResponse(res, 200, outcome)
  } catch (err) {
    jsonResponse(res, 400, { error: (err as Error).message })
  }
}

async function handleGetPendingSkills(_req: IncomingMessage, res: ServerResponse) {
  const pending = await listPendingSkills()
  jsonResponse(res, 200, pending)
}

async function handleApproveSkill(_req: IncomingMessage, res: ServerResponse, slug: string) {
  const ok = await approvePendingSkill(slug)
  if (ok) notifySkillsChanged()
  jsonResponse(res, 200, { approved: ok })
}

async function handleDiscardSkill(_req: IncomingMessage, res: ServerResponse, slug: string) {
  await discardPendingSkill(slug)
  notifySkillsChanged()
  jsonResponse(res, 200, { discarded: true })
}

// ─── MCP Handlers ─────────────────────────────────────────────────────────────

async function handleGetMcpConfig(_req: IncomingMessage, res: ServerResponse) {
  const config = await readMcpConfig()
  jsonResponse(res, 200, config)
}

async function handlePutMcpConfig(req: IncomingMessage, res: ServerResponse) {
  try {
    const config = await readBody(req)
    const status = await saveMcpConfig(config as any)
    jsonResponse(res, 200, status)
  } catch (err) {
    jsonResponse(res, 400, { error: (err as Error).message })
  }
}

async function handleReconnectMcp(_req: IncomingMessage, res: ServerResponse, name?: string) {
  const status = await reconnectMcp(name)
  jsonResponse(res, 200, status)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(slug?: string): string | undefined {
  if (!slug) return undefined
  return slug.replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
}

type ParamHandler = (req: IncomingMessage, res: ServerResponse, ...params: string[]) => Promise<void>

interface RouteEntry {
  pattern: RegExp
  paramNames: string[]
  handler: ParamHandler
}

// ─── Request Router ──────────────────────────────────────────────────────────

function routeKey(method: string, url: string): string {
  // Normalizar: remover query string e barra final
  const path = url.split('?')[0]?.replace(/\/$/, '') ?? '/'
  return `${method} ${path}`
}


function createRouter(
  validatePin: (pin: string, ip: string) => boolean,
  getPairingPin: () => string | null,
  validateToken: (token: string) => Promise<boolean>,
) {
  const routes: RouteEntry[] = [
    // GET endpoints
    { pattern: /^GET \/api\/preferences$/, paramNames: [], handler: handleGetPreferences },
    { pattern: /^GET \/api\/models\/selected$/, paramNames: [], handler: handleGetSelectedModel },
    { pattern: /^GET \/api\/catalog$/, paramNames: [], handler: handleGetCatalog },
    { pattern: /^GET \/api\/status$/, paramNames: [], handler: handleGetStatus },
    { pattern: /^GET \/api\/providers\/connected$/, paramNames: [], handler: handleGetConnectedProviders },
    { pattern: /^GET \/api\/skills$/, paramNames: [], handler: handleGetSkills },
    { pattern: /^GET \/api\/skills\/pending$/, paramNames: [], handler: handleGetPendingSkills },
    { pattern: /^GET \/api\/mcp\/status$/, paramNames: [], handler: handleGetMcpStatus },
    { pattern: /^GET \/api\/mcp\/config$/, paramNames: [], handler: handleGetMcpConfig },

    // Mutation endpoints
    { pattern: /^PATCH \/api\/preferences$/, paramNames: [], handler: handlePatchPreferences },
    { pattern: /^PUT \/api\/models\/selected$/, paramNames: [], handler: handlePutSelectedModel },
    { pattern: /^POST \/api\/skills$/, paramNames: [], handler: handleCreateSkill },
    { pattern: /^POST \/api\/skills\/import$/, paramNames: [], handler: handleImportSkill },
    { pattern: /^DELETE \/api\/skills\/([^/]+)$/, paramNames: ['slug'], handler: handleDeleteSkill },
    { pattern: /^POST \/api\/skills\/([^/]+)\/approve$/, paramNames: ['slug'], handler: handleApproveSkill },
    { pattern: /^POST \/api\/skills\/([^/]+)\/discard$/, paramNames: ['slug'], handler: handleDiscardSkill },
    { pattern: /^PUT \/api\/mcp\/config$/, paramNames: [], handler: handlePutMcpConfig },
    { pattern: /^POST \/api\/mcp\/servers\/([^/]+)\/reconnect$/, paramNames: ['name'], handler: handleReconnectMcp },
    { pattern: /^POST \/api\/mcp\/servers\/reconnect$/, paramNames: [], handler: (_r, res) => handleReconnectMcp(_r, res, undefined) },
  ]

  return async (req: IncomingMessage, res: ServerResponse) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, PATCH, PUT, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      })
      res.end()
      return
    }

    // Discovery — endpoint público (sem auth) para o app mobile detectar
    if (req.method === 'GET' && (req.url === '/api/ping' || req.url?.startsWith('/api/ping?'))) {
      const pairingPin = getPairingPin()
      jsonResponse(res, 200, {
        app: 'orbit',
        name: hostname(),
        version: app.getVersion(),
        wsPort: 3847,
        ...(pairingPin ? { pin: pairingPin } : {}),
      })
      return
    }

    // Auth — tenta token persistente primeiro, depois PIN
    if (!(await validateAuth(req, validatePin, validateToken))) {
      jsonResponse(res, 401, { error: 'PIN inválido ou ausente' })
      return
    }

    const key = routeKey(req.method ?? 'GET', req.url ?? '/')

    for (const entry of routes) {
      const match = key.match(entry.pattern)
      if (match) {
        const params = entry.paramNames.reduce(
          (acc, name, i) => ({ ...acc, [name]: match[i + 1] }),
          {} as Record<string, string>,
        )
        try {
          await entry.handler(req, res, ...Object.values(params))
        } catch (err) {
          console.error('[CompanionHTTP] Handler error:', err)
          jsonResponse(res, 500, { error: 'Erro interno' })
        }
        return
      }
    }

    jsonResponse(res, 404, { error: 'Endpoint não encontrado' })
  }
}

// ─── Server Lifecycle ────────────────────────────────────────────────────────

export function startCompanionHttpServer(
  validatePin: (pin: string, ip: string) => boolean,
  getPairingPin: () => string | null,
  validateToken: (token: string) => Promise<boolean>,
): { port: number } | null {
  if (httpServer) return { port: HTTP_PORT }

  const handler = createRouter(validatePin, getPairingPin, validateToken)
  httpServer = createServer(handler)

  httpServer.on('error', (err: Error) => {
    console.error('[CompanionHTTP] Server error:', err)
  })

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`[CompanionHTTP] Server started on port ${HTTP_PORT}`)
  })

  return { port: HTTP_PORT }
}

export function stopCompanionHttpServer(): void {
  if (httpServer) {
    httpServer.close()
    httpServer = null
    console.log('[CompanionHTTP] Server stopped')
  }
}

export function isCompanionHttpRunning(): boolean {
  return httpServer !== null
}
