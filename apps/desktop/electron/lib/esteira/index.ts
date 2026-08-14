import type {
  Esteira,
  FaseConfig,
  FaseEscolhida,
  FaseTemplate,
  Projeto,
  RelatorioEsteira,
  Task,
} from '@shared/esteira'
import {
  atualizarTaskCampos,
  criarTask,
  desligarFila,
  emitir,
  filaLigada,
  iniciarTask,
  ligarFila,
  pausarTask,
  removerTask,
  retomarTask,
  taskEmExecucao,
} from './engine'
import {
  listarEsteiras,
  listarProjetos,
  listarTasks,
  listarTemplatesCustom,
  removerTasks,
  salvarEsteiras,
  salvarProjetos,
  salvarTemplatesCustom,
} from './repo'
import { FASE_TEMPLATES, POLITICA_PADRAO, templatesPadrao } from './templates'

/**
 * Fachada do modo esteira: é o que o IPC e as tools de chat consomem. O engine
 * cuida da execução; aqui fica o CRUD e a montagem das esteiras a partir dos
 * templates.
 */

export {
  criarTask,
  iniciarTask,
  pausarTask,
  retomarTask,
  removerTask,
  atualizarTaskCampos,
  ligarFila,
  desligarFila,
  filaLigada,
  taskEmExecucao,
  listarTasks,
  listarProjetos,
  listarEsteiras,
}
export { abortarTudo } from './engine'

