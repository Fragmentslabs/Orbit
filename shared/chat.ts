/**
 * Tipos compartilhados entre o main process (Electron) e o renderer.
 * Modelo de dados inspirado no opencode: sessões + mensagens compostas por "parts"
 * (texto, reasoning e chamadas de ferramenta).
 */

export type SessionMode = "chat" | "code"

export type ChatStatus = "idle" | "submitted" | "streaming" | "error"

export interface SessionOrchestration {
  role: "orchestrator" | "worker"
  /** Só em workers: sessão do orquestrador que criou este worker */
  parentSessionId?: string
  /** Descrição da tarefa delegada (workers) */
  task?: string
}

export interface SessionInfo {
  id: string
  title: string
  mode: SessionMode
  pinned: boolean
  archived: boolean
  folderId: string | null
  /** Pasta principal de trabalho (modo código) */
  directory?: string
  /** Pastas adicionais anexadas (modo código) */
  extraDirectories?: string[]
  /** Papel na orquestração (orquestrador ou worker) */
  orchestration?: SessionOrchestration
  /** Sessão-pai na árvore da sidebar (atalho de orchestration.parentSessionId) */
  parentId?: string
  createdAt: number
  updatedAt: number
}

export interface FolderInfo {
  id: string
  name: string
  mode: SessionMode
  pinned: boolean
  createdAt: number
}

export type TextPartState = "streaming" | "done"

export interface TextPart {
  id: string
  type: "text"
  text: string
  state: TextPartState
}

export interface ReasoningPart {
  id: string
  type: "reasoning"
  text: string
  state: TextPartState
  durationMs?: number
}

export type ToolPartState = "running" | "done" | "error"

export interface ToolPart {
  id: string
  type: "tool"
  tool: string
  state: ToolPartState
  title?: string
  input?: Record<string, unknown>
  output?: string
  error?: string
}

/** Imagem que o assistente inclui na resposta (tool show_image) */
export interface ImagePart {
  id: string
  type: "image"
  /** URL orbit-media:// servida pelo protocolo do main (arquivo em orbit-data/media) */
  src: string
  alt?: string
}

export type MessagePart = TextPart | ReasoningPart | ToolPart | ImagePart

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** USD, calculado com os preços do catálogo (quando disponíveis) */
  cost?: number
}

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  parts: MessagePart[]
  createdAt: number
  providerId?: string
  modelId?: string
  error?: string
  /** Gerada em modo simples: renderizar como texto puro, sem markdown/tool views */
  simple?: boolean
  /** Tokens consumidos na geração desta mensagem (assistant) */
  tokens?: TokenUsage
  /** Mensagem sintética de compactação: resumo do histórico anterior */
  summary?: boolean
}

export interface ModelVariant {
  /** ID único usado na comunicação (ex: "high", "max", "medium") */
  id: string
  /** Label de exibição no dropdown */
  label: string
  /** Descrição curta para tooltip (opcional) */
  description?: string
}

export interface ReasoningConfig {
  /** Toggle on/off do thinking */
  enabled: boolean
  /** ID da variant selecionada — undefined usa o baseline do modelo */
  variantId?: string
}

export type PermissionMode = "ask" | "approve" | "full"

/** Nível de risco de uma ação — ordem crescente: low < medium < high. "forbidden" é piso absoluto (mesmo full não passa). */
export type RiskLevel = "low" | "medium" | "high"
export type Verdict = RiskLevel | "forbidden"

/** Sensibilidade de decisões estruturais — controla autonomia do modelo em responder tool question.
 * low = pergunta cada decisão; medium = decide coisas básicas, pergunta estruturais; high = decide tudo sozinho. */
export type SensitivityLevel = "low" | "medium" | "high"

