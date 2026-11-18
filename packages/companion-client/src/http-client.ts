/**
 * HTTP client for the REST API of Orbit Desktop.
 *
 * Used for simple configuration operations (preferences, models, catalog)
 * that do not need streaming. Authentication via Bearer token (PIN).
 */

import type { ConnectionConfig } from './types'
import type {
  CompanionSourcesList,
  FilesListRequest,
  FilesListResponse,
  FilesReadRequest,
  FilesReadResponse,
  FilesSearchRequest,
  FilesSearchResponse,
  FilesWriteRequest,
  FilesWriteResponse,
  LiveFrameResponse,
  LiveKind,
  LiveListResponse,
  MediaEntry,
  MediaUsage,
  ReasoningPrefsMap,
  RotationConfig,
  SessionPrefsSnapshot,
  VoiceEngineId,
  VoiceSpeakResponse,
  VoiceStatusResponse,
  VoiceTranscribeResponse,
  WorkerConfigSnapshot,
} from '@orbit/shared'

// ─── Types ───────────────────────────────────────────────────────────────────

/** A PDF page drawn by the desktop, with its text positioned as fractions (0 to 1) of the page. */
export interface DocumentPageImage {
  page: number
  dataUrl: string
  width: number
  height: number
  items: { x: number; y: number; width: number; height: number; text: string }[]
}

export interface DocumentPagesView {
  total: number
  outline: { title: string; page: number | null; level: number }[]
  pages: DocumentPageImage[]
}

/** A document as the desktop viewer reads it: pages of lines (the same numbering a citation uses). */
export interface DocumentTextView {
  id: string
  filename: string
  kind: 'pdf' | 'docx' | 'spreadsheet' | 'text' | 'web'
  totalPages: number
  pages: { num: number; label?: string; lines: string[] }[]
  hasOriginal: boolean
  originalKind?: 'pdf' | 'docx'
}

export interface HttpResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

// ─── CompanionHttp ───────────────────────────────────────────────────────────

export class CompanionHttp {
  private baseUrl: string
  private token: string
  private fetchImpl: typeof fetch

  constructor(config: ConnectionConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch
    this.baseUrl = config.httpUrl ?? `http://${config.host}:${config.port + 1}`
    // Uses the persistent token when available (it does not expire like the PIN)
    this.token = config.token ?? config.pin
  }

  /** Updates the configuration (host/port/pin) after reconnection. */
  updateConfig(config: ConnectionConfig): void {
    this.baseUrl = config.httpUrl ?? `http://${config.host}:${config.port + 1}`
    this.token = config.token ?? config.pin
  }

  /** Replaces the token used in the authentication (e.g. after the WS issues a persistent token). */
  setToken(token: string): void {
    this.token = token
  }

  // ─── Preferences ─────────────────────────────────────────────────────────

  async getPreferences(): Promise<HttpResult<Record<string, unknown>>> {
    return this.get('/api/preferences')
  }

  async updatePreferences(patch: Record<string, unknown>): Promise<HttpResult> {
    return this.request('PATCH', '/api/preferences', patch)
  }

  /** Model overrides per session (map sessionId → model) kept by the
   *  desktop renderer. Used so the mobile inherits the model per chat. */

  async getSelectedModel(): Promise<HttpResult<{ providerId: string; modelId: string; workerModelId?: string }>> {
    return this.get('/api/models/selected')
  }

  async selectModel(providerId: string, modelId: string): Promise<HttpResult> {
    return this.request('PUT', '/api/models/selected', { providerId, modelId })
  }

  async getCatalog(): Promise<HttpResult> {
    return this.get('/api/catalog')
  }

  /** Active modes per chat (search, browser, plan, subagents,
   *  orchestration, vision, simple and brain) kept by the desktop renderer.
   *  The mobile inherits the chat state when connecting. */
  async getSessionModels(): Promise<HttpResult<{ overrides: Record<string, { providerId: string; modelId: string }> }>> {
    return this.get('/api/session-models')
  }

  /** Active modes per chat (sessionId → mode → boolean) kept by the desktop
   *  renderer. The mobile inherits on connect and then follows through the WS event
   *  'session:mode-change'. */
  async getSessionModes(): Promise<HttpResult<{ overrides: Record<string, Record<string, boolean>> }>> {
    return this.get('/api/session-modes')
  }