function novoId(prefixo: string): string {
  return `${prefixo}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function agora(): string {
  return new Date().toISOString()
}

/**
 * Templates disponíveis: os embutidos + os do usuário. Quando o id coincide, o
 * do usuário vence (é uma sobrescrita do embutido). Guardar separado permite
 * que uma atualização do Orbit melhore os prompts de fábrica sem apagar o que
 * o usuário escreveu.
 */
export async function listarTemplates(): Promise<FaseTemplate[]> {
  const custom = await listarTemplatesCustom()
  const porId = new Map(FASE_TEMPLATES.map((t) => [t.id, t]))
  for (const t of custom) {
    // Templates antigos (gravados antes do campo `tipo`) herdam o papel do
    // embutido de mesmo id; fases novas do usuário caem em 'generico'.
    porId.set(t.id, { ...t, tipo: t.tipo ?? porId.get(t.id)?.tipo ?? 'generico', custom: true })
  }
  return [...porId.values()]
}

/** Cria ou sobrescreve um template ("salvar como padrão" no editor de fase). */
export async function salvarTemplate(template: FaseTemplate): Promise<FaseTemplate[]> {
  const custom = await listarTemplatesCustom()
  const proximo: FaseTemplate = { ...template, custom: true }
  const indice = custom.findIndex((t) => t.id === template.id)
  if (indice >= 0) custom[indice] = proximo
  else custom.push(proximo)
  await salvarTemplatesCustom(custom)
  return listarTemplates()
}

/** Remove um template do usuário. Embutido volta a valer no lugar da sobrescrita. */
export async function removerTemplate(id: string): Promise<FaseTemplate[]> {
  const custom = await listarTemplatesCustom()
  await salvarTemplatesCustom(custom.filter((t) => t.id !== id))
  return listarTemplates()
}

// ─── Projetos ────────────────────────────────────────────────────────────────

export async function criarProjeto(nome: string, pastas: string[]): Promise<Projeto> {
  const projetos = await listarProjetos()
  const projeto: Projeto = { id: novoId('proj_'), nome, pastas, criadoEm: agora(), esteiras: [] }
  const todos = [...projetos, projeto]
  await salvarProjetos(todos)
  emitir({ type: 'projetos', projetos: todos })
  return projeto
}

export async function atualizarProjeto(
  id: string,
  patch: Partial<Pick<Projeto, 'nome' | 'pastas'>>,
): Promise<Projeto | null> {
  const projetos = await listarProjetos()
  const indice = projetos.findIndex((p) => p.id === id)
  if (indice < 0) return null
  projetos[indice] = { ...projetos[indice], ...patch }
  await salvarProjetos(projetos)
  emitir({ type: 'projetos', projetos })
  return projetos[indice]
}

export async function removerProjeto(id: string): Promise<void> {
  const projetos = await listarProjetos()
  const esteiras = await listarEsteiras()
  // Remove as esteiras do projeto junto — deixá-las órfãs esconderia tasks
  // rodando sem nenhuma tela onde aparecer.
  for (const esteira of esteiras.filter((e) => e.projetoId === id)) {
    desligarFila(esteira.id)
    await removerTasks(esteira.id)
  }
  await salvarEsteiras(esteiras.filter((e) => e.projetoId !== id))
  const restantes = projetos.filter((p) => p.id !== id)
  await salvarProjetos(restantes)
  emitir({ type: 'projetos', projetos: restantes })
}

// ─── Esteiras ────────────────────────────────────────────────────────────────

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
  branch?: string
  worktree?: string
  pushAoFinal?: boolean
  /** Instrui as fases a capturarem prints do resultado visual */
  printsDoResultado?: boolean
  modoOperacao?: 'manual' | 'automatico'
}

/** Fases da esteira = CÓPIA do que foi escolhido (D4): editar a esteira depois
 *  nunca toca no template mestre. */
async function copiarFases(input: NovaEsteiraInput): Promise<FaseConfig[]> {
  const disponiveis = await listarTemplates()
  const comoEscolhida = (t: FaseTemplate): FaseEscolhida => ({
    templateId: t.id,
    nome: t.nome,
    descricao: t.descricao,
    prompt: t.prompt,
    tools: t.tools,
    tipo: t.tipo,
  })

  let escolhidas = input.fases
  if (!escolhidas?.length) {
    const ids = input.templateIds?.length ? input.templateIds : templatesPadrao().map((t) => t.id)
    escolhidas = ids
      .map((id) => disponiveis.find((t) => t.id === id))
      .filter((t): t is FaseTemplate => !!t)
      .map(comoEscolhida)
  }

  return escolhidas.map((fase, ordem) => ({
    id: novoId('fase_'),
    nome: fase.nome,
    descricao: fase.descricao,
    prompt: fase.prompt,
    providerId: input.providerId,
    modelId: input.modelId,
    thinkingNivel: input.thinkingNivel ?? 0,
    tools: [...fase.tools],
    tipo: fase.tipo,
    ordem,
  }))
}

export async function criarEsteira(input: NovaEsteiraInput): Promise<Esteira> {
  const esteira: Esteira = {
    id: novoId('est_'),
    projetoId: input.projetoId,
    nome: input.nome,
    fases: await copiarFases(input),
    branch: input.branch,
    worktree: input.worktree,
    modoOperacao: input.modoOperacao ?? 'manual',
    pushAoFinal: input.pushAoFinal ?? false,
    printsDoResultado: input.printsDoResultado ?? false,
    politicaComandos: { bloqueados: [...POLITICA_PADRAO.bloqueados], controlados: [...POLITICA_PADRAO.controlados] },
    templateId: input.fases?.map((f) => f.templateId ?? 'custom').join(',') ?? input.templateIds?.join(','),
    criadoEm: agora(),
  }
  const esteiras = await listarEsteiras()
  await salvarEsteiras([...esteiras, esteira])

  const projetos = await listarProjetos()
  const projeto = projetos.find((p) => p.id === input.projetoId)
  if (projeto) {
    projeto.esteiras = [...projeto.esteiras, esteira.id]
    await salvarProjetos(projetos)
    emitir({ type: 'projetos', projetos })
  }
  emitir({ type: 'esteira', esteira })
  return esteira
}

export async function atualizarEsteira(
  id: string,
  patch: Partial<Omit<Esteira, 'id' | 'projetoId' | 'criadoEm'>>,
): Promise<Esteira | null> {
  const esteiras = await listarEsteiras()
  const indice = esteiras.findIndex((e) => e.id === id)
  if (indice < 0) return null
  esteiras[indice] = { ...esteiras[indice], ...patch }
  await salvarEsteiras(esteiras)
  emitir({ type: 'esteira', esteira: esteiras[indice] })
  return esteiras[indice]
}

export async function removerEsteira(id: string): Promise<void> {
  desligarFila(id)
  const esteiras = await listarEsteiras()
  await salvarEsteiras(esteiras.filter((e) => e.id !== id))
  await removerTasks(id)
  const projetos = await listarProjetos()
  for (const projeto of projetos) {
    projeto.esteiras = projeto.esteiras.filter((e) => e !== id)
  }
  await salvarProjetos(projetos)
  emitir({ type: 'projetos', projetos })
}

// ─── Relatório (§13) ─────────────────────────────────────────────────────────

export async function relatorio(esteiraId: string): Promise<RelatorioEsteira> {
  const tasks = await listarTasks(esteiraId)
  const commits = new Set<string>()
  let tokens = 0
  let custo = 0
  let tempo = 0
  for (const task of tasks) {
    tokens += task.tokens
    custo += task.custo
    tempo += task.tempoTrabalhoMs
    for (const anotacao of task.anotacoes) {
      if (anotacao.commitHash) commits.add(anotacao.commitHash)
    }
  }
  return {
    esteiraId,
    tasksConcluidas: tasks.filter((t) => t.status === 'concluida').length,
    tasksFalhas: tasks.filter((t) => t.pausaMotivo === 'erro').length,
    tasksEmAndamento: tasks.filter((t) => t.status === 'em_progresso').length,
    tasksPendentes: tasks.filter((t) => t.status === 'pendente').length,
    commitsCriados: [...commits],
    tokensTotais: tokens,
    custoTotal: custo,
    tempoTotalMs: tempo,
    atualizadoEm: agora(),
  }
}

/** Snapshot completo para a UI abrir o board numa tacada só. */
export async function carregarTudo(): Promise<{
  projetos: Projeto[]
  esteiras: Esteira[]
  tasksPorEsteira: Record<string, Task[]>
}> {
  const projetos = await listarProjetos()
  const esteiras = await listarEsteiras()
  const tasksPorEsteira: Record<string, Task[]> = {}
  for (const esteira of esteiras) {
    tasksPorEsteira[esteira.id] = await listarTasks(esteira.id)
  }
  return { projetos, esteiras, tasksPorEsteira }
}
