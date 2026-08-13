import type {
  Catalog,
  CatalogProvider,
  ChatEvent,
  SearchHit,
  SendMessageInput,
  SessionRevert,
} from "@shared/chat"
import type { McpConfig, McpServerStatus } from "@shared/mcp"
import type { MediaEntry, MediaFilter, MediaUsage } from "@shared/media"
import type {
  Esteira,
  EsteiraEvent,
  FaseEscolhida,
  FaseTemplate,
  NovaTaskInput,
  Projeto,
  RelatorioEsteira,
  Task,
} from "@shared/esteira"
import type { ModelsSnapshot } from "@shared/models"
import type { InitEvent, InitStatus, Memory, MemoryEvent } from "@shared/memory"
import type { Skill, SkillProposal } from "@shared/skills"
import type { AnalyticsSummary, AnalyticsRange } from "@shared/analytics"
import type { PanelEvent } from "@/src/stores/panel-store"

export type { SearchHit }

/** Ações acionadas pelo menu nativo do macOS (menu:action). */
export type MenuAction =
  | "settings"
  | "new-chat"
  | "new-code"
  | "view-chats"
  | "view-memories"
  | "view-models"
  | "how-to"

/** Wrapper tipado sobre a bridge IPC exposta pelo preload. */

export const windowApi = {
  platform: window.platform,
  minimize: () => window.ipcRenderer?.invoke("window:minimize"),
  maximize: () => window.ipcRenderer?.invoke("window:maximize"),
  close: () => window.ipcRenderer?.invoke("window:close"),
  isMaximized: () => (window.ipcRenderer?.invoke("window:isMaximized") ?? Promise.resolve(false)) as Promise<boolean>,
  toggleFullscreen: () => window.ipcRenderer?.invoke("window:toggleFullscreen"),
  onMaximizedChange: (listener: (maximized: boolean) => void) => {
    if (!window.ipcRenderer) return () => {}
    const wrapper = window.ipcRenderer.on("window:maximized-change", (maximized) => listener(maximized as boolean))
    return () => window.ipcRenderer.off("window:maximized-change", wrapper)
  },
  /** Pasta aberta via "Abrir com Orbit" (Explorer) ou segunda instância */
  onOpenFolder: (listener: (directory: string) => void) => {
    if (!window.ipcRenderer) return () => {}
    const wrapper = window.ipcRenderer.on("app:open-folder", (directory) => listener(directory as string))
    return () => window.ipcRenderer.off("app:open-folder", wrapper)
  },
  /** Busca pasta pendente da abertura fria (app iniciado pelo Explorer) */
  consumePendingOpen: () =>
    (window.ipcRenderer?.invoke("app:consumePendingOpen") ?? Promise.resolve(null)) as Promise<string | null>,
  /** Ações do menu nativo do macOS (menu bar do topo da tela) */
  onMenuAction: (listener: (action: MenuAction) => void) => {
    if (!window.ipcRenderer) return () => {}
    const wrapper = window.ipcRenderer.on("menu:action", (action) => listener(action as MenuAction))
    return () => window.ipcRenderer.off("menu:action", wrapper)
  },
}

/** Integração "Abrir com Orbit" no menu de contexto do Explorer (Windows) */
export const openWithApi = {
  status: () =>
    window.ipcRenderer.invoke("openwith:status") as Promise<{ supported: boolean; registered: boolean; error?: string }>,
  register: () =>
    window.ipcRenderer.invoke("openwith:register") as Promise<{ ok: boolean; error?: string }>,
  unregister: () =>
    window.ipcRenderer.invoke("openwith:unregister") as Promise<{ ok: boolean; error?: string }>,
}

export const storage = {
  read: <T>(key: string) => window.ipcRenderer.invoke("storage:read", key) as Promise<T | null>,
  write: (key: string, value: unknown) => window.ipcRenderer.invoke("storage:write", key, value),
  remove: (key: string) => window.ipcRenderer.invoke("storage:remove", key),
  list: (prefix: string) => window.ipcRenderer.invoke("storage:list", prefix) as Promise<string[]>,
}

