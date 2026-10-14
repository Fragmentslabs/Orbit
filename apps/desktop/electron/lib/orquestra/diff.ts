import type { AssistantSnapshot } from '@shared/chat'
import { git, raizDoRepositorio } from '../worktrees/nucleo'

/**
 * Os dois canais do diff que o revisor vê (orquestra/acompanhamento).
 *
 * Com worktree, o git responde direto (diffDoWorktree). Sem worktree, a
 * evidência são os snapshots dos turnos do chat do worker — e um turno cuja
 * captura falhou não deixa patch NENHUM. Devolver vazio nesse caso faz o
 * revisor ler "não escreveu nada" onde a verdade é "não deu para registrar":
 * é exatamente o que a verificação de fim de turno do chat-engine existe para
 * separar ('unchanged' × 'unknown'). Aqui a falha é dita em voz alta, e a
 * pasta — a prova real, ainda que compartilhada — é consultada em vez de se
 * concluir pelo silêncio do snapshot.
 */

/** O que interessa de um snapshot de turno para montar o diff do worker. */
export type SnapshotDoTurno = Pick<AssistantSnapshot, 'patch' | 'files' | 'failed' | 'captureError' | 'verified'>

export interface DiffDosTurnos {
  /** Patch dos turnos que FORAM capturados (vazio quando nenhum foi) */
  patch: string
  /** Aviso de que o canal não tem o que o worker escreveu; ausente quando todos os turnos foram registrados */
  indisponivel?: string
}

/**
 * Junta os patches dos turnos do worker. `failed` (a captura inicial falhou) e
 * `verified: 'unknown'` (a final falhou) são a mesma coisa daqui: um turno
 * cujo efeito no filesystem não foi registrado. `verified: 'unchanged'` é o
 * oposto — o canal funcionou e o turno não escreveu nada —, então não vira
 * aviso.
 */
export function diffDosTurnos(snapshots: SnapshotDoTurno[]): DiffDosTurnos {
  const patch = snapshots
    .filter((s) => s.patch)
    .map((s) => `${(s.files ?? []).map((f) => `- ${f}`).join('\n')}\n${s.patch}`)
    .join('\n\n')

  const falhas = snapshots.filter((s) => s.failed || s.verified === 'unknown')
  if (falhas.length === 0 && snapshots.length > 0) return { patch }
  const motivo = falhas.find((s) => s.captureError)?.captureError
  return {
    patch,
    indisponivel: falhas.length
      ? `UNAVAILABLE: the filesystem snapshot of ${falhas.length} turn(s) of this worker could not be captured${motivo ? ` (${motivo})` : ''}. An empty diff here does NOT mean "nothing was written" — the engine failed to record it, not the worker to do it.${patch ? ' The diff below covers only the turns that were captured.' : ' Evidence from the folder follows when there is any.'}`
      : 'UNAVAILABLE: no filesystem snapshot was recorded for this worker, so there is no diff to build from its turns.',
  }
}

/**
 * Estado ATUAL da pasta em relação ao HEAD: o canal de reserva para quando os
 * snapshots dos turnos não puderam ser capturados.
 *
 * `git diff HEAD`, não `git diff`: o worker pode ter dado `git add`, e o diff
 * puro sairia vazio com o trabalho no disco.
 *
 * Sem worktree a pasta é COMPARTILHADA — o diff pode trazer mudanças de outros
 * workers e do próprio usuário (o prompt do revisor já avisa disso).
 */
export async function diffDaPasta(pasta: string): Promise<string> {
  const repo = await raizDoRepositorio(pasta).catch(() => null)
  if (!repo) return ''
  const arquivos = await git(repo, ['status', '--porcelain']).catch(() => '')
  if (!arquivos) return ''
  const patch = await git(repo, ['diff', 'HEAD']).catch(() => '')
  return [`Estado da pasta (compartilhada — pode incluir trabalho de outros workers):\n${arquivos}`, patch]
    .filter(Boolean)
    .join('\n\n')
}
