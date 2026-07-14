"use client"

import { useEffect, useState } from "react"
import { ChevronsUpDownIcon, ExternalLinkIcon, FileTextIcon, RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { MessageResponse } from "@/src/components/ai/message"
import { useSessionStore } from "@/src/stores/session-store"
import { chatApi } from "@/src/lib/ipc"
import { PlanDialog } from "@/src/components/plan-dialog"

export function PlanViewer({ sessionId }: { sessionId: string }) {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
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

  useEffect(() => { load() }, [])

  const checkboxCount = content
    ? [...content.matchAll(/\[(\s|x)\]/gi)].length
    : 0
  const checkedCount = content
    ? [...content.matchAll(/\[x\]/gi)].length
    : 0

  return (
    <>
      <Collapsible defaultOpen>
        <Card className="shadow-none border-sidebar-border">
          <CardHeader className="flex flex-row items-center justify-between gap-2 py-2.5 px-3">
            <div className="flex items-center gap-2 min-w-0">
              <CardTitle className="text-sm font-medium truncate flex items-center gap-1.5">
                <FileTextIcon className="size-4 shrink-0" />
                Plano de implementação
              </CardTitle>
              {checkboxCount > 0 && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {checkedCount}/{checkboxCount}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="size-7" onClick={load} disabled={loading} title="Recarregar">
                <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
              </Button>
              <Button variant="ghost" size="icon" className="size-7" onClick={() => setDialogOpen(true)} title="Expandir">
                <ExternalLinkIcon className="size-3.5" />
              </Button>
              <CollapsibleTrigger render={
                <Button variant="ghost" size="icon" className="size-7" title="Expandir/recolher">
                  <ChevronsUpDownIcon className="size-3.5" />
                </Button>
              } />
            </div>
          </CardHeader>
          <CollapsibleContent render={
            <CardContent className="px-3 pb-3 pt-0 max-h-96 overflow-y-auto text-sm">
              {loading ? (
                <p className="text-xs text-muted-foreground animate-pulse">Carregando...</p>
              ) : content ? (
                <MessageResponse>{content}</MessageResponse>
              ) : (
                <p className="text-xs text-muted-foreground">PLAN.md não encontrado.</p>
              )}
            </CardContent>
          } />
        </Card>
      </Collapsible>

      <PlanDialog sessionId={sessionId} open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  )
}
