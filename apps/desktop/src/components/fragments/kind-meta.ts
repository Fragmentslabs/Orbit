import { AppWindow, PanelRight, type LucideIcon } from "lucide-react"
import type { FragmentKind } from "@shared/fragments"

/** Icon and i18n keys of each kind of fragment — one place, so the gallery, the header and the creation screen agree. */
export const KIND_META: Record<FragmentKind, { icon: LucideIcon; name: string; description: string }> = {
  screen: { icon: AppWindow, name: "fragments.kind.screen.name", description: "fragments.kind.screen.description" },
  panel: { icon: PanelRight, name: "fragments.kind.panel.name", description: "fragments.kind.panel.description" },
}
