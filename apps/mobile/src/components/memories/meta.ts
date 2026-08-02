import type { Memory, MemoryKind, ProjectArea, ProjectCategory } from '@orbit/shared'
import i18n from '~/i18n'

/** Rótulos e cores por tipo de memória — espelho do meta.ts do desktop. */

export function kindLabel(kind: MemoryKind): string {
  return i18n.t(`memoryMeta.kind.${kind}`)
}

/** Cor sólida por kind (badges e nós do grafo) */
export const KIND_COLOR: Record<MemoryKind, string> = {
  core: '#3b82f6',
  seasonal: '#f59e0b',
  general: '#8b5cf6',
  project: '#10b981',
}

export function categoryLabel(category: ProjectCategory): string {
  return i18n.t(`memoryMeta.category.${category}`)
}

/** Ícone Lucide por categoria (usado nos badges de memórias sem área). */
export const CATEGORY_ICON: Partial<Record<ProjectCategory, string>> = {
  database: 'Database',
  learning: 'GraduationCap',
  standard: 'BookText',
}

/** Ícone Lucide por área de conhecimento (usado no grafo de memórias). */
export const AREA_ICON: Record<ProjectArea, string> = {
  overview: 'BrainCircuit',
  business: 'Briefcase',
  design: 'Palette',
  architecture: 'Layers',
  preferences: 'SlidersHorizontal',
  infrastructure: 'Server',
  security: 'Shield',
  development: 'Terminal',
  database: 'Database',
  testing: 'TestTube',
  performance: 'Gauge',
  dependencies: 'Package',
  standards: 'BookText',
}

export function canPromote(memory: Memory): boolean {
  return memory.kind === 'seasonal' || (memory.kind === 'project' && memory.category === 'context')
}

export function lastActivity(memory: Memory): number {
  return Math.max(memory.lastHitAt ?? 0, memory.createdAt)
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(i18n.language, { day: '2-digit', month: 'short', year: 'numeric' })
}
