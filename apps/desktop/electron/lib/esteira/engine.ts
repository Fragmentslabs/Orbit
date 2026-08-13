import { BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AnotacaoFase, Esteira, EsteiraEvent, Projeto, Task } from '@shared/esteira'
import { ESTEIRA_RETRY_PADRAO } from '@shared/esteira'
import { capture, diff } from '../snapshot'
import { userShellEnv } from '../shell-env'
import { criaCiclo, dependenciasPendentes } from './contrato'
import { executarFase, type ToolProgress } from './runner'
import { atualizarTask, listarEsteiras, listarProjetos, listarTasks, salvarTasks } from './repo'

const execFileAsync = promisify(execFile)

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
/**
 * Promessa da execução em andamento por task. Sem isso, pausar e retomar em
 * seguida cai numa corrida: o retomar chega antes de a execução abortada
 * limpar `emExecucao`, `executarTask` sai na guarda inicial e a task fica
 * "em_progresso" com ninguém executando.
 */
const execucoes = new Map<string, Promise<void>>()

/** Aborta a execução da task (se houver) e espera ela realmente terminar. */
async function pararEsperando(taskId: string): Promise<void> {
  emExecucao.get(taskId)?.abort()
  const pendente = execucoes.get(taskId)
  if (pendente) await pendente.catch(() => {})
}
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
async function executarTask(esteiraId: string, taskId: string, retomandoInterrompida = false): Promise<void> {
  if (emExecucao.has(taskId)) return
  const execucao = rodarTask(esteiraId, taskId, retomandoInterrompida)
  execucoes.set(taskId, execucao)
  try {
    await execucao
  } finally {
    if (execucoes.get(taskId) === execucao) execucoes.delete(taskId)
  }
}

