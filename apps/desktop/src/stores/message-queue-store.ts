import { create } from "zustand"
import { chatApi, storage } from "@/src/lib/ipc"
import type { FilePart, QueuedMessage, SessionMode, SendMessageOptions } from "@shared/chat"
import { StorageKeys } from "@shared/chat"
import { useSessionStore } from "@/src/stores/session-store"
import { useAppSettings } from "@/src/stores/app-settings"
import { useDraftInput } from "@/src/stores/draft-input"

const QUEUE_STORAGE_KEY = StorageKeys.queuedMessages

interface MessageQueueState {
  queues: Record<string, QueuedMessage[]>
  /** sessionId → id of the item the main input is editing right now */
  editing: Record<string, string>
  initialized: boolean

  initialize: () => Promise<void>
  enqueue: (sessionId: string, msg: QueuedMessage) => void
  /** Puts a new item at the FRONT of the queue (the phone got "session busy"
   *  when sending: the message was meant to go out now, so it jumps the queue). */
  enqueueFront: (sessionId: string, msg: QueuedMessage) => void
  dequeue: (sessionId: string) => QueuedMessage | undefined
  peek: (sessionId: string) => QueuedMessage | undefined
  remove: (sessionId: string, msgId: string) => void
  /** Puts the item at the FRONT of the queue (the next to go out), without touching the others */
  moveToFront: (sessionId: string, msgId: string) => void
  /** Writes the text into the item WITHOUT changing its position in the queue */
  update: (sessionId: string, msgId: string, text: string) => void
  /** The main input entered editing mode for a queue item */
  startEdit: (sessionId: string, msgId: string) => void
  /** Leaves editing mode (the input text stays where it is — we never erase what the person wrote) */
  cancelEdit: (sessionId: string) => void
  hasPending: (sessionId: string) => boolean
  /** Returns the number of messages in the queue (not scheduled) */
  queueSize: (sessionId: string) => number
  /** Processes the queue: if the session is idle, sends the next message */
  processQueue: (sessionId: string) => void
  /** Sends an item now, out of order — the exit from a queue paused by an error */
  sendNow: (sessionId: string, msgId: string) => void
  /** Enqueues for immediate send as soon as the agent is idle */
  enqueueForSend: (
    sessionId: string,
    text: string,
    options: SendMessageOptions,
    mode: SessionMode,
    extra?: { directory?: string; extraDirectories?: string[]; files?: FilePart[] },
  ) => void
  /** Enqueues for scheduled send */
  enqueueScheduled: (
    sessionId: string,
    text: string,
    options: SendMessageOptions,
    mode: SessionMode,
    scheduledAt: number,
    extra?: { directory?: string; extraDirectories?: string[]; files?: FilePart[] },
  ) => void
  /** Handler called by the session-store when status → idle or error */
  onSessionIdle: (sessionId: string) => void
}

/** The whole queue goes to disk — not only the scheduled ones: it is the queue of
 *  every device, and closing the desktop cannot erase what the person
 *  left waiting (on the phone or here). On reopening, the items go out when the
 *  session is free, through the scheduler. */
function persist(queues: Record<string, QueuedMessage[]>) {
  const all: Record<string, QueuedMessage[]> = {}
  for (const [sid, msgs] of Object.entries(queues)) {
    if (msgs.length > 0) all[sid] = msgs
  }
  void storage.write(QUEUE_STORAGE_KEY, all)
}

