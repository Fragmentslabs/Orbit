import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Globe, Terminal, Trash2 } from "lucide-react"
import { IconAction } from "@/src/components/ai/artifact-part"
import { TabHeader } from "@/src/components/tab-header"
import { processApi, type ProcessInfo } from "@/src/lib/ipc"
import { useProcessStore } from "@/src/stores/process-store"
import { usePanelStore, ORPHAN_KEY } from "@/src/stores/panel-store"
import { cn } from "@/lib/utils"

/**
 * Tab of a background process (bash_background / promoted foreground):
 * it shows stdout/stderr live, allows terminating and opening in the browser the URL
 * the command itself announced (e.g. `npm run dev` → http://localhost:5173).
 *
 * It replaces the old output dialog: as a tab, the output gets the whole space of the
 * panel, survives the chat tab switch and the process stops being a loose card
 * in the footer.
 */
export function ProcessTab({ pid, sessionId }: { pid: number; sessionId?: string }) {
  const { t } = useTranslation()
  const [output, setOutput] = useState("")
  // The process may disappear from the list (terminated by the trash, end of the command):
  // we keep the last record seen so the header is not left empty.
  const [snapshot, setSnapshot] = useState<ProcessInfo | undefined>(undefined)
  const [pinned, setPinned] = useState(true)
  const preRef = useRef<HTMLPreElement>(null)

  const info = useProcessStore((s) => s.processes.find((p) => p.pid === pid))
  const fetchProcesses = useProcessStore((s) => s.fetch)

  useEffect(() => {
    if (info) setSnapshot(info)
  }, [info])

  // Same source as the footer: it keeps the status and the announced URLs up to date.
  useEffect(() => {
    void fetchProcesses(sessionId)
    const interval = setInterval(() => void fetchProcesses(sessionId), 3_000)
    return () => clearInterval(interval)
  }, [fetchProcesses, sessionId])

  useEffect(() => {
    let cancelled = false
    const fetchOutput = async () => {
      const text = await processApi.output(pid, sessionId)
      if (!cancelled) setOutput(text)
    }
    void fetchOutput()
    const interval = setInterval(fetchOutput, 1_500)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [pid, sessionId])

  // Auto-scroll only while the user is at the end: scrolling up to read a
  // log cannot be undone by the next chunk.
  useEffect(() => {
    if (!pinned) return
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output, pinned])

  const current = info ?? snapshot
  const running = current?.status === "running"
  const url = running ? current?.urls?.[0] : undefined

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <TabHeader
        icon={Terminal}
        iconClassName={running ? "text-emerald-400" : undefined}
        title={current?.label ?? t("panel.tabs.process.label")}
        tag={t("panel.processes.pid", { pid })}
      >
          {url && (
            <IconAction
              icon={Globe}
              label={`${t("panel.processes.openInBrowser")} — ${url}`}
              onClick={() => usePanelStore.getState().openTerminalLink(sessionId ?? ORPHAN_KEY, url)}
            />
          )}
          {running && (
            <IconAction
              icon={Trash2}
              label={t("panel.processes.kill")}
              onClick={() => void useProcessStore.getState().kill(pid, sessionId)}
            />
          )}
      </TabHeader>
      {current?.command && (
        <div className="border-b border-sidebar-border px-3 py-1.5 font-mono text-[10px] break-all text-muted-foreground">
          {current.command}
        </div>
      )}
      <pre
        ref={preRef}
        onScroll={(e) => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          setPinned((prev) => (prev === atBottom ? prev : atBottom))
        }}
        className={cn(
          "min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs",
          "text-muted-foreground",
        )}
      >
        {output || t("panel.processes.outputEmpty")}
      </pre>
      {current && !running && (
        <div className="border-t border-sidebar-border px-3 py-1.5 text-[10px] text-muted-foreground">
          {t(`panel.processes.status.${current.status}`)}
          {current.exitCode !== undefined ? ` · exit ${current.exitCode}` : ""}
        </div>
      )}
    </div>
  )
}
