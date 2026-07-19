/**
 * Cliente HTTP para o REST API do Orbit Desktop.
 *
 * Usado para operações simples de configuração (preferences, models, catalog)
 * que não precisam de streaming. Autenticação via Bearer token (PIN).
 */

import type { ConnectionConfig } from './types'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HttpResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

// ─── CompanionHttp ───────────────────────────────────────────────────────────

export class CompanionHttp {
  private baseUrl: string
  private pin: string

  constructor(config: ConnectionConfig) {
    this.baseUrl = `http://${config.host}:${config.port + 1}`
    this.pin = config.pin
  }

  /** Atualiza a configuração (host/port/pin) após reconexão. */
  updateConfig(config: ConnectionConfig): void {
    this.baseUrl = `http://${config.host}:${config.port + 1}`
    this.pin = config.pin
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

  async getConnectedProviders(): Promise<HttpResult<string[]>> {
    return this.get('/api/providers/connected')
  }

  // ─── Skills ───────────────────────────────────────────────────────────────

  async getSkills(directory?: string): Promise<HttpResult> {
    const qs = directory ? `?directory=${encodeURIComponent(directory)}` : ''
    return this.get(`/api/skills${qs}`)
  }

  // ─── MCP ──────────────────────────────────────────────────────────────────

  async getMcpStatus(): Promise<HttpResult> {
    return this.get('/api/mcp/status')
  }

  // ─── Status ──────────────────────────────────────────────────────────────

  async getStatus(): Promise<HttpResult<{ online: boolean; activeSessions: number; pendingAsks: number; uptime: number }>> {
    return this.get('/api/status')
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
        Authorization: `Bearer ${this.pin}`,
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
