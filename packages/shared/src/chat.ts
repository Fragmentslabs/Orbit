/**
 * Tipos compartilhados entre o main process (Electron) e o renderer.
 * Modelo de dados inspirado no opencode: sessões + mensagens compostas por "parts"
 * (texto, reasoning e chamadas de ferramenta).
 */

export type SessionMode = "chat" | "code"

export type ChatStatus = "idle" | "submitted" | "streaming" | "cancelling" | "error"

/** Resultado de busca textual em sessões (título + mensagens). */
export interface SearchHit {
  sessionId: string
  sessionTitle: string
  mode: SessionMode | string
  updatedAt: number
  snippet: string
}

export interface SessionOrchestration {
  role: "orchestrator" | "worker"
  /** Só em workers: sessão do orquestrador que criou este worker */
  parentSessionId?: string
  /** Descrição da tarefa delegada (workers) */
  task?: string
}

/** Estado de revert ativo numa sessão. O revert trunca as mensagens a
 * partir de `messageId` imediatamente (tanto modo código quanto chat),
 * guardando as descartadas em `discardedMessages` para permitir unrevert.
 * Em modo código, `snapshot`/`files`/`diff` registram o estado do
 * filesystem anterior ao restore. */
export interface SessionRevert {
  messageId: string
  /** Tree hash capturado antes do restore (modo código) — permite unrevert do filesystem */
  snapshot?: string
  /** Arquivos afetados pelo revert (modo código) */
  files?: string[]
  /** Diff unificado das mudanças revertidas (modo código) */
  diff?: string
  /** Mensagens descartadas no truncamento — permite unrevert da conversa */
  discardedMessages?: ChatMessage[]
  /** true quando o filesystem foi restaurado (revert em modo código com
   * snapshot). false quando o filesystem não pôde ser restaurado (modo
   * código sem snapshot para a mensagem) — a UI avisa explicitamente em
   * vez de tratar como revert de chat. Ausente em modo chat (sem arquivos
   * envolvidos). */
  filesRestored?: boolean
  /** Motivo de o filesystem não ter sido restaurado — presente quando
   * filesRestored === false em modo código. */
  reason?: 'no-snapshot' | 'capture-failed'
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
  /** Execução de uma rotina agendada: a sessão vive no grupo "Rotinas" da
   *  sidebar (nunca em pasta) e é excluída junto com a rotina. */
  routineId?: string
  /** Revert ativo (modo código) — limpo ao desfazer ou enviar nova mensagem */
  revert?: SessionRevert
  createdAt: number
  updatedAt: number
}

export interface FolderInfo {
  id: string
  name: string
  mode: SessionMode
  pinned: boolean
  /** Pasta arquivada: some do grupo "Pastas" e vai para "Arquivados" com seus
   *  chats (arquivados junto). Chats removidos de uma pasta arquivada caem
   *  para os recentes, sem desarquivar. */
  archived: boolean
  createdAt: number
}

export type TextPartState = "streaming" | "done"

