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

/**
 * Papel da fase no pipeline. Define o que a fase faz — e o que ela deixa para
 * as próximas — independentemente do nome que o usuário der a ela. É o que
 * permite rotear responsabilidades (ex.: validar) mesmo em fases customizadas.
 */
export type FaseTipo = 'desenvolvimento' | 'validacao' | 'seguranca' | 'revisao' | 'infra' | 'generico'

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
  /**
   * Papel da fase no pipeline. Opcional por retrocompatibilidade: esteiras
   * gravadas antes deste campo lêem como 'generico' no consumo.
   */
  tipo?: FaseTipo
}

/** Template de fases do sistema: as fases são COPIADAS ao criar a esteira,
 *  então editar a esteira nunca altera o template mestre. */
export interface FaseTemplate {
  id: string
  nome: string
  descricao: string
  prompt: string
  tools: ToolPermitida[]
  /** true nas fases sugeridas de cara numa esteira nova (as demais entram pelo "+") */
  padrao: boolean
  /** Criado ou sobrescrito pelo usuário ("salvar como padrão") */
  custom?: boolean
  /** Chave de i18n do nome/descrição (fases embutidas). Ausente nas do usuário. */
  i18nKey?: string
  /** Papel da fase no pipeline (define responsabilidades além do nome/prompt). */
  tipo: FaseTipo
}

/** Fase já resolvida no modal de criação — pode ter sido editada só para esta
 *  esteira, sem virar padrão. */
export interface FaseEscolhida {
  /** Template de origem (ausente em fase criada do zero) */
  templateId?: string
  nome: string
  descricao: string
  prompt: string
  tools: ToolPermitida[]
  /** Papel da fase no pipeline. */
  tipo: FaseTipo
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
  /** O engine faz push do branch ao concluir a última fase (padrão false — commit local) */
  pushAoFinal: boolean
  /**
   * Instrui as fases a capturarem prints do resultado visual das mudanças
   * (run_browser_script / panel_screenshot) e a anexá-los na anotação.
   */
  printsDoResultado?: boolean
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
  /**
   * A fase corrente foi abortada no meio (pausa forçada). Ao retomar, ela roda
   * DO ZERO — e recebe o aviso de que o repositório pode ter mudanças parciais
   * da tentativa interrompida.
   */
  faseInterrompida?: boolean
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
  /**
   * Push final falhou (pushAoFinal ligado): a task foi concluída, mas o branch
   * não subiu — o erro fica aqui para o usuário resolver (a task não pausa).
   */
  pushFalha?: string
  /** Origem da task, quando criada pelo agente a partir de um chat */
  origemSessionId?: string
  /**
   * Task iniciada pela FILA AUTOMÁTICA (uma por vez): a fila só dispara a
   * próxima quando a automática atual conclui TODAS as fases. Tasks sem este
   * campo foram iniciadas manualmente e rodam em paralelo de propósito.
   */
  auto?: boolean
  /**
   * Diff acumulado da task (snapshot do filesystem antes da primeira fase x
   * estado atual). É o que a UI mostra no badge de arquivos alterados e abre
   * no painel — o mesmo caminho do diff por mensagem no chat.
   */
  diff?: {
    /** Tree hash antes da primeira fase */
    inicio: string
    arquivos: string[]
    patch: string
  }
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
  /** Pensamento do modelo (reasoning) da fase em execução, delta por delta */
  | { type: 'fase-pensando'; esteiraId: string; taskId: string; faseIndice: number; texto: string }
  /** Chamada de ferramenta da fase em execução (início e fim) */
  | {
      type: 'fase-tool'
      esteiraId: string
      taskId: string
      faseIndice: number
      toolCallId: string
      tool: string
      estado: 'rodando' | 'concluida' | 'erro'
      resumo: string
      detalhe?: string
    }

/** Entrada de criação de task — usada pela UI e pelas tools de chat. */
export interface NovaTaskInput {
  esteiraId: string
  titulo: string
  descricao: string
  dependeDe?: string[]
  origemSessionId?: string
}

/**
 * Tentativas por fase antes de pausar a task com erro. É parâmetro interno do
 * Orbit, igual para todas as esteiras — não configurável por esteira: quem
 * está montando um pipeline não tem como calibrar esse número, e expô-lo só
 * daria mais uma decisão sem resposta certa.
 */
export const ESTEIRA_RETRY_PADRAO = 3
