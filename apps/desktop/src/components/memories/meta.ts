import type { Memory, MemoryKind, ProjectArea, ProjectCategory } from "@shared/memory"

/** Labels and colors per memory type, shared between list and tree. */

export const KIND_LABEL: Record<MemoryKind, string> = {
  core: "core",
  seasonal: "seasonal",
  general: "general",
  project: "project",
}

/** Badge classes per kind (list) */
export const KIND_BADGE: Record<MemoryKind, string> = {
  core: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  seasonal: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  general: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  project: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
}

/** Kind badge of the list card: border and text in the kind color, as in the routines pill. */
export const KIND_PILL: Record<MemoryKind, string> = {
  core: "border-blue-500/40 text-blue-600 dark:text-blue-400",
  seasonal: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  general: "border-violet-500/40 text-violet-600 dark:text-violet-400",
  project: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
}

/** Solid color per kind (nodes of the SVG tree) */
export const KIND_COLOR: Record<MemoryKind, string> = {
  core: "#3b82f6",
  seasonal: "#f59e0b",
  general: "#8b5cf6",
  project: "#10b981",
}

export const CATEGORY_LABEL: Record<ProjectCategory, string> = {
  preference: "preference",
  convention: "convention",
  structure: "structure",
  decision: "decision",
  context: "context",
  database: "database",
  learning: "learning",
  standard: "standard",
}

/** Lucide icon per category (used in the badges of memories without an area — kind
 * "general"/"project" outside the /init graph, e.g. learnings). */
export const CATEGORY_ICON: Partial<Record<ProjectCategory, string>> = {
  database: "Database",
  learning: "GraduationCap",
  standard: "BookText",
}

/** Lucide icon per knowledge area (used in the memory graph). */
export const AREA_ICON: Record<ProjectArea, string> = {
  overview: "BrainCircuit",
  business: "Briefcase",
  design: "Palette",
  architecture: "Layers",
  preferences: "SlidersHorizontal",
  infrastructure: "Server",
  security: "Shield",
  development: "Terminal",
  database: "Database",
  testing: "TestTube",
  performance: "Gauge",
  dependencies: "Package",
  standards: "BookText",
}

export function canPromote(memory: Memory): boolean {
  return memory.kind === "seasonal" || (memory.kind === "project" && memory.category === "context")
}

export function lastActivity(memory: Memory): number {
  return Math.max(memory.lastHitAt ?? 0, memory.createdAt)
}