export interface TextPart {
  id: string
  type: "text"
  text: string
  state: TextPartState
  /**
   * "attachment" = gerado por extração de anexo (PDF/planilha/DOCX/skill),
   * não digitado pelo usuário. O modelo ainda recebe esse texto normalmente
   * (toModelMessages/partText não filtram por origem) — só a bolha visível
   * do chat esconde essas parts, mostrando apenas o que a pessoa escreveu.
   * "vision" = indicador transitório do modo Visão ("Analisando imagem…"),
   * emitido enquanto o modelo de visão descreve um anexo; nunca persiste.
   * "nudge" = texto gerado numa continuação INTERNA do engine (nudge de
   * verificação/anti-overclaim — ver NO_CHANGES_PROMPT em chat-engine.ts),
   * não em resposta direta ao usuário. A UI renderiza sempre em cor apagada
   * (nunca como resposta final branca); o engine promove a normal quando o
   * turno de fato grava arquivos depois do nudge.
   * "internal" = texto do nudge que terminou como confirmação de que não
   * havia nada a corrigir (falso positivo do gatilho): é verificação interna
   * pura — a UI NÃO o renderiza de forma alguma.
   * "todo" = texto gerado na continuação do nudge de fechamento da TODO
   * (TODO_COMPLETION_PROMPT): bookkeeping da checklist, não a resposta ao
   * usuário. Renderiza como o "nudge" (sempre apagado, nunca resposta final),
   * mas nunca é promovido a normal — senão essa linha curta roubaria o lugar
   * da resposta final que o modelo já tinha escrito.
   */
  source?: "attachment" | "vision" | "nudge" | "internal" | "todo"
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

/** Arquivo anexado pelo usuário à mensagem (data URL vinda do input) */
export interface FilePart {
  id: string
  type: "file"
  /** MIME type (image/png, text/plain, application/pdf…) */
  mime: string
  filename?: string
  /** Data URL com o conteúdo do arquivo */
  url: string
  /**
   * Chip de UI: anexo já pré-processado pelo engine (conteúdo extraído como
   * texto no TextPart irmão ou descrito pelo modelo de visão). O modelo NÃO
   * recebe o arquivo (toModelMessages ignora chips). Em imagens, `url`
   * carrega um thumbnail reduzido só para a bolha do chat; nos demais
   * formatos fica vazio.
   */
  chip?: boolean
}

/** Agente do pipeline /init exibido como acordeon (estilo thinking): o
 * principal narra a revisão; cada worker mostra sua exploração em streaming. */
export interface AgentPart {
  id: string
  type: "agent"
  /** Rótulo exibido (ex: "Design System", "Agente principal") */
  label: string
  role: "main" | "worker"
  text: string
  state: "running" | "done" | "error"
  durationMs?: number
}

export type MessagePart = TextPart | ReasoningPart | ToolPart | ImagePart | FilePart | AgentPart

export interface TokenUsage {
  /** Soma de todos os steps do turno (tool loop) — reflete custo/billing, NÃO
   * o tamanho do contexto atual (um turno com N idas-e-vindas de tool reenvia
   * o histórico N vezes, então este valor pode ser um múltiplo do contexto real). */
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** USD, calculado com os preços do catálogo (quando disponíveis) */
  cost?: number
  /** Usage só do ÚLTIMO step do turno — essa sim é a métrica correta de
   * "tamanho do contexto atual", usada pelo medidor de contexto e pelo
   * gatilho de compactação. Ausente em mensagens persistidas antes desse campo existir. */
  lastStep?: { input: number; output: number }
}

/** Snapshots do filesystem capturados em volta de uma resposta do assistente
 * (modo código): permitem revert per-message. */
export interface AssistantSnapshot {
  /** Tree hash antes do stream começar. Ausente quando a captura inicial
   * falhou (ver `failed`) — sinaliza que não há estado anterior para
   * diff/revert. */
  start?: string
  /** Tree hash depois de todas as tools executarem */
  end?: string
  /** Arquivos alterados entre start e end */
  files?: string[]
  /** Diff unificado entre start e end (truncado em ~200kB) */
  patch?: string
  /** true quando o rastreamento do filesystem falhou neste turno (start/end
   *  não capturados) — a UI avisa que as alterações não foram registradas. */
  failed?: boolean
  /** Motivo da falha da captura inicial (start) — para diagnóstico e a UI
   * explicar por que não há diff/revert disponível. */
  captureError?: string
  /**
   * Veredito da verificação de fim de turno, calculado pelo engine comparando
   * os snapshots (não é afirmação do modelo):
   * - `changed`: arquivos alterados (files/patch preenchidos)
   * - `unchanged`: o turno não escreveu NADA no filesystem
   * - `unknown`: sem snapshot ou a captura falhou — não dá para afirmar nada
   *
   * É a única evidência dura do que o turno fez que sobrevive para os turnos
   * seguintes: ToolParts nunca voltam ao modelo (ver todo-context.ts), então
   * sem isto o histórico guarda só a NARRATIVA do agente sobre o próprio
   * trabalho — e uma alegação falsa vira "fato" nos turnos posteriores.
   */
  verified?: 'changed' | 'unchanged' | 'unknown'
}

/**
 * Causa da falha de um turno, quando reconhecível.
 * - `moderation`: o provedor bloqueou a resposta por filtro de conteúdo. É
 *   server-side (ex: DashScope/Qwen) — não há como desligar pelo request.
 * - `model-unavailable`: o modelo não existe/não é servido pelo provedor.
 * Ambos são resolvidos trocando de modelo, não repetindo a mesma chamada.
 */
export type MessageErrorKind = "moderation" | "model-unavailable" | "unknown"

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  parts: MessagePart[]
  /** Quando a mensagem foi criada — para o assistant, é o início do turno (antes do modelo responder). */
  createdAt: number
  /** Quando o assistant terminou de responder (stream concluído, erro ou abort). Ausente enquanto ainda está gerando. */
  completedAt?: number
  providerId?: string
  modelId?: string
  error?: string
  /** Classificação da falha — a UI usa para explicar a causa e oferecer a ação
   *  certa (ex: moderação do provedor só é contornável trocando de modelo). */
  errorKind?: MessageErrorKind
  /** Gerada em modo simples: UI enxuta (sem tool/reasoning views); texto ainda com markdown */
  simple?: boolean
  /** Modo ativo do turno em que a mensagem foi enviada (user) — metadados
   *  lidos pela tool session_context. Ausente em mensagens antigas. */
  mode?: SessionMode
  /** Modo de permissões vigente no turno (user) — metadados lidos pela tool
   *  session_context. Ausente em mensagens antigas. */
  permissionMode?: PermissionMode
  /** Tokens consumidos na geração desta mensagem (assistant) */
  tokens?: TokenUsage
  /** Mensagem sintética de compactação: resumo do histórico anterior */
  summary?: boolean
  /** Snapshots start/end do filesystem (assistant, modo código) */
  snapshot?: AssistantSnapshot
  /** true quando a geração parou por atingir o teto de passos (MAX_STEPS) em
   * vez de o modelo concluir naturalmente — sinaliza à UI e ao próprio
   * modelo (no próximo turno) que o trabalho pode ter ficado incompleto. */
  truncated?: boolean
  /** true quando a resposta terminou com itens da TODO ainda "in_progress"
   * (o modelo não marcou como concluído). Vira lembrete para o modelo no
   * próximo turno (via messageContextText) e para a UI explicar o spinner. */
  todoReminder?: boolean
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
export type PermissionDecision = "allow" | "always_chat" | "always" | "deny"

/** Ação sensível que uma ferramenta quer executar (bash, write, edit, MCP) */
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
  status: "proposed" | "implementing" | "rejected" | "revising"
  messageId: string
  /** Conteúdo do plano exibido no chat; não é persistido como arquivo por padrão. */
  content?: string
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
  /** Modo Brain: memória persistente (ferramentas memory_* ) */
  brain?: boolean
  /** Injeta memórias relevantes automaticamente no prompt */
  brainContext?: boolean
  /** Modo Orchestra: divide em plano de tarefas + workers em sessões filhas */
  orchestrate?: { plan?: OrchestrationPlan }
  /** Modo Loop: agente revisa e itera até completar a tarefa (max N iterações configurável) */
  loop?: boolean
  /** Modo de permissões (code-mode e workers): default efetivo "ask" */
  permissionMode?: PermissionMode
  /** /init: executa o pipeline de análise de projeto em vez de gerar texto */
  initMode?: boolean
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
  /** Arquivos anexados à mensagem do usuário */
  files?: FilePart[]
  providerId: string
  modelId: string
  mode: SessionMode
  options: SendMessageOptions
  directory?: string
  extraDirectories?: string[]
  /** Modelo dos workers (subagents/orchestra), vindo do modal de configuração */
  workerModel?: WorkerModelConfig
  /** Modelo de visão delegado (modo Visão) — descreve imagens para modelos sem visão */
  visionModel?: WorkerModelConfig
  /** Preenchido pelo main process em execuções de worker — nunca pelo renderer */
  orchestrationRole?: "orchestrator" | "worker"
  /** Sessão do orquestrador que criou este worker (preenchido pelo main) */
  parentSessionId?: string
  /** Título curto da tarefa do worker, para badges de origem (preenchido pelo main) */
  workerTitle?: string
  /** True na primeira troca da sessão (sem histórico prévio). Controla injeção de conteúdo de memória. */
  isFirstExchange?: boolean
  /** Configuração do modo loop (enviada do renderer) */
  loopConfig?: { maxIterations: number; maxTokensPerIter: number; autoReview: boolean }
  /** Idioma preferido do usuário (nome em inglês, ex: "Portuguese", "English") —
   * usado nos system prompts para instruir o modelo a responder nesse idioma
   * por padrão. O modelo ainda pode seguir o idioma da própria mensagem do
   * usuário quando ela difere claramente disto (ver IDENTITY em prompts.ts). */
  language?: string
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
      kind: "text" | "reasoning" | "agent"
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
  /** Sessão excluída (desktop ou companion) — remove da UI em todos os clientes */
  | { type: "session:deleted"; sessionId: string }
  /** Lista de pastas mudou (criada/renomeada/fixada/removida) — substituição completa */
  | { type: "folders"; folders: FolderInfo[] }
  /** Clique numa notificação nativa — o renderer abre a sessão correspondente */
  | { type: "notifications:open"; sessionId: string }

/** Modalidades suportadas por um modelo (models.dev): text, image, audio, video, pdf */
export interface ModelModalities {
  input: string[]
  output: string[]
}

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
  /** Tipos de input/output aceitos (text, image, audio, video, pdf) */
  modalities?: ModelModalities
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

/** O modelo aceita imagens como input? Usa as modalidades do models.dev
 * (input inclui 'image'); sem modalidades, cai no flag `attachment`. */
export function modelSupportsVision(provider: CatalogProvider | undefined, modelId: string): boolean {
  const model = provider?.models[modelId]
  if (!model) return false
  const input = model.modalities?.input
  if (input && input.length > 0) return input.includes('image')
  return model.attachment === true
}

export interface ProviderCredential {
  type: "api"
  key: string
}

/** Chaves usadas no storage genérico (main process) */
/** Mensagem enfileirada para envio posterior (fila ou agendada) */
export interface QueuedMessage {
  id: string
  text: string
  /** Arquivos anexados (data URLs) */
  files?: FilePart[]
  options: SendMessageOptions
  mode: SessionMode
  sessionId?: string
  directory?: string
  extraDirectories?: string[]
  /** Timestamp MS para envio agendado; undefined = envia assim que possível */
  scheduledAt?: number
  createdAt: number
  /** Número de tentativas já realizadas */
  retryCount?: number
}

export const MAX_QUEUE_RETRIES = 3

export const StorageKeys = {
  session: (id: string) => `session/${id}`,
  sessionPrefix: "session/",
  messages: (sessionId: string) => `messages/${sessionId}`,
  folders: "folders",
  orchestration: (orchestratorSessionId: string) => `orchestration/${orchestratorSessionId}`,
  planReview: (sessionId: string) => `plan-review/${sessionId}`,
  pendingAsks: (sessionId: string) => `pendingAsks/${sessionId}`,
  memory: (id: string) => `memory/items/${id}`,
  memoryItemsPrefix: "memory/items/",
  memoryIndex: "memory/_index",
  /** Idioma efetivo do app, publicado pelo renderer para o main ler.
   *  O scheduler de rotinas roda sem renderer no laço e precisa dele. */
  appLanguage: "app-language",
  queuedMessages: "message-queue",
} as const
