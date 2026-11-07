import { Clapperboard, FileText, LayoutGrid, Presentation } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { CreationKind } from "@/src/lib/start-creation"

/** The pieces the panel's Create cards start, with the look they share with the composer's badge. */
export const CREATIONS: { kind: CreationKind; Icon: LucideIcon; tone: string }[] = [
  { kind: "document", Icon: FileText, tone: "bg-sky-500/15 text-sky-400" },
  { kind: "design", Icon: LayoutGrid, tone: "bg-violet-500/15 text-violet-400" },
  { kind: "slides", Icon: Presentation, tone: "bg-amber-500/15 text-amber-400" },
  { kind: "motion", Icon: Clapperboard, tone: "bg-emerald-500/15 text-emerald-400" },
]
