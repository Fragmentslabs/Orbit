import type { Memory, MemoryKind, ProjectCategory } from "@/shared/memory"

/** Rótulos e cores por tipo de memória, compartilhados entre lista e árvore. */

export const KIND_LABEL: Record<MemoryKind, string> = {
  core: "core",
  seasonal: "sazonal",
  general: "geral",
  project: "projeto",
}

/** Classes de badge por kind (lista) */
export const KIND_BADGE: Record<MemoryKind, string> = {
  core: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  seasonal: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  general: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  project: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
}

/** Cor sólida por kind (nós da árvore SVG) */
export const KIND_COLOR: Record<MemoryKind, string> = {
  core: "#3b82f6",
  seasonal: "#f59e0b",
  general: "#8b5cf6",
  project: "#10b981",
}

export const CATEGORY_LABEL: Record<ProjectCategory, string> = {
  preference: "preferência",
  convention: "convenção",
  structure: "estrutura",
  decision: "decisão",
  context: "contexto",
}

export function canPromote(memory: Memory): boolean {
  return memory.kind === "seasonal" || (memory.kind === "project" && memory.category === "context")
}

export function lastActivity(memory: Memory): number {
  return Math.max(memory.lastHitAt ?? 0, memory.createdAt)
}
