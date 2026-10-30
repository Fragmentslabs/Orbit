import type { AskItem } from '@shared/chat'
import { ask, newRequestId } from './ask-broker'
import { broadcastChatEvent } from './broadcast'
import { notifyPendingAsk, notifyPendingAskBatch } from './notifications'
import { notifyCompanionAsk } from './companion-server'

/**
 * Emission layer of the requests (above the ask-broker, which stays pure):
 * - Main session request: immediate individual event.
 * - WORKER request (it has an origin): enters a 1.5s batching window per parent
 *   session — 4 workers asking in parallel become ONE batch card in the
 *   orchestrator's chat, with a single submit.
 * The "ask:done" per item keeps being emitted by the requester (finally).
 */

const BATCH_WINDOW_MS = 1500

interface PendingBatch {
  items: AskItem[]
  timer: NodeJS.Timeout
}

const batches = new Map<string, PendingBatch>()

/**
 * Human title of the request for the companion. Empty when the item does not bring its own
 * text: the mobile app (which may be in another language) applies its own translated
 * fallback — sending a ready-made sentence from here was what made a phone in
 * English receive a notice in Portuguese. The desktop's native notification resolves the
 * fallback on this side, in lib/notifications.ts.
 */
function requestTitle(item: AskItem): string {
  if (item.kind === 'subchat') return item.subchat?.title ?? ''
  return item.kind === 'permission' ? (item.claim?.title ?? '') : (item.questions?.[0]?.text ?? '')
}

function emitSingle(target: string, item: AskItem): void {
  void notifyPendingAsk(target, item)
  notifyCompanionAsk(
    target,
    item.requestId,
    item.kind === 'permission' ? 'permission' : 'question',
    requestTitle(item),
    item.questions,
  )
  if (item.kind === 'subchat') {
    broadcastChatEvent({
      type: 'subchat',
      sessionId: target,
      requestId: item.requestId,
      title: item.subchat?.title ?? '',
      brief: item.subchat?.brief ?? '',
      scope: item.subchat?.scope,
      origin: item.origin,
    })
    return
  }
  broadcastChatEvent(
    item.kind === 'permission'
      ? {
          type: 'permission',
          sessionId: target,
          requestId: item.requestId,
          claim: item.claim!,
          origin: item.origin,
        }
      : {
          type: 'question',
          sessionId: target,
          requestId: item.requestId,
          questions: item.questions ?? [],
          origin: item.origin,
        },
  )
}

function flushBatch(target: string): void {
  const batch = batches.get(target)
  if (!batch) return
  batches.delete(target)
  if (batch.items.length === 0) return
  if (batch.items.length === 1) {
    emitSingle(target, batch.items[0])
    return
  }
  void notifyPendingAskBatch(target, batch.items)
  const first = batch.items[0]
  notifyCompanionAsk(
    target,
    first.requestId,
    first.kind === 'permission' ? 'permission' : 'question',
    requestTitle(first),
    first.questions,
  )
  broadcastChatEvent({ type: 'ask:batch', sessionId: target, batchId: newRequestId(), items: batch.items })
}

/** Removes an item not yet emitted (request rejected by an abort in the window). */
function dropFromBatch(target: string, requestId: string): void {
  const batch = batches.get(target)
  if (!batch) return
  batch.items = batch.items.filter((i) => i.requestId !== requestId)
}

/**
 * Registers the Deferred in the broker and emits the request (directly or in a batch).
 * The promise resolves with the value sent by the UI via chat:askReply.
 */
export function dispatchAsk<T>(target: string, item: AskItem, signal?: AbortSignal): Promise<T> {
  const promise = ask<T>(target, item.requestId, signal)

  if (item.origin) {
    let batch = batches.get(target)
    if (!batch) {
      batch = { items: [], timer: setTimeout(() => flushBatch(target), BATCH_WINDOW_MS) }
      batches.set(target, batch)
    }
    batch.items.push(item)
    // Aborted while waiting for the window → do not emit a dead card
    promise.catch(() => dropFromBatch(target, item.requestId))
  } else {
    emitSingle(target, item)
  }

  return promise
}
