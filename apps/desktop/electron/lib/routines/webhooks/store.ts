import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { MAX_WEBHOOK_DELIVERIES_KEPT, type WebhookActivity, type WebhookDelivery } from '@shared/routines'
import { scriptsDir } from '../repo'
import { deriveToken, sha256Hex } from './guard'

/**
 * What is kept on disk for webhook-triggered routines, next to the scripts' records:
 * - `key`: the app's own random key; tokens are derived from it, so no file holds a raw token.
 * - `<routineId>.json`: the hash of the current token, the signing secret and the activity.
 * - `listener.json`: the last port, so the address survives a restart when the port is free.
 */

export interface WebhookRecord {
  /** Bumped to rotate the token (the old address stops working). */
  epoch: number
  tokenHash: string
  /** Signing secret, present when the routine demands a signature. */
  secret?: string
  activity: WebhookActivity
}

function dir(): string {
  return path.join(path.dirname(scriptsDir()), 'webhooks')
}

/** The id becomes a file name. */
function fileFor(routineId: string): string | null {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(routineId) ? path.join(dir(), `${routineId}.json`) : null
}

async function writeAtomic(file: string, text: string, mode = 0o600): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, text, { encoding: 'utf8', mode })
  await fsp.rename(tmp, file)
}

let cachedKey: Buffer | null = null

async function appKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey
  const file = path.join(dir(), 'key')
  try {
    cachedKey = Buffer.from((await fsp.readFile(file, 'utf8')).trim(), 'base64url')
    if (cachedKey.length === 32) return cachedKey
  } catch {
    // first use
  }
  cachedKey = crypto.randomBytes(32)
  await writeAtomic(file, cachedKey.toString('base64url'))
  return cachedKey
}

export function emptyWebhookActivity(routineId: string): WebhookActivity {
  return { routineId, deliveries: [], pending: [] }
}

export async function readWebhookRecord(routineId: string): Promise<WebhookRecord | null> {
  const file = fileFor(routineId)
  if (!file) return null
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<WebhookRecord>
    if (typeof raw.tokenHash !== 'string' || typeof raw.epoch !== 'number') return null
    return {
      epoch: raw.epoch,
      tokenHash: raw.tokenHash,
      ...(typeof raw.secret === 'string' ? { secret: raw.secret } : {}),
      activity: { ...emptyWebhookActivity(routineId), ...raw.activity, routineId },
    }
  } catch {
    return null
  }
}

export async function writeWebhookRecord(routineId: string, record: WebhookRecord): Promise<void> {
  const file = fileFor(routineId)
  if (file) await writeAtomic(file, JSON.stringify(record))
}

export async function removeWebhookRecord(routineId: string): Promise<void> {
  const file = fileFor(routineId)
  if (file) await fsp.rm(file, { force: true })
}

/** The record of a routine, created (with a fresh address) the first time it is needed. */
export async function ensureWebhookRecord(routineId: string, signed: boolean): Promise<WebhookRecord> {
  const existing = await readWebhookRecord(routineId)
  const base: WebhookRecord = existing ?? {
    epoch: 1,
    tokenHash: sha256Hex(deriveToken(await appKey(), routineId, 1)),
    activity: emptyWebhookActivity(routineId),
  }
  const secret = signed ? (base.secret ?? crypto.randomBytes(24).toString('base64url')) : undefined
  const next: WebhookRecord = { epoch: base.epoch, tokenHash: base.tokenHash, ...(secret ? { secret } : {}), activity: base.activity }
  if (!existing || next.secret !== existing.secret) await writeWebhookRecord(routineId, next)
  return next
}

/** A new address: the old one stops working at once. */
export async function rotateWebhookToken(routineId: string): Promise<WebhookRecord | null> {
  const record = await readWebhookRecord(routineId)
  if (!record) return null
  const epoch = record.epoch + 1
  const next = { ...record, epoch, tokenHash: sha256Hex(deriveToken(await appKey(), routineId, epoch)) }
  await writeWebhookRecord(routineId, next)
  return next
}

/** The token of the current address, for showing it to the person. */
export async function currentToken(routineId: string, record: WebhookRecord): Promise<string> {
  return deriveToken(await appKey(), routineId, record.epoch)
}

export function withDelivery(activity: WebhookActivity, delivery: WebhookDelivery): WebhookActivity {
  return { ...activity, deliveries: [...activity.deliveries, delivery].slice(-MAX_WEBHOOK_DELIVERIES_KEPT) }
}

export async function readLastPort(): Promise<number | null> {
  try {
    const port = (JSON.parse(await fsp.readFile(path.join(dir(), 'listener.json'), 'utf8')) as { port?: unknown }).port
    return typeof port === 'number' && port >= 1024 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

export async function writeLastPort(port: number): Promise<void> {
  await writeAtomic(path.join(dir(), 'listener.json'), JSON.stringify({ port }), 0o644)
}
