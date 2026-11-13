/**
 * REST HTTP server for Orbit Companion.
 *
 * It runs on port 3848 (0.0.0.0) and provides simple request/response endpoints
 * for preference, model and catalog operations — complementing the
 * WebSocket (port 3847) that is used for streaming and notifications.
 *
 * Security:
 * - Authentication via the `Authorization: Bearer {pin}` header
 * - Reuses the same PIN validation as companion-server
 * - CORS enabled for local development
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
import { hostname } from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, BrowserWindow } from 'electron'
import { StorageKeys } from '@shared/chat'
import { readJson, writeJson, listKeys } from './storage'
import { getCatalog } from './catalog'
import { listCredentialProviders } from './auth'
import { globalSkillsDir, loadSkills, notifySkillsChanged } from './skills'
import { importSkillSelection } from './skills/import'
import { sanitizeSlug, serializeSkill } from './skills/parser'
import { approvePendingSkill, discardPendingSkill, listPendingSkills } from './skills/pending'
import { authorizeMcp, listMcpStatus, readMcpConfig, reconnectMcp, saveMcpConfig } from './mcp'
import type { McpConfig } from '@shared/mcp'
import { readMedia, listMedia, mediaDiskUsage, deleteMedia, deleteManyMedia } from './media'
import { createAssetToken, validateAssetToken, type AssetScope } from './companion-token'
import { serveAsset } from './companion-assets'
import { getMotion } from './video/motion-store'
import { getDesign } from './design/design-store'
import { readDesignCanvas } from './design/design-canvas'
import { getSlides } from './slides/slides-store'
import { mediaKind, type MediaEntry } from '@shared/media'

import { transcribePcm, voiceStatus } from './voice'
import { speakToFile } from './voice/speech-file'
import { getAppSettings } from './app-settings'

import type {
  SessionModeOverrides,
  SessionPrefsSnapshot,
  WorkerConfigSnapshot,
  ReasoningPrefsMap,
  VoiceSpeakErrorResponse,
} from '@shared/companion'
import type { VoiceEngineId } from '@shared/voice'
import type { RotationConfig } from '@shared/chat'
import { tNow } from './i18n'

const execFileAsync = promisify(execFile)

export const HTTP_PORT = 3848

let httpServer: Server | null = null

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Validates the Authorization: Bearer {token/pin} header.
 * Tries the persistent token first, then the PIN (5 min TTL).
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

  // Tries as a persistent token first (64 hex chars)
  if (credential.length === 64 && /^[a-f0-9]+$/i.test(credential)) {
    return validateToken(credential)
  }

  // Fallback: PIN (5 min TTL)
  return Promise.resolve(validatePin(credential, ip))
}

// ─── Media Tokens ─────────────────────────────────────────────────────────────
// React Native's <Image> does not send the Authorization header reliably
// (Android ignores headers in the Image component), so the media URLs come out
// signed with an HMAC token. The secret and the signature live in
// companion-token.ts; here only the `media` scope is used, whose token format is
// the historical one (`?t=<exp>.<sig>`) so as not to invalidate a URL already delivered to the phone.

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
        reject(new Error(tNow('companion.http.invalidJson')))
      }
    })
    req.on('error', reject)
  })
}

// ─── Storage Keys for Companion Preferences ──────────────────────────────────

const PREFS_KEY = 'companion/preferences'
// Shared key: the sampling of a connected app (lib/mcp/sampling.ts)
// needs the same "current model" when there is no conversation in the loop at all.
const SELECTED_MODEL_KEY = StorageKeys.selectedModel

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

  // Sync with the renderer via IPC
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

  // Broadcast so the renderer updates (sessionId null = new chat/draft +
  // global default, the same semantics as the renderer's selectModel)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('companion:model-select', {
        providerId: model.providerId,
        modelId: model.modelId,
        sessionId: null,
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

    // Only allowed fields
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

// Models per session (renderer → main): cache that the mobile queries on
// connect (GET /api/session-models) and receives in real time via WS
// 'session:model-change'. The renderer pushes the map on every change (and on
// load, repopulating the cache after a reload).
let sessionModelsCache: Record<string, SelectedModel> = {}

export function setSessionModelsCache(overrides: Record<string, SelectedModel>): void {
  sessionModelsCache = overrides ?? {}
}

export function getSessionModelsCache(): Record<string, SelectedModel> {
  return sessionModelsCache
}

async function handleGetSessionModels(_req: IncomingMessage, res: ServerResponse) {
  jsonResponse(res, 200, { overrides: getSessionModelsCache() })
}

// Model rotation: the same mechanics. The engine's cache lives in
// model-rotation.ts (it is what resolves the turn's sequence); here stays only
// the copy that the mobile reads on connect (GET /api/rotations) — in real time
// it arrives through the WS 'rotation:change'.
let rotationConfigHttpCache: RotationConfig = { rotations: [], sessionOverrides: {} }

export function setRotationHttpCache(config: RotationConfig | null | undefined): void {
  rotationConfigHttpCache = config ?? { rotations: [], sessionOverrides: {} }
}

async function handleGetRotations(_req: IncomingMessage, res: ServerResponse) {
  jsonResponse(res, 200, { config: rotationConfigHttpCache })
}

// Same mechanics as the models, for the modes active per chat: the renderer is the
// source of truth (the modes live in its localStorage) and pushes the whole map
// on every change; here stays the cache that the mobile reads when connecting.
let sessionModesCache: SessionModeOverrides = {}

export function setSessionModesCache(overrides: SessionModeOverrides): void {
  sessionModesCache = overrides ?? {}
}

export function getSessionModesCache(): SessionModeOverrides {
  return sessionModesCache
}

// Same mechanics again, for the tools of each chat (the subset of MCP servers that
// enters the conversation): the renderer's selection, cached here for the connect.
let sessionToolsCache: Record<string, string[] | null> = {}

export function setSessionToolsCache(overrides: Record<string, string[] | null>): void {
  sessionToolsCache = overrides ?? {}
}

export function getSessionToolsCache(): Record<string, string[] | null> {
  return sessionToolsCache
}

async function handleGetSessionTools(_req: IncomingMessage, res: ServerResponse) {
  jsonResponse(res, 200, { overrides: getSessionToolsCache() })
}

async function handleGetSessionModes(_req: IncomingMessage, res: ServerResponse) {
  jsonResponse(res, 200, { overrides: getSessionModesCache() })
}

// Thinking and autonomy per chat: the same mechanics. The renderer pushes the snapshot
// (reasoning + permission per session) on every change; here stays the cache that the
// mobile reads on connect (GET /api/session-prefs). In real time it arrives through the WS
// 'session:prefs-change'.
let sessionPrefsCache: SessionPrefsSnapshot = { reasoning: {}, permission: {} }

export function setSessionPrefsCache(prefs: SessionPrefsSnapshot): void {
  sessionPrefsCache = {
    reasoning: prefs?.reasoning ?? {},
    permission: prefs?.permission ?? {},
  }
}

export function getSessionPrefsCache(): SessionPrefsSnapshot {
  return sessionPrefsCache
}

async function handleGetSessionPrefs(_req: IncomingMessage, res: ServerResponse) {
  jsonResponse(res, 200, getSessionPrefsCache())
}

// Thinking per model: the same mechanics as the modes. The renderer pushes the map
// (localStorage) on every change; here stays the cache that the mobile reads on connect
// (GET /api/reasoning-prefs) — in real time it arrives through the WS 'reasoning:change'.
let reasoningPrefsCache: ReasoningPrefsMap = {}

export function setReasoningPrefsCache(prefs: ReasoningPrefsMap): void {
  reasoningPrefsCache = prefs ?? {}
}

export function getReasoningPrefsCache(): ReasoningPrefsMap {
  return reasoningPrefsCache
}

async function handleGetReasoningPrefs(_req: IncomingMessage, res: ServerResponse) {
  jsonResponse(res, 200, { prefs: getReasoningPrefsCache() })
}

// Configuration of the delegated modes (workers' model + vision model): it also
// lives in the renderer, and is also pushed from there. Without it the phone ran
// subagents/orchestration/vision with whatever was configured on the device.
let workerConfigCache: WorkerConfigSnapshot = {
  workerModel: null,
  workerReasoning: null,
  visionModel: null,
}

export function setWorkerConfigCache(config: WorkerConfigSnapshot): void {
  const next = config ?? { workerModel: null, workerReasoning: null, visionModel: null }
  // Conductor fields that are absent (an app that does not know them) keep the current value.
  workerConfigCache = {
    ...next,
    orchestratorModel: 'orchestratorModel' in next ? next.orchestratorModel : workerConfigCache.orchestratorModel,
    orchestratorReasoning: 'orchestratorReasoning' in next ? next.orchestratorReasoning : workerConfigCache.orchestratorReasoning,
    orchestration: 'orchestration' in next ? next.orchestration : workerConfigCache.orchestration,
  }
}

export function getWorkerConfigCache(): WorkerConfigSnapshot {
  return workerConfigCache
}

async function handleGetWorkerConfig(_req: IncomingMessage, res: ServerResponse) {
  jsonResponse(res, 200, { config: getWorkerConfigCache() })
}

async function handlePutSelectedModel(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req)

    if (typeof body.providerId !== 'string' || typeof body.modelId !== 'string') {
      jsonResponse(res, 400, { error: tNow('companion.http.providerAndModelRequired') })
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

// ─── Media Handler ────────────────────────────────────────────────────────────

/** Serves the assistant's images (orbit-media://) to the mobile app, which has no
 *  access to the protocol registered in Electron. Auth via a signed token in the query
 *  (?t=) — React Native's <Image> does not send headers, so the standard Bearer
 *  is not accepted on this route (it runs before the global auth block). */
