import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { generateText } from 'ai'
import type { AnotacaoFase, Esteira, EsteiraEvent, Projeto, Task } from '@shared/esteira'
import { ESTEIRA_COMMIT_PROMPT_PADRAO, ESTEIRA_RETRY_PADRAO } from '@shared/esteira'
import type { SendMessageInput } from '@shared/chat'
import { capture, diff } from '../snapshot'
import { userShellEnv } from '../shell-env'
import { criaCiclo, dependenciasPendentes } from './contrato'
import { executarFase, type ToolProgress } from './runner'
import { atualizarTask, listarEsteiras, listarProjetos, listarTasks, modificarTasks } from './repo'
import { broadcastEsteiraEvent } from '../broadcast'
import { loadPromptContext, search as buscarMemoria } from '../memory/service'
import { getProvider } from '../catalog'
import { resolveModel } from '../providers'
import { withProviderSession } from '../provider-session'
import { buildProviderOptions, interleavedReasoningField, normalizeMessages } from '../reasoning'
import { toTokenUsage } from '../usage'
import type { Memory } from '@shared/memory'

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

/**
 * Funnel único dos eventos de esteira: janelas (renderer) + companions (app
 * mobile) — o mobile espelha o board inteiro por este canal.
 */
export function emitir(evento: EsteiraEvent): void {
  broadcastEsteiraEvent(evento)
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
      // Commit final + push determinísticos (D10): as fases posteriores à
      // desenvolvimento não podem commitar, então o commit aqui captura o
      // trabalho completo da task — incluindo os ajustes de validação — em
      // vez de deixá-lo solto na working tree. Push implica commit: não
      // existe entrega de branch sem o estado final commitado.
      const querCommitFinal = ultimaFase && (esteira.commitAoFinal !== false || esteira.pushAoFinal)
      const commit = querCommitFinal
        ? await tentarCommit(raiz, esteira, task, projeto.pastas, controller.signal)
        : undefined
      const pushFalha =
        ultimaFase && esteira.pushAoFinal
          ? commit?.erro
            ? 'Commit final falhou; o push foi cancelado para não subir trabalho incompleto.'
            : await tentarPush(raiz, controller.signal)
          : undefined
      const diffAtual = await medirDiff()
      // Pausa caiu DEPOIS do modelo terminar (durante o commit/push/diff): a
      // fase ainda não conta como concluída — o retomar roda ela de novo do
      // zero, como qualquer fase interrompida. Sem este check, o persist abaixo
      // sobrescrevia a pausa com 'concluida' na última fase (corrida entre
      // pausarTask e a gravação de conclusão).
      if (controller.signal.aborted) break
      const atualizada = await persistir(esteiraId, taskId, (t) => ({
        ...t,
        diff: diffAtual ?? t.diff,
        anotacoes: [...t.anotacoes, anotacao],
        tokens: t.tokens + resultado.tokens + (commit?.tokens ?? 0),
        custo: t.custo + resultado.custo + (commit?.custo ?? 0),
        commitFalha: commit?.erro,
        commitFinalHash: commit?.hash,
        pushFalha,
        faseAtual: ultimaFase ? t.faseAtual : indice + 1,
        // Guarda extra: se a pausa venceu esta gravação, não conclui.
        status: ultimaFase && t.status === 'em_progresso' ? 'concluida' : t.status,
        concluidoEm: ultimaFase && t.status === 'em_progresso' ? agora() : t.concluidoEm,
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
  await persistir(esteiraId, taskId, (t) =>
    // Pausa pode ter vencido esta gravação — não conclui quem foi pausado.
    t.status !== 'em_progresso'
      ? t
      : {
          ...t,
          status: 'concluida',
          concluidoEm: agora(),
          tempoTrabalhoMs: t.tempoTrabalhoMs + (Date.now() - inicioExecucao),
        },
  )
}

// ─── Commit final ────────────────────────────────────────────────────────────

interface ResultadoCommit {
  /** Erro do git ao medir/encenar/commitar (mensagem não gerada NÃO é erro — vira fallback) */
  erro?: string
  /** Hash curto do commit criado */
  hash?: string
  tokens: number
  custo: number
}

/** Quantos caminhos por `git add` antes de cair no add -A da árvore inteira. */
const MAX_CAMINHOS_ADD = 2000

/**
 * Commit final determinístico quando `commitAoFinal` está ligado (D10).
 *
 * Sem ele, os ajustes das fases posteriores à desenvolvimento viveriam só na
 * working tree (os templates as proíbem de commitar) — e o push subiria um
 * branch sem esse trabalho. A mensagem é gerada por uma chamada one-shot (sem
 * tools) com o MESMO contexto que uma fase recebe: descrição da task, notas
 * das fases anteriores, preferências de commits do usuário na memória e o
 * estilo dos commits recentes do repo. Sem diff, nada é commitado — as fases
 * anteriores podem já ter commitado tudo, e commit vazio não existe.
 *
 * Falha NÃO reverte a conclusão da task (igual ao push): o erro vai para
 * `task.commitFalha` e o push é cancelado, para não subir trabalho incompleto.
 */
async function tentarCommit(
  raiz: string,
  esteira: Esteira,
  task: Task,
  pastas: string[],
  signal: AbortSignal,
): Promise<ResultadoCommit> {
  // 1) Diff real do worktree (porcelain -z + untracked-files=all: inclui
  //    arquivos novos e não escapa caminhos com espaço/aspas).
  let status: string
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: raiz, env: userShellEnv(), timeout: 30_000, signal },
    )
    status = stdout
  } catch (err) {
    if (signal.aborted) return { tokens: 0, custo: 0 }
    const e = err as { stderr?: string; message?: string }
    return { erro: e.stderr?.trim() || e.message || String(err), tokens: 0, custo: 0 }
  }
  if (!status.trim()) return { tokens: 0, custo: 0 }

  const { mensagem, tokens, custo } = await gerarMensagemCommit(raiz, esteira, task, pastas, status, signal)

  // 3) Só os arquivos que a task mudou (git status respeita .gitignore): nada
  //    de varredura da árvore inteira, nada do que não é do trabalho da task.
  const caminhos = caminhosDoStatus(status)
  const addArgs = caminhos.length > MAX_CAMINHOS_ADD ? ['add', '-A'] : ['add', '-A', '--', ...caminhos]
  try {
    await execFileAsync('git', addArgs, { cwd: raiz, env: userShellEnv(), timeout: 120_000, signal })
  } catch (err) {
    if (signal.aborted) return { tokens, custo }
    const e = err as { stderr?: string; message?: string }
    return { erro: e.stderr?.trim() || e.message || String(err), tokens, custo }
  }

  // 4) Commit — header e body como -m separados (o git junta com linha em
  //    branco entre eles). Mensagem vazia/fallback cai no título da task.
  const [cabecalho, ...corpo] = mensagem.split('\n')
  const corpoJunto = corpo.join('\n').trim()
  const commitArgs = corpoJunto
    ? ['commit', '-m', cabecalho.trim() || task.titulo, '-m', corpoJunto]
    : ['commit', '-m', cabecalho.trim() || task.titulo]
  try {
    await execFileAsync('git', commitArgs, { cwd: raiz, env: userShellEnv(), timeout: 120_000, signal })
  } catch (err) {
    if (signal.aborted) return { tokens, custo }
    const e = err as { stderr?: string; message?: string }
    return { erro: e.stderr?.trim() || e.message || String(err), tokens, custo }
  }

  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: raiz,
      env: userShellEnv(),
      timeout: 15_000,
      signal,
    })
    return { hash: stdout.trim() || undefined, tokens, custo }
  } catch {
    // Hash ilegível não invalida o commit — segue sem ele no relatório.
    return { tokens, custo }
  }
}

