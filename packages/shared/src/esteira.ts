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

import type { ReasoningConfig } from './chat'

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
  /** Legado (nunca lido na execução) — o nível de raciocínio vive em `reasoning`. */
  thinkingNivel: number
  /** Raciocínio da fase; ausente/null = desligado */
  reasoning?: ReasoningConfig | null
  /** Template de origem (ausente em fase criada do zero ou gravada antes do campo) */
  templateId?: string
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
  /** Fase criada pelo usuário (não é sobrescrita de uma embutida) — pode ser excluída */
  doUsuario?: boolean
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
  /** Modelo próprio da fase; ausente = herda o modelo padrão da esteira */
  providerId?: string
  modelId?: string
  /** Raciocínio próprio da fase; undefined = herda o da esteira, null = desligado */
  reasoning?: ReasoningConfig | null
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
   * O engine cria um commit final ao concluir a última fase, contendo só o
   * que a task mudou (padrão true). As fases posteriores à desenvolvimento
   * não podem commitar (templates), então sem isto os ajustes delas viveriam
   * só na working tree — e um push (pushAoFinal) subiria um branch sem eles.
   */
  commitAoFinal: boolean
  /**
   * Prompt do agente que escreve a mensagem do commit final. Ausente = o
   * default (ESTEIRA_COMMIT_PROMPT_PADRAO): seguir as preferências de commits
   * do usuário na memória; sem elas, Conventional Commits com header e body.
   */
  commitPrompt?: string
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
  /** Rodada em que a anotação foi escrita (ausente = 1, anterior às rodadas) */
  rodada?: number
}

/**
 * Revisão do usuário que devolveu uma task concluída para a esteira. Cada
 * devolução abre uma rodada nova (a primeira abre a rodada 2).
 */
export interface Devolucao {
  /** Rodada que esta devolução abre */
  rodada: number
  /** O que o usuário quer corrigido — instrução prioritária da rodada */
  texto: string
  /** Índice da fase por onde a rodada recomeça */
  faseInicial: number
  criadoEm: string
}

/**
 * Instrução que o usuário deu ao retomar uma task pausada. Vale para a fase em
 * que a task parou, na rodada em que foi dada — sem abrir rodada nova.
 */
export interface InstrucaoRetomada {
  texto: string
  rodada: number
  faseId: string
  faseNome: string
  criadoEm: string
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
  /**
   * Commit final falhou (commitAoFinal ligado): o erro do git fica aqui — a
   * task não pausa, o trabalho está feito; commit e push são entrega.
   */
  commitFalha?: string
  /** Hash do commit final criado pelo engine (commitAoFinal ligado). */
  commitFinalHash?: string
  /** Rodada atual (ausente = 1). Sobe a cada devolução. */
  rodada?: number
  /** Devoluções em ordem — o histórico de revisões da task */
  devolucoes?: Devolucao[]
  /** Instruções dadas ao retomar a task pausada, em ordem */
  instrucoes?: InstrucaoRetomada[]
  /** Commits finais das rodadas anteriores (o da rodada atual é commitFinalHash) */
  commitsAnteriores?: string[]
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

/** Rodada atual da task (tasks anteriores às rodadas contam como 1). */
export function rodadaDaTask(task: Pick<Task, 'rodada'>): number {
  return task.rodada ?? 1
}

/** Anotações escritas numa rodada. */
export function anotacoesDaRodada(task: Pick<Task, 'anotacoes'>, rodada: number): AnotacaoFase[] {
  return task.anotacoes.filter((a) => (a.rodada ?? 1) === rodada)
}

/** Instruções de retomada dadas numa rodada. */
export function instrucoesDaRodada(task: Pick<Task, 'instrucoes'>, rodada: number): InstrucaoRetomada[] {
  return (task.instrucoes ?? []).filter((i) => i.rodada === rodada)
}

/** Devolução que abriu a rodada (undefined na rodada 1). */
export function devolucaoDaRodada(task: Pick<Task, 'devolucoes'>, rodada: number): Devolucao | undefined {
  return task.devolucoes?.find((d) => d.rodada === rodada)
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

/** Entrada de criação de esteira — usada pela UI, pelo app companion e pelas tools de chat. */
export interface NovaEsteiraInput {
  projetoId: string
  nome: string
  /** Fases já resolvidas (podem ter sido editadas só para esta esteira). */
  fases?: FaseEscolhida[]
  /** Alternativa simples (tools do chat): ids de template, na ordem desejada. */
  templateIds?: string[]
  providerId: string
  modelId: string
  thinkingNivel?: number
  /** Raciocínio padrão das fases (cada fase pode trazer o seu) */
  reasoning?: ReasoningConfig | null
  branch?: string
  worktree?: string
  pushAoFinal?: boolean
  /** Commit final do engine ao concluir a última fase (padrão true) */
  commitAoFinal?: boolean
  /** Prompt da mensagem do commit final (ausente = ESTEIRA_COMMIT_PROMPT_PADRAO) */
  commitPrompt?: string
  /** Instrui as fases a capturarem prints do resultado visual */
  printsDoResultado?: boolean
  modoOperacao?: 'manual' | 'automatico'
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

/**
 * Prompt padrão do agente que escreve a mensagem do commit final (D10). É o
 * valor de `Esteira.commitPrompt` quando o usuário não customiza: segue as
 * preferências de commits dele salvas nas memórias; sem elas, Conventional
 * Commits com header + body de tópicos resumidos. O contexto (task, anotações
 * das fases, arquivos alterados) vai na mensagem do usuário, como nas fases.
 */
export const ESTEIRA_COMMIT_PROMPT_PADRAO = `Write the git commit message for the final state of this pipeline task.

Follow the user's commit preferences from memory when they exist (language, format, scope). If there are none, fall back to Conventional Commits: a concise header "type: subject" plus a body with the summarized topics of what changed.

Base the message ONLY on the actual changes in the context below (task description, notes from the phases, changed files) — never invent work that was not done. The header must be short; the body lists the main topics, not a file-by-file log.

Output just the commit message: first line the header, then a blank line, then the body. No markdown fences, no commentary.`