async function handleGetMedia(req: IncomingMessage, res: ServerResponse, id: string) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (!validateAssetToken('media', id, url.searchParams.get('t'))) {
    jsonResponse(res, 401, { error: tNow('companion.http.invalidToken') })
    return
  }
  const media = await readMedia(id)
  if (!media) {
    jsonResponse(res, 404, { error: tNow('companion.http.imageNotFound') })
    return
  }
  res.writeHead(200, {
    'Content-Type': media.contentType,
    'Content-Length': media.buffer.length,
    'Cache-Control': 'private, max-age=86400',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(media.buffer)
}

// ─── Media Registry Handlers ──────────────────────────────────────────────────
// The mobile app's gallery reads the desktop's media registry through here. Every
// entry comes out with the signed URL of ITS type (token in the path, in every
// scope except image, which keeps the historical query) — before, everything pointed
// to /api/media/<id>, which only reads the images folder, and that is why artifact,
// document, video and piece arrived on the phone as a broken tile.

/**
 * Base of the absolute URLs handed to the client. The companion server is plain
 * HTTP; the desktop peer server is HTTPS on the same router — reading the socket
 * keeps the generated URL reachable from the side that asked (the phone and a
 * paired desktop use different schemes).
 */
function requestBaseUrl(req: IncomingMessage): string {
  const secure = (req.socket as { encrypted?: boolean }).encrypted === true
  return `${secure ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`
}

function mediaUrlFor(req: IncomingMessage, id: string): string {
  return `${requestBaseUrl(req)}/api/media/${id}?t=${createAssetToken('media', id)}`
}

/**
 * URL of a file of the scope, with the token in the path — the format that the WebView,
 * the `<video>` and the `<Image>` accept (none of them sends an Authorization header) and
 * that makes a piece's relative path inherit the directory's token.
 */
function fileUrlFor(
  req: IncomingMessage,
  scope: AssetScope,
  id: string,
  relative?: string,
): string {
  const base = requestBaseUrl(req)
  const rel = relative ? `/${relative.split('/').map(encodeURIComponent).join('/')}` : ''
  return `${base}/api/file/${scope}/${encodeURIComponent(id)}/${createAssetToken(scope, id)}${rel}`
}

/** Base of a document id: `.md` source, `.html` preview and renderings
 *  live side by side with the same base id (same rule as documentBase in
 *  media.ts, which is internal there). */
function documentBase(id: string): string {
  return id.replace(/\.(md|html|pdf|docx|png)$/, '')
}

/** Relative path of a piece's entry, with `/`. */
function relativeEntry(folder: string, entry: string): string {
  return path.relative(folder, entry).split(path.sep).join('/')
}

/**
 * The URL the phone should open for this entry — one per TYPE, because each
 * one lives in a different scope of the asset server:
 *
 * - image: `/api/media/<id>` (the historical alias, in the query);
 * - artifact: the `.html` page itself;
 * - document: the `.html` PREVIEW (the record's `.md` is text, not a page);
 * - audio/video: the file, which the player reads by Range;
 * - piece (motion/slides): the folder's entry; design: the first artboard.
 *
 * `undefined` when the piece is no longer registered on the desktop (the folder is
 * gone, the record was cleaned): the tile stays in the gallery, it just does not open.
 */
async function mediaEntryUrl(req: IncomingMessage, entry: MediaEntry): Promise<string | undefined> {
  switch (mediaKind(entry)) {
    case 'image':
      return mediaUrlFor(req, entry.id)
    case 'artifact':
      return fileUrlFor(req, 'artifact', entry.id)
    case 'document':
      return fileUrlFor(req, 'artifact', `${documentBase(entry.id)}.html`)
    case 'audio':
      return fileUrlFor(req, 'audio', entry.id)
    case 'video':
      return fileUrlFor(req, 'video', entry.id)
    case 'motion': {
      if (!entry.motionId) return undefined
      const motion = await getMotion(entry.motionId)
      if (!motion) return undefined
      return fileUrlFor(req, 'motion', entry.motionId, relativeEntry(motion.folder, motion.entry))
    }
    case 'design': {
      if (!entry.designId) return undefined
      const design = await getDesign(entry.designId)
      if (!design) return undefined
      // canvas.json is the index (data) — the page is the first artboard.
      const first = await readDesignCanvas(design.folder)
        .then((canvas) => canvas.order[0] ?? null)
        .catch(() => null)
      return fileUrlFor(req, 'design', entry.designId, first ?? 'canvas.json')
    }
    case 'slides': {
      if (!entry.slidesId) return undefined
      const slides = await getSlides(entry.slidesId)
      if (!slides) return undefined
      return fileUrlFor(req, 'slides', entry.slidesId, relativeEntry(slides.folder, slides.entry))
    }
  }
}

async function handleListMedia(req: IncomingMessage, res: ServerResponse) {
  const entries = await listMedia()
  jsonResponse(
    res,
    200,
    await Promise.all(entries.map(async (entry) => ({ ...entry, url: await mediaEntryUrl(req, entry) }))),
  )
}

async function handleMediaUsage(_req: IncomingMessage, res: ServerResponse) {
  jsonResponse(res, 200, await mediaDiskUsage())
}

async function handleDeleteMedia(_req: IncomingMessage, res: ServerResponse, id: string) {
  jsonResponse(res, 200, { deleted: await deleteMedia(id) })
}

async function handleDeleteManyMedia(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req)
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id): id is string => typeof id === 'string')
      : []
    jsonResponse(res, 200, { removed: await deleteManyMedia(ids) })
  } catch (err) {
    jsonResponse(res, 400, { error: (err as Error).message })
  }
}

