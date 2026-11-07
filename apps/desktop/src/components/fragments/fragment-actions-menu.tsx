import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Check, House, MoreHorizontal, PanelRight, Pin, Sparkles, Trash2 } from "lucide-react"
import type { FragmentManifest } from "@shared/fragments"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { DeleteFragmentDialog } from "@/src/components/fragment-tab"
import { fragmentApi } from "@/src/lib/ipc"

/**
 * The actions of a fragment (pin it, show it in the panel, allow or stop its AI, delete it) — one menu for every place that lists or shows a fragment: the gallery card and the
 * header of its page. Only the look of the trigger changes between them.
 */
export function FragmentActionsMenu({
  fragment,
  triggerClassName,
  align = "end",
  icon,
}: {
  fragment: FragmentManifest
  /** Class of the trigger button, or a function of whether the menu is open (a card keeps it visible while open). */
  triggerClassName: string | ((open: boolean) => string)
  align?: "start" | "end"
  icon?: ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const update = (patch: Parameters<typeof fragmentApi.update>[1]) => void fragmentApi.update(fragment.id, patch)

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          aria-label={t("fragments.more")}
          className={cn(typeof triggerClassName === "function" ? triggerClassName(open) : triggerClassName)}
        >
          {icon ?? <MoreHorizontal className="size-4" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="min-w-56">
          <DropdownMenuItem onClick={() => update({ pinned: { sidebar: !fragment.pinned.sidebar } })}>
            {fragment.pinned.sidebar ? <Check className="size-3.5" /> : <Pin className="size-3.5" />}
            {t("fragments.pinSidebar")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => update({ pinned: { panel: !fragment.pinned.panel } })}>
            {fragment.pinned.panel ? <Check className="size-3.5" /> : <PanelRight className="size-3.5" />}
            {t("fragments.pinPanel")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => update({ pinned: { home: !fragment.pinned.home } })}>
            {fragment.pinned.home ? <Check className="size-3.5" /> : <House className="size-3.5" />}
            {t("fragments.pinHome")}
          </DropdownMenuItem>
          {/* Only a fragment that asked for the model has anything to allow — and only the person allows it. */}
          {fragment.requests.includes("ai") && (
            <DropdownMenuItem onClick={() => void fragmentApi.grant(fragment.id, "ai", !fragment.grants.includes("ai"))}>
              {fragment.grants.includes("ai") ? <Check className="size-3.5" /> : <Sparkles className="size-3.5" />}
              {t("fragments.aiEnable")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="size-3.5" />
            {t("fragments.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteFragmentDialog open={confirmDelete} onOpenChange={setConfirmDelete} fragmentId={fragment.id} />
    </>
  )
}
