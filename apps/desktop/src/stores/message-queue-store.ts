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
  /** sessionId → id do item que o input principal está editando agora */
  editing: Record<string, string>
  initialized: boolean

  initialize: () => Promise<void>
  enqueue: (sessionId: string, msg: QueuedMessage) => void
  /** Põe um item novo na FRENTE da fila (o celular recebeu "sessão ocupada"
   *  ao enviar: a mensagem era para sair agora, então fura a fila). */
  enqueueFront: (sessionId: string, msg: QueuedMessage) => void
  dequeue: (sessionId: string) => QueuedMessage | undefined
  peek: (sessionId: string) => QueuedMessage | undefined
  remove: (sessionId: string, msgId: string) => void
  /** Põe o item na FRENTE da fila (o próximo a sair), sem mexer nos outros */
  moveToFront: (sessionId: string, msgId: string) => void
  /** Grava o texto no item SEM mudar a posição dele na fila */
  update: (sessionId: string, msgId: string, text: string) => void
  /** O input principal entrou em modo edição de um item da fila */
  startEdit: (sessionId: string, msgId: string) => void
  /** Sai do modo edição (o texto do input fica onde está — nunca apagamos o que a pessoa escreveu) */
  cancelEdit: (sessionId: string) => void
  hasPending: (sessionId: string) => boolean
  /** Retorna o número de mensagens na fila (não agendadas) */
  queueSize: (sessionId: string) => number
  /** Processa a fila: se a sessão está idle, envia a próxima mensagem */
  processQueue: (sessionId: string) => void
  /** Envia um item agora, fora da ordem — a saída da fila pausada por erro */
  sendNow: (sessionId: string, msgId: string) => void
  /** Enfileira para envio imediato assim que o agente ficar idle */
  enqueueForSend: (
    sessionId: string,
    text: string,
    options: SendMessageOptions,
    mode: SessionMode,
    extra?: { directory?: string; extraDirectories?: string[]; files?: FilePart[] },
  ) => void
  /** Enfileira para envio agendado */
  enqueueScheduled: (
    sessionId: string,
    text: string,
    options: SendMessageOptions,
    mode: SessionMode,
    scheduledAt: number,
    extra?: { directory?: string; extraDirectories?: string[]; files?: FilePart[] },
  ) => void
  /** Handler chamado pelo session-store quando status → idle ou error */
  onSessionIdle: (sessionId: string) => void
}

/** A fila inteira vai para o disco — não só as agendadas: ela é a fila de
 *  todos os aparelhos, e fechar o desktop não pode apagar o que a pessoa
 *  deixou esperando (no celular ou aqui). Ao reabrir, os itens saem quando a
 *  sessão estiver livre, pelo agendador. */
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
    // O que entrou enquanto o disco era lido (ex.: o celular entregando o que
    // escreveu offline logo na abertura) vai depois do que já estava salvo —
    // e o resultado é regravado, porque o persist desse item já tinha
    // sobrescrito o arquivo só com ele.
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
    // O item saiu da fila (enviado ou descartado): se era ele que o input
    // estava editando, o modo edição acabou — senão o próximo Enter gravaria
    // numa mensagem que não existe mais.
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
      // Só a posição muda: a mensagem leva consigo modo, opções, anexos e
      // agendamento, e as outras mantêm a ordem entre si.
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
      // `map` (e não reenfileirar): o item fica EXATAMENTE onde estava — só o
      // texto muda. O resto (modo, opções, agendamento, anexos) é preservado.
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
    // O texto vai para o input principal (bridge do rascunho); o Enter depois
    // grava de volta NESTE item, sem mexer na ordem.
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

    // Só sai com a sessão livre. `error` NÃO conta: o turno anterior falhou, e
    // a mensagem da fila quase sempre depende da resposta que não veio — a
    // fila fica pausada até um turno terminar bem (ou a pessoa usar sendNow).
    const status = useSessionStore.getState().status[sessionId]
    if (status && status !== "idle") return

    // O status do renderer não basta: o loop emite idle ao fim de cada
    // iteração e segue rodando, e o idle do fim do turno sai um instante antes
    // de o main liberar a sessão. Um envio nessa hora abortava o turno no
    // meio — quem diz se a sessão está livre é o main.
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
        // Reconfere depois do await: a fila ou o status podem ter mudado.
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
    // Erro pausa a fila (ver processQueue). Não há reenvio daqui: a mensagem
    // da fila já sai com `retries`, e o engine repete o MESMO turno em
    // segundo plano — reenviar daqui duplicava a mensagem no chat a cada
    // tentativa.
    if (useSessionStore.getState().status[sessionId] === "error") return
    get().processQueue(sessionId)
  },
}))

/** Sessões com a checagem de "rodando no main" em voo — evita dois envios. */
const checking = new Set<string>()
const recheckTimers = new Map<string, ReturnType<typeof setTimeout>>()
const BUSY_RECHECK_MS = 2_500

/** Sessão ainda rodando no main: tenta de novo em instantes, enquanto ela
 *  rodar (o idle que destravaria a fila pode já ter passado). */
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

/** A pessoa não está olhando quando um item da fila sai: falha transitória
 *  ganha rodadas extras no engine, dentro do mesmo turno (quantas: Preferências). */
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