// ─── Skills Handlers ──────────────────────────────────────────────────────────

async function handleCreateSkill(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req)
    if (typeof body.name !== 'string' || typeof body.content !== 'string') {
      jsonResponse(res, 400, { error: tNow('companion.http.nameAndContentRequired') })
      return
    }
    const safeSlug = slugify(body.slug as string | undefined) ?? sanitizeSlug(body.name)
    if (!safeSlug) {
      jsonResponse(res, 400, { error: tNow('companion.http.invalidSlug') })
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
    jsonResponse(res, 400, { error: tNow('companion.http.invalidSlugShort') })
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
      jsonResponse(res, 400, { error: tNow('companion.http.contentAndFilenameRequired') })
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
    // Raw network body: readBody returns Record<string, unknown> and whoever
    // validates the shape is saveMcpConfig (writes the file and reconciles).
    const status = await saveMcpConfig(config as unknown as McpConfig)
    jsonResponse(res, 200, status)
  } catch (err) {
    jsonResponse(res, 400, { error: (err as Error).message })
  }
}

async function handleReconnectMcp(_req: IncomingMessage, res: ServerResponse, name?: string) {
  const status = await reconnectMcp(name)
  jsonResponse(res, 200, status)
}

/**
 * Triggers the server's OAuth flow at the mobile's request. The browser opens on the
 * computer (the redirect_uri is the desktop's loopback) and the user may take
 * minutes to finish — answering right away avoids holding the phone's request
 * until the timeout. The app follows the outcome through /api/mcp/status:
 * the server stays in "connecting" until the login ends.
 */