export const useMessageQueueStore = create<MessageQueueState>((set, get) => ({
  queues: {},
  editing: {},
  initialized: false,

  initialize: async () => {
    const data = (await storage.read<Record<string, QueuedMessage[]>>(QUEUE_STORAGE_KEY)) ?? {}
    // What came in while the disk was being read (e.g.: the phone delivering what
    // it wrote offline right at startup) goes after what was already saved —
    // and the result is written again, because the persist of that item had already
    // overwritten the file with only itself.
    const queues: Record<string, QueuedMessage[]> = { ...data }
    for (const [sid, msgs] of Object.entries(get().queues)) {
      const saved = queues[sid] ?? []
      const ids = new Set(saved.map((m) => m.id))
      queues[sid] = [...saved, ...msgs.filter((m) => !ids.has(m.id))]
    }
    persist(queues)
    set({ queues, initialized: true })
  },

  enqueue: (sessionId, msg) => {
    set((state) => {
      const current = state.queues[sessionId] ?? []
      const next = { ...state.queues, [sessionId]: [...current, msg] }
      persist(next)
      return { queues: next }
    })
  },

  enqueueFront: (sessionId, msg) => {
    set((state) => {
      const current = (state.queues[sessionId] ?? []).filter((m) => m.id !== msg.id)
      const next = { ...state.queues, [sessionId]: [msg, ...current] }
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
    // The item left the queue (sent or discarded): if it was the one the input
    // was editing, editing mode is over — otherwise the next Enter would write
    // into a message that no longer exists.
    const editing = { ...state.editing }
    if (editing[sessionId] === head.id) delete editing[sessionId]
    set({ queues: cleaned, editing })
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
      const editing = { ...state.editing }
      if (editing[sessionId] === msgId) delete editing[sessionId]
      return { queues: cleaned, editing }
    })
  },

  moveToFront: (sessionId, msgId) => {
    set((state) => {
      const current = state.queues[sessionId]
      if (!current || current.length < 2 || current[0].id === msgId) return state
      const target = current.find((m) => m.id === msgId)
      if (!target) return state
      // Only the position changes: the message takes mode, options, attachments and
      // scheduling with it, and the others keep the order among themselves.
      const next = {
        ...state.queues,
        [sessionId]: [target, ...current.filter((m) => m.id !== msgId)],
      }
      persist(next)
      return { queues: next }
    })
  },

  update: (sessionId, msgId, text) => {
    set((state) => {
      const current = state.queues[sessionId]
      if (!current) return state
      let found = false
      // `map` (and not re-enqueue): the item stays EXACTLY where it was — only the
      // text changes. The rest (mode, options, scheduling, attachments) is preserved.
      const next = current.map((m) => {
        if (m.id !== msgId) return m
        found = true
        return { ...m, text }
      })
      if (!found) return state
      const queues = { ...state.queues, [sessionId]: next }
      persist(queues)
      return { queues }
    })
  },

  startEdit: (sessionId, msgId) => {
    const msg = get().queues[sessionId]?.find((m) => m.id === msgId)
    if (!msg) return
    // The text goes to the main input (draft bridge); Enter afterwards
    // writes it back into THIS item, without touching the order.
    useDraftInput.getState().setDraft(sessionId, msg.text)
    set((state) => ({ editing: { ...state.editing, [sessionId]: msgId } }))
  },

  cancelEdit: (sessionId) => {
    set((state) => {
      if (state.editing[sessionId] === undefined) return state
      const editing = { ...state.editing }
      delete editing[sessionId]
      return { editing }
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

    // It only leaves with the session free. `error` does NOT count: the previous turn failed, and
    // the queue message almost always depends on the answer that did not come — the
    // queue stays paused until a turn ends well (or the person uses sendNow).
    const status = useSessionStore.getState().status[sessionId]
    if (status && status !== "idle") return

    // The renderer status is not enough: the loop emits idle at the end of each
    // iteration and keeps running, and the turn-end idle comes out an instant before
    // main frees the session. A send at that moment aborted the turn in
    // the middle — whoever says whether the session is free is main.
    if (checking.has(sessionId)) return
    checking.add(sessionId)
    void chatApi
      .running()
      .catch(() => [] as string[])
      .then((running) => {
        checking.delete(sessionId)
        if (running.includes(sessionId)) {
          scheduleRecheck(sessionId)
          return
        }
        // Re-checks after the await: the queue or the status may have changed.
        const head = get().queues[sessionId]?.[0]
        if (!head || (head.scheduledAt && head.scheduledAt > Date.now())) return
        const now = useSessionStore.getState().status[sessionId]
        if (now && now !== "idle") return
        const msg = get().dequeue(sessionId)
        if (msg) send(sessionId, msg)
      })
  },

  sendNow: (sessionId, msgId) => {
    const status = useSessionStore.getState().status[sessionId]
    if (status && status !== "idle" && status !== "error") return
    const msg = get().queues[sessionId]?.find((m) => m.id === msgId)
    if (!msg) return
    get().remove(sessionId, msgId)
    send(sessionId, msg)
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
    // An error pauses the queue (see processQueue). There is no resend from here: the queue
    // message already goes out with `retries`, and the engine repeats the SAME turn in
    // the background — resending from here duplicated the message in the chat on every
    // attempt.
    if (useSessionStore.getState().status[sessionId] === "error") return
    get().processQueue(sessionId)
  },
}))

/** Sessions with the "running in main" check in flight — avoids two sends. */
const checking = new Set<string>()
const recheckTimers = new Map<string, ReturnType<typeof setTimeout>>()
const BUSY_RECHECK_MS = 2_500

/** Session still running in main: tries again shortly, while it
 *  runs (the idle that would release the queue may already have passed). */
function scheduleRecheck(sessionId: string) {
  if (recheckTimers.has(sessionId)) return
  recheckTimers.set(
    sessionId,
    setTimeout(() => {
      recheckTimers.delete(sessionId)
      useMessageQueueStore.getState().processQueue(sessionId)
    }, BUSY_RECHECK_MS),
  )
}

/** The person is not watching when a queue item goes out: a transient failure
 *  gets extra rounds in the engine, within the same turn (how many: Preferences). */
function send(sessionId: string, msg: QueuedMessage) {
  void useSessionStore.getState().sendMessage(msg.mode, msg.text, {
    options: { ...msg.options, retries: useAppSettings.getState().settings.transientRetries },
    sessionId: msg.sessionId ?? sessionId,
    directory: msg.directory,
    extraDirectories: msg.extraDirectories,
    files: msg.files,
  })
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null

export function startMessageScheduler() {
  if (schedulerTimer) return
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
