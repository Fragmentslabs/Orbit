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
import { app, BrowserWindow } from 'electron'
import { readJson, writeJson, listKeys } from './storage'
import { getCatalog } from './catalog'
import { listCredentialProviders } from './auth'
import { loadSkills } from './skills'
import { listMcpStatus } from './mcp'

export const HTTP_PORT = 3848

let httpServer: Server | null = null

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Valida o header Authorization: Bearer {pin}.
 * Retorna true se o PIN for válido.
 */
function validateAuth(req: IncomingMessage, validatePin: (pin: string, ip: string) => boolean): boolean {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return false

  const pin = authHeader.slice(7).trim()
  if (!pin) return false

  const ip = req.socket.remoteAddress ?? 'unknown'
  return validatePin(pin, ip)
}

// ─── Response Helpers ─────────────────────────────────────────────────────────

function jsonResponse(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PATCH, PUT, OPTIONS',
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

// ─── Request Router ──────────────────────────────────────────────────────────

function routeKey(method: string, url: string): string {
  // Normalizar: remover query string e barra final
  const path = url.split('?')[0]?.replace(/\/$/, '') ?? '/'
  return `${method} ${path}`
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function createRouter(
  validatePin: (pin: string, ip: string) => boolean,
  getPairingPin: () => string | null,
) {
  const routes = new Map<string, Handler>()

  // GET endpoints
  routes.set('GET /api/preferences', handleGetPreferences)
  routes.set('GET /api/models/selected', handleGetSelectedModel)
  routes.set('GET /api/catalog', handleGetCatalog)
  routes.set('GET /api/status', handleGetStatus)
  routes.set('GET /api/providers/connected', handleGetConnectedProviders)
  routes.set('GET /api/skills', handleGetSkills)
  routes.set('GET /api/mcp/status', handleGetMcpStatus)

  // Mutation endpoints
  routes.set('PATCH /api/preferences', handlePatchPreferences)
  routes.set('PUT /api/models/selected', handlePutSelectedModel)

  return async (req: IncomingMessage, res: ServerResponse) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, PATCH, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      })
      res.end()
      return
    }

    // Discovery — endpoint público (sem auth) para o app mobile detectar
    // um Orbit Desktop na rede. Expõe apenas metadados inofensivos.
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

    // Auth
    if (!validateAuth(req, validatePin)) {
      jsonResponse(res, 401, { error: 'PIN inválido ou ausente' })
      return
    }

    const key = routeKey(req.method ?? 'GET', req.url ?? '/')
    const handler = routes.get(key)

    if (!handler) {
      jsonResponse(res, 404, { error: 'Endpoint não encontrado' })
      return
    }

    try {
      await handler(req, res)
    } catch (err) {
      console.error('[CompanionHTTP] Handler error:', err)
      jsonResponse(res, 500, { error: 'Erro interno' })
    }
  }
}

// ─── Server Lifecycle ────────────────────────────────────────────────────────

export function startCompanionHttpServer(
  validatePin: (pin: string, ip: string) => boolean,
  getPairingPin: () => string | null,
): { port: number } | null {
  if (httpServer) return { port: HTTP_PORT }

  const handler = createRouter(validatePin, getPairingPin)
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
