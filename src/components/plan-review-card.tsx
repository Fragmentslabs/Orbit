import { useState } from "react"
import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { usePermissionPrefs } from "@/src/stores/permission-prefs"
import { useSessionStore } from "@/src/stores/session-store"
import { PlanDialog } from "@/src/components/plan-dialog"
import type { PlanReview } from "@/shared/chat"
import type { PermissionMode } from "@/shared/chat"

const ALL_MODES: { id: PermissionMode; label: string }[] = [
  { id: "ask", label: "Perguntas" },
  { id: "approve", label: "Autonomia" },
  { id: "full", label: "Irrestrito" },
]

const MODE_LABEL: Record<PermissionMode, string> = {
  ask: "Perguntar",
  approve: "Autonomia",
  full: "Irrestrito",
}

export function PlanReviewCard({ sessionId, review }: { sessionId: string; review: PlanReview }) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const acceptPlanReview = useSessionStore((s) => s.acceptPlanReview)
  const rejectPlanReview = useSessionStore((s) => s.rejectPlanReview)
  const currentMode = usePermissionPrefs((s) => s.mode)
  const otherModes = ALL_MODES.filter((m) => m.id !== currentMode)

  if (review.status !== "proposed") return null

  return (
    <>
      <div className="rounded-xl border-2 border-sidebar-border bg-sidebar/50 p-3 text-sm">
        <p className="mb-2 font-medium">Plano de implementação proposto</p>
        <p className="mb-3 text-xs text-muted-foreground">
          Revise o plano gerado acima e escolha como deseja implementá-lo.
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => setDialogOpen(true)}>
            Ver plano
          </Button>
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => rejectPlanReview(sessionId)}>
            Rejeitar
          </Button>
          <div className="flex">
            <Button
              size="sm"
              className="rounded-r-none text-xs"
              onClick={() => acceptPlanReview(sessionId, currentMode)}
            >
              Aceitar ({MODE_LABEL[currentMode]})
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="sm" className="rounded-l-none border-l border-primary-foreground/20 px-1.5">
                <ChevronDown className="size-3" />
              </Button>} />
              <DropdownMenuContent align="end" side="top">
                {otherModes.map((m) => (
                  <DropdownMenuItem key={m.id} onClick={() => acceptPlanReview(sessionId, m.id)}>
                    Aceitar com modo {m.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
      <PlanDialog sessionId={sessionId} open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  )
}