  /** MCP servers per chat (sessionId → list) kept by the desktop renderer — the
   *  "tools" selection of the conversation. The mobile inherits on connect and then
   *  follows through the WS event 'session:tools-change'. */
  async getSessionTools(): Promise<HttpResult<{ overrides: Record<string, string[] | null> }>> {
    return this.get('/api/session-tools')
  }

  /** Thinking per model (toggle + variant) kept by the desktop renderer.
   *  The mobile inherits the state when connecting and then follows through the WS event
   *  'reasoning:change'. */
  async getSessionPrefs(): Promise<HttpResult<SessionPrefsSnapshot>> {
    return this.get('/api/session-prefs')
  }

  /** Model rotation of the desktop: list of rotations + which one is chosen
   *  in each chat. The phone inherits the state when connecting and then follows
   *  through the WS event 'rotation:change'. */
  async getReasoningPrefs(): Promise<HttpResult<{ prefs: ReasoningPrefsMap }>> {
    return this.get('/api/reasoning-prefs')
  }

  /** A document's pages as numbered-line text — a conversation source (`docN`/`srcN`, needs the
   *  session) or a gallery document. The desktop panel's `docs:text`. */
  async getDocumentText(docId: string, sessionId?: string): Promise<HttpResult<DocumentTextView>> {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return this.get(`/api/documents/${encodeURIComponent(docId)}/text${query}`)
  }

  /** PDF pages as images + positioned text (the desktop panel's `docs:render`), at most 4 per call. */
  async getDocumentPages(
    docId: string,
    options: { sessionId?: string; from: number; count: number; scale?: number; text?: boolean; outline?: boolean },
  ): Promise<HttpResult<DocumentPagesView>> {
    const query = new URLSearchParams({ from: String(options.from), count: String(options.count) })
    if (options.sessionId) query.set('sessionId', options.sessionId)
    if (options.scale) query.set('scale', String(options.scale))
    if (options.text === false) query.set('text', '0')
    if (options.outline) query.set('outline', '1')
    return this.get(`/api/documents/${encodeURIComponent(docId)}/pages?${query.toString()}`)
  }

  /** The .docx original converted to HTML (the desktop panel's `docs:html`). */
  async getDocumentHtml(docId: string, sessionId?: string): Promise<HttpResult<{ html: string }>> {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return this.get(`/api/documents/${encodeURIComponent(docId)}/html${query}`)
  }

  /** Global config of the delegated modes (model/thinking of the subagent and
   *  orchestration workers, and model of the Vision mode) of the desktop. */
  async getRotations(): Promise<HttpResult<{ config: RotationConfig }>> {
    return this.get('/api/rotations')
  }

  /** Global config of the delegated modes (model/thinking of the subagent and
   *  orchestration workers, and model of the Vision mode) of the desktop. */
  async getWorkerConfig(): Promise<HttpResult<{ config: WorkerConfigSnapshot }>> {
    return this.get('/api/worker-config')
  }

  async getConnectedProviders(): Promise<HttpResult<string[]>> {
    return this.get('/api/providers/connected')
  }

  // ─── Skills ───────────────────────────────────────────────────────────────

  async getSkills(directory?: string): Promise<HttpResult> {
    const qs = directory ? `?directory=${encodeURIComponent(directory)}` : ''
    return this.get(`/api/skills${qs}`)
  }

  async createSkill(data: {
    name: string
    description?: string
    content: string
    slug?: string
    oldSlug?: string
  }): Promise<HttpResult<{ filePath: string }>> {
    return this.request('POST', '/api/skills', data)
  }

  async removeSkill(slug: string): Promise<HttpResult> {
    return this.request('DELETE', `/api/skills/${encodeURIComponent(slug)}`)
  }

  async importSkill(content: string, filename: string): Promise<HttpResult<{ imported: boolean; slug?: string; error?: string }>> {
    return this.request('POST', '/api/skills/import', { content, filename })
  }

  async listPendingSkills(): Promise<HttpResult> {
    return this.get('/api/skills/pending')
  }

