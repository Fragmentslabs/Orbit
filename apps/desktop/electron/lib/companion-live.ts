import type { IncomingMessage, ServerResponse } from 'http'
import sharp from 'sharp'
import { LIVE_FRAME_MAX_EDGE, LIVE_FRAME_QUALITY, type LiveKind, type LiveState } from '@shared/live'
import { onComputerEvent, stopComputer } from './computer'
import { shotView } from './computer/shots'
import {
  createLiveThrottle,
  fitFrameSize,
  liveFrameRequest,
  liveListRequest,
  liveStopRequest,
  LiveRegistry,
  type EncodedFrame,
  type LiveDeps,
  type LiveResult,
} from './companion-live-core'
import { onPanelLive, panelLiveWebContents } from './panel-browser'
import { abortSession } from './send-dispatch'

/**
 * Wires the real browser/computer panels into the phone's live view. The state machine and the
 * request logic live in companion-live-core.ts; this file only observes the panels, encodes
 * frames and answers the three HTTP routes.
 *
 * View-first: there is no input path from the phone into either panel (the desktop has no
 * safe remote-input API for them — only the agent drives them). The only action the phone
 * has is Stop, which aborts the turn exactly like the desktop's Stop / ⌘⇧. does.
 */

const CAPTURE_TIMEOUT_MS = 4_000
/** Minimum gap between two pushes for the same surface. */
const PUSH_INTERVAL_MS = 500

export const liveRegistry = new LiveRegistry()

/** Last screenshot the agent itself took, per chat — the fallback when the panel does not paint. */
const agentShots = new Map<string, Buffer>()
const watchedWebContents = new Map<string, () => void>()

async function encode(input: Buffer): Promise<{ jpeg: Buffer; width: number; height: number; srcWidth: number; srcHeight: number } | null> {
  const meta = await sharp(input).metadata()
  if (!meta.width || !meta.height) return null
  const size = fitFrameSize(meta.width, meta.height, LIVE_FRAME_MAX_EDGE)
  const jpeg = await sharp(input)
    .resize(size.width, size.height, { fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: LIVE_FRAME_QUALITY })
    .toBuffer()
  return { jpeg, ...size, srcWidth: meta.width, srcHeight: meta.height }
}

const toDataUrl = (jpeg: Buffer) => `data:image/jpeg;base64,${jpeg.toString('base64')}`

async function captureBrowser(sessionId: string): Promise<EncodedFrame | null> {
  const wc = panelLiveWebContents(sessionId)
  let source: Buffer | null = null
  if (wc) {
    const image = await Promise.race([
      wc.capturePage().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS)),
    ])
    // A hidden webview returns an empty image: fall through to the agent's own screenshot.
    if (image && !image.isEmpty()) source = image.toPNG()
  }
  source ??= agentShots.get(sessionId) ?? null
  if (!source) return null
  const out = await encode(source)
  return out ? { dataUrl: toDataUrl(out.jpeg), width: out.width, height: out.height, marker: null } : null
}

async function captureComputer(sessionId: string): Promise<EncodedFrame | null> {
  const shot = shotView(sessionId)
  if (!shot) return null
  const comma = shot.dataUrl.indexOf(',')
  if (comma < 0) return null
  const out = await encode(Buffer.from(shot.dataUrl.slice(comma + 1), 'base64'))
  if (!out) return null
  const sx = out.width / Math.max(1, shot.width)
  const sy = out.height / Math.max(1, shot.height)
  const marker = shot.marker
    ? { x: shot.marker.x * sx, y: shot.marker.y * sy, w: shot.marker.w * sx, h: shot.marker.h * sy, label: shot.marker.label }
    : null
  return { dataUrl: toDataUrl(out.jpeg), width: out.width, height: out.height, marker }
}