async function handleAuthorizeMcp(_req: IncomingMessage, res: ServerResponse, name: string) {
  void authorizeMcp(name)
  jsonResponse(res, 202, listMcpStatus())
}

// ─── Git Handlers ─────────────────────────────────────────────────────────────

async function handleGetBranches(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req)
    const repoPath = body?.repoPath as string | undefined
    if (!repoPath) { jsonResponse(res, 200, { branches: [], current: '' }); return }
    const [{ stdout: list }, { stdout: current }] = await Promise.all([
      execFileAsync('git', ['branch', '--list', '--format=%(refname:short)'], { cwd: repoPath }),
      execFileAsync('git', ['branch', '--show-current'], { cwd: repoPath }),
    ])
    const branches = list.trim().split('\n').filter(Boolean)
    jsonResponse(res, 200, { branches, current: current.trim() })
  } catch (err) {
    jsonResponse(res, 200, { branches: [], current: '' })
  }
}

async function handlePostCheckout(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req)
    const { repoPath, branch } = body as { repoPath?: string; branch?: string }
    if (!repoPath || !branch) { jsonResponse(res, 400, { error: tNow('companion.http.repoAndBranchRequired') }); return }
    await execFileAsync('git', ['checkout', branch], { cwd: repoPath })
    jsonResponse(res, 200, { ok: true })
  } catch (err) {
    jsonResponse(res, 500, { error: (err as Error).message })
  }
}

