import { useEffect, useState } from "react"
import { ChevronDown, FileTextIcon, RefreshCwIcon, MessageSquareText, X } from "lucide-react"
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
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewText, setReviewText] = useState("")
  const acceptPlanReview = useSessionStore((s) => s.acceptPlanReview)
  const rejectPlanReview = useSessionStore((s) => s.rejectPlanReview)
  const reviewPlanReview = useSessionStore((s) => s.reviewPlanReview)
  const dismissPlanReview = useSessionStore((s) => s.dismissPlanReview)
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

  function handleSubmitReview() {
    const text = reviewText.trim()
    if (!text) return
    reviewPlanReview(sessionId, text)
    setReviewOpen(false)
    setReviewText("")
  }

  return (
    <>
      <div className="rounded-xl border border-sidebar-border bg-sidebar/50 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
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
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setReviewOpen(!reviewOpen)}>
                  <MessageSquareText className="size-3.5 mr-1" />
                  Revisar
                </Button>
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
                          Aceitar com {m.label}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuItem onClick={() => acceptPlanReview(sessionId, currentMode, true)}>
                        Aceitar com Orquestração
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={load} disabled={loading}>
                  <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
                </Button>
                <button
                  type="button"
                  onClick={() => dismissPlanReview(sessionId)}
                  className="ml-0.5 flex size-5 items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-sidebar-accent"
                >
                  <X className="size-3" />
                </button>
              </>
            )}
          </div>
        </div>
        {isProposed && reviewOpen && (
          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-sidebar-border">
            <input
              value={reviewText}
              onChange={(e) => setReviewText(e.target.value)}
              placeholder="Escreva seu feedback para revisar o plano..."
              className="h-8 flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmitReview() }}
            />
            <Button size="sm" className="h-8 text-xs" onClick={handleSubmitReview} disabled={!reviewText.trim()}>
              Enviar
            </Button>
          </div>
        )}
      </div>
      <PlanDialog sessionId={sessionId} open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  )
}
