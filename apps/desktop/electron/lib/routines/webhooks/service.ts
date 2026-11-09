import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Routine, WebhookActivity, WebhookDelivery, WebhookInfo } from '@shared/routines'
import { createReceiver, type ReceiverDeps, type WebhookRequest, type WebhookTarget } from './receiver'
import { drainWebhook, superviseWebhooks, withRoutineLock, type WebhookSupervisorDeps } from './supervisor'
import { WEBHOOK_PATH_PREFIX } from './guard'
import { listRoutines } from '../repo'
import {
  currentToken,
  emptyWebhookActivity,
  ensureWebhookRecord,
  readLastPort,
  readWebhookRecord,
  rotateWebhookToken,
  withDelivery,
  writeLastPort,
  writeWebhookRecord,
} from './store'

/**
 * The local listener for webhook-triggered routines. It binds 127.0.0.1 only, on a random port
 * (the last one is tried first so an address survives a restart), and exists only while at least
 * one active routine is woken by a webhook. The app never opens anything to the internet: the
 * person points their own tunnel at the address shown on the routine.
 */

const HOST = '127.0.0.1'
/** At most this many payloads wait for a run; the oldest are dropped first. */
const MAX_PENDING = 5

let server: http.Server | null = null
let port: number | null = null
let starting: Promise<void> | null = null
let deps: WebhookSupervisorDeps | null = null

const isWebhookRoutine = (r: Routine): boolean => r.active && r.trigger?.kind === 'webhook'

async function findByTokenHash(hash: string): Promise<WebhookTarget | null> {
  for (const routine of (await listRoutines()).filter(isWebhookRoutine)) {
    const record = await readWebhookRecord(routine.id)
    if (record?.tokenHash === hash) return { routine, record }
  }
  return null
}

async function recordDelivery(routineId: string, delivery: WebhookDelivery, payload?: string): Promise<void> {
  const activity = await withRoutineLock(routineId, async (): Promise<WebhookActivity | null> => {
    const record = await readWebhookRecord(routineId)
    if (!record) return null
    const base = withDelivery(record.activity, delivery)
    const next = payload === undefined ? base : { ...base, pending: [...base.pending, payload].slice(-MAX_PENDING) }
    await writeWebhookRecord(routineId, { ...record, activity: next })
    return next
  })
  if (!activity || !deps) return
  deps.onActivity(activity)
  if (payload !== undefined) {
    const routine = (await listRoutines()).find((r) => r.id === routineId)
    if (routine) await drainWebhook(routine, deps)
  }
}

const receiverDeps: ReceiverDeps = { now: Date.now, findByTokenHash, record: recordDelivery }
const handle = createReceiver(receiverDeps)

function adapt(req: http.IncomingMessage): WebhookRequest {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers[name] = value
  return {
    method: req.method ?? '',
    path: req.url ?? '',
    headers,
    readBody: (limit) =>
      new Promise((resolve) => {
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > limit) {
            chunks.length = 0
            req.removeAllListeners('data')
            resolve(null)
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks)))
        req.on('error', () => resolve(null))
      }),
  }
}

function createServer(): http.Server {
  const created = http.createServer((req, res) => {
    void handle(adapt(req))
      .catch((err) => {
        console.error('[routines] webhook request failed:', err)
        return { status: 500, body: '{"ok":false,"error":"Internal error."}' }
      })
      .then(({ status, body }) => {
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' })
        res.end(body)
      })
  })
  created.requestTimeout = 10_000
  created.headersTimeout = 5_000
  created.maxHeadersCount = 50
  created.keepAliveTimeout = 1_000
  return created
}

function listen(candidate: http.Server, wanted: number): Promise<boolean> {
  return new Promise((resolve) => {
    candidate.once('error', () => resolve(false))
    candidate.listen(wanted, HOST, () => resolve(true))
  })
}

async function start(): Promise<void> {
  const lastPort = await readLastPort()
  let candidate = createServer()
  if (!(lastPort !== null && (await listen(candidate, lastPort)))) {
    candidate.close()
    candidate = createServer()
    if (!(await listen(candidate, 0))) {
      console.error('[routines] the webhook listener could not start')
      return
    }
  }
  candidate.on('error', (err) => console.error('[routines] webhook listener error:', err))
  server = candidate
  port = (candidate.address() as AddressInfo).port
  await writeLastPort(port).catch(() => undefined)
  console.log(`[routines] webhook listener on ${HOST}:${port}`)
}

function stop(): void {
  server?.close()
  server?.closeAllConnections()
  server = null
  port = null
}

/**
 * Called on every scheduler tick: brings the listener up or down to match the routines, makes
 * sure each one has its address, and hands waiting payloads to the routines that can take them.
 */
export async function tickWebhooks(routines: readonly Routine[], supervisorDeps: WebhookSupervisorDeps): Promise<void> {
  deps = supervisorDeps
  const active = routines.filter(isWebhookRoutine)
  if (active.length === 0) {
    stop()
    return
  }
  await Promise.all(active.map((r) => ensureWebhookRecord(r.id, r.trigger?.kind === 'webhook' && !!r.trigger.signed)))
  if (!server) await (starting ??= start().finally(() => (starting = null)))
  await superviseWebhooks(routines, supervisorDeps)
}

export function stopWebhooks(): void {
  stop()
  deps = null
}

/** What the routine screen shows: the local address, the secret (if signed) and the latest calls. */
export async function webhookInfo(routineId: string): Promise<WebhookInfo | null> {
  const routine = (await listRoutines()).find((r) => r.id === routineId)
  if (!routine || routine.trigger?.kind !== 'webhook') return null
  const record = await ensureWebhookRecord(routine.id, !!routine.trigger.signed)
  const listening = server !== null && port !== null && routine.active
  return {
    listening,
    ...(listening ? { url: `http://${HOST}:${port}${WEBHOOK_PATH_PREFIX}${await currentToken(routine.id, record)}` } : {}),
    ...(record.secret ? { secret: record.secret } : {}),
    activity: record.activity ?? emptyWebhookActivity(routine.id),
  }
}

/** A new address for the routine; the old one stops working at once. */
export async function rotateWebhook(routineId: string): Promise<WebhookInfo | null> {
  await rotateWebhookToken(routineId)
  return webhookInfo(routineId)
}