  async approveSkill(slug: string): Promise<HttpResult<{ approved: boolean }>> {
    return this.request('POST', `/api/skills/${encodeURIComponent(slug)}/approve`)
  }

  async discardSkill(slug: string): Promise<HttpResult> {
    return this.request('POST', `/api/skills/${encodeURIComponent(slug)}/discard`)
  }

  // ─── MCP ──────────────────────────────────────────────────────────────────

  async getMcpStatus(): Promise<HttpResult> {
    return this.get('/api/mcp/status')
  }

  async getMcpConfig(): Promise<HttpResult> {
    return this.get('/api/mcp/config')
  }

  async saveMcpConfig(config: unknown): Promise<HttpResult> {
    return this.request('PUT', '/api/mcp/config', config)
  }

  async reconnectMcp(name?: string): Promise<HttpResult> {
    const path = name
      ? `/api/mcp/servers/${encodeURIComponent(name)}/reconnect`
      : '/api/mcp/servers/reconnect'
    return this.request('POST', path)
  }

  /**
   * Triggers the server OAuth flow on the desktop. Answers right away (202) —
   * the browser opens on the computer and the outcome appears in /api/mcp/status.
   */
  async authorizeMcp(name: string): Promise<HttpResult> {
    return this.request('POST', `/api/mcp/servers/${encodeURIComponent(name)}/authorize`)
  }

  // ─── Voice (dictation) ───────────────────────────────────────────────────
  // The phone does not run a voice model: it records, converts to mono PCM16 and sends
  // the base64 to the desktop to transcribe (no audio goes out to the cloud).

  /**
   * Transcribes PCM16 audio (base64, little-endian) on the desktop.
   * `sampleRate` is the rate of the PCM sent (the app records at 16 kHz, mono).
   */
  async transcribePcm(
    pcm: string,
    sampleRate: number,
    opts?: { engine?: VoiceEngineId; modelId?: string | null; language?: string },
  ): Promise<HttpResult<VoiceTranscribeResponse>> {
    return this.request('POST', '/api/voice/transcribe', { pcm, sampleRate, ...opts })
  }

  /**
   * Reads the text aloud: the desktop synthesizes it and returns the signed URL of the
   * WAV. The opposite path of dictation — there the audio goes and the text comes back.
   *
   * `voice`/`lang`/`speed` omitted use the desktop voice preferences,
   * which is what one wants on a simple button tap.
   */
  async speak(
    text: string,
    opts?: { voice?: string; lang?: string; speed?: number },
  ): Promise<HttpResult<VoiceSpeakResponse>> {
    return this.request('POST', '/api/voice/speak', { text, ...opts })
  }

  /** State of the desktop voice engines (ready + installed per engine). */
  async getVoiceStatus(): Promise<HttpResult<VoiceStatusResponse>> {
    return this.get('/api/voice/status')
  }

  // ─── Git Branches ────────────────────────────────────────────────────────

  async getBranches(repoPath: string): Promise<HttpResult<{ branches: string[]; current: string }>> {
    return this.request('POST', '/api/git/branches', { repoPath })
  }

  async checkoutBranch(repoPath: string, branch: string): Promise<HttpResult<{ ok: boolean }>> {
    return this.request('POST', '/api/git/checkout', { repoPath, branch })
  }

  // ─── Status ──────────────────────────────────────────────────────────────

  async getStatus(): Promise<HttpResult<{ online: boolean; activeSessions: number; pendingAsks: number; uptime: number }>> {
    return this.get('/api/status')
  }

  // ─── Media ───────────────────────────────────────────────────────────────
  // The media registry lives on the desktop (orbit-data/media). The server returns
  // the entries with `url` already signed (token in the query) for the native <Image>.

  async listMedia(): Promise<HttpResult<MediaEntry[]>> {
    return this.get('/api/media')
  }

  async mediaUsage(): Promise<HttpResult<MediaUsage>> {
    return this.get('/api/media/usage')
  }

  async deleteMedia(id: string): Promise<HttpResult<{ deleted: boolean }>> {
    return this.request('DELETE', `/api/media/${encodeURIComponent(id)}`)
  }

