"use client"

import { useEffect, useState } from "react"
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
                ({checkedCount}/{checkboxCount} concluídas)
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 px-1">
          {loading ? (
            <p className="text-sm text-muted-foreground animate-pulse">Carregando...</p>
          ) : content ? (
            <MessageResponse>{content}</MessageResponse>
          ) : (
            <p className="text-sm text-muted-foreground">PLAN.md não encontrado.</p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCwIcon className={`size-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
            Recarregar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