export const catalogApi = {
  get: () => window.ipcRenderer.invoke("catalog:get") as Promise<Catalog>,
}

export const modelsApi = {
  list: () => window.ipcRenderer.invoke("models:list") as Promise<ModelsSnapshot>,
  refresh: () => window.ipcRenderer.invoke("models:refresh") as Promise<ModelsSnapshot>,
}

export const authApi = {
  set: (providerId: string, key: string) => window.ipcRenderer.invoke("auth:set", providerId, key),
  remove: (providerId: string) => window.ipcRenderer.invoke("auth:remove", providerId),
  list: () => window.ipcRenderer.invoke("auth:list") as Promise<string[]>,
}

export interface DetectResult {
  providerId: string
  name: string
  baseURL: string
  detected: boolean
  models: string[]
  error?: string
}

export const customProvidersApi = {
  list: () => window.ipcRenderer.invoke("custom-providers:list") as Promise<CatalogProvider[]>,
  add: (id: string, name: string, baseURL: string, apiKey?: string) =>
    window.ipcRenderer.invoke("custom-providers:add", id, name, baseURL, apiKey) as Promise<CatalogProvider>,
  remove: (id: string) => window.ipcRenderer.invoke("custom-providers:remove", id) as Promise<void>,
  update: (id: string, patch: { name?: string; baseURL?: string; apiKey?: string }) =>
    window.ipcRenderer.invoke("custom-providers:update", id, patch) as Promise<CatalogProvider>,
  detect: () => window.ipcRenderer.invoke("custom-providers:detect") as Promise<DetectResult[]>,
}

export interface ProcessInfo {
  pid: number
  label: string
  command: string
  cwd: string
  startTime: number
  status: "running" | "exited" | "killed"
  exitCode?: number
  /** Sessão de chat que iniciou o processo (filtro do footer e das tools bash_*). */
  sessionId?: string
}

export const processApi = {
  list: (sessionId?: string) => window.ipcRenderer.invoke("process:list", sessionId) as Promise<ProcessInfo[]>,
  kill: (pid: number, sessionId?: string) => window.ipcRenderer.invoke("process:kill", pid, sessionId) as Promise<boolean>,
  output: (pid: number, sessionId?: string) => window.ipcRenderer.invoke("process:output", pid, sessionId) as Promise<string>,
}

export const sessionApi = {
  revert: (sessionId: string, messageId: string) =>
    window.ipcRenderer.invoke("session:revert", sessionId, messageId) as Promise<SessionRevert | null>,
  unrevert: (sessionId: string) =>
    window.ipcRenderer.invoke("session:unrevert", sessionId) as Promise<boolean>,
}

export const chatApi = {
  send: (input: SendMessageInput) => window.ipcRenderer.invoke("chat:send", input),
  /** Emite um ChatEvent (sessão/pasta criada ou alterada na UI) para o main,
   *  que o repassa às outras janelas e aos companions (mobile) em tempo real. */
  emit: (event: ChatEvent) => {
    window.ipcRenderer?.send("chat:event:emit", event)
  },
  abort: (sessionId: string) => window.ipcRenderer.invoke("chat:abort", sessionId),
  /** Sessões ainda rodando no main (após reload do renderer, para re-emitir
   *  o status de streaming sem esperar o próximo evento). */
  running: () => window.ipcRenderer.invoke("chat:running") as Promise<string[]>,
  compact: (sessionId: string) => window.ipcRenderer.invoke("chat:compact", sessionId),
  approvePlan: (sessionId: string, planId: string, taskIds?: string[]) =>
    window.ipcRenderer.invoke("chat:approvePlan", sessionId, planId, taskIds),
  rejectPlan: (sessionId: string) => window.ipcRenderer.invoke("chat:rejectPlan", sessionId),
  savePlanFile: (directory: string, content: string) =>
    window.ipcRenderer.invoke("plan:saveFile", directory, content),
  deletePlanFile: (directory: string) =>
    window.ipcRenderer.invoke("plan:deleteFile", directory),
  readPlanFile: (directory: string) =>
    window.ipcRenderer.invoke("plan:readFile", directory) as Promise<string | null>,
  closeBrowser: (sessionId: string) => window.ipcRenderer.invoke("chat:closeBrowser", sessionId),
  askReply: (requestId: string, value: unknown) =>
    window.ipcRenderer.invoke("chat:askReply", requestId, value) as Promise<boolean>,
  onEvent: (listener: (event: ChatEvent) => void) => {
    const wrapper = window.ipcRenderer.on("chat:event", (event) => listener(event as ChatEvent))
    return () => window.ipcRenderer.off("chat:event", wrapper)
  },
}

