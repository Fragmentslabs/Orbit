import fs from 'node:fs/promises'
import path from 'node:path'
import type { Task, WorktreeDaTask } from '@shared/esteira'
import { descartarSnapshots } from '../snapshot'
import {
  baseAtual,
  branchExiste,
  git,
  pastaDosWorktrees,
  prepararDependencias,
  raizDoRepositorio,
  slug,
} from '../worktrees/nucleo'

// Reexportados: a esteira e os testes dela importam daqui.
export { acharExtras, existe, pastaDosWorktrees, prepararDependencias, raizDoRepositorio, slug } from '../worktrees/nucleo'

/**
 * Worktree por task (esteira com `worktreePorTask`): cada task trabalha num
 * `git worktree` próprio, num branch próprio, em
 * orbit-data/worktrees/<projeto>/<task>. O git e as dependências vêm do
 * núcleo compartilhado com os chats (../worktrees/nucleo).
 */

function caminhoDoWorktree(projetoId: string, taskId: string): string {
  return path.join(pastaDosWorktrees(), projetoId, taskId)
}

/** Branch da task: legível no `git branch` e único pelo sufixo do id. */
export function nomeDoBranch(task: Pick<Task, 'id' | 'titulo'>): string {
  return `esteira/${slug(task.titulo)}-${task.id.slice(-6).toLowerCase()}`
}

/**
 * Cria (ou recria, se a pasta sumiu) o worktree da task.
 *
 * `base`: de onde o branch novo sai. Se o branch da task já existe (recriação
 * ou nome repetido), o worktree só faz checkout dele — o trabalho já
 * commitado continua lá.
 */
export async function criarWorktree(opts: {
  pastaPrincipal: string
  projetoId: string
  task: Pick<Task, 'id' | 'titulo' | 'worktree'>
  base?: string
  signal?: AbortSignal
}): Promise<WorktreeDaTask> {
  const repo = await raizDoRepositorio(opts.pastaPrincipal)
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  } catch {
    throw new Error('O repositório ainda não tem nenhum commit — o worktree precisa de um ponto de partida.')
  }
  const caminho = opts.task.worktree?.caminho ?? caminhoDoWorktree(opts.projetoId, opts.task.id)
  const branch = opts.task.worktree?.branch ?? nomeDoBranch(opts.task)
  const base = opts.task.worktree?.base ?? opts.base ?? (await baseAtual(repo))

  // Registro velho de um worktree cuja pasta foi apagada à mão: sem o prune,
  // o `worktree add` recusa o mesmo caminho.
  await git(repo, ['worktree', 'prune']).catch(() => {})
  await fs.mkdir(path.dirname(caminho), { recursive: true })
  if (await branchExiste(repo, branch)) {
    await git(repo, ['worktree', 'add', caminho, branch], opts.signal)
  } else {
    await git(repo, ['worktree', 'add', '-b', branch, caminho, base], opts.signal)
  }

  const dependencias = await prepararDependencias(repo, caminho)
  const relativo = path.relative(repo, path.resolve(opts.pastaPrincipal))
  return {
    caminho,
    pasta: relativo ? path.join(caminho, relativo) : caminho,
    branch,
    base,
    dependencias,
    criadoEm: new Date().toISOString(),
  }
}

/**
 * Remove o worktree da task (pasta, registro no git e snapshots). O branch só
 * sai com `apagarBranch` — sem isso, o trabalho commitado continua acessível.
 * Alterações não commitadas no worktree são perdidas: quem chama confirma.
 */
export async function removerWorktree(
  pastaPrincipal: string | undefined,
  worktree: WorktreeDaTask,
  opts: { apagarBranch?: boolean } = {},
): Promise<void> {
  const repo = pastaPrincipal ? await raizDoRepositorio(pastaPrincipal).catch(() => undefined) : undefined
  if (repo) {
    await git(repo, ['worktree', 'remove', '--force', worktree.caminho]).catch(() => {})
  }
  await fs.rm(worktree.caminho, { recursive: true, force: true })
  if (repo) {
    await git(repo, ['worktree', 'prune']).catch(() => {})
    if (opts.apagarBranch) await git(repo, ['branch', '-D', worktree.branch]).catch(() => {})
  }
  await descartarSnapshots(worktree.pasta).catch(() => {})
}

/**
 * Apaga worktrees de tasks que não existem mais (task removida com o app
 * fechado, falha no meio de uma remoção). `vivas`: ids de task por projeto.
 */
export async function limparOrfaos(
  projetos: Array<{ id: string; pastas: string[] }>,
  vivas: Map<string, Set<string>>,
): Promise<void> {
  const raiz = pastaDosWorktrees()
  let pastasProjeto: string[]
  try {
    pastasProjeto = await fs.readdir(raiz)
  } catch {
    return // nenhum worktree criado ainda
  }
  for (const projetoId of pastasProjeto) {
    // Só as pastas de projeto da esteira (proj_…): a mesma raiz guarda os
    // worktrees dos chats (chats/), que não são dela e não podem ser varridos.
    if (!projetoId.startsWith('proj_')) continue
    const projeto = projetos.find((p) => p.id === projetoId)
    const tasksVivas = vivas.get(projetoId) ?? new Set<string>()
    let tasks: string[]
    try {
      tasks = await fs.readdir(path.join(raiz, projetoId))
    } catch {
      continue
    }
    for (const taskId of tasks) {
      if (tasksVivas.has(taskId)) continue
      const caminho = path.join(raiz, projetoId, taskId)
      console.log(`[esteira] removendo worktree órfão ${caminho}`)
      await fs.rm(caminho, { recursive: true, force: true })
      await descartarSnapshots(caminho).catch(() => {})
    }
    const repo = projeto?.pastas[0] ? await raizDoRepositorio(projeto.pastas[0]).catch(() => undefined) : undefined
    if (repo) await git(repo, ['worktree', 'prune']).catch(() => {})
    if (!projeto) await fs.rm(path.join(raiz, projetoId), { recursive: true, force: true })
  }
}