// ─── Voice Handlers ───────────────────────────────────────────────────────────

/**
 * Dictation from the companion app: the phone sends the raw PCM16 audio (base64) and
 * receives the text. What transcribes it is the desktop's local engine (see docs/voice.md) —
 * the device does not run a voice model and no audio leaves for the cloud.
 *
 * Engine unavailable or model not downloaded becomes 503 with { error, reason }: the app
 * shows the reason ("download the model...") instead of an opaque 500.
 */
async function handlePostVoiceTranscribe(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req)

    if (typeof body.pcm !== 'string' || !body.pcm) {
      jsonResponse(res, 400, { error: tNow('companion.http.pcmRequired') })
      return
    }
    if (typeof body.sampleRate !== 'number' || !Number.isFinite(body.sampleRate) || body.sampleRate <= 0) {
      jsonResponse(res, 400, { error: tNow('companion.http.invalidSampleRate') })
      return
    }
    if (body.engine !== undefined && body.engine !== 'parakeet' && body.engine !== 'whisper') {
      jsonResponse(res, 400, { error: 'engine deve ser "parakeet" ou "whisper"' })
      return
    }

    const pcm = Buffer.from(body.pcm, 'base64')
    if (pcm.length === 0) {
      jsonResponse(res, 400, { error: tNow('companion.http.invalidPcm') })
      return
    }

    const result = await transcribePcm(pcm, {
      sampleRate: body.sampleRate,
      engine: body.engine as VoiceEngineId | undefined,
      modelId: typeof body.modelId === 'string' && body.modelId ? body.modelId : null,
      language: typeof body.language === 'string' && body.language ? body.language : undefined,
    })
    jsonResponse(res, 200, result)
  } catch (err) {
    jsonResponse(res, 503, {
      error: tNow('companion.http.voiceUnavailable'),
      reason: (err as Error)?.message || String(err),
    })
  }
}

/** State of the desktop's voice engines — the app decides whether to show the microphone. */
async function handleGetVoiceStatus(_req: IncomingMessage, res: ServerResponse) {
  try {
    jsonResponse(res, 200, await voiceStatus())
  } catch (err) {
    jsonResponse(res, 503, {
      error: tNow('companion.http.voiceUnavailable'),
      reason: (err as Error)?.message || String(err),
    })
  }
}

/** Ceiling for the text of an utterance: the phone reads ONE answer per tap, and the
 *  synthesis already goes in chunks of 3500 characters. Above that it is text pasted by mistake. */
const MAX_SPEAK_CHARS = 20_000

/**
 * Read-aloud requested by the phone: text goes in, WAV comes out.
 *
 * The device does not synthesize — it sends the text and receives the signed URL of a WAV
 * synthesized on the desktop (see `voice/speech-file`). It is the mirror of
 * `/api/voice/transcribe`: there the audio goes through and the text comes back; here the
 * text goes through and the audio comes back.
 *
 * A failure comes out as 503 with { error: CODE, detail } — never with a sentence. Whoever
 * writes to the person is the app, which is the only one that knows which language
 * they are reading in; a ready-made sentence from here would arrive in Portuguese on the
 * screen of someone using the phone in English. The `detail` is the engine's text, for the log.
 */