/**
 * Caminhos do `git status --porcelain=v1 -z`: cada entrada é `XY <caminho>`,
 * com exceção de rename/copy (`R`/`C`) — no -z o campo corrente é o DESTINO
 * e o próximo campo traz a origem (que não existe mais e não precisa entrar
 * no `git add`).
 */
function caminhosDoStatus(status: string): string[] {
  const campos = status.split('\0')
  const caminhos: string[] = []
  for (let i = 0; i < campos.length; i++) {
    const campo = campos[i]
    if (!campo) continue
    const primeiro = campo[0]
    const caminho = campo.slice(3)
    if (primeiro === 'R' || primeiro === 'C') {
      if (caminho) caminhos.push(caminho)
      i++
    } else if (caminho) {
      caminhos.push(caminho)
    }
  }
  return caminhos
}

/**
 * Gera a mensagem do commit final com uma chamada one-shot (sem tools), no
 * modelo padrão da esteira. O prompt do sistema é o `commitPrompt` da esteira
 * ou o default (preferências de commits na memória; fallback Conventional
 * Commits). Falha da chamada NÃO falha o commit: cai no título da task.
 */
async function gerarMensagemCommit(
  raiz: string,
  esteira: Esteira,
  task: Task,
  pastas: string[],
  status: string,
  signal: AbortSignal,
): Promise<{ mensagem: string; tokens: number; custo: number }> {
  const fase = esteira.fases[0]
  if (!fase) return { mensagem: task.titulo, tokens: 0, custo: 0 }
  let provider
  try {
    provider = await getProvider(fase.providerId)
  } catch {
    provider = undefined
  }
  let model
  try {
    model = await resolveModel(fase.providerId, fase.modelId)
  } catch (err) {
    console.error('[esteira] modelo do commit final indisponível — mensagem fallback:', err)
    return { mensagem: task.titulo, tokens: 0, custo: 0 }
  }

  // Preferências de commits do usuário: gerais por peso + busca direcionada
  // (a busca lexical acha "mensagens de commit em inglês" mesmo fora do topo).
  const ctx = await loadPromptContext('code', raiz)
  const commitPrefs = await buscarMemoria({ query: 'commit', kinds: ['general'], limit: 5 }).catch(() => [])
  const memorias = [...ctx.general, ...commitPrefs.filter((m) => !ctx.general.includes(m))]

  // Estilo real do repo: os últimos commits são a preferência de fato.
  let log = ''
  try {
    const { stdout } = await execFileAsync('git', ['log', '--oneline', '-20'], {
      cwd: raiz,
      env: userShellEnv(),
      timeout: 15_000,
      signal,
    })
    log = stdout.trim()
  } catch {
    // repo sem commits ainda — segue sem o bloco de estilo
  }

  const input: SendMessageInput = {
    sessionId: `esteira_${task.id}`,
    text: task.descricao,
    providerId: fase.providerId,
    modelId: fase.modelId,
    mode: 'code',
    options: { permissionMode: 'full' },
    directory: raiz,
    extraDirectories: pastas.filter((p) => p !== raiz),
  }

  const providerOptions = await buildProviderOptions(input)
  try {
    // withProviderSession: provedores que exigem um identificador estável de
    // conversa (ex.: header x-opencode-session) recebem o da task, como nas fases.
    const { text, usage } = await withProviderSession(`esteira_${task.id}`, () =>
      generateText({
        model,
        system: esteira.commitPrompt?.trim() || ESTEIRA_COMMIT_PROMPT_PADRAO,
        messages: normalizeMessages(
          [{ role: 'user', content: montarPromptCommit({ esteira, task, pastas, status, memorias, log }) }],
          interleavedReasoningField(provider, fase.modelId),
        ),
        abortSignal: signal,
        providerOptions,
      }),
    )
    const tok = toTokenUsage(usage, provider?.models[fase.modelId]?.cost)
    const mensagem = limparMensagemCommit(text)
    return {
      mensagem: mensagem || task.titulo,
      tokens: tok.input + tok.output + (tok.reasoning ?? 0),
      custo: tok.cost ?? 0,
    }
  } catch (err) {
    console.error('[esteira] geração da mensagem do commit final falhou — fallback no título:', err)
    return { mensagem: task.titulo, tokens: 0, custo: 0 }
  }
}

