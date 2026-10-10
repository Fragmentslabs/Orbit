import { create } from 'zustand'
import type { FilePart, MessageQueueOp, MessageQueueSnapshot, QueuedMessage, SessionMode, SendMessageOptions } from '@orbit/shared'
import { StorageKeys } from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useConnectionStore } from './connection-store'

/**
 * Fila de mensagens do celular.
 *
 * A fila de verdade mora no desktop — é ele quem envia o próximo item quando a
 * sessão fica livre —, então só existe uma fila por chat, a mesma nos dois
 * aparelhos. Aqui ficam:
 *  - `remote`: o espelho dela, recebido no connect ('queue:get') e a cada
 *    mudança ('queue:change');
 *  - `outbox`: o que foi escrito SEM conexão. Não há onde entregar, então fica
 *    guardado no aparelho e entra na fila do desktop ao reconectar.
 *
 * O celular nunca tira itens da fila para enviar: antes cada aparelho tinha a
 * sua e as duas disputavam a sessão — e um envio com a sessão ainda rodando
 * aborta o turno atual no meio.
 */

const OUTBOX_STORAGE_KEY = StorageKeys.queuedMessages

interface MessageQueueState {
  remote: MessageQueueSnapshot
  outbox: Record<string, QueuedMessage[]>
  /** remote + outbox por sessão — o que a UI mostra, na ordem de saída. */
  queues: Record<string, QueuedMessage[]>
  initialized: boolean

  initialize: () => Promise<void>
  /** Fila inteira vinda do desktop. */
  applySync: (queues: MessageQueueSnapshot) => void
  /** Busca a fila do desktop (connect). */
  fetchRemote: () => Promise<void>
  /** Entrega ao desktop o que foi escrito sem conexão, na ordem. */
  flushOutbox: () => Promise<void>
  enqueueForSend: (
    sessionId: string,
    text: string,
    options: SendMessageOptions,
    mode: SessionMode,
    extra?: { directory?: string; extraDirectories?: string[]; files?: FilePart[] },
  ) => void
  enqueueScheduled: (
    sessionId: string,
    text: string,
    options: SendMessageOptions,
    mode: SessionMode,
    scheduledAt: number,
    extra?: { directory?: string; extraDirectories?: string[]; files?: FilePart[] },
  ) => void
  /** Item que era para sair agora, mas a sessão estava ocupada: fura a fila. */
  enqueueFront: (sessionId: string, msg: QueuedMessage) => void
  remove: (sessionId: string, msgId: string) => void
}

