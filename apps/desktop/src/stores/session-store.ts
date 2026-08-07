import { nanoid } from "nanoid"
import { create } from "zustand"
import type {
  AskItem,
  ChatEvent,
  ChatMessage,
  ChatStatus,
  FilePart,
  FolderInfo,
  OrchestrationPlan,
  PlanReview,
  SendMessageOptions,
  SessionInfo,
  SessionMode,
  TextPart,
} from "@shared/chat"
import { StorageKeys } from "@shared/chat"
import { chatApi, sessionApi, storage } from "@/src/lib/ipc"
import { visibleMessageText } from "@/src/lib/message-utils"
import { useBrainPrefs } from "@/src/stores/brain-prefs"
import { useSimplePrefs } from "@/src/stores/simple-prefs"
import { useDraftInput } from "@/src/stores/draft-input"
import { useMessageQueueStore } from "@/src/stores/message-queue-store"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import { useProviderStore } from "@/src/stores/provider-store"
import { sessionModelFor, useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { useLoopConfigStore } from "@/src/stores/loop-config-store"
import { LOCALE_PROMPT_NAME, useLocaleStore } from "@/src/stores/locale-store"
import { usePanelStore } from "@/src/stores/panel-store"

/**
 * Store de sessões/mensagens no padrão do opencode: sessões persistidas
 * localmente (via storage do main process), mensagens compostas por parts e
 * status de streaming por sessão dirigindo a UI (persona em "thinking" etc).
 */

/** Pedido pendente (permissão ou question) exibido como card acima do input.
 * batchId agrupa pedidos de workers emitidos em lote (card único, submit único). */
export type PendingAskUI = AskItem & { batchId?: string }

export interface SendConfig {
  options: SendMessageOptions
  directory?: string
  extraDirectories?: string[]
  /** Envia para uma sessão específica (ex: worker no painel direito) em vez da ativa */
  sessionId?: string
  /** Arquivos anexados à mensagem (data URLs) */
  files?: FilePart[]
}

interface SessionState {
  initialized: boolean
  sessions: SessionInfo[]
  folders: FolderInfo[]
  messages: Record<string, ChatMessage[]>
  status: Record<string, ChatStatus>
  errors: Record<string, string | undefined>
  activeIds: Record<SessionMode, string | null>
  /** Pasta a atribuir à próxima sessão criada pelo fluxo de novo chat.
   *  O "+" da pasta não cria sessão no clique — só ao enviar a 1ª mensagem. */
  pendingFolderId: string | null
  /** Contagem de mensagens não lidas por sessão. */
  unreadCounts: Record<string, number>
  /** Planos de orquestração por sessão orquestradora */
  orchestration: Record<string, OrchestrationPlan>
  /** Revisão de planos (modo plano): propostos ou em implementação */
  planReviews: Record<string, PlanReview>
  /** Sessões que enviaram mensagem em plan mode e aguardam o fim do streaming para criar a review */
  _planReviewOutbox: Record<string, true>
  /** Pedidos de permissão/question aguardando resposta, por sessão */
  pendingAsks: Record<string, PendingAskUI[]>

  initialize: () => Promise<void>
  ensureMessages: (sessionId: string) => Promise<void>
  approvePlan: (sessionId: string, planId: string, taskIds?: string[]) => void
  rejectPlan: (sessionId: string) => void
  acceptPlanReview: (sessionId: string, permissionMode: "ask" | "approve" | "full", orchestrate?: boolean) => void
  rejectPlanReview: (sessionId: string) => void
  reviewPlanReview: (sessionId: string, feedback: string) => void
  dismissPlanReview: (sessionId: string) => void
  dismissOrchestration: (sessionId: string) => void
  createSession: (mode: SessionMode, partial?: Partial<SessionInfo> & { setActive?: boolean }) => Promise<SessionInfo>
  selectSession: (mode: SessionMode, id: string | null) => Promise<void>
  setPendingFolder: (folderId: string | null) => void
  renameSession: (id: string, title: string) => void
  togglePin: (id: string) => void
  toggleArchive: (id: string) => void
  deleteSession: (id: string) => Promise<void>
  deleteSessions: (ids: string[]) => Promise<void>
  moveToFolder: (id: string, folderId: string | null) => void
  /** Atualiza as pastas de trabalho de uma sessão de código */
  setSessionDirectories: (id: string, directory: string | undefined, extraDirectories?: string[]) => void
  /** Duplica a sessão (até messageId, se informado) com novos IDs */
  forkSession: (id: string, messageId?: string) => Promise<SessionInfo | null>
  /** Restaura o filesystem para antes da mensagem (modo código) */
  revertToMessage: (sessionId: string, messageId: string) => Promise<void>
  /** Desfaz um revert ativo */
  unrevert: (sessionId: string) => Promise<void>

  createFolder: (mode: SessionMode, name: string) => FolderInfo
  renameFolder: (id: string, name: string) => void
  toggleFolderPin: (id: string) => void
  deleteFolder: (id: string) => void

  sendMessage: (mode: SessionMode, text: string, config: SendConfig) => Promise<void>
  stopStreaming: (sessionId: string) => void
}

const AUTO_FOLDER_MAP_KEY = "orbit-auto-folder-map"

function loadAutoFolderMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(AUTO_FOLDER_MAP_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function persistAutoFolderMap(map: Record<string, string>) {
  localStorage.setItem(AUTO_FOLDER_MAP_KEY, JSON.stringify(map))
}

function normalizeFolderName(directoryPath: string): string {
  const baseName = directoryPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? directoryPath
  return baseName
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
}

function persistSession(session: SessionInfo) {
  void storage.write(StorageKeys.session(session.id), session)
}

function persistFolders(folders: FolderInfo[]) {
  void storage.write(StorageKeys.folders, folders)
}

function updateSessionIn(state: SessionState, id: string, patch: Partial<SessionInfo>) {
  const sessions = state.sessions.map((s) => {
    if (s.id !== id) return s
    const next = { ...s, ...patch, updatedAt: Date.now() }
    persistSession(next)
    return next
  })
  return { sessions }
}

/** Emite um ChatEvent para o main → outras janelas + companions (mobile).
 *  O store local já aplicou a mudança; o evento é só sincronização. */
function emitChatEvent(event: ChatEvent) {
  chatApi.emit(event)
}

/** Evento "session" com o objeto atualizado do store (pós-set). */
function emitSessionEvent(id: string) {
  const session = useSessionStore.getState().sessions.find((s) => s.id === id)
  if (session) emitChatEvent({ type: "session", sessionId: id, session })
}

export const useSessionStore = create<SessionState>((set, get) => ({
  initialized: false,
  sessions: [],
  folders: [],
  messages: {},
  status: {},
  errors: {},
  activeIds: { chat: null, code: null },
  pendingFolderId: null,
  orchestration: {},
  planReviews: {},
  _planReviewOutbox: {},
  pendingAsks: {},
  unreadCounts: {},

  initialize: async () => {
    if (get().initialized) return
    set({ initialized: true })

    const keys = await storage.list(StorageKeys.sessionPrefix)
    const sessions = (
      await Promise.all(keys.map((key) => storage.read<SessionInfo>(key)))
    ).filter((s): s is SessionInfo => s !== null)
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)

    const folders = (await storage.read<FolderInfo[]>(StorageKeys.folders)) ?? []
    // Merge em vez de substituição: uma sessão/pasta criada enquanto a carga
    // estava em andamento (ex.: abertura via "Abrir com Orbit" na montagem)
    // não pode ser perdida pelo set abaixo.
    set((state) => {
      const byId = new Map(state.sessions.map((s) => [s.id, s]))
      for (const s of sessions) byId.set(s.id, s)
      const mergedSessions = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
      const folderById = new Map(state.folders.map((f) => [f.id, f]))
      for (const f of folders) folderById.set(f.id, f)
      return { sessions: mergedSessions, folders: [...folderById.values()] }
    })

    chatApi.onEvent((event) => applyChatEvent(event, set, get))
  },

  createSession: async (mode, partial) => {
    const now = Date.now()
    const { setActive = true, ...rest } = partial ?? {}
    const session: SessionInfo = {
      id: nanoid(),
      title: mode === "chat" ? "Nova conversa" : "Nova sessão de código",
      mode,
      pinned: false,
      archived: false,
      folderId: null,
      createdAt: now,
      updatedAt: now,
      ...rest,
    }

    if (mode === "code" && partial?.directory && useModelModePrefs.getState().autoCreateFolders) {
      const autoFolderMap = loadAutoFolderMap()
      const existingFolderId = autoFolderMap[partial.directory]
      const existingFolder = get().folders.find((f) => f.id === existingFolderId)

      if (existingFolder) {
        session.folderId = existingFolder.id
      } else {
        const folderName = normalizeFolderName(partial.directory)
        const folder = get().createFolder("code", folderName)
        autoFolderMap[partial.directory] = folder.id
        persistAutoFolderMap(autoFolderMap)
        session.folderId = folder.id
      }
    }

    await storage.write(StorageKeys.session(session.id), session)
    set((state) => ({
      sessions: [session, ...state.sessions],
      activeIds: setActive ? { ...state.activeIds, [mode]: session.id } : state.activeIds,
      messages: { ...state.messages, [session.id]: [] },
    }))
    emitChatEvent({ type: "session", sessionId: session.id, session })
    return session
  },

  selectSession: async (mode, id) => {
    set((state) => ({
      activeIds: { ...state.activeIds, [mode]: id },
      unreadCounts: id ? { ...state.unreadCounts, [id]: 0 } : state.unreadCounts,
      // Navegar para outra sessão ou abrir um novo chat encerra o intent de pasta pendente
      pendingFolderId: null,
    }))
    if (id) {
      await get().ensureMessages(id)
      if (get().orchestration[id] === undefined) {
        const plan = await storage.read<OrchestrationPlan>(StorageKeys.orchestration(id))
        if (plan) set((state) => ({ orchestration: { ...state.orchestration, [id]: plan } }))
      }
      if (get().planReviews[id] === undefined) {
        const review = await storage.read<PlanReview>(StorageKeys.planReview(id))
        if (review) set((state) => ({ planReviews: { ...state.planReviews, [id]: review } }))
      }
      if (get().pendingAsks[id] === undefined) {
        const asks = await storage.read<PendingAskUI[]>(StorageKeys.pendingAsks(id))
        if (asks) set((state) => ({ pendingAsks: { ...state.pendingAsks, [id]: asks } }))
      }
    }
  },

  setPendingFolder: (folderId) => set({ pendingFolderId: folderId }),

  ensureMessages: async (sessionId) => {
    if (get().messages[sessionId] !== undefined) return
    const messages = (await storage.read<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
    set((state) => ({ messages: { ...state.messages, [sessionId]: messages } }))
  },

  approvePlan: (sessionId, planId, taskIds) => {
    set((state) => {
      const plan = state.orchestration[sessionId]
      if (!plan || plan.id !== planId) return state
      return { orchestration: { ...state.orchestration, [sessionId]: { ...plan, status: "approved" } } }
    })
    void chatApi.approvePlan(sessionId, planId, taskIds)
  },

  rejectPlan: (sessionId) => {
    void chatApi.rejectPlan(sessionId)
  },

  dismissOrchestration: (sessionId: string) => {
    set((state) => {
      const next = { ...state.orchestration }
      delete next[sessionId]
      return { orchestration: next }
    })
  },

  acceptPlanReview: (sessionId, permissionMode, orchestrate) => {
    const review = get().planReviews[sessionId]
    if (!review || review.status !== "proposed") return
    const updated: PlanReview = { ...review, status: "implementing", permissionMode }
    set((state) => ({ planReviews: { ...state.planReviews, [sessionId]: updated } }))
    void storage.write(StorageKeys.planReview(sessionId), updated)
    const session = get().sessions.find((s) => s.id === sessionId)
    const mode = session?.mode ?? "code"
    void get().sendMessage(mode, "Implemente o plano acima.", {
      options: {
        planReview: { status: "implementing", messageId: review.messageId, permissionMode },
        permissionMode,
        orchestrate: orchestrate ? {} : undefined,
      },
      sessionId,
    })
  },

  rejectPlanReview: (sessionId) => {
    const review = get().planReviews[sessionId]
    if (!review || review.status !== "proposed") return
    const updated: PlanReview = { ...review, status: "rejected" }
    set((state) => ({ planReviews: { ...state.planReviews, [sessionId]: updated } }))
    void storage.write(StorageKeys.planReview(sessionId), updated)
    const session = get().sessions.find((s) => s.id === sessionId)
    if (session?.directory) {
      void chatApi.deletePlanFile(session.directory)
    }
  },

  dismissPlanReview: (sessionId: string) => {
    set((state) => {
      const next = { ...state.planReviews }
      delete next[sessionId]
      void storage.remove(StorageKeys.planReview(sessionId))
      return { planReviews: next }
    })
  },

  reviewPlanReview: (sessionId, feedback) => {
    const review = get().planReviews[sessionId]
    if (!review || review.status !== "proposed") return
    const updated: PlanReview = { ...review, status: "revising" }
    set((state) => ({ planReviews: { ...state.planReviews, [sessionId]: updated } }))
    void storage.write(StorageKeys.planReview(sessionId), updated)
    const session = get().sessions.find((s) => s.id === sessionId)
    const mode = session?.mode ?? "code"
    void get().sendMessage(mode, feedback, {
      options: {
        planReview: { status: "revising", messageId: review.messageId, permissionMode: review.permissionMode ?? "ask" },
        permissionMode: review.permissionMode ?? "ask",
      },
      sessionId,
    })
  },

  renameSession: (id, title) => {
    set((state) => updateSessionIn(state, id, { title }))
    emitSessionEvent(id)
  },

  togglePin: (id) => {
    set((state) => {
      const session = state.sessions.find((s) => s.id === id)
      return session ? updateSessionIn(state, id, { pinned: !session.pinned }) : state
    })
    emitSessionEvent(id)
  },

  toggleArchive: (id) => {
    set((state) => {
      const session = state.sessions.find((s) => s.id === id)
      return session ? updateSessionIn(state, id, { archived: !session.archived }) : state
    })
    emitSessionEvent(id)
  },

  deleteSession: async (id) => {
    // Cascata: deletar um orquestrador aborta e remove seus workers filhos.
    // O abort do próprio id também é necessário — deletar sessão streamando
    // deixava o stream rodando órfão no main.
    const ids = [id, ...get().sessions.filter((s) => s.parentId === id).map((s) => s.id)]
    for (const sid of ids) {
      void chatApi.abort(sid)
      await storage.remove(StorageKeys.session(sid))
      await storage.remove(StorageKeys.messages(sid))
      void chatApi.closeBrowser(sid)
      useBrainPrefs.getState().setEnabled(sid, true) // limpa o override do Brain
      useSimplePrefs.getState().clear(sid)
      useSessionModelPrefs.getState().clear(sid)
      void storage.remove(StorageKeys.planReview(sid))
      void storage.remove(StorageKeys.pendingAsks(sid))
      emitChatEvent({ type: "session:deleted", sessionId: sid })
    }
    const idSet = new Set(ids)
    set((state) => {
      const messages = { ...state.messages }
      for (const sid of ids) delete messages[sid]
      const activeIds = { ...state.activeIds }
      for (const mode of ["chat", "code"] as SessionMode[]) {
        const active = activeIds[mode]
        if (active && idSet.has(active)) activeIds[mode] = null
      }
      const planReviews = { ...state.planReviews }
      for (const sid of ids) delete planReviews[sid]
      const pendingAsks = { ...state.pendingAsks }
      for (const sid of ids) delete pendingAsks[sid]
      const unreadCounts = { ...state.unreadCounts }
      for (const sid of ids) delete unreadCounts[sid]
      return { sessions: state.sessions.filter((s) => !idSet.has(s.id)), messages, activeIds, planReviews, pendingAsks, unreadCounts }
    })
  },

  moveToFolder: (id, folderId) => {
    set((state) => updateSessionIn(state, id, { folderId }))
    emitSessionEvent(id)
  },

  setSessionDirectories: (id, directory, extraDirectories) => {
    set((state) =>
      updateSessionIn(state, id, {
        ...(directory !== undefined ? { directory } : {}),
        extraDirectories: extraDirectories ?? [],
      }),
    )
    emitSessionEvent(id)
  },

  forkSession: async (id, messageId) => {
    const source = get().sessions.find((s) => s.id === id)
    if (!source) return null
    await get().ensureMessages(id)
    let msgs = get().messages[id] ?? []
    if (messageId) {
      const idx = msgs.findIndex((m) => m.id === messageId)
      if (idx >= 0) msgs = msgs.slice(0, idx + 1)
    }

    // Título "Original (fork #n)": n = maior contador existente do mesmo original + 1
    const baseTitle = source.title.replace(/ \(fork #\d+\)$/, "")
    const escaped = baseTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const counter = new RegExp(`^${escaped} \\(fork #(\\d+)\\)$`)
    const maxFork = get().sessions.reduce((max, s) => {
      const match = counter.exec(s.title)
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)

    const now = Date.now()
    const fork: SessionInfo = {
      ...source,
      id: nanoid(),
      title: `${baseTitle} (fork #${maxFork + 1})`,
      pinned: false,
      createdAt: now,
      updatedAt: now,
    }
    // Fork é uma sessão independente: não herda vínculos de orquestração nem revert
    delete fork.parentId
    delete fork.orchestration
    delete fork.revert

    // Novos IDs de mensagens e parts (evita colisão de eventos entre sessões)
    const cloned = msgs.map((m) => ({
      ...m,
      id: nanoid(),
      parts: m.parts.map((p) => ({ ...p, id: nanoid() })),
    }))

    await storage.write(StorageKeys.session(fork.id), fork)
    await storage.write(StorageKeys.messages(fork.id), cloned)
    set((state) => ({
      sessions: [fork, ...state.sessions],
      messages: { ...state.messages, [fork.id]: cloned },
    }))
    emitChatEvent({ type: "session", sessionId: fork.id, session: fork })
    return fork
  },

  deleteSessions: async (ids) => {
    const idSet = new Set<string>()
    for (const id of ids) {
      idSet.add(id)
      // Inclui workers filhos em cascata
      for (const s of get().sessions) {
        if (s.parentId === id) idSet.add(s.id)
      }
    }
    for (const sid of idSet) {
      void chatApi.abort(sid)
      await storage.remove(StorageKeys.session(sid))
      await storage.remove(StorageKeys.messages(sid))
      void chatApi.closeBrowser(sid)
      useBrainPrefs.getState().setEnabled(sid, true)
      useSimplePrefs.getState().clear(sid)
      useSessionModelPrefs.getState().clear(sid)
      void storage.remove(StorageKeys.planReview(sid))
      emitChatEvent({ type: "session:deleted", sessionId: sid })
    }
    set((state) => {
      const messages = { ...state.messages }
      for (const sid of idSet) delete messages[sid]
      const activeIds = { ...state.activeIds }
      for (const mode of ["chat", "code"] as SessionMode[]) {
        const active = activeIds[mode]
        if (active && idSet.has(active)) activeIds[mode] = null
      }
      const planReviews = { ...state.planReviews }
      for (const sid of idSet) delete planReviews[sid]
      return { sessions: state.sessions.filter((s) => !idSet.has(s.id)), messages, activeIds, planReviews }
    })
  },

  createFolder: (mode, name) => {
    const folder: FolderInfo = { id: nanoid(), name, mode, pinned: false, createdAt: Date.now() }
    set((state) => {
      const folders = [...state.folders, folder]
      persistFolders(folders)
      return { folders }
    })
    emitChatEvent({ type: "folders", folders: get().folders })
    return folder
  },

  renameFolder: (id, name) => {
    set((state) => {
      const folders = state.folders.map((f) => (f.id === id ? { ...f, name } : f))
      persistFolders(folders)
      return { folders }
    })
    emitChatEvent({ type: "folders", folders: get().folders })
  },

  toggleFolderPin: (id) => {
    set((state) => {
      const folders = state.folders.map((f) => (f.id === id ? { ...f, pinned: !f.pinned } : f))
      persistFolders(folders)
      return { folders }
    })
    emitChatEvent({ type: "folders", folders: get().folders })
  },

  deleteFolder: (id) => {
    // Sessões afetadas ANTES do set (depois, folderId já estará null)
    const affected = get().sessions.filter((s) => s.folderId === id).map((s) => s.id)
    set((state) => {
      const folders = state.folders.filter((f) => f.id !== id)
      persistFolders(folders)
      // Sessões da pasta voltam para a raiz
      const sessions = state.sessions.map((s) => {
        if (s.folderId !== id) return s
        const next = { ...s, folderId: null }
        persistSession(next)
        return next
      })
      // Limpa entradas órfãs do mapa de pastas automáticas
      const autoFolderMap = loadAutoFolderMap()
      for (const [dir, fid] of Object.entries(autoFolderMap)) {
        if (fid === id) {
          delete autoFolderMap[dir]
        }
      }
      persistAutoFolderMap(autoFolderMap)
      return { folders, sessions }
    })
    for (const sid of affected) emitSessionEvent(sid)
    emitChatEvent({ type: "folders", folders: get().folders })
  },

  sendMessage: async (mode, text, config) => {
    const provider = useProviderStore.getState()
    // O modelo segue a sessão: override do chat (ou do draft de chat novo)
    // > default global do provider.
    const targetSessionId = config.sessionId ?? get().activeIds[mode]
    const selected = sessionModelFor(targetSessionId) ?? provider.selectedModel
    if (!selected) {
      throw new Error("Nenhum modelo selecionado. Configure um provedor em Configurações.")
    }

    let sessionId = config.sessionId ?? get().activeIds[mode]
    let session = get().sessions.find((s) => s.id === sessionId)
    if (!session) {
      // A pasta pendente só vale se pertencer ao mesmo modo da sessão a criar
      const pendingFolderId = get().pendingFolderId
      const pendingFolder = pendingFolderId
        ? get().folders.find((f) => f.id === pendingFolderId)
        : undefined
      session = await get().createSession(mode, {
        directory: config.directory,
        extraDirectories: config.extraDirectories,
        ...(pendingFolder && pendingFolder.mode === mode ? { folderId: pendingFolderId } : {}),
      })
      sessionId = session.id
      if (pendingFolderId) set({ pendingFolderId: null })
      // O toggle Brain do chat novo (rascunho) passa a valer para esta sessão
      useBrainPrefs.getState().adopt(sessionId)
      useSimplePrefs.getState().adopt(sessionId)
      useDraftInput.getState().adopt(sessionId)
      // O modelo escolhido no chat novo (draft) passa a ser o da sessão; sem
      // escolha explícita, fixa o modelo efetivamente usado (herdado do último
      // chat), para o picker e o envio continuarem consistentes.
      useSessionModelPrefs.getState().adopt(sessionId, selected)
    } else if (mode === "code") {
      const dirChanged = config.directory && session.directory !== config.directory
      const extraChanged =
        config.extraDirectories &&
        JSON.stringify(config.extraDirectories) !== JSON.stringify(session.extraDirectories ?? [])
      if (dirChanged || extraChanged) {
        set((state) =>
          updateSessionIn(state, session!.id, {
            ...(dirChanged ? { directory: config.directory } : {}),
            extraDirectories: config.extraDirectories,
          }),
        )
      }
    }

    // Limpa plan review implementado/concluído e orquestração concluída
    const planReview = get().planReviews[sessionId!]
    const isPlanMsg = config.options.plan || config.options.planReview
    if (!isPlanMsg && planReview && planReview.status !== "proposed") {
      const next = { ...get().planReviews }
      delete next[sessionId!]
      set({ planReviews: next })
      void storage.remove(StorageKeys.planReview(sessionId!))
    }
    const orch = get().orchestration[sessionId!]
    if (orch && orch.status === "done") {
      const next = { ...get().orchestration }
      delete next[sessionId!]
      set({ orchestration: next })
    }

    // Se está enviando em plan mode, marca para criar a review quando o streaming terminar
    if (config.options.plan) {
      set((state) => ({ _planReviewOutbox: { ...state._planReviewOutbox, [sessionId!]: true } }))
    }

    // Subagents, orquestra e /init usam o modelo worker configurado
    const needsWorker = config.options.subagents || config.options.orchestrate || config.options.initMode
    const worker = provider.workerModel ?? useModelModePrefs.getState().codeModel
    const workerModel =
      needsWorker && worker
        ? { ...worker, reasoning: provider.workerReasoning ?? undefined }
        : undefined

    await chatApi.send({
      sessionId: sessionId!,
      text,
      files: config.files,
      providerId: selected.providerId,
      modelId: selected.modelId,
      mode: session.mode ?? mode,
      options: config.options,
      directory: config.directory ?? session.directory,
      extraDirectories: config.extraDirectories ?? session.extraDirectories,
      workerModel,
      language: LOCALE_PROMPT_NAME[useLocaleStore.getState().activeLocale],
      ...(config.options.loop ? { loopConfig: useLoopConfigStore.getState().config } : {}),
    })
  },

  stopStreaming: (sessionId) => {
    void chatApi.abort(sessionId)
  },

  // O main persiste e emite o evento "session" com o estado atualizado —
  // aqui só espelha imediatamente para a barra de revert aparecer sem delay
  revertToMessage: async (sessionId, messageId) => {
    const revert = await sessionApi.revert(sessionId, messageId)
    if (!revert) return
    set((state) => updateSessionIn(state, sessionId, { revert }))
    // A mensagem revertida volta para o input, como se estivesse sendo editada.
    // O texto sai de `discardedMessages` em vez de vir num campo próprio do
    // SessionRevert: anexos são data URLs e duplicá-los dobraria o tamanho da
    // sessão em disco.
    const prompt = revert.discardedMessages?.find((m) => m.role === "user")
    if (prompt) {
      const files = prompt.parts.filter((p): p is FilePart => p.type === "file")
      useDraftInput.getState().setDraft(sessionId, visibleMessageText(prompt), files)
    }
  },

  unrevert: async (sessionId) => {
    const done = await sessionApi.unrevert(sessionId)
    if (done) set((state) => updateSessionIn(state, sessionId, { revert: undefined }))
  },
}))

type Setter = (fn: (state: SessionState) => Partial<SessionState>) => void

// ─── Batching de deltas ──────────────────────────────────────────────────────
// Agrupa part-deltas num frame (~33ms) para o stream parecer fluido sem um
// re-render por token (espelho do mobile). O flush aplica tudo num único set
// copiando só a lista da sessão afetada e atualizando só a mensagem/parte
// afetada — as demais mensagens mantêm a referência e não re-renderizam.

interface PendingDelta {
  sessionId: string
  messageId: string
  partId: string
  text: string
}

const DELTA_FLUSH_MS = 33

const deltaBuffer = new Map<string, PendingDelta>()
let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null

function flushDeltas(set: Setter) {
  if (deltaFlushTimer) {
    clearTimeout(deltaFlushTimer)
    deltaFlushTimer = null
  }
  if (deltaBuffer.size === 0) return
  const pending = [...deltaBuffer.values()]
  deltaBuffer.clear()

  set((state) => {
    const messages = { ...state.messages }
    // Agrupa por sessão para copiar cada lista uma única vez
    const bySession = new Map<string, PendingDelta[]>()
    for (const d of pending) {
      const list = bySession.get(d.sessionId)
      if (list) list.push(d)
      else bySession.set(d.sessionId, [d])
    }
    for (const [sessionId, deltas] of bySession) {
      const list = messages[sessionId]
      if (!list) continue
      const next = list.slice()
      for (const delta of deltas) {
        // Mensagem ativa costuma ser a última — busca do fim
        let msgIdx = -1
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].id === delta.messageId) {
            msgIdx = i
            break
          }
        }
        if (msgIdx < 0) continue
        const message = next[msgIdx]
        const parts = message.parts.slice()
        const partIdx = parts.findIndex((p) => p.id === delta.partId)
        if (partIdx < 0) continue
        const part = parts[partIdx]
        if (part.type === "text" || part.type === "reasoning" || part.type === "agent") {
          parts[partIdx] = { ...part, text: part.text + delta.text }
          next[msgIdx] = { ...message, parts }
        }
      }
      messages[sessionId] = next
    }
    return { messages }
  })
}

function applyChatEvent(event: ChatEvent, set: Setter, get: () => SessionState) {
  // "folders" é o único evento sem sessionId (substituição completa da lista)
  const sessionId = "sessionId" in event ? event.sessionId : ""

  // Eventos que tocam as mensagens diretamente precisam ver o texto já
  // acumulado — descarrega os deltas pendentes antes de aplicá-los.
  if (event.type === "message" || event.type === "part" || event.type === "messages" || event.type === "status") {
    flushDeltas(set)
  }

  const persistPendingAsks = (sid: string) => {
    void storage.write(StorageKeys.pendingAsks(sid), get().pendingAsks[sid] ?? [])
  }

  switch (event.type) {
    case "status":
      set((state) => ({
        status: { ...state.status, [sessionId]: event.status },
        errors: { ...state.errors, [sessionId]: event.error },
      }))
      break

case "message": {
      const inbound = event.message
      set((state) => {
        const list = state.messages[sessionId] ?? []
        const idx = list.findIndex((m) => m.id === inbound.id)
        const next = idx >= 0 ? list.map((m, i) => (i === idx ? inbound : m)) : [...list, inbound]

        const isInbound = inbound.role === "assistant"
        const activeId = state.activeIds["chat"] ?? state.activeIds["code"] ?? null
        const unreadCounts =
          isInbound && sessionId !== activeId
            ? { ...state.unreadCounts, [sessionId]: (state.unreadCounts[sessionId] ?? 0) + 1 }
            : state.unreadCounts

        return { messages: { ...state.messages, [sessionId]: next }, unreadCounts }
      })

      // Um modelo só entra nos "recentes" quando foi de fato usado: a resposta
      // final do agente (completedAt) chegou completa, com conteúdo real e sem
      // erro. Se o 1º turno falhar (sem resposta), não conta como uso — e um
      // turno posterior que responder, sim.
      if (
        inbound.role === "assistant" &&
        inbound.completedAt &&
        !inbound.error &&
        inbound.parts.some((p) => p.type === "text" || p.type === "tool" || p.type === "image" || p.type === "agent")
      ) {
        useSessionModelPrefs.getState().markUsed(inbound.providerId, inbound.modelId)
      }
      break
    }

    case "part":
      set((state) => {
        const list = state.messages[sessionId] ?? []
        const next = list.map((message) => {
          if (message.id !== event.messageId) return message
          const idx = message.parts.findIndex((p) => p.id === event.part.id)
          const parts =
            idx >= 0
              ? message.parts.map((p, i) => (i === idx ? event.part : p))
              : [...message.parts, event.part]
          return { ...message, parts }
        })
        return { messages: { ...state.messages, [sessionId]: next } }
      })
      break

    case "part-delta": {
      const key = `${sessionId}:${event.messageId}:${event.partId}`
      const pending = deltaBuffer.get(key)
      if (pending) {
        pending.text += event.delta
      } else {
        deltaBuffer.set(key, {
          sessionId,
          messageId: event.messageId,
          partId: event.partId,
          text: event.delta,
        })
      }
      if (!deltaFlushTimer) {
        deltaFlushTimer = setTimeout(() => flushDeltas(set), DELTA_FLUSH_MS)
      }
      break
    }

    case "messages":
      // Substituição completa (ex: compactação inseriu um resumo no meio)
      set((state) => ({ messages: { ...state.messages, [sessionId]: event.messages } }))
      break

case "title":
      set((state) => {
        const sessions = state.sessions.map((s) => (s.id === sessionId ? { ...s, title: event.title } : s))
        return { sessions }
      })
      // O agente nomeou o chat: espelha o novo título nas abas de chat do
      // painel lateral que apontam para essa sessão.
      usePanelStore.getState().renameChatTabs(sessionId, event.title)
      break

    case "orchestration:plan":
      set((state) => ({ orchestration: { ...state.orchestration, [sessionId]: event.plan } }))
      break

    case "plan:review":
      set((state) => ({ planReviews: { ...state.planReviews, [sessionId]: event.review } }))
      void storage.write(StorageKeys.planReview(sessionId), event.review)
      break

    case "session":
      // Session criada/atualizada pelo main (workers da orquestração)
      set((state) => {
        const exists = state.sessions.some((s) => s.id === event.session.id)
        const sessions = exists
          ? state.sessions.map((s) => (s.id === event.session.id ? event.session : s))
          : [event.session, ...state.sessions]
        // Workers nascem vazios e o main emite "session" antes de iniciar o
        // runChat deles: inicializar o buffer aqui garante que os primeiros
        // events de message/part não sejam perdidos nem sobrescritos por um
        // ensureMessages tardio (que vira no-op com a chave já definida).
        const messages =
          state.messages[event.session.id] === undefined
            ? { ...state.messages, [event.session.id]: [] }
            : state.messages
        return { sessions, messages }
      })
      break

    case "session:deleted":
      useSessionModelPrefs.getState().clear(sessionId)
      set((state) => {
        const sessions = state.sessions.filter((s) => s.id !== sessionId)
        const messages = { ...state.messages }
        delete messages[sessionId]
        const activeIds = { ...state.activeIds }
        for (const mode of ["chat", "code"] as SessionMode[]) {
          if (activeIds[mode] === sessionId) activeIds[mode] = null
        }
        const planReviews = { ...state.planReviews }
        delete planReviews[sessionId]
        const unreadCounts = { ...state.unreadCounts }
        delete unreadCounts[sessionId]
        return { sessions, messages, activeIds, planReviews, unreadCounts }
      })
      break

    case "folders":
      set(() => ({ folders: event.folders }))
      break

    case "permission":
    case "question": {
      const ask: PendingAskUI =
        event.type === "permission"
          ? { requestId: event.requestId, kind: "permission", claim: event.claim, origin: event.origin }
          : { requestId: event.requestId, kind: "question", questions: event.questions, origin: event.origin }
      set((state) => {
        const current = state.pendingAsks[sessionId] ?? []
        if (current.some((a) => a.requestId === ask.requestId)) return state
        return { pendingAsks: { ...state.pendingAsks, [sessionId]: [...current, ask] } }
      })
      void persistPendingAsks(sessionId)
      break
    }

    case "ask:batch":
      set((state) => {
        const current = state.pendingAsks[sessionId] ?? []
        const fresh = event.items
          .filter((item) => !current.some((a) => a.requestId === item.requestId))
          .map((item) => ({ ...item, batchId: event.batchId }))
        if (fresh.length === 0) return state
        return { pendingAsks: { ...state.pendingAsks, [sessionId]: [...current, ...fresh] } }
      })
      void persistPendingAsks(sessionId)
      break

    case "ask:done":
      set((state) => {
        const current = state.pendingAsks[sessionId]
        if (!current?.some((a) => a.requestId === event.requestId)) return state
        return {
          pendingAsks: {
            ...state.pendingAsks,
            [sessionId]: current.filter((a) => a.requestId !== event.requestId),
          },
        }
      })
      void persistPendingAsks(sessionId)
      break
  }

  function extractMessageText(msg: ChatMessage): string {
    return msg.parts
      .filter((p): p is TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n")
  }

  // Quando o streaming termina ou dá erro, verifica planos e processa fila
  if (event.type === "status" && event.status === "idle") {
    const state = get()
    const sessions = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
    const patch: Partial<SessionState> = { sessions }

    // Cria PlanReview se estava em plan mode
    if (state._planReviewOutbox[sessionId] && !state.planReviews[sessionId]) {
      const msgs = state.messages[sessionId] ?? []
      const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant")
      if (lastAssistant) {
        const review: PlanReview = { status: "proposed", messageId: lastAssistant.id }
        patch.planReviews = { ...state.planReviews, [sessionId]: review }
        void storage.write(StorageKeys.planReview(sessionId), review)
        // Salva PLAN.md no diretório da sessão
        const session = state.sessions.find((s) => s.id === sessionId)
        if (session?.directory) {
          const planText = extractMessageText(lastAssistant)
          if (planText) {
            void chatApi.savePlanFile(session.directory, planText)
          }
        }
      }
    }
    const cleanOutbox = { ...state._planReviewOutbox }
    delete cleanOutbox[sessionId]
    patch._planReviewOutbox = cleanOutbox

    set(() => patch)
  }

  // Processa a fila tanto em idle quanto em erro (para retry/skip)
  if (event.type === "status" && (event.status === "idle" || event.status === "error")) {
    useMessageQueueStore.getState().onSessionIdle(sessionId)
  }
}

/** Sessão ativa do modo atual */
export function useActiveSession(mode: SessionMode) {
  return useSessionStore((state) => {
    const id = state.activeIds[mode]
    return id ? state.sessions.find((s) => s.id === id) : undefined
  })
}

export function useSessionStatus(sessionId: string | null | undefined): ChatStatus {
  return useSessionStore((state) => (sessionId ? state.status[sessionId] ?? "idle" : "idle"))
}
