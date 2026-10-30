import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useProcessStore } from "@/src/stores/process-store"

import { Hint } from "@/components/ui/hint"
/**
 * Development servers running in the current chat, on the start screen of the
 * panel browser.
 *
 * The URL is not guessed: it comes from what the command itself announced in the output
 * (`npm run dev` → "Local: http://localhost:5173"), extracted in the main process by
 * extractLocalUrls. A click calls `onSelect` with the URL — whoever navigates is the
 * owner of the browser, without this component depending on the WebPreview context.
 */
export function RunningServers({ sessionId, onSelect }: { sessionId?: string; onSelect: (url: string) => void }) {
  const { t } = useTranslation()
  const processes = useProcessStore((s) => s.processes)
  const fetchProcesses = useProcessStore((s) => s.fetch)

  useEffect(() => {
    void fetchProcesses(sessionId)
    const interval = setInterval(() => void fetchProcesses(sessionId), 3_000)
    return () => clearInterval(interval)
  }, [fetchProcesses, sessionId])

  const servers: { url: string; label: string }[] = []
  const seen = new Set<string>()
  for (const process of processes) {
    if (process.status !== "running") continue
    for (const url of process.urls ?? []) {
      if (seen.has(url)) continue
      seen.add(url)
      servers.push({ url, label: process.label })
    }
  }

  if (servers.length === 0) return null

  return (
    <div className="mt-1 w-full max-w-xs text-left">
      <p className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">
        {t("panel.processes.serversTitle")}
      </p>
      <div className="flex flex-col gap-1">
        {servers.map((server) => (
          <Hint label={server.url}>
            <button
              key={server.url}
              onClick={() => onSelect(server.url)}
              className="flex min-w-0 items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/40 px-2.5 py-1.5 text-left transition-colors hover:bg-sidebar-accent"
            >
       
               <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{server.label}</span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{server.url.replace(/^https?:\/\//, "")}</span>
          </button>
          </Hint>
        ))}
      </div>
    </div>
  )
}