export const skillsApi = {
  list: (directory?: string) =>
    window.ipcRenderer.invoke("skills:list", directory) as Promise<Skill[]>,
  create: (data: { name: string; description?: string; content: string; slug?: string; oldSlug?: string }) =>
    window.ipcRenderer.invoke("skills:create", data) as Promise<{ filePath: string }>,
  remove: (slug: string) => window.ipcRenderer.invoke("skills:remove", slug) as Promise<void>,
  import: () =>
    window.ipcRenderer.invoke("skills:import") as Promise<{
      imported: boolean
      slug?: string
      error?: string
    }>,
  pending: () => window.ipcRenderer.invoke("skills:pending") as Promise<SkillProposal[]>,
  approve: (slug: string) => window.ipcRenderer.invoke("skills:approve", slug) as Promise<boolean>,
  discard: (slug: string) => window.ipcRenderer.invoke("skills:discard", slug) as Promise<void>,
  onChanged: (listener: () => void) => {
    const wrapper = window.ipcRenderer.on("skills:changed", () => listener())
    return () => window.ipcRenderer.off("skills:changed", wrapper)
  },
}

export const mcpApi = {
  config: () => window.ipcRenderer.invoke("mcp:config") as Promise<McpConfig>,
  status: () => window.ipcRenderer.invoke("mcp:status") as Promise<McpServerStatus[]>,
  save: (config: McpConfig) =>
    window.ipcRenderer.invoke("mcp:save", config) as Promise<McpServerStatus[]>,
  reconnect: (name?: string) =>
    window.ipcRenderer.invoke("mcp:reconnect", name) as Promise<McpServerStatus[]>,
}

export const analyticsApi = {
  summary: (range: AnalyticsRange) =>
    window.ipcRenderer.invoke("analytics:summary", range) as Promise<AnalyticsSummary>,
}

export const panelApi = {
  /** Registra (ou limpa, com null) o webContents do <webview> do painel — por sessão de chat */
  register: (sessionId: string | null, webContentsId: number | null) =>
    window.ipcRenderer.send("panel:register", sessionId, webContentsId),
  onEvent: (listener: (event: PanelEvent) => void) => {
    const wrapper = window.ipcRenderer.on("panel:event", (event) => listener(event as PanelEvent))
    return () => window.ipcRenderer.off("panel:event", wrapper)
  },
}