/** Thresholds parametrizáveis por modo: terminal (execução de ações) + decisions (tool question). */
export interface PermissionThresholds {
  /** Risco máximo que o agente executa sem perguntar. */
  terminalAuto: RiskLevel
  /** Sensibilidade máxima para o agente decidir sozinho uma tool question. */
  decisionsAuto: SensitivityLevel
}

export type PermissionThresholdsByMode = Record<PermissionMode, PermissionThresholds>

/** Defaults alinhados à spec: ask=max collaboration, approve=autonomia operacional, full=irrestrito. */
export const DEFAULT_PERMISSION_THRESHOLDS: PermissionThresholdsByMode = {
  ask: { terminalAuto: "medium", decisionsAuto: "medium" },
  approve: { terminalAuto: "high", decisionsAuto: "medium" },
  full: { terminalAuto: "high", decisionsAuto: "high" },
}

/** Ação sensível que uma ferramenta quer executar (bash, write, edit) */
export interface PermissionClaim {
  tool: string
  /** Título curto exibido na UI (ex: "bash: git push --force") */
  title: string
  detail?: string
  /** Ação crítica (nível deny) — a UI destaca o aviso */
  critical?: boolean
}

/** Pergunta estruturada da tool question */
export interface Question {
  id: string
  text: string
  options?: string[]
  multi?: boolean
}

/** Origem de um pedido vindo de worker (exibido no chat do orquestrador) */
export interface AskOrigin {
  workerSessionId: string
  workerTitle: string
}

/** Item de pedido pendente (permissão ou question) — eventos individuais, em lote e UI */
export interface AskItem {
  requestId: string
  kind: "permission" | "question"
  claim?: PermissionClaim
  questions?: Question[]
  origin?: AskOrigin
}

export interface PlanReview {
  status: "proposed" | "implementing" | "rejected"
  messageId: string
  permissionMode?: PermissionMode
}

export interface SendMessageOptions {
  /** Modo pesquisa aprofundada (prompt de deep research + ferramentas web) */
  research?: boolean
  /** Habilita ferramentas de browser nativo */
  browser?: boolean
  /** Modo plano: apenas ferramentas de leitura, saída em formato de plano */
  plan?: boolean
  /** Ao aceitar um plano: sinaliza para o backend usar o prompt de implementação */
  planReview?: PlanReview
  /** Modo simples: respostas diretas em texto puro, sem formatação */
  simple?: boolean
  /** Configuração de reasoning/thinking do modelo quando suportado */
  reasoning?: ReasoningConfig
  /** Modo subagents: expõe a tool subagent (workers efêmeros em background) */
  subagents?: boolean
  /** Modo Brain: memória persistente (ferramentas memory_* + injeção no prompt) */
  brain?: boolean
  /** Modo Orchestra: divide em plano de tarefas + workers em sessões filhas */
  orchestrate?: { plan?: OrchestrationPlan }
  /** Modo de permissões (code-mode e workers): default efetivo "ask" */
  permissionMode?: PermissionMode
}

export interface OrchestrationTask {
  id: string
  title: string
  /** Prompt autocontido enviado ao worker */
  prompt: string
  mode: SessionMode
  options: SendMessageOptions
  /** Sessão filha criada na execução */
  workerSessionId?: string
  status: ChatStatus
}

export interface OrchestrationPlan {
  id: string
  tasks: OrchestrationTask[]
  status: "proposed" | "approved" | "running" | "done" | "rejected"
  /** Tokens/custo acumulados: planejamento + workers + síntese */
  usage?: TokenUsage
}

export interface WorkerModelConfig {
  providerId: string
  modelId: string
  reasoning?: ReasoningConfig
}

