import { BookOpen, Clock, Folder, Gem, type LucideIcon } from "lucide-react"
import type { MemoryKind } from "@shared/memory"

/**
 * Icon of each memory kind — the same shape on the list card and in the type filter,
 * so color and drawing say the same thing in both places.
 */
export const KIND_ICON: Record<MemoryKind, LucideIcon> = {
  core: Gem,
  seasonal: Clock,
  general: BookOpen,
  project: Folder,
}
