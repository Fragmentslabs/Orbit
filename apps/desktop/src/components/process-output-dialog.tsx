import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { processApi, type ProcessInfo } from "@/src/lib/ipc"

/** Saída (stdout/stderr) de um processo em background, com auto-refresh enquanto ele roda. */
export function ProcessOutputDialog({ process, onOpenChange }: {
  process: ProcessInfo | null
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [output, setOutput] = useState("")
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!process) return
    let cancelled = false
    const fetchOutput = async () => {
      const text = await processApi.output(process.pid, process.sessionId)
      if (!cancelled) setOutput(text)
    }
    void fetchOutput()
    const interval = process.status === "running" ? setInterval(fetchOutput, 1500) : undefined
    return () => {
      cancelled = true
      if (interval) clearInterval(interval)
    }
  }, [process])

  useEffect(() => {
    preRef.current?.scrollTo({ top: preRef.current.scrollHeight })
  }, [output])

  return (
    <Dialog open={!!process} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate">{process?.label}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{process?.command}</DialogDescription>
        </DialogHeader>
        <pre
          ref={preRef}
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground"
        >
          {output || t("panel.processes.outputEmpty")}
        </pre>
      </DialogContent>
    </Dialog>
  )
}