async function rodarTask(esteiraId: string, taskId: string, retomandoInterrompida: boolean): Promise<void> {
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
      // Feed ao vivo da fase: texto, pensamento e ferramentas vão para a UI
      // pelo mesmo canal dos eventos de estado (o modal mostra a execução).
      const progresso = (faseIndice: number) => ({
        onTexto: (texto: string) =>
          emitir({ type: 'fase-progresso', esteiraId, taskId, faseIndice, texto }),
        onPensando: (texto: string) =>
          emitir({ type: 'fase-pensando', esteiraId, taskId, faseIndice, texto }),
        onFerramenta: (t: ToolProgress) =>
          emitir({
            type: 'fase-tool',
            esteiraId,
            taskId,
            faseIndice,
            toolCallId: t.toolCallId,
            tool: t.tool,
            estado: t.estado,
            resumo: t.resumo,
            detalhe: t.detalhe,
          }),
      })
      let resultado = await executarFase({
        esteira,
        task,
        fase,
        indiceFase: indice,
        pastas: projeto.pastas,
        tentativa: 1,
        // Só na primeira fase depois de retomar: a interrupção foi nela.
        interrompidaAntes: retomandoInterrompida && task.anotacoes.length === indice,
        abort: controller.signal,
        ...progresso(indice),
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
          ...progresso(indice),
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
      // Push final determinístico: a fase Relatório (que fazia isso) não
      // existe mais — ninguém vai subir o branch se o engine não fizer.
      const pushFalha = ultimaFase && esteira.pushAoFinal ? await tentarPush(raiz, controller.signal) : undefined
      const diffAtual = await medirDiff()
      const atualizada = await persistir(esteiraId, taskId, (t) => ({
        ...t,
        diff: diffAtual ?? t.diff,
        anotacoes: [...t.anotacoes, anotacao],
        tokens: t.tokens + resultado.tokens,
        custo: t.custo + resultado.custo,
        pushFalha,
        faseAtual: ultimaFase ? t.faseAtual : indice + 1,
        status: ultimaFase ? 'concluida' : t.status,
        concluidoEm: ultimaFase ? agora() : t.concluidoEm,
        tempoTrabalhoMs: ultimaFase
          ? t.tempoTrabalhoMs + (Date.now() - inicioExecucao)
          : t.tempoTrabalhoMs,
      }))
      if (ultimaFase || !atualizada) break

      // Parada SUAVE — hoje só o desligar da fila automática passa por aqui
      // (§6.2): a task termina a fase corrente e só então pausa, sem perder o
      // trabalho. O botão de pausar é o oposto: aborta na hora (pausarTask).
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
    // Abortada no meio da fase: sem isto a task ficaria "em_progresso" para
    // sempre, com o card girando sem ninguém executando nada.
    if (controller.signal.aborted) {
      await persistir(esteiraId, taskId, (t) =>
        t.status === 'em_progresso'
          ? {
              ...t,
              status: 'pausada',
              pausaMotivo: 'manual',
              faseInterrompida: true,
              tempoTrabalhoMs: t.tempoTrabalhoMs + (Date.now() - inicioExecucao),
            }
          : t,
      )
    }
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

// ─── Push final ──────────────────────────────────────────────────────────────

/**
 * Push determinístico do branch quando `pushAoFinal` está ligado. Antes isso
 * era instrução do prompt da fase Relatório (removida): o modelo podia
 * esquecer ou falhar, e o push era mais um custo de LLM. Agora o engine
 * executa ao concluir a última fase e registra o resultado.
 *
 * Falha NÃO reverte a conclusão da task: o trabalho está feito, o push é
 * entrega — o erro vai para `task.pushFalha` para o usuário resolver. Primeiro
 * `git push`; se falhar sem upstream, tenta `git push -u origin HEAD`.
 */
async function tentarPush(raiz: string, signal: AbortSignal): Promise<string | undefined> {
  const tentativas: string[][] = [
    ['git', 'push'],
    ['git', 'push', '-u', 'origin', 'HEAD'],
  ]
  let ultimoErro = 'git push falhou sem detalhes.'
  for (const args of tentativas) {
    try {
      await execFileAsync('git', args, { cwd: raiz, env: userShellEnv(), timeout: 120_000, signal })
      return undefined
    } catch (err) {
      // Pausa no meio do push: a task vai ser pausada de qualquer forma, não
      // faz sentido registrar falha de push no estado.
      if (signal.aborted) return undefined
      const e = err as { stderr?: string; stdout?: string; message?: string }
      ultimoErro = e.stderr?.trim() || e.stdout?.trim() || e.message || String(err)
    }
  }
  return ultimoErro
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
  await pararEsperando(taskId)
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

/**
 * Pausa AGORA: aborta o que a fase está fazendo (modelo e tools recebem o
 * abort) e marca a task como pausada.
 *
 * A versão anterior só marcava e esperava a fase fechar — do lado do usuário
 * isso é indistinguível de um botão quebrado, porque uma fase leva minutos.
 * O preço é perder o trabalho da fase corrente: ao retomar, ela roda de novo
 * do zero (as fases anteriores já entregaram as anotações, e o repositório
 * pode ter mudanças parciais — o retomar avisa a fase disso).
 */
export async function pausarTask(esteiraId: string, taskId: string): Promise<void> {
  const controller = emExecucao.get(taskId)
  pausaSolicitada.add(taskId)
  controller?.abort()
  await persistir(esteiraId, taskId, (t) =>
    t.status === 'em_progresso'
      ? { ...t, status: 'pausada', pausaMotivo: 'manual', faseInterrompida: !!controller }
      : t,
  )
}

/** Retomar reinicia a MESMA fase e zera o contador de retries (§9.5). */
export async function retomarTask(esteiraId: string, taskId: string): Promise<void> {
  await pararEsperando(taskId)
  const tasks = await listarTasks(esteiraId)
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return
  const interrompida = task.faseInterrompida === true
  await persistir(esteiraId, taskId, (t) => ({
    ...t,
    status: 'em_progresso',
    pausaMotivo: undefined,
    erro: undefined,
    faseAtual: t.faseAtual ?? 0,
    faseInterrompida: undefined,
  }))
  void executarTask(esteiraId, taskId, interrompida)
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