/** Modo esteira — board de projetos/esteiras/tasks (orbit-data/esteira). */
export const esteiraApi = {
  carregar: () =>
    window.ipcRenderer.invoke("esteira:carregar") as Promise<{
      projetos: Projeto[]
      esteiras: Esteira[]
      tasksPorEsteira: Record<string, Task[]>
    }>,
  templates: () => window.ipcRenderer.invoke("esteira:templates") as Promise<FaseTemplate[]>,
  salvarTemplate: (template: FaseTemplate) =>
    window.ipcRenderer.invoke("esteira:salvarTemplate", template) as Promise<FaseTemplate[]>,
  removerTemplate: (id: string) =>
    window.ipcRenderer.invoke("esteira:removerTemplate", id) as Promise<FaseTemplate[]>,
  criarProjeto: (nome: string, pastas: string[]) =>
    window.ipcRenderer.invoke("esteira:criarProjeto", nome, pastas) as Promise<Projeto>,
  atualizarProjeto: (id: string, patch: Partial<Pick<Projeto, "nome" | "pastas">>) =>
    window.ipcRenderer.invoke("esteira:atualizarProjeto", id, patch) as Promise<Projeto | null>,
  removerProjeto: (id: string) => window.ipcRenderer.invoke("esteira:removerProjeto", id) as Promise<void>,
  criar: (input: NovaEsteiraInput) => window.ipcRenderer.invoke("esteira:criar", input) as Promise<Esteira>,
  atualizar: (id: string, patch: Partial<Esteira>) =>
    window.ipcRenderer.invoke("esteira:atualizar", id, patch) as Promise<Esteira | null>,
  remover: (id: string) => window.ipcRenderer.invoke("esteira:remover", id) as Promise<void>,
  criarTask: (input: NovaTaskInput) => window.ipcRenderer.invoke("esteira:criarTask", input) as Promise<Task>,
  atualizarTask: (esteiraId: string, taskId: string, patch: Partial<Task>) =>
    window.ipcRenderer.invoke("esteira:atualizarTask", esteiraId, taskId, patch) as Promise<Task | null>,
  removerTask: (esteiraId: string, taskId: string) =>
    window.ipcRenderer.invoke("esteira:removerTask", esteiraId, taskId) as Promise<void>,
  iniciarTask: (esteiraId: string, taskId: string, fase?: number) =>
    window.ipcRenderer.invoke("esteira:iniciarTask", esteiraId, taskId, fase) as Promise<void>,
  pausarTask: (esteiraId: string, taskId: string) =>
    window.ipcRenderer.invoke("esteira:pausarTask", esteiraId, taskId) as Promise<void>,
  retomarTask: (esteiraId: string, taskId: string) =>
    window.ipcRenderer.invoke("esteira:retomarTask", esteiraId, taskId) as Promise<void>,
  ligarFila: (esteiraId: string, ligar: boolean) =>
    window.ipcRenderer.invoke("esteira:ligarFila", esteiraId, ligar) as Promise<boolean>,
  relatorio: (esteiraId: string) =>
    window.ipcRenderer.invoke("esteira:relatorio", esteiraId) as Promise<RelatorioEsteira>,
  onEvent: (listener: (event: EsteiraEvent) => void) => {
    const wrapper = window.ipcRenderer.on("esteira:event", (event) => listener(event as EsteiraEvent))
    return () => window.ipcRenderer.off("esteira:event", wrapper)
  },
}

/** Entrada de criação de esteira (espelha NovaEsteiraInput do main). */
export interface NovaEsteiraInput {
  projetoId: string
  nome: string
  /** Fases resolvidas (podem ter sido editadas só para esta esteira) */
  fases?: FaseEscolhida[]
  /** Alternativa simples: ids de template na ordem desejada */
  templateIds?: string[]
  providerId: string
  modelId: string
  thinkingNivel?: number
  branch?: string
  worktree?: string
  pushAoFinal?: boolean
  /** Instrui as fases a capturarem prints do resultado visual */
  printsDoResultado?: boolean
  modoOperacao?: "manual" | "automatico"
}

/** Galeria de mídia — imagens produzidas pelo agente (orbit-data/media). */
export const mediaApi = {
  list: (filter?: MediaFilter) => window.ipcRenderer.invoke("media:list", filter) as Promise<MediaEntry[]>,
  usage: () => window.ipcRenderer.invoke("media:usage") as Promise<MediaUsage>,
  remove: (ids: string[]) => window.ipcRenderer.invoke("media:delete", ids) as Promise<number>,
  cleanupScripts: () => window.ipcRenderer.invoke("media:cleanupScripts") as Promise<number>,
  /** Indexa imagens anteriores ao registry — idempotente, roda na 1ª abertura. */
  backfill: () => window.ipcRenderer.invoke("media:backfill") as Promise<number>,
}

