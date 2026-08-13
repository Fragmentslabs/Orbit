import { BrowserWindow } from 'electron'
import type { AnotacaoFase, Esteira, EsteiraEvent, Projeto, Task } from '@shared/esteira'
import { ESTEIRA_RETRY_PADRAO } from '@shared/esteira'
import { capture, diff } from '../snapshot'
import { criaCiclo, dependenciasPendentes } from './contrato'
import { executarFase } from './runner'
import { atualizarTask, listarEsteiras, listarProjetos, listarTasks, salvarTasks } from './repo'

/**
 * Máquina de estados e fila do modo esteira (§5, §6, §9 do plano).
 *
 * Regra central: o pipeline é LINEAR. O engine só avança faseAtual → +1;
 * não existe voltar nem pular automático. A única entrada fora da fase 1 é o
 * início manual por drag, e ainda assim as fases anteriores ficam registradas
 * como "pulada" — o histórico nunca finge que elas rodaram.
 */

/** Execuções vivas por task: permite pausar/abortar e evita rodar duas vezes. */
const emExecucao = new Map<string, AbortController>()
/** Esteiras com a fila automática ligada. */
const filasAtivas = new Set<string>()
/** Pausa pedida pelo usuário: a task para ao terminar a fase corrente. */
const pausaSolicitada = new Set<string>()

function agora(): string {
  return new Date().toISOString()
}

