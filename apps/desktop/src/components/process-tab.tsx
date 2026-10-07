import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Globe, Trash2 } from "lucide-react"
import { processApi, type ProcessInfo } from "@/src/lib/ipc"
import { useProcessStore } from "@/src/stores/process-store"
import { usePanelStore, ORPHAN_KEY } from "@/src/stores/panel-store"
import { cn } from "@/lib/utils"

/**
 * Aba de um processo em background (bash_background / foreground promovido):
 * mostra o stdout/stderr ao vivo, permite encerrar e abrir no browser a URL
 * que o próprio comando anunciou (ex.: `npm run dev` → http://localhost:5173).
 *
 * Substitui o antigo dialog de saída: como aba, a saída ganha o espaço todo do
 * painel, sobrevive à troca de abas do chat e o processo deixa de ser um card
 * solto no rodapé.
 */
export function ProcessTab({ pid, sessionId }: { pid: number; sessionId?: string }) {
  const { t } = useTranslation()
  const [output, setOutput] = useState("")
  // O processo pode sumir da lista (encerrado pela lixeira, fim do comando):
  // guardamos o último registro visto para o cabeçalho não ficar vazio.
  const [snapshot, setSnapshot] = useState<ProcessInfo | undefined>(undefined)
  const [pinned, setPinned] = useState(true)
  const preRef = useRef<HTMLPreElement>(null)

  const info = useProcessStore((s) => s.processes.find((p) => p.pid === pid))
  const fetchProcesses = useProcessStore((s) => s.fetch)

  useEffect(() => {
    if (info) setSnapshot(info)
  }, [info])

  // Mesma fonte do rodapé: mantém status e URLs anunciadas atualizados.
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

  // Auto-scroll só enquanto o usuário está no fim: rolar para cima para ler um
  // log não pode ser desfeito pelo próximo chunk.
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
      <div className="flex items-center gap-2 border-b border-sidebar-border px-3 py-2">
        {running ? (
          <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
        ) : (
          <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
        )}
        <span className="min-w-0 truncate text-xs font-medium text-foreground">
          {current?.label ?? t("panel.tabs.process.label")}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">PID {pid}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {url && (
            <button
              onClick={() => usePanelStore.getState().openTerminalLink(sessionId ?? ORPHAN_KEY, url)}
              title={`${t("panel.processes.openInBrowser")} — ${url}`}
              className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            >
              <Globe className="size-3" />
              {t("panel.processes.openInBrowser")}
            </button>
          )}
          {running && (
            <button
              onClick={() => void useProcessStore.getState().kill(pid, sessionId)}
              title={t("panel.processes.kill")}
              className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-accent hover:text-destructive"
            >
              <Trash2 className="size-3" />
            </button>
          )}
        </div>
      </div>
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