async function handlePostVoiceSpeak(req: IncomingMessage, res: ServerResponse) {
  try {
    // The preferences switch counts for the app too: turned off, the
    // phone does not synthesize behind the owner's back.
    if (!getAppSettings().voice.tts.enabled) {
      jsonResponse(res, 503, { error: 'tts_disabled' } satisfies VoiceSpeakErrorResponse)
      return
    }

    const body = await readBody(req)

    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) {
      jsonResponse(res, 400, { error: 'invalid_text' } satisfies VoiceSpeakErrorResponse)
      return
    }
    if (text.length > MAX_SPEAK_CHARS) {
      jsonResponse(res, 400, { error: 'text_too_long' } satisfies VoiceSpeakErrorResponse)
      return
    }
    if (body.voice !== undefined && !/^[FM][1-5]$/.test(String(body.voice))) {
      jsonResponse(res, 400, { error: 'invalid_voice' } satisfies VoiceSpeakErrorResponse)
      return
    }
    if (body.lang !== undefined && !/^(auto|[a-z]{2})$/.test(String(body.lang))) {
      jsonResponse(res, 400, { error: 'invalid_lang' } satisfies VoiceSpeakErrorResponse)
      return
    }
    if (
      body.speed !== undefined &&
      (typeof body.speed !== 'number' || !Number.isFinite(body.speed) || body.speed < 0.5 || body.speed > 2)
    ) {
      jsonResponse(res, 400, {
        error: 'invalid_speed',
        detail: `recebido: ${String(body.speed)}`,
      } satisfies VoiceSpeakErrorResponse)
      return
    }

    const spoken = await speakToFile(text, {
      voice: typeof body.voice === 'string' ? body.voice : undefined,
      lang: typeof body.lang === 'string' ? body.lang : undefined,
      speed: typeof body.speed === 'number' ? body.speed : undefined,
    })

    jsonResponse(res, 200, {
      id: spoken.id,
      // `audio` scope, token in the path: the player opens it directly, and Range (which
      // `serveAsset` already implements) gives the duration without downloading everything.
      url: fileUrlFor(req, 'audio', spoken.id),
      durationMs: spoken.durationMs,
      cached: spoken.cached,
    })
  } catch (err) {
    // Engine missing, model not downloaded, synthesis that blew up: to the app it is the
    // same case — there is no voice. The error text (from the stack trace, in
    // Portuguese) goes in `detail`: it serves the log and does not go to the screen.
    jsonResponse(res, 503, {
      error: 'voice_unavailable',
      detail: (err as Error)?.message || String(err),
    } satisfies VoiceSpeakErrorResponse)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  // Normalize: remove the query string and the trailing slash
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
    { pattern: /^GET \/api\/media$/, paramNames: [], handler: handleListMedia },
    { pattern: /^GET \/api\/media\/usage$/, paramNames: [], handler: handleMediaUsage },
    { pattern: /^GET \/api\/session-models$/, paramNames: [], handler: handleGetSessionModels },
    { pattern: /^GET \/api\/session-modes$/, paramNames: [], handler: handleGetSessionModes },
    { pattern: /^GET \/api\/session-tools$/, paramNames: [], handler: handleGetSessionTools },
    { pattern: /^GET \/api\/session-prefs$/, paramNames: [], handler: handleGetSessionPrefs },
    { pattern: /^GET \/api\/reasoning-prefs$/, paramNames: [], handler: handleGetReasoningPrefs },
    { pattern: /^GET \/api\/rotations$/, paramNames: [], handler: handleGetRotations },
    { pattern: /^GET \/api\/worker-config$/, paramNames: [], handler: handleGetWorkerConfig },
    { pattern: /^GET \/api\/voice\/status$/, paramNames: [], handler: handleGetVoiceStatus },

    // Mutation endpoints
    { pattern: /^PATCH \/api\/preferences$/, paramNames: [], handler: handlePatchPreferences },
    { pattern: /^PUT \/api\/models\/selected$/, paramNames: [], handler: handlePutSelectedModel },
    { pattern: /^POST \/api\/skills$/, paramNames: [], handler: handleCreateSkill },
    { pattern: /^POST \/api\/skills\/import$/, paramNames: [], handler: handleImportSkill },
    { pattern: /^DELETE \/api\/skills\/([^/]+)$/, paramNames: ['slug'], handler: handleDeleteSkill },
    { pattern: /^POST \/api\/skills\/([^/]+)\/approve$/, paramNames: ['slug'], handler: handleApproveSkill },
    { pattern: /^POST \/api\/skills\/([^/]+)\/discard$/, paramNames: ['slug'], handler: handleDiscardSkill },
    { pattern: /^PUT \/api\/mcp\/config$/, paramNames: [], handler: handlePutMcpConfig },
    { pattern: /^DELETE \/api\/media\/([^/]+)$/, paramNames: ['id'], handler: handleDeleteMedia },
    { pattern: /^POST \/api\/media\/delete$/, paramNames: [], handler: handleDeleteManyMedia },
    { pattern: /^POST \/api\/mcp\/servers\/([^/]+)\/reconnect$/, paramNames: ['name'], handler: handleReconnectMcp },
    { pattern: /^POST \/api\/mcp\/servers\/([^/]+)\/authorize$/, paramNames: ['name'], handler: handleAuthorizeMcp },
    { pattern: /^POST \/api\/mcp\/servers\/reconnect$/, paramNames: [], handler: (_r, res) => handleReconnectMcp(_r, res, undefined) },
    { pattern: /^POST \/api\/voice\/transcribe$/, paramNames: [], handler: handlePostVoiceTranscribe },
    { pattern: /^POST \/api\/voice\/speak$/, paramNames: [], handler: handlePostVoiceSpeak },
    { pattern: /^POST \/api\/git\/branches$/, paramNames: [], handler: handleGetBranches },
    { pattern: /^POST \/api\/git\/checkout$/, paramNames: [], handler: handlePostCheckout },
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

    // Discovery — public endpoint (no auth) for the mobile app to detect
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

    // Assistant media — auth via a signed token in the query (React Native's <Image>
    // does not send a header), which is why it stays BEFORE the global
    // auth block (which requires a Bearer header). Simple route GET /api/media/:id.
    const mediaKey = routeKey(req.method ?? 'GET', req.url ?? '/')
    const mediaMatch = /^GET \/api\/media\/([^/]+)$/.exec(mediaKey)
    // 'usage' is a registry endpoint (listed below), not a file id.
    if (mediaMatch && mediaMatch[1] !== 'usage') {
      await handleGetMedia(req, res, mediaMatch[1])
      return
    }

    // Desktop files for the phone: audio, video, artifact, document and
    // the pieces (motion/design/slides). Auth through the token in the PATH — the
    // <video> and the WebView also do not send a header, and it is the path that makes the
    // `base.css` of a piece inherit the directory's token. It runs before the
    // global Bearer block, like the image route.
    const assetMatch = /^(GET|HEAD) \/api\/file\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(mediaKey)
    if (assetMatch) {
      // The id comes percent-encoded; a loose `%` would break the decode and bring
      // the handler down midway. An id that does not decode does not exist — 404.
      let assetId: string | null = null
      try {
        assetId = decodeURIComponent(assetMatch[3])
      } catch {
        assetId = null
      }
      if (!assetId) {
        jsonResponse(res, 404, { error: tNow('companion.http.fileNotFound') })
        return
      }
      // The relative path is NOT decoded here: what decodes it is the resolve*File
      // of each store, the same contract as the scheme handlers.
      await serveAsset(req, res, assetMatch[2], assetId, assetMatch[4], assetMatch[5] ?? '')
      return
    }

    // Auth — tries the persistent token first, then the PIN
    if (!(await validateAuth(req, validatePin, validateToken))) {
      jsonResponse(res, 401, { error: tNow('companion.http.invalidPin') })
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
          jsonResponse(res, 500, { error: tNow('companion.http.internalError') })
        }
        return
      }
    }

    jsonResponse(res, 404, { error: tNow('companion.http.endpointNotFound') })
  }
}

/**
 * The same router, for the mutual-TLS peer server (peers/peer-server.ts).
 *
 * There the request was already authenticated by the certificate + device token
 * before reaching here, so the router's own Bearer check is a no-op — a paired
 * desktop gets exactly the endpoints the phone has (including media listing and
 * deletion), and the peer server must never expose this router without its own
 * authentication in front.
 */
export function createPeerRouter() {
  return createRouter(
    () => false,
    () => null,
    async () => true,
  )
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
    // It does not leave a phantom server: if the bind failed (port in use by another
    // instance), it reports not running instead of httpServer !== null forever.
    httpServer = null
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
