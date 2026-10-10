import fs from 'node:fs/promises'
import path from 'node:path'
import type { OrchestrationTask } from '@shared/chat'
import { descartarSnapshots } from '../snapshot'
import { pastaNoRepositorioPrincipal } from '../worktrees/principal'
import {
  acharExtras,
  baseAtual,
  branchExiste,
  git,
  prepararDependencias,
  raizConfigurada,
  raizDoRepositorio,
  raizNoProjeto,
  slug,
  worktreesDentroDoProjeto,
} from '../worktrees/nucleo'

/**
 * Worktree por worker da orquestra ("Isolar workers em worktrees").
 *
 * Cada worker trabalha num branch próprio (`orquestra/<plano>/<tarefa>`), a
 * partir do branch do chat — ou do branch da dependência, quando a tarefa
 * depende de outra. Ao ser aceito, o trabalho dele é commitado; no fim, os
 * branches aceitos são juntados no chat em ordem de dependência.
 */

export type WorktreeDoWorker = NonNullable<OrchestrationTask['worktree']>

/** A pasta do chat está num repositório git? (a opção só vale nesse caso) */
export async function repositorioDoChat(pasta: string): Promise<string | null> {
  return raizDoRepositorio(pasta).catch(() => null)
}

/**
 * Cria o worktree do worker. `dependencias` são os worktrees das tarefas de
 * que ele depende: com uma, parte do branch dela; com várias, parte da
 * primeira e junta as outras (um conflito aqui fica para o worker resolver,
 * avisado no prompt).
 */
export async function criarWorktreeDoWorker(opts: {
  pastaDoChat: string
  planId: string
  task: OrchestrationTask
  dependencias: WorktreeDoWorker[]
}): Promise<{ worktree: WorktreeDoWorker; avisos: string[] }> {
  const repo = await raizDoRepositorio(opts.pastaDoChat)
  const avisos: string[] = []
  const plano = opts.planId.slice(-6).toLowerCase()
  const nome = slug(opts.task.title)
  let branch = `orquestra/${plano}/${nome}`
  for (let n = 2; await branchExiste(repo, branch); n++) branch = `orquestra/${plano}/${nome}-${n}`

  const raiz = worktreesDentroDoProjeto()
    ? path.join(await raizNoProjeto(repo), 'orquestra', plano)
    : path.join(raizConfigurada(), 'orquestra', `${slug(path.basename(repo))}-${plano}`)
  const caminho = path.join(raiz, branch.split('/').pop()!)

  const [primeira, ...outras] = opts.dependencias
  const base = primeira?.branch ?? (await baseAtual(opts.pastaDoChat))
  await fs.mkdir(raiz, { recursive: true })
  await git(repo, ['worktree', 'prune']).catch(() => {})
  await git(repo, ['worktree', 'add', '--no-track', '-b', branch, caminho, base])

  for (const dep of outras) {
    try {
      await git(caminho, ['merge', '--no-edit', dep.branch])
    } catch {
      await git(caminho, ['merge', '--abort']).catch(() => {})
      avisos.push(`O branch ${dep.branch} (de uma tarefa de que esta depende) não pôde ser juntado sozinho — há conflito. Junte-o com \`git merge ${dep.branch}\` e resolva antes de seguir.`)
    }
  }
  await prepararDependencias(repo, caminho)

  // A mesma subpasta do chat dentro do worktree (monorepo).
  const relativo = path.relative(repo, await fs.realpath(opts.pastaDoChat).catch(() => opts.pastaDoChat))
  const pasta = relativo && !relativo.startsWith('..') ? path.join(caminho, relativo) : caminho
  return { worktree: { caminho, pasta, branch, base }, avisos }
}

/**
 * Commita o que o worker deixou no worktree — sem commit, o merge do fim não
 * levaria nada. Os .env copiados do principal ficam fora (são segredos que o
 * Orbit trouxe, não trabalho do worker).
 */
export async function commitarTrabalho(worktree: WorktreeDoWorker, titulo: string): Promise<boolean> {
  const status = await git(worktree.caminho, ['status', '--porcelain']).catch(() => '')
  if (!status) return false
  await git(worktree.caminho, ['add', '-A'])
  // Os .env que o Orbit copiou vêm do PRINCIPAL (a raiz do próprio worktree
  // seria ele mesmo).
  const repo = await pastaNoRepositorioPrincipal(worktree.caminho)
  const { envs } = await acharExtras(repo).catch(() => ({ envs: [] as string[] }))
  if (envs.length > 0) await git(worktree.caminho, ['reset', '-q', '--', ...envs]).catch(() => {})
  const restante = await git(worktree.caminho, ['diff', '--cached', '--name-only']).catch(() => '')
  if (!restante) return false
  await git(worktree.caminho, ['commit', '-q', '-m', `orquestra: ${titulo}`])
  return true
}

