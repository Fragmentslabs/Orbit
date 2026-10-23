import { randomBytes } from 'node:crypto'
import type { ShotGeometry } from './geometry'
import { ComputerError, type AppInfo, type Frame, type WindowInfo } from './types'

/**
 * Observações numeradas por sessão. Cada índice mostrado ao modelo vira um
 * handle serializável (caminho + identidade) — a bridge não guarda elementos
 * entre processos, então a ação re-encontra o elemento pelo caminho e confere
 * que ainda é o mesmo. Uma observação nova do mesmo app invalida a anterior.
 */

/** Depois disso a observação vence: a tela provavelmente mudou. */
export const OBSERVATION_TTL_MS = 120_000

export interface ElementHandle {
  index: number
  path: number[]
  role: string
  title: string | null
  /** Pontos globais */
  frame: Frame | null
  actions: string[]
  secure: boolean
}

export interface ObservationRecord {
  id: string
  sessionId: string
  createdAt: number
  app: AppInfo
  window: WindowInfo
  geometry: ShotGeometry
  /** O screenshot existe? Sem ele as coordenadas são pontos da janela. */
  hasScreenshot: boolean
  url: string | null
  elements: Map<number, ElementHandle>
  /** Resumo da árvore — duas observações iguais seguidas = a ação não mudou nada */
  digest: string | null
}

export function newObservationId(): string {
  return `obs_${randomBytes(4).toString('hex')}`
}

export function createRegistry(now: () => number = Date.now) {
  /** sessão → pid → observação mais recente */
  const bySession = new Map<string, Map<number, ObservationRecord>>()
  /** pid → o app e a URL da última observação, de qualquer sessão (para o gate) */
  const recent = new Map<number, { bundleId: string | null; name: string; pid: number; url: string | null }>()

  function fresh(record: ObservationRecord): ObservationRecord {
    if (now() - record.createdAt > OBSERVATION_TTL_MS) {
      throw new ComputerError(
        'staleIndex',
        `Observation ${record.id} expired (older than ${OBSERVATION_TTL_MS / 1000}s) — call cu_observe again before acting.`,
      )
    }
    return record
  }

  return {
    record(record: ObservationRecord): void {
      const apps = bySession.get(record.sessionId) ?? new Map<number, ObservationRecord>()
      apps.set(record.app.pid, record)
      bySession.set(record.sessionId, apps)
      recent.delete(record.app.pid)
      recent.set(record.app.pid, { bundleId: record.app.bundleId, name: record.app.name, pid: record.app.pid, url: record.url })
    },

    /** A observação mais recente de um app nesta sessão, se houver (sem checar validade). */
    peek(sessionId: string, pid: number): ObservationRecord | null {
      return bySession.get(sessionId)?.get(pid) ?? null
    },

    /**
     * A observação contra a qual uma ação é resolvida. Com `observationId`,
     * precisa ser exatamente a mais recente daquele app — índice de uma
     * observação anterior é erro explícito, nunca um clique no lugar errado.
     */
    forAction(sessionId: string, pid: number, observationId?: string): ObservationRecord {
      const latest = bySession.get(sessionId)?.get(pid)
      if (!latest) {
        throw new ComputerError('staleIndex', 'There is no observation of this app yet — call cu_observe first.')
      }
      if (observationId && observationId !== latest.id) {
        throw new ComputerError(
          'staleIndex',
          `Observation ${observationId} is not the latest for this app (latest: ${latest.id}) — its indices are no longer valid. Use the latest observation or call cu_observe again.`,
        )
      }
      return fresh(latest)
    },

    element(record: ObservationRecord, index: number): ElementHandle {
      const handle = record.elements.get(index)
      if (!handle) {
        throw new ComputerError('staleIndex', `Index ${index} does not exist in observation ${record.id} — call cu_observe again.`)
      }
      return handle
    },

    /**
     * O app observado mais recentemente que casa com o texto do modelo (bundle
     * id, nome ou pid) — o gate de permissões não resolve apps, só lê isto
     * para pedir aprovação pelo bundle e pelo site certos.
     */
    lastTargetFor(query: string): { bundleId: string | null; name: string; pid: number; url: string | null } | null {
      const q = query.trim().toLowerCase()
      const list = [...recent.values()].reverse()
      return (
        list.find((t) => String(t.pid) === q || t.bundleId?.toLowerCase() === q || t.name.toLowerCase() === q) ??
        list.find((t) => t.name.toLowerCase().includes(q)) ??
        null
      )
    },

    clear(sessionId: string): void {
      bySession.delete(sessionId)
    },

    sessions(): string[] {
      return [...bySession.keys()]
    },
  }
}

export type Registry = ReturnType<typeof createRegistry>

/** O registro do app. Mora aqui (sem electron) para o gate de permissões poder ler a URL vista. */
export const computerRegistry = createRegistry()