export interface SendMessageInput {
  sessionId: string
  text: string
  providerId: string
  modelId: string
  mode: SessionMode
  options: SendMessageOptions
  directory?: string
  extraDirectories?: string[]
  /** Modelo dos workers (subagents/orchestra), vindo do modal de configuração */
  workerModel?: WorkerModelConfig
  /** Preenchido pelo main process em execuções de worker — nunca pelo renderer */
  orchestrationRole?: "orchestrator" | "worker"
  /** Sessão do orquestrador que criou este worker (preenchido pelo main) */
  parentSessionId?: string
  /** Título curto da tarefa do worker, para badges de origem (preenchido pelo main) */
  workerTitle?: string
  /** Thresholds de permissões por modo (vindo das Settings; default = DEFAULT_PERMISSION_THRESHOLDS) */
  permissionThresholds?: PermissionThresholdsByMode
}

export type ChatEvent =
  | { type: "status"; sessionId: string; status: ChatStatus; error?: string }
  | { type: "message"; sessionId: string; message: ChatMessage }
  /** Substituição completa do histórico (ex: compactação insere resumo no meio) */
  | { type: "messages"; sessionId: string; messages: ChatMessage[] }
  | { type: "part"; sessionId: string; messageId: string; part: MessagePart }
  | {
      type: "part-delta"
      sessionId: string
      messageId: string
      partId: string
      kind: "text" | "reasoning"
      delta: string
    }
  | { type: "title"; sessionId: string; title: string }
  | { type: "orchestration:plan"; sessionId: string; plan: OrchestrationPlan }
  | { type: "plan:review"; sessionId: string; review: PlanReview }
  /** Session criada/atualizada pelo main process (workers da orquestração) */
  | { type: "session"; sessionId: string; session: SessionInfo }
  /** Pedido de permissão aguardando resposta (card inline; origin = veio de worker) */
  | { type: "permission"; sessionId: string; requestId: string; claim: PermissionClaim; origin?: AskOrigin }
  /** Perguntas da tool question aguardando resposta */
  | { type: "question"; sessionId: string; requestId: string; questions: Question[]; origin?: AskOrigin }
  /** Lote de pedidos de workers agrupados numa janela de batching (card único) */
  | { type: "ask:batch"; sessionId: string; batchId: string; items: AskItem[] }
  /** Pedido resolvido/cancelado — remove o card da UI */
  | { type: "ask:done"; sessionId: string; requestId: string }

/** Modelo do catálogo models.dev (mesmo formato usado pelo opencode) */
export interface CatalogModel {
  id: string
  name: string
  reasoning: boolean
  /** Modelo sempre pensa (não há controle de nível) — ex: DeepSeek R1 */
  reasoningAlwaysOn?: boolean
  /** Níveis de reasoning disponíveis (metadados gerados no main process) */
  variants?: ModelVariant[]
  tool_call: boolean
  attachment: boolean
  release_date?: string
  limit?: { context: number; output: number }
  cost?: { input: number; output: number }
}

export interface CatalogProvider {
  id: string
  name: string
  env: string[]
  npm?: string
  api?: string
  models: Record<string, CatalogModel>
}

export type Catalog = Record<string, CatalogProvider>

export interface ProviderCredential {
  type: "api"
  key: string
}

/** Chaves usadas no storage genérico (main process) */
/** Mensagem enfileirada para envio posterior (fila ou agendada) */
export interface QueuedMessage {
  id: string
  text: string
  options: SendMessageOptions
  mode: SessionMode
  sessionId?: string
  directory?: string
  extraDirectories?: string[]
  /** Timestamp MS para envio agendado; undefined = envia assim que possível */
  scheduledAt?: number
  createdAt: number
}

export const StorageKeys = {
  session: (id: string) => `session/${id}`,
  sessionPrefix: "session/",
  messages: (sessionId: string) => `messages/${sessionId}`,
  folders: "folders",
  orchestration: (orchestratorSessionId: string) => `orchestration/${orchestratorSessionId}`,
  planReview: (sessionId: string) => `plan-review/${sessionId}`,
  memory: (id: string) => `memory/items/${id}`,
  memoryItemsPrefix: "memory/items/",
  memoryIndex: "memory/_index",
  queuedMessages: "message-queue",
} as const