/**
 * Contexto da mensagem do commit — espelha o que uma fase recebe (montarMensagem
 * do runner): o agente precisa saber o que foi feito nas fases anteriores para
 * escrever um bom commit, não adivinhar pelo diff.
 */
function montarPromptCommit(ctx: {
  esteira: Esteira
  task: Task
  pastas: string[]
  status: string
  memorias: Memory[]
  log: string
}): string {
  const partes: string[] = []
  partes.push(`# Task: ${ctx.task.titulo}`)
  if (ctx.task.descricao.trim()) partes.push(ctx.task.descricao.trim())

  const fases = ctx.esteira.fases
  const listaFases = fases.map((f) => `${f.nome} — ${f.descricao}`).join('\n')
  partes.push(`\n## Pipeline\nThis task ran through ${fases.length} phases:\n${listaFases}`)

  const anteriores = ctx.task.anotacoes.filter((a) => a.status !== 'pulada')
  if (anteriores.length > 0) {
    partes.push('\n## Notes from the phases')
    for (const a of anteriores) {
      partes.push(`### ${a.faseNome} (${a.status})\n${a.conteudo}`)
    }
  }

  const repo: string[] = [`Working folder: ${ctx.pastas[0] ?? '(none)'}`]
  if (ctx.esteira.branch) repo.push(`Branch: ${ctx.esteira.branch}`)
  if (ctx.esteira.worktree) repo.push(`Worktree: ${ctx.esteira.worktree}`)
  partes.push(`\n## Repository\n${repo.join('\n')}`)

  partes.push(`\n## Changed files (working tree)\n${ctx.status.trim() || '(none)'}`)

  if (ctx.memorias.length > 0) {
    partes.push(
      `\n## User's commit preferences (from memory — follow them)\n${ctx.memorias.map((m) => `- ${m.text}`).join('\n')}`,
    )
  }
  if (ctx.log) {
    partes.push(
      `\n## Recent commits in this repository (imitate the style when the preferences above don't specify)\n${ctx.log}`,
    )
  }
  return partes.join('\n')
}

