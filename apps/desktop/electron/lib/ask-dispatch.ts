import type { AskItem } from '@shared/chat'
import { ask, newRequestId } from './ask-broker'
import { broadcastChatEvent } from './broadcast'
import { notifyPendingAsk, notifyPendingAskBatch } from './notifications'

/**
 * Camada de emissão dos pedidos (acima do ask-broker, que permanece puro):
 * - Pedido da sessão principal: evento individual imediato.
 * - Pedido de WORKER (tem origin): entra numa janela de batching de 1.5s por
 *   sessão-pai — 4 workers perguntando em paralelo viram UM card em lote no
 *   chat do orquestrador, com submit único.
 * O "ask:done" por item continua sendo emitido pelo requester (finally).
 */

const BATCH_WINDOW_MS = 1500

interface PendingBatch {
  items: AskItem[]
  timer: NodeJS.Timeout
}

const batches = new Map<string, PendingBatch>()

function emitSingle(target: string, item: AskItem): void {
  void notifyPendingAsk(target, item)
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
  broadcastChatEvent({ type: 'ask:batch', sessionId: target, batchId: newRequestId(), items: batch.items })
}

/** Remove um item ainda não emitido (pedido rejeitado por abort na janela). */
function dropFromBatch(target: string, requestId: string): void {
  const batch = batches.get(target)
  if (!batch) return
  batch.items = batch.items.filter((i) => i.requestId !== requestId)
}

/**
 * Registra o Deferred no broker e emite o pedido (direto ou em lote).
 * A promise resolve com o valor enviado pela UI via chat:askReply.
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
    // Abortado enquanto aguardava a janela → não emitir um card morto
    promise.catch(() => dropFromBatch(target, item.requestId))
  } else {
    emitSingle(target, item)
  }

  return promise
}