function novoId(prefixo: string): string {
  return `${prefixo}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function emitir(evento: EsteiraEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('esteira:event', evento)
  }
}

async function carregarContexto(esteiraId: string): Promise<{ esteira: Esteira; projeto: Projeto } | null> {
  const esteira = (await listarEsteiras()).find((e) => e.id === esteiraId)
  if (!esteira) return null
  const projeto = (await listarProjetos()).find((p) => p.id === esteira.projetoId)
  if (!projeto) return null
  return { esteira, projeto }
}

async function persistir(esteiraId: string, taskId: string, patch: (t: Task) => Task): Promise<Task | null> {
  const task = await atualizarTask(esteiraId, taskId, patch)
  if (task) emitir({ type: 'task', esteiraId, task })
  return task
}

// ─── Dependências ────────────────────────────────────────────────────────────

export { criaCiclo, dependenciasPendentes } from './contrato'

// ─── Execução de uma task ────────────────────────────────────────────────────

/**
 * Roda a task da fase atual até a última, ou até pausar/falhar. Cada fase é
 * tentada até retryCount vezes; esgotado, a task pausa com motivo 'erro' e
 * espera intervenção humana (§9).
 */
async function executarTask(esteiraId: string, taskId: string): Promise<void> {
  if (emExecucao.has(taskId)) return
  const contexto = await carregarContexto(esteiraId)
  if (!contexto) return
  const { esteira, projeto } = contexto

  const controller = new AbortController()
  emExecucao.set(taskId, controller)
  const inicioExecucao = Date.now()
  const raiz = esteira.worktree || projeto.pastas[0]

  /**
   * Snapshot do filesystem antes da primeira fase desta execução. O diff da
   * task é medido contra ele — é o mesmo mecanismo do diff por mensagem do
   * chat, e não depende do agente relatar o que mexeu.
   */
  const inicioDiff = await (async () => {
    const existente = (await listarTasks(esteiraId)).find((t) => t.id === taskId)?.diff?.inicio
    if (existente) return existente // retomada: mantém a base original da task
    try {
      return raiz ? await capture(raiz) : undefined
    } catch (err) {
      console.error('[esteira] snapshot inicial falhou:', err)
      return undefined
    }
  })()

  /** Recalcula o diff acumulado da task contra o snapshot inicial. */
  const medirDiff = async (): Promise<Task['diff'] | undefined> => {
    if (!inicioDiff || !raiz) return undefined
    try {
      const fim = await capture(raiz)
      if (fim === inicioDiff) return { inicio: inicioDiff, arquivos: [], patch: '' }
      const mudancas = await diff(raiz, inicioDiff, fim)
      return { inicio: inicioDiff, arquivos: mudancas.files, patch: mudancas.patch }
    } catch (err) {
      console.error('[esteira] diff da task falhou:', err)
      return undefined
    }
  }

  try {
    for (;;) {
      const tasks = await listarTasks(esteiraId)
      const task = tasks.find((t) => t.id === taskId)
      if (!task || task.status !== 'em_progresso' || task.faseAtual == null) break
      if (controller.signal.aborted) break

      const indice = task.faseAtual
      const fase = esteira.fases[indice]
      if (!fase) {
        // Fases removidas da esteira depois da task começar: conclui em vez de
        // deixar a task presa apontando para uma fase que não existe mais.
        await concluir(esteiraId, taskId, inicioExecucao)
        break
      }

      const iniciadoEm = agora()
      let resultado = await executarFase({
        esteira,
        task,
        fase,
        indiceFase: indice,
        pastas: projeto.pastas,
        tentativa: 1,
        abort: controller.signal,
        onTexto: (texto) =>
          emitir({ type: 'fase-progresso', esteiraId, taskId, faseIndice: indice, texto }),
      })

      // Retry: cada tentativa recebe o erro da anterior para atacar a causa.
      for (let tentativa = 2; resultado.erro && tentativa <= ESTEIRA_RETRY_PADRAO; tentativa++) {
        if (controller.signal.aborted) break
        resultado = await executarFase({
          esteira,
          task,
          fase,
          indiceFase: indice,
          pastas: projeto.pastas,
          tentativa,
          erroAnterior: resultado.erro,
          abort: controller.signal,
          onTexto: (texto) =>
            emitir({ type: 'fase-progresso', esteiraId, taskId, faseIndice: indice, texto }),
        })
      }

      if (controller.signal.aborted) break

      const anotacao: AnotacaoFase = {
        faseId: fase.id,
        faseNome: fase.nome,
        status: resultado.erro ? 'erro' : 'ok',
        conteudo: resultado.anotacao ?? (resultado.texto.slice(0, 4000) || '(sem anotação)'),
        comandosControlados: resultado.comandosControlados,
        commitHash: resultado.commitHash,
        tokens: resultado.tokens,
        custo: resultado.custo,
        iniciadoEm,
        concluidoEm: agora(),
      }

      if (resultado.erro) {
        const diffAtual = await medirDiff()
        await persistir(esteiraId, taskId, (t) => ({
          ...t,
          status: 'pausada',
          pausaMotivo: 'erro',
          erro: resultado.erro,
          diff: diffAtual ?? t.diff,
          anotacoes: [...t.anotacoes, anotacao],
          tokens: t.tokens + resultado.tokens,
          custo: t.custo + resultado.custo,
          tempoTrabalhoMs: t.tempoTrabalhoMs + (Date.now() - inicioExecucao),
        }))
        break
      }

      const ultimaFase = indice >= esteira.fases.length - 1
      const diffAtual = await medirDiff()
      const atualizada = await persistir(esteiraId, taskId, (t) => ({
        ...t,
        diff: diffAtual ?? t.diff,
        anotacoes: [...t.anotacoes, anotacao],
        tokens: t.tokens + resultado.tokens,
        custo: t.custo + resultado.custo,
        faseAtual: ultimaFase ? t.faseAtual : indice + 1,
        status: ultimaFase ? 'concluida' : t.status,
        concluidoEm: ultimaFase ? agora() : t.concluidoEm,
        tempoTrabalhoMs: ultimaFase
          ? t.tempoTrabalhoMs + (Date.now() - inicioExecucao)
          : t.tempoTrabalhoMs,
      }))
      if (ultimaFase || !atualizada) break

      // Pausa pedida durante a fase: só agora, com a fase fechada, para não
      // perder o trabalho no meio (§6.1).
      if (pausaSolicitada.has(taskId)) {
        pausaSolicitada.delete(taskId)
        await persistir(esteiraId, taskId, (t) => ({
          ...t,
          status: 'pausada',
          pausaMotivo: 'manual',
          tempoTrabalhoMs: t.tempoTrabalhoMs + (Date.now() - inicioExecucao),
        }))
        break
      }
    }
  } finally {
    emExecucao.delete(taskId)
    pausaSolicitada.delete(taskId)
    // A fila automática só anda quando uma task termina — é o "uma por vez".
    if (filasAtivas.has(esteiraId)) void avancarFila(esteiraId)
  }
}

async function concluir(esteiraId: string, taskId: string, inicioExecucao: number): Promise<void> {
  await persistir(esteiraId, taskId, (t) => ({
    ...t,
    status: 'concluida',
    concluidoEm: agora(),
    tempoTrabalhoMs: t.tempoTrabalhoMs + (Date.now() - inicioExecucao),
  }))
}

// ─── Fila automática (D9) ────────────────────────────────────────────────────

/**
 * Uma task por vez: só dispara se nenhuma task DA FILA estiver rodando. Tasks
 * iniciadas manualmente rodam em paralelo de propósito e não bloqueiam a fila.
 */
const filaEmAndamento = new Map<string, string>()

async function avancarFila(esteiraId: string): Promise<void> {
  if (!filasAtivas.has(esteiraId)) return
  const atual = filaEmAndamento.get(esteiraId)
  if (atual && emExecucao.has(atual)) return
  filaEmAndamento.delete(esteiraId)

  const tasks = await listarTasks(esteiraId)
  const candidatas = tasks
    .filter((t) => t.status === 'pendente' && dependenciasPendentes(t, tasks).length === 0)
    .sort((a, b) => a.criadoEm.localeCompare(b.criadoEm))

  const proxima = candidatas[0]
  if (!proxima) return
  filaEmAndamento.set(esteiraId, proxima.id)
  await iniciarTask(esteiraId, proxima.id, 0)
}

export function ligarFila(esteiraId: string): void {
  filasAtivas.add(esteiraId)
  void avancarFila(esteiraId)
}

/** Desligar não mata o que está rodando: a task termina a fase e pausa (§6.2). */
export function desligarFila(esteiraId: string): void {
  filasAtivas.delete(esteiraId)
  const atual = filaEmAndamento.get(esteiraId)
  if (atual) pausaSolicitada.add(atual)
  filaEmAndamento.delete(esteiraId)
}

export function filaLigada(esteiraId: string): boolean {
  return filasAtivas.has(esteiraId)
}

// ─── API de controle ─────────────────────────────────────────────────────────

/**
 * Inicia a task na fase indicada. `faseInicial > 0` vem do drag: as fases
 * anteriores entram como 'pulada' para o histórico não sugerir que rodaram.
 */
export async function iniciarTask(esteiraId: string, taskId: string, faseInicial = 0): Promise<void> {
  const contexto = await carregarContexto(esteiraId)
  if (!contexto) return
  const { esteira } = contexto

  const puladas: AnotacaoFase[] = esteira.fases.slice(0, faseInicial).map((fase) => ({
    faseId: fase.id,
    faseNome: fase.nome,
    status: 'pulada',
    conteudo: 'Fase pulada: a task foi iniciada manualmente a partir de uma fase posterior.',
    comandosControlados: [],
    tokens: 0,
    custo: 0,
    iniciadoEm: agora(),
    concluidoEm: agora(),
  }))

  await persistir(esteiraId, taskId, (t) => ({
    ...t,
    status: 'em_progresso',
    faseAtual: faseInicial,
    pausaMotivo: undefined,
    erro: undefined,
    iniciadoEm: t.iniciadoEm ?? agora(),
    // Retomada mantém as anotações; início do zero registra as puladas
    anotacoes: t.anotacoes.length > 0 ? t.anotacoes : puladas,
  }))
  void executarTask(esteiraId, taskId)
}

export async function pausarTask(esteiraId: string, taskId: string): Promise<void> {
  if (emExecucao.has(taskId)) {
    // Marca para pausar ao fechar a fase; o abort imediato perderia o trabalho.
    pausaSolicitada.add(taskId)
    return
  }
  await persistir(esteiraId, taskId, (t) => ({ ...t, status: 'pausada', pausaMotivo: 'manual' }))
}

/** Retomar reinicia a MESMA fase e zera o contador de retries (§9.5). */
export async function retomarTask(esteiraId: string, taskId: string): Promise<void> {
  const tasks = await listarTasks(esteiraId)
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return
  await persistir(esteiraId, taskId, (t) => ({
    ...t,
    status: 'em_progresso',
    pausaMotivo: undefined,
    erro: undefined,
    faseAtual: t.faseAtual ?? 0,
  }))
  void executarTask(esteiraId, taskId)
}

export function taskEmExecucao(taskId: string): boolean {
  return emExecucao.has(taskId)
}

/** Aborta tudo (fechamento do app). */
export function abortarTudo(): void {
  for (const controller of emExecucao.values()) controller.abort()
  emExecucao.clear()
  filasAtivas.clear()
  filaEmAndamento.clear()
}

// ─── CRUD de tasks ───────────────────────────────────────────────────────────

export async function criarTask(input: {
  esteiraId: string
  titulo: string
  descricao: string
  dependeDe?: string[]
  origemSessionId?: string
}): Promise<Task> {
  const tasks = await listarTasks(input.esteiraId)
  const task: Task = {
    id: novoId('task_'),
    esteiraId: input.esteiraId,
    titulo: input.titulo,
    descricao: input.descricao,
    status: 'pendente',
    faseAtual: null,
    dependeDe: input.dependeDe ?? [],
    anotacoes: [],
    criadoEm: agora(),
    tempoTrabalhoMs: 0,
    tokens: 0,
    custo: 0,
    origemSessionId: input.origemSessionId,
  }
  await salvarTasks(input.esteiraId, [...tasks, task])
  emitir({ type: 'task', esteiraId: input.esteiraId, task })
  // Task nova entra na fila automática sem esperar a próxima conclusão.
  if (filasAtivas.has(input.esteiraId)) void avancarFila(input.esteiraId)
  return task
}

export async function atualizarTaskCampos(
  esteiraId: string,
  taskId: string,
  patch: Partial<Pick<Task, 'titulo' | 'descricao' | 'dependeDe' | 'anotacoes'>>,
): Promise<Task | null> {
  if (patch.dependeDe) {
    const tasks = await listarTasks(esteiraId)
    if (criaCiclo(taskId, patch.dependeDe, tasks)) {
      throw new Error('Dependência circular: a task passaria a depender de si mesma.')
    }
  }
  return persistir(esteiraId, taskId, (t) => ({ ...t, ...patch }))
}

export async function removerTask(esteiraId: string, taskId: string): Promise<void> {
  emExecucao.get(taskId)?.abort()
  const tasks = await listarTasks(esteiraId)
  const restantes = tasks
    .filter((t) => t.id !== taskId)
    // Remove a referência nas dependências, senão a fila trava esperando uma
    // task que não existe mais.
    .map((t) => (t.dependeDe.includes(taskId) ? { ...t, dependeDe: t.dependeDe.filter((d) => d !== taskId) } : t))
  await salvarTasks(esteiraId, restantes)
  emitir({ type: 'tasks', esteiraId, tasks: restantes })
}