/** Tira cercas de markdown e sobra de branco da resposta do modelo. */
function limparMensagemCommit(texto: string): string {
  const semFences = texto.trim().replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '')
  return semFences.trim()
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
 * Uma task por vez: a fila só dispara a próxima quando a task automática atual
 * concluiu TODAS as fases. A guarda usa o estado PERSISTIDO (campo `auto` da
 * Task), não um registro em memória — pausa, erro, retomada manual ou
 * desligar/religar a fila nunca fazem a fila avançar com a anterior no meio.
 * Tasks iniciadas manualmente (`auto` ausente) rodam em paralelo de propósito
 * e não bloqueiam nem são bloqueadas pela fila.
 */
const filaRodando = new Set<string>()

async function avancarFila(esteiraId: string): Promise<void> {
  if (!filasAtivas.has(esteiraId) || filaRodando.has(esteiraId)) return
  filaRodando.add(esteiraId)
  try {
    const tasks = await listarTasks(esteiraId)
    // Automática não-concluída (rodando, pausada ou com erro) segura a fila:
    // a próxima só entra quando a atual percorreu tudo. Cabe ao usuário
    // resolver (retomar, remover ou desligar a fila).
    const automaticaNaoConcluida = tasks.some((t) => t.auto === true && t.status !== 'concluida')
    if (automaticaNaoConcluida) return
    const candidatas = tasks
      .filter((t) => t.status === 'pendente' && dependenciasPendentes(t, tasks).length === 0)
      .sort((a, b) => a.criadoEm.localeCompare(b.criadoEm))
    const proxima = candidatas[0]
    if (!proxima) return
    await iniciarTask(esteiraId, proxima.id, 0, true)
  } finally {
    filaRodando.delete(esteiraId)
  }
}

