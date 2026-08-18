import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronRightIcon, GlobeIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Shimmer } from "@/src/components/ai/shimmer"
import { AGENT_BROWSER_FRESH_MS, usePanelStore } from "@/src/stores/panel-store"

/**
 * Indicador "testando…" do browser do agente: aparece na conversa enquanto o
 * agente do chat está usando o browser (em segundo plano, com o painel
 * fechado). Clique abre o browser do agente no painel lateral.
 */

/** URL curta para exibir: host + caminho (sem protocolo/query), truncada. */
function shortUrl(url: string): string {
  if (!url) return ""
  try {
    const u = new URL(url)
    return u.host + (u.pathname && u.pathname !== "/" ? u.pathname : "")
  } catch {
    return url.replace(/^https?:\/\//, "")
  }
}

export function BrowserTestChip({ sessionId, className, compact }: { sessionId?: string; className?: string; compact?: boolean }) {
  const { t } = useTranslation()
  const entry = usePanelStore((s) => (sessionId ? s.agentBrowser[sessionId] : undefined))
  const [, setTick] = useState(0)

  // Tic a cada 2s para o indicador sumir sozinho quando a atividade expira.
  useEffect(() => {
    if (!entry) return
    const timer = setInterval(() => setTick((v) => v + 1), 2_000)
    return () => clearInterval(timer)
  }, [entry])

  if (!sessionId || !entry) return null
  if (Date.now() - entry.at > AGENT_BROWSER_FRESH_MS) return null

  // No compact o texto pode estar escondido (header estreito): o title carrega
  // o estado junto, senão sobra um globo sem explicação.
  const label = compact
    ? [`${t("chat.browser.testing")} — ${t("chat.browser.viewAgentBrowser")}`, entry.url].filter(Boolean).join(" — ")
    : t("chat.browser.viewAgentBrowser")

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={() => usePanelStore.getState().openAgentBrowser(sessionId)}
      className={cn(
        "group inline-flex max-w-full items-center gap-1.5 self-start rounded-full border border-emerald-500/30 bg-background/90 px-2.5 py-1 text-[11px] font-medium text-emerald-600 shadow-sm backdrop-blur transition-colors hover:bg-emerald-500/10 dark:text-emerald-400",
        className,
      )}
    >
      <GlobeIcon className="size-3.5 shrink-0" />
      {/* Header estreito (sidebar + painel abertos): só o globo, com o texto
          no title. O @lg mede o container do header, não o viewport. */}
      <Shimmer className={cn(compact && "hidden @lg:inline-block")}>{t("chat.browser.testing")}</Shimmer>
      {!compact && entry.url && <span className="max-w-40 truncate font-mono text-emerald-600/70 dark:text-emerald-400/70">{shortUrl(entry.url)}</span>}
      {!compact && <ChevronRightIcon className="size-3.5 shrink-0 text-emerald-600/50 transition-transform group-hover:translate-x-0.5 dark:text-emerald-400/50" />}
    </button>
  )
}
