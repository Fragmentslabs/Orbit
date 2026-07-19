import { create } from 'zustand'
import type { FilePart, QueuedMessage, SessionMode, SendMessageOptions } from '@orbit/shared'
import { MAX_QUEUE_RETRIES, StorageKeys } from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useSessionStore } from './session-store'

const QUEUE_STORAGE_KEY = StorageKeys.queuedMessages

interface MessageQueueState {
  queues: Record<string, QueuedMessage[]>
  initialized: boolean
  _pendingQueueSend: Record<string, QueuedMessage | undefined>

  initialize: () => Promise<void>
  enqueue: (sessionId: string, msg: QueuedMessage) => void
  dequeue: (sessionId: string) => QueuedMessage | undefined
  peek: (sessionId: string) => QueuedMessage | undefined
  remove: (sessionId: string, msgId: string) => void
  hasPending: (sessionId: string) => boolean
  queueSize: (sessionId: string) => number
  processQueue: (sessionId: string) => void
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
  onSessionIdle: (sessionId: string) => void
}

function persist(queues: Record<string, QueuedMessage[]>) {
  const scheduled: Record<string, QueuedMessage[]> = {}
  for (const [sid, msgs] of Object.entries(queues)) {
    const sched = msgs.filter((m) => m.scheduledAt)
    if (sched.length > 0) scheduled[sid] = sched
  }
  void Storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(scheduled))
}

export const useMessageQueueStore = create<MessageQueueState>((set, get) => ({
  queues: {},
  initialized: false,
  _pendingQueueSend: {},

  initialize: async () => {
    try {
      const raw = await Storage.getItem(QUEUE_STORAGE_KEY)
      const data = raw ? JSON.parse(raw) : null
      set({ queues: data ?? {}, initialized: true })
    } catch {
      set({ initialized: true })
    }
  },

  enqueue: (sessionId, msg) => {
    set((state) => {
      const current = state.queues[sessionId] ?? []
      const next = { ...state.queues, [sessionId]: [...current, msg] }
      persist(next)
      return { queues: next }
    })
  },

  dequeue: (sessionId) => {
    const state = get()
    const current = state.queues[sessionId]
    if (!current || current.length === 0) return undefined
    const [head, ...rest] = current
    const next = { ...state.queues, [sessionId]: rest }
    const cleaned = { ...next }
    for (const key of Object.keys(cleaned)) {
      if (cleaned[key].length === 0) delete cleaned[key]
    }
    persist(cleaned)
    set({ queues: cleaned })
    return head
  },

  peek: (sessionId) => {
    const current = get().queues[sessionId]
    return current && current.length > 0 ? current[0] : undefined
  },

  remove: (sessionId, msgId) => {
    set((state) => {
      const current = state.queues[sessionId]
      if (!current) return state
      const filtered = current.filter((m) => m.id !== msgId)
      if (filtered.length === current.length) return state
      const next = { ...state.queues, [sessionId]: filtered }
      const cleaned = { ...next }
      for (const key of Object.keys(cleaned)) {
        if (cleaned[key].length === 0) delete cleaned[key]
      }
      persist(cleaned)
      return { queues: cleaned }
    })
  },

  hasPending: (sessionId) => {
    const current = get().queues[sessionId]
    if (!current || current.length === 0) return false
    return current.some((m) => !m.scheduledAt || m.scheduledAt <= Date.now())
  },

  queueSize: (sessionId) => {
    const current = get().queues[sessionId]
    if (!current) return 0
    return current.filter((m) => !m.scheduledAt).length
  },

  processQueue: (sessionId) => {
    const state = get()
    const current = state.queues[sessionId]
    if (!current || current.length === 0) return

    const next = current[0]
    if (next.scheduledAt && next.scheduledAt > Date.now()) return

    const sessionState = useSessionStore.getState()
    const status = sessionState.status[sessionId]
    if (status && status !== 'idle' && status !== 'error') return

    const msg = get().dequeue(sessionId)
    if (!msg) return

    set((s) => ({ _pendingQueueSend: { ...s._pendingQueueSend, [sessionId]: msg } }))

    void sessionState.sendMessage(msg.text, {
      options: msg.options,
      sessionId: msg.sessionId ?? sessionId,
      directory: msg.directory,
      extraDirectories: msg.extraDirectories,
      files: msg.files,
    })
  },

  enqueueForSend: (sessionId, text, options, mode, extra) => {
    const msg: QueuedMessage = {
      id: `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text,
      files: extra?.files?.length ? extra.files : undefined,
      options,
      mode,
      sessionId,
      directory: extra?.directory,
      extraDirectories: extra?.extraDirectories,
      createdAt: Date.now(),
    }
    get().enqueue(sessionId, msg)
  },

  enqueueScheduled: (sessionId, text, options, mode, scheduledAt, extra) => {
    const msg: QueuedMessage = {
      id: `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
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
    get().enqueue(sessionId, msg)
  },

  onSessionIdle: (sessionId) => {
    const sessionState = useSessionStore.getState()
    const status = sessionState.status[sessionId]

    if (status === 'error') {
      const pending = get()._pendingQueueSend[sessionId]
      if (pending) {
        if ((pending.retryCount ?? 0) < MAX_QUEUE_RETRIES) {
          get().enqueue(sessionId, { ...pending, retryCount: (pending.retryCount ?? 0) + 1 })
        }
        set((s) => {
          const next = { ...s._pendingQueueSend }
          delete next[sessionId]
          return { _pendingQueueSend: next }
        })
      }
    }

    get().processQueue(sessionId)
  },
}))

let schedulerTimer: ReturnType<typeof setInterval> | null = null

export function startMessageScheduler() {
  if (schedulerTimer) return

  useMessageQueueStore.getState().initialize()

  schedulerTimer = setInterval(() => {
    const state = useMessageQueueStore.getState()
    for (const sessionId of Object.keys(state.queues)) {
      state.processQueue(sessionId)
    }
  }, 15_000)
}

export function stopMessageScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
  }
}