export const initApi = {
  run: (input: {
    directory: string
    providerId: string
    modelId: string
    workerProviderId?: string
    workerModelId?: string
    force?: boolean
    language?: string
  }) => window.ipcRenderer.invoke("init:run", input),
  status: (directory: string) =>
    window.ipcRenderer.invoke("init:status", directory) as Promise<InitStatus>,
  onEvent: (listener: (event: InitEvent) => void) => {
    const wrapper = window.ipcRenderer.on("init:event", (event) => listener(event as InitEvent))
    return () => window.ipcRenderer.off("init:event", wrapper)
  },
}

export const fsApi = {
  listFilesRecursive: (dirPath: string) =>
    window.ipcRenderer.invoke("fs:listFilesRecursive", dirPath) as Promise<{ ok: true; files: string[] } | { ok: false; error: string }>,
  readFileAsDataUrl: (filePath: string) =>
    window.ipcRenderer.invoke("fs:readFileAsDataUrl", filePath) as Promise<{ dataUrl: string } | { error: string }>,
  stat: (filePath: string) =>
    window.ipcRenderer.invoke("fs:stat", filePath) as Promise<
      { ok: true; isDirectory: boolean; isFile: boolean; size: number } | { ok: false; error: string }
    >,
}

export const searchApi = {
  sessions: (query: string) =>
    window.ipcRenderer.invoke("search:sessions", query) as Promise<SearchHit[]>,
}

export const dataApi = {
  export: (includeAuth: boolean, localStorage: Record<string, string>) =>
    window.ipcRenderer.invoke("export:data", includeAuth, localStorage) as Promise<
      { cancelled: boolean; filePath?: string }
    >,
  import: () =>
    window.ipcRenderer.invoke("import:data") as Promise<
      { cancelled: boolean; error?: string; localStorage?: Record<string, string> }
    >,
}

export interface CompanionStatus {
  running: boolean
  port: number
  httpPort: number
  httpRunning: boolean
  ip: string
  pin: string | null
  /** Erro de bind do servidor WS (ex.: porta ocupada por outra instância). */
  bindError: string | null
  connectedClients: { deviceName: string; connectedAt: number }[]
}

export const companionApi = {
  status: () => window.ipcRenderer.invoke("companion:status") as Promise<CompanionStatus>,
  setPairingMode: (active: boolean) =>
    window.ipcRenderer.invoke("companion:setPairingMode", active) as Promise<void>,
}

export const memoryApi = {
  list: () => window.ipcRenderer.invoke("memory:list") as Promise<Memory[]>,
  create: (input: {
    text: string
    kind: Memory["kind"]
    tags?: string[]
    document?: string
    directory?: string
    relatedId?: string
  }) =>
    window.ipcRenderer.invoke("memory:create", input) as Promise<{ id: string; merged: boolean; text: string }>,
  get: (id: string) =>
    window.ipcRenderer.invoke("memory:get", id) as Promise<{ memory: Memory; document: string | null } | null>,
  update: (id: string, patch: Partial<Pick<Memory, "text" | "tags" | "weight">>) =>
    window.ipcRenderer.invoke("memory:update", id, patch) as Promise<Memory | null>,
  delete: (id: string) => window.ipcRenderer.invoke("memory:delete", id) as Promise<void>,
  promote: (id: string) => window.ipcRenderer.invoke("memory:promote", id) as Promise<Memory | null>,
  link: (sourceId: string, targetId: string) =>
    window.ipcRenderer.invoke("memory:link", sourceId, targetId) as Promise<boolean>,
  onEvent: (listener: (event: MemoryEvent) => void) => {
    const wrapper = window.ipcRenderer.on("memory:event", (event) => listener(event as MemoryEvent))
    return () => window.ipcRenderer.off("memory:event", wrapper)
  },
}
