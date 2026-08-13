/**
 * Modo Esteira — executor de pipeline de tasks (docs/esteira-plan.md).
 *
 * Um projeto (board) tem esteiras; cada esteira é uma sequência FIXA de fases
 * e uma fila de tasks. Cada fase roda com prompt, modelo, thinking e tools
 * próprios, sem chat e sem agente gestor: o roteamento é a própria ordem das
 * fases.
 *
 * Os nomes do domínio ficam em português porque são o vocabulário do produto
 * (o plano define assim) — o resto do código segue a convenção do repo.
 */

// ─── Projeto ─────────────────────────────────────────────────────────────────

export interface Projeto {
  id: string
  nome: string
  /** Pastas de trabalho, mesma semântica do seletor de pastas do chat */
  pastas: string[]
  criadoEm: string
  /** ids das esteiras do projeto */
  esteiras: string[]
}

// ─── Fases ───────────────────────────────────────────────────────────────────

/**
 * Capacidades liberadas por fase. É um agrupamento de produto, não o nome das
 * tools do engine — o mapeamento vive em electron/lib/esteira/runner.ts.
 */
export type ToolPermitida = 'leitura' | 'edit' | 'shell' | 'browser' | 'memoria'

export interface FaseConfig {
  id: string
  nome: string
  descricao: string
  /** Instruções da fase: o que fazer, o que anotar, quando falhar */
  prompt: string
  /** Herda o modelo padrão da esteira; editável por fase */
  providerId: string
  modelId: string
  /** 0 = desligado */
  thinkingNivel: number
  tools: ToolPermitida[]
  /** Posição na sequência — a execução segue a ordem crescente, sem pular */
  ordem: number
}

/** Template de fases do sistema: as fases são COPIADAS ao criar a esteira,
 *  então editar a esteira nunca altera o template mestre. */
export interface FaseTemplate {
  id: string
  nome: string
  descricao: string
  prompt: string
  tools: ToolPermitida[]
  /** true nas fases que compõem o template "Padrão" de uma esteira nova */
  padrao: boolean
}

// ─── Política de comandos ────────────────────────────────────────────────────

/**
 * Três camadas: o que não está em nenhuma lista é livre. Mais conservadora que
 * o modo interativo porque a esteira roda sem supervisão (D5/D6).
 */
export interface PoliticaComandos {
  /** Recusado e anotado na task — conta como falha da fase */
  bloqueados: string[]
  /** Executa e registra em AnotacaoFase.comandosControlados */
  controlados: string[]
}

// ─── Esteira ─────────────────────────────────────────────────────────────────

export type ModoOperacao = 'manual' | 'automatico'

export interface Esteira {
  id: string
  projetoId: string
  nome: string
  /** Cópia dos templates, editável sem afetar o mestre */
  fases: FaseConfig[]
  /** Branch de trabalho (ausente = branch atual do repo) */
  branch?: string
  /** Caminho do worktree dedicado, quando usado */
  worktree?: string
  modoOperacao: ModoOperacao
  /** Tentativas por fase antes de pausar a task (padrão 3) */
  retryCount: number
  /** A fase final faz push (padrão false — commit local) */
  pushAoFinal: boolean
  politicaComandos: PoliticaComandos
  templateId?: string
  criadoEm: string
}

// ─── Task ────────────────────────────────────────────────────────────────────

export type TaskStatus = 'pendente' | 'em_progresso' | 'pausada' | 'concluida'

export interface AnotacaoFase {
  faseId: string
  faseNome: string
  /** 'pulada' = a task começou numa fase posterior (início manual por drag) */
  status: 'ok' | 'erro' | 'pulada'
  /** Markdown: o que foi feito, artefatos, decisões */
  conteudo: string
  comandosControlados: string[]
  commitHash?: string
  tokens: number
  custo: number
  iniciadoEm: string
  concluidoEm: string
}

export interface Task {
  id: string
  esteiraId: string
  titulo: string
  descricao: string
  status: TaskStatus
  /** Índice 0-based da fase em execução; null enquanto pendente */
  faseAtual: number | null
  pausaMotivo?: 'manual' | 'erro'
  erro?: string
  /** Tasks que precisam concluir antes desta iniciar */
  dependeDe: string[]
  anotacoes: AnotacaoFase[]
  criadoEm: string
  iniciadoEm?: string
  concluidoEm?: string
  /** Soma dos períodos em execução (exclui pausas) */
  tempoTrabalhoMs: number
  tokens: number
  custo: number
  /** Origem da task, quando criada pelo agente a partir de um chat */
  origemSessionId?: string
}

// ─── Relatório ───────────────────────────────────────────────────────────────

export interface RelatorioEsteira {
  esteiraId: string
  tasksConcluidas: number
  tasksFalhas: number
  tasksEmAndamento: number
  tasksPendentes: number
  commitsCriados: string[]
  tokensTotais: number
  custoTotal: number
  tempoTotalMs: number
  atualizadoEm: string
}

// ─── Eventos (main → renderer) ───────────────────────────────────────────────

export type EsteiraEvent =
  | { type: 'task'; esteiraId: string; task: Task }
  | { type: 'tasks'; esteiraId: string; tasks: Task[] }
  | { type: 'esteira'; esteira: Esteira }
  | { type: 'projetos'; projetos: Projeto[] }
  /** Progresso textual da fase em execução (feed ao vivo no card) */
  | { type: 'fase-progresso'; esteiraId: string; taskId: string; faseIndice: number; texto: string }

/** Entrada de criação de task — usada pela UI e pelas tools de chat. */
export interface NovaTaskInput {
  esteiraId: string
  titulo: string
  descricao: string
  dependeDe?: string[]
  origemSessionId?: string
}

export const ESTEIRA_RETRY_PADRAO = 3