export function newQueueId(): string {
  return `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function merge(remote: MessageQueueSnapshot, outbox: Record<string, QueuedMessage[]>) {
  const queues: Record<string, QueuedMessage[]> = {}
  for (const sessionId of new Set([...Object.keys(remote), ...Object.keys(outbox)])) {
    const items = [...(remote[sessionId] ?? []), ...(outbox[sessionId] ?? [])]
    if (items.length > 0) queues[sessionId] = items
  }
  return queues
}

function cleaned(map: Record<string, QueuedMessage[]>) {
  const next: Record<string, QueuedMessage[]> = {}
  for (const [sid, msgs] of Object.entries(map)) if (msgs.length > 0) next[sid] = msgs
  return next
}

function persistOutbox(outbox: Record<string, QueuedMessage[]>) {
  void Storage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(outbox))
}

function isOnline(): boolean {
  return useConnectionStore.getState().connection.status === 'connected'
}

async function sendOp(op: MessageQueueOp): Promise<boolean> {
  try {
    const res = await useConnectionStore.getState().wsClient.send({ type: 'queue:op', op })
    return res.ok
  } catch {
    return false
  }
}

export const useMessageQueueStore = create<MessageQueueState>((set, get) => {
  function setOutbox(outbox: Record<string, QueuedMessage[]>) {
    const next = cleaned(outbox)
    persistOutbox(next)
    set((s) => ({ outbox: next, queues: merge(s.remote, next) }))
  }

  function setRemote(remote: MessageQueueSnapshot) {
    const next = cleaned(remote)
    set((s) => ({ remote: next, queues: merge(next, s.outbox) }))
  }

  /** Online: vai para a fila do desktop (já aparece na tela, sem esperar o
   *  eco). Sem conexão, ou se a entrega falhar: fica no outbox. */
  function add(sessionId: string, msg: QueuedMessage, front: boolean) {
    const toOutbox = () => {
      const current = (get().outbox[sessionId] ?? []).filter((m) => m.id !== msg.id)
      setOutbox({ ...get().outbox, [sessionId]: front ? [msg, ...current] : [...current, msg] })
    }
    if (!isOnline()) {
      toOutbox()
      return
    }
    const current = get().remote[sessionId] ?? []
    setRemote({ ...get().remote, [sessionId]: front ? [msg, ...current] : [...current, msg] })
    void sendOp({ op: 'enqueue', sessionId, msg, front }).then((ok) => {
      if (ok) return
      // Não chegou: sai do espelho otimista e espera a próxima conexão.
      setRemote({
        ...get().remote,
        [sessionId]: (get().remote[sessionId] ?? []).filter((m) => m.id !== msg.id),
      })
      toOutbox()
    })
  }

  function build(
    sessionId: string,
    text: string,
    options: SendMessageOptions,
    mode: SessionMode,
    extra?: { directory?: string; extraDirectories?: string[]; files?: FilePart[] },
    scheduledAt?: number,
  ): QueuedMessage {
    return {
      id: newQueueId(),
      text,
      files: extra?.files?.length ? extra.files : undefined,
      options,
      mode,
      sessionId,
      scheduledAt,
      directory: extra?.directory,
      extraDirectories: extra?.extraDirectories,
      createdAt: Date.now(),
    }
  }

  return {
    remote: {},
    outbox: {},
    queues: {},
    initialized: false,

    initialize: async () => {
      if (get().initialized) return
      try {
        const raw = await Storage.getItem(OUTBOX_STORAGE_KEY)
        const outbox = cleaned(raw ? (JSON.parse(raw) as Record<string, QueuedMessage[]>) : {})
        set((s) => ({ outbox, queues: merge(s.remote, outbox), initialized: true }))
      } catch {
        set({ initialized: true })
      }
    },

    applySync: (queues) => setRemote(queues),

    fetchRemote: async () => {
      try {
        const res = await useConnectionStore.getState().wsClient.send({ type: 'queue:get' })
        if (res.ok && res.data) setRemote(res.data as MessageQueueSnapshot)
      } catch {
        // O próximo 'queue:change' traz a fila.
      }
    },

    flushOutbox: async () => {
      await get().initialize()
      for (const [sessionId, msgs] of Object.entries(get().outbox)) {
        for (const msg of msgs) {
          if (!isOnline()) return
          // O desktop ignora um id que já tem: reentregar depois de uma
          // resposta perdida não duplica a mensagem.
          if (!(await sendOp({ op: 'enqueue', sessionId, msg }))) return
          setOutbox({
            ...get().outbox,
            [sessionId]: (get().outbox[sessionId] ?? []).filter((m) => m.id !== msg.id),
          })
        }
      }
    },

    enqueueForSend: (sessionId, text, options, mode, extra) => {
      add(sessionId, build(sessionId, text, options, mode, extra), false)
    },

    enqueueScheduled: (sessionId, text, options, mode, scheduledAt, extra) => {
      add(sessionId, build(sessionId, text, options, mode, extra, scheduledAt), false)
    },

    enqueueFront: (sessionId, msg) => add(sessionId, msg, true),

    remove: (sessionId, msgId) => {
      if (get().outbox[sessionId]?.some((m) => m.id === msgId)) {
        setOutbox({ ...get().outbox, [sessionId]: get().outbox[sessionId].filter((m) => m.id !== msgId) })
        return
      }
      setRemote({
        ...get().remote,
        [sessionId]: (get().remote[sessionId] ?? []).filter((m) => m.id !== msgId),
      })
      void sendOp({ op: 'remove', sessionId, msgId })
    },
  }
})
