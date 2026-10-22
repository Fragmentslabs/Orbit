import type { OrchestrationTask } from '@shared/chat'

/**
 * Posse de arquivos na orquestra: cada tarefa declara os arquivos que vai
 * mexer, o planejamento evita que duas paralelas disputem os mesmos, e a
 * revisão confere se o worker ficou dentro dos dele. Nada aqui trava —
 * são avisos para o orquestrador decidir.
 */

/** "./src\\app/" e "src/app" são o mesmo caminho para quem compara posse. */
export function normalizarCaminho(caminho: string): string {
  return caminho
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')
}

/**
 * Pasta que um caminho cobre. Glob vira a pasta antes do primeiro curinga
 * ("src/components/**" → "src/components"; "src/*.ts" → "src"); "" é o projeto
 * inteiro, que se toca com tudo.
 */
function alcance(caminho: string): string {
  const p = normalizarCaminho(caminho)
  const curinga = p.search(/[*?[{]/)
  if (curinga < 0) return p
  const antes = p.slice(0, curinga)
  return antes.includes('/') ? antes.slice(0, antes.lastIndexOf('/')) : ''
}

/** Mesmo arquivo, ou um dentro da pasta do outro. */
export function caminhosSeTocam(a: string, b: string): boolean {
  const x = alcance(a)
  const y = alcance(b)
  return x === '' || y === '' || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

/** `de` espera (direta ou indiretamente) por `ate`? */
export function esperaPor(de: OrchestrationTask, ate: string, tarefas: OrchestrationTask[], vistos = new Set<string>()): boolean {
  for (const id of de.dependeDe ?? []) {
    if (id === ate) return true
    if (vistos.has(id)) continue
    vistos.add(id)
    const dep = tarefas.find((t) => t.id === id)
    if (dep && esperaPor(dep, ate, tarefas, vistos)) return true
  }
  return false
}

/**
 * Tarefas do plano que rodariam AO MESMO TEMPO que `task` mexendo nos mesmos
 * arquivos. Tarefa só de leitura não disputa nada, e quem espera pela outra
 * (dependsOn, mesmo que indireto) não roda junto.
 */
export function disputasDeArquivo(
  task: OrchestrationTask,
  tarefas: OrchestrationTask[],
): { task: OrchestrationTask; arquivos: string[] }[] {
  if (task.options.plan || !task.arquivos?.length) return []
  const disputas: { task: OrchestrationTask; arquivos: string[] }[] = []
  for (const outra of tarefas) {
    if (outra.id === task.id || outra.options.plan || !outra.arquivos?.length) continue
    if (esperaPor(task, outra.id, tarefas) || esperaPor(outra, task.id, tarefas)) continue
    const comuns = task.arquivos.filter((a) => outra.arquivos!.some((b) => caminhosSeTocam(a, b)))
    if (comuns.length > 0) disputas.push({ task: outra, arquivos: comuns })
  }
  return disputas
}

/**
 * Arquivos que o worker mudou fora da lista dele. Os que pertencem a outra
 * tarefa vêm marcados com ela: sem worktree a pasta é compartilhada e o diff
 * do worker pode trazer o trabalho do vizinho — o revisor precisa saber a
 * diferença entre "invadiu" e "provavelmente não foi ele".
 */
export function foraDaPosse(
  task: OrchestrationTask,
  tocados: string[],
  tarefas: OrchestrationTask[],
): { arquivo: string; dono?: OrchestrationTask }[] {
  if (!task.arquivos?.length) return []
  return [...new Set(tocados.map(normalizarCaminho))]
    .filter((f) => f && !task.arquivos!.some((a) => caminhosSeTocam(f, a)))
    .map((arquivo) => ({
      arquivo,
      dono: tarefas.find((t) => t.id !== task.id && t.arquivos?.some((a) => caminhosSeTocam(arquivo, a))),
    }))
}
