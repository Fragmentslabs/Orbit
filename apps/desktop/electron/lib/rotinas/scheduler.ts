import { BrowserWindow, Notification } from 'electron'
import type { ChatMessage, SendMessageInput, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import type { Rotina, RotinaEvent, RotinaRun } from '@shared/rotinas'
import { opcoesDaRotina, proximaExecucao, ROTINA_SESSION_PREFIX } from '@shared/rotinas'
import { runChat } from '../chat-engine'
import { runChatWithLoop } from '../loop-engine'
import { runOrchestration } from '../orchestrator'
import { broadcastChatEvent } from '../broadcast'
import { readJson, writeJson } from '../storage'
import { atualizarRotina, listarRotinas, listarRuns, salvarRun } from './repo'

/**
 * Scheduler das rotinas: um tick de 1 minuto no main, sem lib de cron.
 *
 * O disparo REUSA o caminho do `chat:send` (runChat / runChatWithLoop /
 * runOrchestration) em vez de ter um runner próprio como a esteira. A esteira
 * não é uma conversa — a rotina é: ela precisa de histórico, diff por
 * mensagem, permissões e a UI de chat que já existem.
 *
 * Limitação conhecida: com o app FECHADO nada roda — o scheduler morre com o
 * main process. Ao reabrir, uma execução atrasada dentro da janela de
 * tolerância ainda dispara; mais velha que isso é descartada (a rotina das
 * 09:00 não deve rodar às 23:00 de três dias depois).
 */

const INTERVALO_TICK_MS = 60_000
/** Atraso máximo tolerado no disparo (app fechado, máquina suspensa). */
const JANELA_ATRASO_MS = 60 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null

/**
 * Rotinas rodando agora. Uma rotina nunca dispara de novo enquanto a execução
 * anterior não termina — mesma regra do `emExecucao` da esteira: a segunda
 * rodada trabalharia por cima dos arquivos que a primeira está mexendo.
 */
const emExecucao = new Set<string>()

export function emitir(evento: RotinaEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('rotinas:event', evento)
  }
}

// ─── Sessão da execução ──────────────────────────────────────────────────────

function carimbo(quando: number): string {
  const d = new Date(quando)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * Cada execução nasce numa sessão própria — é o que dá o histórico de chats da
 * rotina. `folderId` fica null de propósito: os chats de rotina vivem só no
 * grupo "Rotinas" da sidebar, nunca dentro de uma pasta.
 */
async function criarSessao(rotina: Rotina, quando: number): Promise<SessionInfo> {
  const session: SessionInfo = {
    id: `${ROTINA_SESSION_PREFIX}${rotina.id}_${quando.toString(36)}`,
    title: `${rotina.titulo} — ${carimbo(quando)}`,
    mode: 'code',
    pinned: false,
    archived: false,
    folderId: null,
    directory: rotina.pastas[0],
    extraDirectories: rotina.pastas.slice(1),
    routineId: rotina.id,
    createdAt: quando,
    updatedAt: quando,
  }
  await writeJson(StorageKeys.session(session.id), session)
  // O renderer só conhece a sessão por este evento: ela nasceu no main, fora
  // do session-store. Sem ele, o chat da rotina não aparece na sidebar até um
  // reload.
  broadcastChatEvent({ type: 'session', sessionId: session.id, session })
  return session
}

/** Métricas do que a execução consumiu: soma os turnos do assistente. */
async function colherResultado(sessionId: string): Promise<{ tokens: number; custo: number; erro?: string }> {
  const mensagens = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
  let tokens = 0
  let custo = 0
  let erro: string | undefined
  for (const msg of mensagens) {
    if (msg.role !== 'assistant') continue
    if (msg.tokens) {
      tokens += msg.tokens.input + msg.tokens.output + msg.tokens.reasoning
      custo += msg.tokens.cost ?? 0
    }
    // Vale o erro do ÚLTIMO turno: uma falha no meio que o loop contornou não
    // torna a execução inteira uma falha.
    erro = msg.error
  }
  return { tokens, custo, erro }
}

function notificar(rotina: Rotina, run: RotinaRun): void {
  if (!Notification.isSupported()) return
  const ok = run.status === 'ok'
  new Notification({
    title: rotina.titulo,
    body: ok
      ? `Rotina concluída${run.custo > 0 ? ` — US$ ${run.custo.toFixed(4)}` : ''}`
      : `Rotina falhou: ${(run.erro ?? '').slice(0, 120) || 'erro desconhecido'}`,
    silent: ok,
  }).show()
}

// ─── Execução ────────────────────────────────────────────────────────────────

/**
 * Roda a rotina agora. Retorna o sessionId criado, ou null quando a rotina já
 * está em execução ou não tem pasta de trabalho.
 */
export async function executarRotina(rotina: Rotina, motivo: 'agenda' | 'manual'): Promise<string | null> {
  if (emExecucao.has(rotina.id)) return null
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) return null
  if (!rotina.pastas[0]) {
    console.warn(`[rotinas] "${rotina.titulo}" sem pasta de trabalho — execução ignorada`)
    return null
  }

  emExecucao.add(rotina.id)
  const inicio = Date.now()
  const session = await criarSessao(rotina, inicio)

  let run: RotinaRun = {
    rotinaId: rotina.id,
    sessionId: session.id,
    iniciadoEm: inicio,
    status: 'rodando',
    tokens: 0,
    custo: 0,
  }
  await salvarRun(run)
  emitir({ type: 'run', run })

  // A marcação de ultimaExecucao é feita ANTES de rodar: se ficasse no fim, um
  // turno longo deixaria o tick seguinte achar que a rotina ainda não rodou.
  const atualizada = await atualizarRotina(rotina.id, (r) => ({ ...r, ultimaExecucao: inicio }))
  if (atualizada) emitir({ type: 'rotina', rotina: atualizada })

  const options = opcoesDaRotina(rotina.modos)
  const input: SendMessageInput = {
    sessionId: session.id,
    text: rotina.prompt,
    providerId: rotina.modelo.providerId,
    modelId: rotina.modelo.modelId,
    mode: 'code',
    options,
    directory: session.directory,
    extraDirectories: session.extraDirectories,
    // Subagentes/orquestração precisam de um modelo de worker; a rotina usa o
    // próprio, que é o único modelo que ela conhece.
    ...(options.subagents || options.orchestrate ? { workerModel: rotina.modelo } : {}),
    isFirstExchange: true,
    ...(options.loop ? { loopConfig: { maxIterations: 3, maxTokensPerIter: 4000, autoReview: true } } : {}),
  }

  console.log(`[rotinas] disparando "${rotina.titulo}" (${motivo}) na sessão ${session.id}`)

  try {
    if (options.orchestrate) await runOrchestration(win, input)
    else if (options.loop) await runChatWithLoop(win, input, input.loopConfig!)
    else await runChat(win, input)
    const { tokens, custo, erro } = await colherResultado(session.id)
    run = { ...run, concluidoEm: Date.now(), status: erro ? 'erro' : 'ok', erro, tokens, custo }
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err)
    const { tokens, custo } = await colherResultado(session.id)
    run = { ...run, concluidoEm: Date.now(), status: 'erro', erro: detalhe, tokens, custo }
  } finally {
    emExecucao.delete(rotina.id)
  }

  // A rotina pode ter sido excluída no meio da execução (o delete apaga os
  // chats e aborta o stream). Regravar as métricas ressuscitaria um registro
  // órfão em runs.json — melhor terminar em silêncio.
  const aindaExiste = (await listarRotinas()).some((r) => r.id === rotina.id)
  if (!aindaExiste) return session.id

  await salvarRun(run)
  emitir({ type: 'run', run })
  notificar(rotina, run)
  return session.id
}

