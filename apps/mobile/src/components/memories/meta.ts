import type { Memory, MemoryKind, ProjectCategory } from '@orbit/shared'

/** Rótulos e cores por tipo de memória — espelho do meta.ts do desktop. */

export const KIND_LABEL: Record<MemoryKind, string> = {
  core: 'core',
  seasonal: 'sazonal',
  general: 'geral',
  project: 'projeto',
}

/** Cor sólida por kind (badges e nós do grafo) */
export const KIND_COLOR: Record<MemoryKind, string> = {
  core: '#3b82f6',
  seasonal: '#f59e0b',
  general: '#8b5cf6',
  project: '#10b981',
}

export const CATEGORY_LABEL: Record<ProjectCategory, string> = {
  preference: 'preferência',
  convention: 'convenção',
  structure: 'estrutura',
  decision: 'decisão',
  context: 'contexto',
}

export function canPromote(memory: Memory): boolean {
  return memory.kind === 'seasonal' || (memory.kind === 'project' && memory.category === 'context')
}

export function lastActivity(memory: Memory): number {
  return Math.max(memory.lastHitAt ?? 0, memory.createdAt)
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
}
