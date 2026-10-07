import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useProcessStore } from "@/src/stores/process-store"
import { useWebPreview } from "@/src/components/ai/web-preview"

/**
 * Servidores de desenvolvimento rodando no chat atual, na tela inicial do
 * browser do painel.
 *
 * A URL não é adivinhada: sai do que o próprio comando anunciou no output
 * (`npm run dev` → "Local: http://localhost:5173"), extraído no main por
 * extractLocalUrls. Um clique navega o webview da aba para lá.
 */
export function RunningServers({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation()
  const { setUrl } = useWebPreview()
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
          <button
            key={server.url}
            onClick={() => setUrl(server.url)}
            title={server.url}
            className="flex min-w-0 items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/40 px-2.5 py-1.5 text-left transition-colors hover:bg-sidebar-accent"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{server.label}</span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{server.url.replace(/^https?:\/\//, "")}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
