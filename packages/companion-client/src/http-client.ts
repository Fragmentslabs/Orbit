/**
 * Cliente HTTP para o REST API do Orbit Desktop.
 *
 * Usado para operações simples de configuração (preferences, models, catalog)
 * que não precisam de streaming. Autenticação via Bearer token (PIN).
 */

import type { ConnectionConfig } from './types'
import type { MediaEntry, MediaUsage } from '@orbit/shared'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HttpResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

// ─── CompanionHttp ───────────────────────────────────────────────────────────

export class CompanionHttp {
  private baseUrl: string
  private token: string

  constructor(config: ConnectionConfig) {
    this.baseUrl = `http://${config.host}:${config.port + 1}`
    // Usa o token persistente quando disponível (não expira como o PIN)
    this.token = config.token ?? config.pin
  }

  /** Atualiza a configuração (host/port/pin) após reconexão. */
  updateConfig(config: ConnectionConfig): void {
    this.baseUrl = `http://${config.host}:${config.port + 1}`
    this.token = config.token ?? config.pin
  }

  /** Substitui o token usado na autenticação (ex: após WS emitir token persistente). */
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

  // ─── Models ──────────────────────────────────────────────────────────────

  async getSelectedModel(): Promise<HttpResult<{ providerId: string; modelId: string; workerModelId?: string }>> {
    return this.get('/api/models/selected')
  }

  async selectModel(providerId: string, modelId: string): Promise<HttpResult> {
    return this.request('PUT', '/api/models/selected', { providerId, modelId })
  }

  async getCatalog(): Promise<HttpResult> {
    return this.get('/api/catalog')
  }

  /** Overrides de modelo por sessão (mapa sessionId → modelo) mantidos pelo
   *  renderer do desktop. Usado para o mobile herdar o modelo por chat. */
  async getSessionModels(): Promise<HttpResult<{ overrides: Record<string, { providerId: string; modelId: string }> }>> {
    return this.get('/api/session-models')
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
   * Dispara o fluxo OAuth do servidor no desktop. Responde na hora (202) —
   * o navegador abre no computador e o desfecho aparece no /api/mcp/status.
   */
  async authorizeMcp(name: string): Promise<HttpResult> {
    return this.request('POST', `/api/mcp/servers/${encodeURIComponent(name)}/authorize`)
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
  // O registry de mídia vive no desktop (orbit-data/media). O servidor devolve
  // as entradas com `url` já assinada (token na query) para o <Image> nativo.

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

      const response = await fetch(`${this.baseUrl}${path}`, init)

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