/** "Executar agora" do painel — mesma execução, sem mexer na agenda. */
export async function executarAgora(id: string): Promise<string | null> {
  const rotina = (await listarRotinas()).find((r) => r.id === id)
  if (!rotina) return null
  return executarRotina(rotina, 'manual')
}

// ─── Tick ────────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  const agora = Date.now()
  let rotinas: Rotina[]
  try {
    rotinas = await listarRotinas()
  } catch (err) {
    console.error('[rotinas] falha ao ler as rotinas no tick:', err)
    return
  }

  for (const rotina of rotinas) {
    if (!rotina.ativa || emExecucao.has(rotina.id)) continue
    // O piso descarta as janelas perdidas de uma vez: com o app fechado por
    // dias, a rotina volta ao calendário no próximo horário em vez de tentar
    // recuperar cada disparo que não aconteceu.
    const base = Math.max(rotina.ultimaExecucao ?? rotina.criadoEm, agora - JANELA_ATRASO_MS)
    const alvo = proximaExecucao(rotina.agenda, base, rotina.ultimaExecucao)
    // Agenda inválida (horário que não parseia): a rotina fica parada em vez
    // de disparar num horário adivinhado.
    if (alvo == null || alvo > agora) continue

    // Sem await: uma rotina longa não pode segurar as outras deste tick.
    void executarRotina(rotina, 'agenda').catch((err) =>
      console.error(`[rotinas] execução de "${rotina.titulo}" falhou:`, err),
    )
  }
}

/**
 * Runs marcados como "rodando" no disco sem ninguém executando: o app foi
 * fechado (ou caiu) no meio. Fechar o registro no boot evita um spinner eterno
 * no painel e uma rotina que nunca mais dispara.
 */
async function reconciliarRuns(): Promise<void> {
  for (const run of await listarRuns()) {
    if (run.status !== 'rodando' || emExecucao.has(run.rotinaId)) continue
    const fechado: RotinaRun = {
      ...run,
      status: 'erro',
      concluidoEm: Date.now(),
      erro: run.erro ?? 'Execução interrompida (app fechado).',
    }
    await salvarRun(fechado)
    emitir({ type: 'run', run: fechado })
  }
}

export function iniciarScheduler(): void {
  if (timer) return
  void reconciliarRuns().catch((err) => console.error('[rotinas] reconciliação falhou:', err))
  timer = setInterval(() => void tick(), INTERVALO_TICK_MS)
  // Um tick imediato pega o que venceu enquanto o app estava fechado (dentro
  // da janela de tolerância) sem esperar o primeiro minuto.
  void tick()
}

export function pararScheduler(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