const deps: LiveDeps = {
  registry: liveRegistry,
  captureFrame: (kind, sessionId) => (kind === 'browser' ? captureBrowser(sessionId) : captureComputer(sessionId)),
  stop: (kind, sessionId) => (kind === 'computer' ? stopComputer(sessionId) : abortSession(sessionId)),
}

function readBrowserMeta(sessionId: string): { url: string | null; title: string | null } {
  const wc = panelLiveWebContents(sessionId)
  if (!wc) return { url: null, title: null }
  const url = wc.getURL()
  return { url: !url || url === 'about:blank' ? null : url, title: wc.getTitle() || null }
}

/** Keeps URL/title/frame fresh when the page changes by itself (loads, redirects), not only on agent actions. */
function watchBrowser(sessionId: string): void {
  const wc = panelLiveWebContents(sessionId)
  if (!wc || watchedWebContents.has(sessionId)) return
  const onChange = () => {
    liveRegistry.update('browser', sessionId, readBrowserMeta(sessionId))
    liveRegistry.frame('browser', sessionId)
  }
  wc.on('did-stop-loading', onChange)
  wc.on('page-title-updated', onChange)
  watchedWebContents.set(sessionId, () => {
    if (wc.isDestroyed()) return
    wc.off('did-stop-loading', onChange)
    wc.off('page-title-updated', onChange)
  })
}

function unwatchBrowser(sessionId: string): void {
  watchedWebContents.get(sessionId)?.()
  watchedWebContents.delete(sessionId)
}

let started = false

/** Starts observing the panels; `send` pushes one throttled state to the connected phones. */
export function startCompanionLive(send: (state: LiveState) => void): void {
  if (started) return
  started = true
  liveRegistry.subscribe(createLiveThrottle(send, PUSH_INTERVAL_MS))

  onPanelLive((event) => {
    const { sessionId } = event
    if (event.type === 'activity') {
      // The first agent action is what makes the browser a "live" surface (an idle tab the person
      // opened by hand is not worth a chip).
      liveRegistry.update('browser', sessionId, readBrowserMeta(sessionId))
      liveRegistry.action('browser', sessionId, event.label)
      watchBrowser(sessionId)
      liveRegistry.frame('browser', sessionId)
    } else if (event.type === 'screenshot') {
      agentShots.set(sessionId, event.data)
      liveRegistry.frame('browser', sessionId)
    } else if (event.type === 'unregistered') {
      unwatchBrowser(sessionId)
      agentShots.delete(sessionId)
      liveRegistry.close('browser', sessionId)
    } else if (liveRegistry.state('browser', sessionId)?.active) {
      // Re-registered (the tab moved): refresh the metadata and listeners.
      watchBrowser(sessionId)
      liveRegistry.update('browser', sessionId, readBrowserMeta(sessionId))
    }
  })

  onComputerEvent((event) => {
    if (event.type === 'active') {
      const { activity } = event
      liveRegistry.open('computer', activity.sessionId, { app: activity.app })
      if (activity.lastAction) liveRegistry.action('computer', activity.sessionId, activity.lastAction)
    } else if (event.type === 'idle') {
      liveRegistry.close('computer', event.sessionId)
    } else {
      liveRegistry.frame('computer', event.sessionId)
    }
  })
}

// ─── HTTP routes ─────────────────────────────────────────────────────────────

function respond(res: ServerResponse, result: LiveResult): void {
  const body = JSON.stringify(result.body)
  res.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(body)
}

function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams
}

export async function handleLiveList(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  respond(res, liveListRequest(deps))
}

export async function handleLiveFrame(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const q = queryOf(req)
  respond(res, await liveFrameRequest(deps, { sessionId: q.get('sessionId'), kind: q.get('kind'), since: q.get('since') }))
}

export async function handleLiveStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  let body: { sessionId?: unknown; kind?: unknown } = {}
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    respond(res, { status: 400, body: { error: 'Invalid JSON' } })
    return
  }
  respond(res, liveStopRequest(deps, body))
}

export type { LiveKind }
