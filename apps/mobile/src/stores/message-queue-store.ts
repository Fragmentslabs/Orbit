import { create } from 'zustand'
import type { FilePart, MessageQueueOp, MessageQueueSnapshot, QueuedMessage, SessionMode, SendMessageOptions } from '@orbit/shared'
import { StorageKeys } from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useConnectionStore } from './connection-store'

/**
 * Message queue of the phone.
 *
 * The real queue lives on the desktop — it is what sends the next item when the
 * session becomes free —, so there is only one queue per chat, the same on both
 * devices. Here live:
 *  - `remote`: its mirror, received on connect ('queue:get') and on every
 *    change ('queue:change');
 *  - `outbox`: what was written WITHOUT a connection. There is nowhere to deliver it, so it stays
 *    stored on the device and enters the desktop queue on reconnection.
 *
 * The phone never takes items out of the queue to send: before, each device had its
 * own and the two competed for the session — and a send with the session still running
 * aborts the current turn halfway.
 */

const OUTBOX_STORAGE_KEY = StorageKeys.queuedMessages

interface MessageQueueState {
  remote: MessageQueueSnapshot
  outbox: Record<string, QueuedMessage[]>
  /** remote + outbox per session — what the UI shows, in send order. */
  queues: Record<string, QueuedMessage[]>
  initialized: boolean

  initialize: () => Promise<void>
  /** Whole queue coming from the desktop. */
  applySync: (queues: MessageQueueSnapshot) => void
  /** Fetches the queue of the desktop (connect). */
  fetchRemote: () => Promise<void>
  /** Delivers to the desktop what was written without a connection, in order. */
  flushOutbox: () => Promise<void>
  enqueueForSend: (
    sessionId: string,
    text: string,
    options: SendMessageOptions,
    mode: SessionMode,
    extra?: QueueExtra,
  ) => void
  enqueueScheduled: (
    sessionId: string,
    text: string,
    options: SendMessageOptions,
    mode: SessionMode,
    scheduledAt: number,
    extra?: QueueExtra,
  ) => void
  /** Item that was meant to go out now, but the session was busy: it jumps the queue. */
  enqueueFront: (sessionId: string, msg: QueuedMessage) => void
  remove: (sessionId: string, msgId: string) => void
}

/** What a queued item carries besides the text and the options — the model
 *  travels with it because the desktop is the one that delivers the queue. */
interface QueueExtra {
  directory?: string
  extraDirectories?: string[]
  files?: FilePart[]
  providerId?: string
  modelId?: string
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

  /** Online: it goes to the desktop queue (it already shows on screen, without waiting for the
   *  echo). Without a connection, or if the delivery fails: it stays in the outbox. */
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
      // It did not arrive: it leaves the optimistic mirror and waits for the next connection.
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
    extra?: QueueExtra,
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
      providerId: extra?.providerId,
      modelId: extra?.modelId,
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
        // The next 'queue:change' brings the queue.
      }
    },

    flushOutbox: async () => {
      await get().initialize()
      for (const [sessionId, msgs] of Object.entries(get().outbox)) {
        for (const msg of msgs) {
          if (!isOnline()) return
          // The desktop ignores an id it already has: redelivering after a lost
          // response does not duplicate the message.
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
