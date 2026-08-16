import type { FaseEscolhida, FaseTemplate, Task } from '@orbit/shared'
import type { TFunction } from 'i18next'

/**
 * Nome/descrição do template: as fases embutidas têm rótulos traduzidos
 * (o prompt segue em inglês, como os demais prompts do app); as do usuário
 * usam o que ele escreveu.
 */
export function rotuloTemplate(tpl: FaseTemplate, t: TFunction): { nome: string; descricao: string } {
  return tpl.i18nKey && !tpl.custom
    ? { nome: t(`esteira.fase.${tpl.i18nKey}.nome`), descricao: t(`esteira.fase.${tpl.i18nKey}.descricao`) }
    : { nome: tpl.nome, descricao: tpl.descricao }
}

/** Converte um template em FaseEscolhida (cópia, D4). */
export function doTemplate(tpl: FaseTemplate, t: TFunction): FaseEscolhida {
  return {
    templateId: tpl.id,
    ...rotuloTemplate(tpl, t),
    prompt: tpl.prompt,
    tools: [...tpl.tools],
    tipo: tpl.tipo,
  }
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

/**
 * Regra de drag do board (mobile, D8 restrito):
 * - pendente → qualquer fase (iniciar na fase X);
 * - em_progresso → só fases À FRENTE da atual (nunca volta);
 * - pausada → retomar na mesma fase ou pular para frente;
 * - concluída → não arrasta.
 */
export function fasesValidasParaDrop(task: Task, totalFases: number): number[] {
  if (task.status === 'concluida' || totalFases <= 0) return []
  if (task.status === 'pendente' || task.faseAtual == null) return range(totalFases)
  if (task.status === 'em_progresso') return range(totalFases).filter((i) => i > task.faseAtual!)
  return range(totalFases).filter((i) => i >= task.faseAtual!)
}

/**
 * Título da dependência que bloqueia a task (mesma regra do desktop):
 * primeira dependência ainda não concluída.
 */
export function dependenciaBloqueante(task: Task, tasks: Task[]): string | undefined {
  for (const id of task.dependeDe) {
    const dep = tasks.find((t) => t.id === id)
    if (dep && dep.status !== 'concluida') return dep.titulo
  }
  return undefined
}

/**
 * "Próxima da fila": a primeira pendente sem dependências pendentes (FIFO por
 * criação — mesma regra do engine). Só faz sentido com a fila ligada.
 */
export function proximaDaFila(task: Task, tasks: Task[]): boolean {
  const candidatas = tasks
    .filter((t) => t.status === 'pendente' && t.dependeDe.every((id) => tasks.some((x) => x.id === id && x.status === 'concluida')))
    .sort((a, b) => a.criadoEm.localeCompare(b.criadoEm))
  return candidatas[0]?.id === task.id
}