export interface ResultadoJuntar {
  juntados: string[]
  /** Conflito de conteúdo entre o branch de um worker e o chat */
  conflito?: { titulo: string; arquivos: string[] }
  /**
   * Nada foi juntado: a pasta do chat tem alterações não commitadas em
   * arquivos que os workers mudaram (o git recusaria o merge).
   */
  bloqueio?: { arquivos: string[] }
  /** Outro erro do git (mensagem dele) */
  erro?: { titulo: string; mensagem: string }
}

/**
 * Caminhos de `git status --porcelain` (o de destino, em renomeações). Pela
 * regex, não por posição: o helper `git` apara a saída, e o espaço inicial do
 * código de status da PRIMEIRA linha (" M a.txt") some.
 */
function caminhosDoStatus(status: string): string[] {
  return status
    .split('\n')
    .map((linha) => /^[ MADRCTU?!]{1,2}\s+(.+)$/.exec(linha)?.[1])
    .filter((c): c is string => !!c)
    .map((c) => c.split(' -> ').pop()!.replace(/^"|"$/g, ''))
}

/**
 * Junta os branches aceitos no chat, na ordem dada (dependências antes).
 *
 * Antes de tudo, confere a pasta do chat: alteração não commitada num arquivo
 * que algum worker mudou faria o git recusar o merge no meio — então nada é
 * juntado e a lista desses arquivos volta, para o usuário commitar ou guardar
 * (stash) e pedir para juntar de novo. Num conflito de conteúdo, desfaz aquele
 * merge e para: os branches seguintes não entram, para não empilhar problema.
 */
export async function juntarBranches(
  pastaDoChat: string,
  tarefas: Array<{ titulo: string; worktree: WorktreeDoWorker }>,
): Promise<ResultadoJuntar> {
  const repo = await raizDoRepositorio(pastaDoChat)

  const sujos = new Set(caminhosDoStatus(await git(repo, ['status', '--porcelain']).catch(() => '')))
  if (sujos.size > 0) {
    const mudadosPelosWorkers = new Set<string>()
    for (const t of tarefas) {
      const nomes = await git(repo, ['diff', '--name-only', `HEAD...${t.worktree.branch}`]).catch(() => '')
      for (const nome of nomes.split('\n').filter(Boolean)) mudadosPelosWorkers.add(nome)
    }
    const emRisco = [...sujos].filter((f) => mudadosPelosWorkers.has(f))
    if (emRisco.length > 0) return { juntados: [], bloqueio: { arquivos: emRisco } }
  }

  const juntados: string[] = []
  for (const t of tarefas) {
    try {
      await git(repo, ['merge', '--no-ff', '--no-edit', '-m', `orquestra: juntar ${t.titulo}`, t.worktree.branch])
      juntados.push(t.titulo)
    } catch (err) {
      const arquivos = (await git(repo, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
        .split('\n')
        .filter(Boolean)
      await git(repo, ['merge', '--abort']).catch(() => {})
      if (arquivos.length > 0) return { juntados, conflito: { titulo: t.titulo, arquivos } }
      // Sem arquivo em conflito: o git recusou por outro motivo — a mensagem
      // dele diz qual (é ela que ajuda o usuário, não um "conflito" vazio).
      const e = err as { stderr?: string; message?: string }
      return { juntados, erro: { titulo: t.titulo, mensagem: (e.stderr || e.message || String(err)).trim().slice(0, 600) } }
    }
  }
  return { juntados }
}

/** Remove o worktree de um worker já juntado (o branch sai junto: está no chat). */
export async function removerWorktreeDoWorker(worktree: WorktreeDoWorker, apagarBranch: boolean): Promise<void> {
  // O git do PRINCIPAL remove o worktree e o branch — de dentro do próprio
  // worktree, a pasta sumiria debaixo do comando.
  const principal = await pastaNoRepositorioPrincipal(worktree.caminho)
  const repo = principal !== path.resolve(worktree.caminho) ? principal : null
  if (repo) await git(repo, ['worktree', 'remove', '--force', worktree.caminho]).catch(() => {})
  await fs.rm(worktree.caminho, { recursive: true, force: true })
  if (repo) {
    await git(repo, ['worktree', 'prune']).catch(() => {})
    if (apagarBranch) await git(repo, ['branch', '-d', worktree.branch]).catch(() => {})
  }
  await descartarSnapshots(worktree.pasta).catch(() => {})
}

/** Diff do worker no worktree: tudo desde a base, commitado ou não. */
export async function diffDoWorktree(worktree: WorktreeDoWorker): Promise<string> {
  const arquivos = await git(worktree.caminho, ['status', '--porcelain']).catch(() => '')
  const patch = await git(worktree.caminho, ['diff', worktree.base]).catch(() => '')
  return [arquivos ? `Arquivos alterados (git status):\n${arquivos}` : '', patch].filter(Boolean).join('\n\n')
}
