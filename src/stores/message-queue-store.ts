import { create } from "zustand"
import { storage } from "@/src/lib/ipc"
import type { QueuedMessage, SessionMode, SendMessageOptions } from "@/shared/chat"
import { StorageKeys } from "@/shared/chat"
import { useSessionStore } from "@/src/stores/session-store"

const QUEUE_STORAGE_KEY = StorageKeys.queuedMessages

interface MessageQueueState {
  queues: Record<string, QueuedMessage[]>
  initialized: boolean

  initialize: () => Promise<void>
  enqueue: (sessionId: string, msg: QueuedMessage) => void
  dequeue: (sessionId: string) => QueuedMessage | undefined
  peek: (sessionId: string) => QueuedMessage | undefined
  remove: (sessionId: string, msgId: string) => void
  hasPending: (sessionId: string) => boolean
  /** Retorna o número de mensagens na fila (não agendadas) */
  queueSize: (sessionId: string) => number
  /** Processa a fila: se session idle, envia a próxima mensagem */
  processQueue: (sessionId: string) => void
  /** Enfileira para envio imediato assim que o agente ficar idle */
  enqueueForSend: (
    sessionId: string,
    text: string,
    options: SendMessageOptions,
    mode: SessionMode,
    extra?: { directory?: string; extraDirectories?: string[] },
  ) => void
  /** Enfileira para envio agendado */
  enqueueScheduled: (
    sessionId: string,
    text: string,
    options: SendMessageOptions,
    mode: SessionMode,
    scheduledAt: number,
    extra?: { directory?: string; extraDirectories?: string[] },
  ) => void
  /** Handler chamado pelo session-store quando status → idle */
  onSessionIdle: (sessionId: string) => void
}

function persist(queues: Record<string, QueuedMessage[]>) {
  // Só persiste mensagens agendadas (com scheduledAt) para não poluir
  const scheduled: Record<string, QueuedMessage[]> = {}
  for (const [sid, msgs] of Object.entries(queues)) {
    const sched = msgs.filter((m) => m.scheduledAt)
    if (sched.length > 0) scheduled[sid] = sched
  }
  void storage.write(QUEUE_STORAGE_KEY, scheduled)
}

export const useMessageQueueStore = create<MessageQueueState>((set, get) => ({
  queues: {},
  initialized: false,

  initialize: async () => {
    const data = await storage.read<Record<string, QueuedMessage[]>>(QUEUE_STORAGE_KEY)
    set({ queues: data ?? {}, initialized: true })
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
    // Se houver alguma não-agendada (envio imediato) ou agendada já vencida
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

    // Pula mensagens agendadas cujo horário ainda não chegou
    const next = current[0]
    if (next.scheduledAt && next.scheduledAt > Date.now()) return

    // Verifica se a sessão está idle
    const sessionState = useSessionStore.getState()
    const status = sessionState.status[sessionId]
    if (status && status !== "idle") return

    // Dequeue e envia
    const msg = get().dequeue(sessionId)
    if (!msg) return

    void sessionState.sendMessage(msg.mode, msg.text, {
      options: msg.options,
      sessionId: msg.sessionId ?? sessionId,
      directory: msg.directory,
      extraDirectories: msg.extraDirectories,
    })
  },

  enqueueForSend: (sessionId, text, options, mode, extra) => {
    const msg: QueuedMessage = {
      id: `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text,
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
    // Tenta processar a fila para esta sessão
    get().processQueue(sessionId)
  },
}))

// Scheduler global: a cada 15s verifica filas por mensagens agendadas vencidas
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
