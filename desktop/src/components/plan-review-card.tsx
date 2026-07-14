import { useEffect, useState } from "react"
import { ChevronDown, FileTextIcon, RefreshCwIcon } from "lucide-react"
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
import { chatApi } from "@/src/lib/ipc"
import type { PlanReview } from "@shared/chat"
import type { PermissionMode } from "@shared/chat"

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
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const acceptPlanReview = useSessionStore((s) => s.acceptPlanReview)
  const rejectPlanReview = useSessionStore((s) => s.rejectPlanReview)
  const currentMode = usePermissionPrefs((s) => s.mode)
  const otherModes = ALL_MODES.filter((m) => m.id !== currentMode)
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId))

  async function load() {
    if (!session?.directory) return
    setLoading(true)
    try {
      setContent(await chatApi.readPlanFile(session.directory))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [review.status])

  const checkboxCount = content
    ? [...content.matchAll(/\[(\s|x)\]/gi)].length
    : 0
  const checkedCount = content
    ? [...content.matchAll(/\[x\]/gi)].length
    : 0

  if (review.status === "rejected") return null

  const isProposed = review.status === "proposed"

  return (
    <>
      <div className="flex items-center gap-2 rounded-xl border border-sidebar-border bg-sidebar/50 px-3 py-2 text-xs">
        <FileTextIcon className="size-4 shrink-0 text-primary" />
        <span className="font-medium truncate">
          {isProposed ? "Plano de implementação proposto" : "Implementando plano"}
        </span>
        {checkboxCount > 0 && (
          <span className="shrink-0 text-muted-foreground">
            {checkedCount}/{checkboxCount}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setDialogOpen(true)}>
            Ver plano
          </Button>
          {isProposed ? (
            <>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => rejectPlanReview(sessionId)}>
                Rejeitar
              </Button>
              <div className="flex">
                <Button
                  size="sm"
                  className="h-7 rounded-r-none text-xs"
                  onClick={() => acceptPlanReview(sessionId, currentMode)}
                >
                  Aceitar ({MODE_LABEL[currentMode]})
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button size="sm" className="h-7 rounded-l-none border-l border-primary-foreground/20 px-1.5">
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
            </>
          ) : (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={load} disabled={loading}>
              <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          )}
        </div>
      </div>
      <PlanDialog sessionId={sessionId} open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  )
}
