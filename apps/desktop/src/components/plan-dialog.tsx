"use client"

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { RefreshCwIcon } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { MessageResponse } from "@/src/components/ai/message"
import { useSessionStore } from "@/src/stores/session-store"
import { chatApi } from "@/src/lib/ipc"

export function PlanDialog({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId))

  async function load() {
    if (!session?.directory) return
    setLoading(true)
    try {
      const text = await chatApi.readPlanFile(session.directory)
      setContent(text)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) load()
  }, [open])

  const checkboxCount = content
    ? [...content.matchAll(/\[(\s|x)\]/gi)].length
    : 0
  const checkedCount = content
    ? [...content.matchAll(/\[x\]/gi)].length
    : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            PLAN.md
            {checkboxCount > 0 && (
              <span className="text-sm font-normal text-muted-foreground">
                {t("planDialog.doneCount", { checked: checkedCount, total: checkboxCount })}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 px-1">
          {loading ? (
            <p className="text-sm text-muted-foreground animate-pulse">{t("planDialog.loading")}</p>
          ) : content ? (
            <MessageResponse>{content}</MessageResponse>
          ) : (
            <p className="text-sm text-muted-foreground">{t("planDialog.notFound")}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCwIcon className={`size-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
            {t("planDialog.reload")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
