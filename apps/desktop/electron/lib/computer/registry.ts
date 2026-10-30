import { randomBytes } from 'node:crypto'
import type { ShotGeometry } from './geometry'
import { ComputerError, type AppInfo, type Frame, type WindowInfo } from './types'

/**
 * Observations numbered by session. Each index shown to the model becomes a
 * serializable handle (path + identity) — the macOS bridge does not keep elements
 * between processes, so the action finds the element again by the path and checks that
 * it is still the same one; the Windows host keeps it, and the `ref` is the key. A new
 * observation of the same app invalidates the previous one.
 */

/** After this the observation expires: the screen has probably changed. */
export const OBSERVATION_TTL_MS = 120_000

export interface ElementHandle {
  index: number
  path: number[]
  /** Identity from the host (Windows); the action goes by it and uses the `path` as a fallback */
  ref?: string
  /** Role in the AX vocabulary (what the model sees) */
  role: string
  /** Role as the host sent it (UIA on Windows) — it is with it that the host checks the identity */
  nativeRole?: string
  title: string | null
  /** Global points */
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
  /** Does the screenshot exist? Without it the coordinates are window points. */
  hasScreenshot: boolean
  url: string | null
  elements: Map<number, ElementHandle>
  /** Summary of the tree — two identical observations in a row = the action changed nothing */
  digest: string | null
  /** Identity → index: the next observation of the same window keeps the indices */
  keys?: Map<string, number>
  /** Index → line: the base of the diff. Absent when the tree was not read whole (cu_query) */
  bodies?: Map<number, string>
  /** How many diffs in a row since the last full tree (0 = this one is full) */
  diffChain?: number
}

/** The last app observed with a pid — what the permission gate reads. */
export interface RecentTarget {
  bundleId: string | null
  name: string
  pid: number
  url: string | null
  /** Windows: the exe ("chrome.exe") — it is what says whether the app is a browser */
  exe?: string
}

export function newObservationId(): string {
  return `obs_${randomBytes(4).toString('hex')}`
}

export function createRegistry(now: () => number = Date.now) {
  /** session → pid → most recent observation */
  const bySession = new Map<string, Map<number, ObservationRecord>>()
  /** pid → the app and the URL of the last observation, from any session (for the gate) */
  const recent = new Map<number, RecentTarget>()

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
      recent.set(record.app.pid, {
        bundleId: record.app.bundleId,
        name: record.app.name,
        pid: record.app.pid,
        url: record.url,
        ...(record.app.exe ? { exe: record.app.exe } : {}),
      })
    },

    /** The most recent observation of an app in this session, if there is one (without checking validity). */
    peek(sessionId: string, pid: number): ObservationRecord | null {
      return bySession.get(sessionId)?.get(pid) ?? null
    },

    /**
     * The observation against which an action is resolved. With `observationId`, it has to
     * be exactly the most recent one of that app — an index from an earlier observation is
     * an explicit error, never a click in the wrong place.
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
     * The most recently observed app that matches the model's text (bundle id, name or
     * pid) — the permission gate does not resolve apps, it only reads this to ask for
     * approval by the right bundle and site.
     */
    lastTargetFor(query: string): RecentTarget | null {
      const q = query.trim().toLowerCase()
      const list = [...recent.values()].reverse()
      const exe = (t: RecentTarget) => t.exe?.toLowerCase()
      return (
        list.find((t) => String(t.pid) === q || t.bundleId?.toLowerCase() === q || t.name.toLowerCase() === q || exe(t) === q || exe(t) === `${q}.exe`) ??
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

/** The app registry. It lives here (without electron) so the permission gate can read the URL seen. */
export const computerRegistry = createRegistry()
