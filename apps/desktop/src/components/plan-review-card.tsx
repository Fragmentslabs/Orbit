import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, FileTextIcon, MessageSquareText, X } from "lucide-react"
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
import type { PlanReview } from "@shared/chat"
import type { PermissionMode } from "@shared/chat"

const ALL_MODES: { id: PermissionMode; labelKey: string }[] = [
  { id: "ask", labelKey: "planReview.modeAsk" },
  { id: "approve", labelKey: "planReview.modeApprove" },
  { id: "full", labelKey: "planReview.modeFull" },
]

const MODE_LABEL: Record<PermissionMode, string> = {
  ask: "planReview.modeAskShort",
  approve: "planReview.modeApprove",
  full: "planReview.modeFull",
}

export function PlanReviewCard({ sessionId, review }: { sessionId: string; review: PlanReview }) {
  const { t } = useTranslation()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewText, setReviewText] = useState("")
  const acceptPlanReview = useSessionStore((s) => s.acceptPlanReview)
  const rejectPlanReview = useSessionStore((s) => s.rejectPlanReview)
  const reviewPlanReview = useSessionStore((s) => s.reviewPlanReview)
  const dismissPlanReview = useSessionStore((s) => s.dismissPlanReview)
  const currentMode = usePermissionPrefs((s) => s.mode)
  const otherModes = ALL_MODES.filter((m) => m.id !== currentMode)
  const content = review.content ?? null
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
            {isProposed ? t("planReview.proposed") : t("planReview.implementing")}
          </span>
          {checkboxCount > 0 && (
            <span className="shrink-0 text-muted-foreground">
              {checkedCount}/{checkboxCount}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setDialogOpen(true)}>
              {t("planReview.viewPlan")}
            </Button>
            {isProposed ? (
              <>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setReviewOpen(!reviewOpen)}>
                  <MessageSquareText className="size-3.5 mr-1" />
                  {t("planReview.review")}
                </Button>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => rejectPlanReview(sessionId)}>
                  {t("planReview.reject")}
                </Button>
                <div className="flex">
                  <Button
                    size="sm"
                    className="h-7 rounded-r-none text-xs"
                    onClick={() => acceptPlanReview(sessionId, currentMode)}
                  >
                    {t("planReview.accept", { mode: t(MODE_LABEL[currentMode]) })}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button size="sm" className="h-7 rounded-l-none border-l border-primary-foreground/20 px-1.5">
                      <ChevronDown className="size-3" />
                    </Button>} />
                    <DropdownMenuContent align="end" side="top">
                      {otherModes.map((m) => (
                        <DropdownMenuItem key={m.id} onClick={() => acceptPlanReview(sessionId, m.id)}>
                          {t("planReview.acceptWith", { mode: t(m.labelKey) })}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuItem onClick={() => acceptPlanReview(sessionId, currentMode, true)}>
                        {t("planReview.acceptOrchestration")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </>
            ) : (
              <>
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
              placeholder={t("planReview.reviewPlaceholder")}
              className="h-8 flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmitReview() }}
            />
            <Button size="sm" className="h-8 text-xs" onClick={handleSubmitReview} disabled={!reviewText.trim()}>
              {t("planReview.send")}
            </Button>
          </div>
        )}
      </div>
      <PlanDialog content={content} open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  )
}