  async deleteManyMedia(ids: string[]): Promise<HttpResult<{ removed: number }>> {
    return this.request('POST', '/api/media/delete', { ids })
  }

  // ─── Sources ────────────────────────────────────────────────────────────

  listSources(sessionId: string): Promise<HttpResult<CompanionSourcesList>> {
    return this.get(`/api/sources/${encodeURIComponent(sessionId)}`)
  }

  /** A file as base64 — same format as the desktop IPC. */
  addSourceFile(sessionId: string, filename: string, data: string, shared: boolean): Promise<HttpResult<{ id: string }>> {
    return this.request('POST', `/api/sources/${encodeURIComponent(sessionId)}/file`, { filename, data, shared })
  }

  addSourceText(sessionId: string, title: string, text: string, shared: boolean): Promise<HttpResult<{ id: string }>> {
    return this.request('POST', `/api/sources/${encodeURIComponent(sessionId)}/text`, { title, text, shared })
  }

  addSourceUrl(sessionId: string, url: string, shared: boolean): Promise<HttpResult<{ id: string }>> {
    return this.request('POST', `/api/sources/${encodeURIComponent(sessionId)}/url`, { url, shared })
  }

  /** Moves between the conversation (`docN`) and the folder (`srcN`); the id changes. */
  setSourceShared(sessionId: string, docId: string, shared: boolean): Promise<HttpResult<{ id: string }>> {
    return this.request('POST', `/api/sources/${encodeURIComponent(sessionId)}/${encodeURIComponent(docId)}/share`, { shared })
  }

  removeSource(sessionId: string, docId: string): Promise<HttpResult<{ removed: boolean }>> {
    return this.request('DELETE', `/api/sources/${encodeURIComponent(sessionId)}/${encodeURIComponent(docId)}`)
  }

  // ─── Session files ───────────────────────────────────────────────────────
  // Browse/read/search/write the working folders of a session. Paths are relative to a
  // root the desktop validates against the session (see @shared/companion-files).

  async listFiles(req: FilesListRequest): Promise<HttpResult<FilesListResponse>> {
    return this.request('POST', '/api/files/list', req)
  }

  async readFile(req: FilesReadRequest): Promise<HttpResult<FilesReadResponse>> {
    return this.request('POST', '/api/files/read', req)
  }

  /** A refused write (`stale`, `binary`…) is still `ok: true` here: read `data.ok`. */
  async writeFile(req: FilesWriteRequest): Promise<HttpResult<FilesWriteResponse>> {
    return this.request('POST', '/api/files/write', req)
  }

  async searchFiles(req: FilesSearchRequest): Promise<HttpResult<FilesSearchResponse>> {
    return this.request('POST', '/api/files/search', req)
  }

  // ─── Live view (browser / computer panels) ───────────────────────────────

  async liveList(): Promise<HttpResult<LiveListResponse>> {
    return this.get('/api/live')
  }

  /** `since` = the revision the phone already shows; the desktop answers `unchanged` without encoding. */
  async liveFrame(sessionId: string, kind: LiveKind, since?: number): Promise<HttpResult<LiveFrameResponse>> {
    const q = `sessionId=${encodeURIComponent(sessionId)}&kind=${kind}${since ? `&since=${since}` : ''}`
    return this.get(`/api/live/frame?${q}`)
  }

  async liveStop(sessionId: string, kind: LiveKind): Promise<HttpResult<{ stopped: boolean }>> {
    return this.request('POST', '/api/live/stop', { sessionId, kind })
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private get<T = unknown>(path: string): Promise<HttpResult<T>> {
    return this.request('GET', path)
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<HttpResult<T>> {
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
      }

      const init: RequestInit = { method, headers }

      if (body !== undefined) {
        headers['Content-Type'] = 'application/json'
        init.body = JSON.stringify(body)
      }

      const response = await this.fetchImpl(`${this.baseUrl}${path}`, init)

      if (!response.ok) {
        const text = await response.text().catch(() => 'Unknown error')
        return { ok: false, error: `${response.status}: ${text}` }
      }

      // 204 No Content
      if (response.status === 204) {
        return { ok: true }
      }

      const data = (await response.json()) as T
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }
}