export function ligarFila(esteiraId: string): void {
  filasAtivas.add(esteiraId)
  void avancarFila(esteiraId)
}

/** Desligar não mata o que está rodando: a task termina a fase e pausa (§6.2). */
export function desligarFila(esteiraId: string): void {
  filasAtivas.delete(esteiraId)
  void (async () => {
    const tasks = await listarTasks(esteiraId)
    const atual = tasks.find((t) => t.auto === true && t.status === 'em_progresso')
    if (atual) pausaSolicitada.add(atual.id)
  })()
}

export function filaLigada(esteiraId: string): boolean {
  return filasAtivas.has(esteiraId)
}

// ─── API de controle ─────────────────────────────────────────────────────────

/**
 * Inicia a task na fase indicada. `faseInicial > 0` vem do drag: as fases
 * anteriores entram como 'pulada' para o histórico não sugerir que rodaram.
 * `auto` marca a task como iniciada pela fila automática (uma por vez).
 */
export async function iniciarTask(esteiraId: string, taskId: string, faseInicial = 0, auto = false): Promise<void> {
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
    auto: auto ? true : t.auto,
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

/**
 * Tasks gravadas como "em_progresso" sem ninguém executando: o app foi fechado
 * (ou caiu) no meio de uma fase. `emExecucao` vive só em memória, então o
 * estado do disco sobrevive ao processo — e o card ficava girando para sempre,
 * como se o agente ainda estivesse trabalhando.
 *
 * Fecha como pausa interrompida, exatamente igual ao abort: retomar roda a
 * fase DO ZERO e o agente é avisado de que a árvore pode ter mudanças parciais.
 * Roda no boot, antes de qualquer execução nova.
 */
export async function reconciliarExecucoes(): Promise<void> {
  for (const esteira of await listarEsteiras()) {
    for (const task of await listarTasks(esteira.id)) {
      if (task.status !== 'em_progresso' || emExecucao.has(task.id)) continue
      console.log(`[esteira] task "${task.titulo}" ficou em progresso sem execução — marcando como pausada`)
      await persistir(esteira.id, task.id, (t) =>
        t.status === 'em_progresso'
          ? { ...t, status: 'pausada', pausaMotivo: 'manual', faseInterrompida: true }
          : t,
      )
    }
  }
}

/** Aborta tudo (fechamento do app). */
export function abortarTudo(): void {
  for (const controller of emExecucao.values()) controller.abort()
  emExecucao.clear()
  filasAtivas.clear()
  filaRodando.clear()
}

// ─── CRUD de tasks ───────────────────────────────────────────────────────────

export async function criarTask(input: {
  esteiraId: string
  titulo: string
  descricao: string
  dependeDe?: string[]
  origemSessionId?: string
}): Promise<Task> {
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
  // Append dentro do lock (modificarTasks): criações concorrentes não se perdem.
  await modificarTasks(input.esteiraId, (tasks) => {
    tasks.push(task)
  })
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
  // Filtra + limpa as dependências DENTRO do lock: remoção concorrente com
  // criação não ressuscita tasks nem deixa referência órfã.
  const restantes = await modificarTasks(esteiraId, (tasks) => {
    const filtradas = tasks
      .filter((t) => t.id !== taskId)
      .map((t) => (t.dependeDe.includes(taskId) ? { ...t, dependeDe: t.dependeDe.filter((d) => d !== taskId) } : t))
    tasks.splice(0, tasks.length, ...filtradas)
    return filtradas
  })
  emitir({ type: 'tasks', esteiraId, tasks: restantes })
  // Remover a automática que segurava a fila (pausada/erro) destrava a próxima.
  if (filasAtivas.has(esteiraId)) void avancarFila(esteiraId)
}
