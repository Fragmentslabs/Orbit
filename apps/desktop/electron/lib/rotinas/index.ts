import type { NovaRotinaInput, Rotina, RotinaRun } from '@shared/rotinas'
import {
  adicionarRotina,
  atualizarRotina,
  listarRotinas,
  listarRuns,
  podarRuns,
  removerRotina,
  removerRunsDaRotina,
} from './repo'
import { emitir, executarAgora, iniciarScheduler, pararScheduler } from './scheduler'

/**
 * Fachada das rotinas: é o que o IPC consome (padrão de esteira/index.ts). O
 * scheduler cuida da execução; aqui fica o CRUD.
 */

export { gerarRotina } from './generator'
export { executarAgora, iniciarScheduler, pararScheduler }

function novoId(): string {
  return `rot_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Snapshot completo para a UI abrir o painel numa tacada só. Quem está
 * rodando sai dos próprios runs (status 'rodando'), que o scheduler grava
 * antes de disparar — depois de um reload do renderer o painel volta com o
 * spinner certo sem consultar mais nada.
 */
export async function carregarTudo(): Promise<{ rotinas: Rotina[]; runs: RotinaRun[] }> {
  const [rotinas, runs] = await Promise.all([listarRotinas(), listarRuns()])
  return { rotinas, runs }
}

export async function criarRotina(input: NovaRotinaInput): Promise<Rotina> {
  const rotina: Rotina = {
    id: novoId(),
    titulo: input.titulo.trim(),
    prompt: input.prompt.trim(),
    agenda: input.agenda,
    modelo: input.modelo,
    modos: input.modos,
    mode: input.mode ?? 'code',
    pastas: [...input.pastas],
    visionModel: input.visionModel,
    ativa: input.ativa ?? true,
    criadoEm: Date.now(),
  }
  await adicionarRotina(rotina)
  emitir({ type: 'rotina', rotina })
  return rotina
}

export async function atualizarRotinaCampos(
  id: string,
  patch: Partial<Omit<Rotina, 'id' | 'criadoEm'>>,
): Promise<Rotina | null> {
  const rotina = await atualizarRotina(id, (atual) => ({ ...atual, ...patch }))
  if (rotina) emitir({ type: 'rotina', rotina })
  return rotina
}

/**
 * Remove a rotina e as métricas das suas execuções. Os CHATS de cada execução
 * são apagados pelo renderer antes desta chamada: o cascade de deleteSession
 * (abort do stream, storage, prefs, browser do painel) vive no session-store, e
 * duplicá-lo aqui daria duas verdades sobre o mesmo delete.
 */
export async function removerRotinaCompleta(id: string): Promise<void> {
  await removerRotina(id)
  await removerRunsDaRotina(id)
  emitir({ type: 'rotina-removida', id })
}

/** Descarta métricas de execuções cujo chat não existe mais. */
export function podarRunsOrfaos(sessionIdsVivos: string[]): Promise<number> {
  return podarRuns(sessionIdsVivos)
}
