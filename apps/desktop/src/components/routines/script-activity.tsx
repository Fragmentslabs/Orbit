import { useTranslation } from "react-i18next"
import { TriangleAlertIcon } from "lucide-react"
import { SCRIPT_FAILING_AFTER, type ScriptActivity } from "@shared/routines"
import { cn } from "@/lib/utils"
import { formatWhen } from "@/src/lib/format"

/** The newest checks drawn as a strip. */
const STRIP = 48

/**
 * What a script-triggered routine has been doing: a strip of the recent checks (green = ran,
 * red = failed, amber = it woke the routine), the counts, and the last error when it is failing.
 * Nothing here costs tokens — only a fire starts the agent.
 */
export function ScriptActivityCard({ activity }: { activity: ScriptActivity | undefined }) {
  const { t, i18n } = useTranslation()
  const checks = activity?.checks ?? []
  const fires = checks.reduce((sum, c) => sum + c.fired, 0)
  const lastError = [...checks].reverse().find((c) => !c.ok)?.error
  const failing = (activity?.failures ?? 0) >= SCRIPT_FAILING_AFTER
  const last = checks[checks.length - 1]
  const recent = checks.slice(-STRIP)

  return (
    <div className="space-y-2 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-[13px] font-semibold">{t("routines.scripts.checks")}</p>
        <span className="text-[11px] text-muted-foreground">
          {t("routines.scripts.checksCount", { checks: checks.length, fires })}
        </span>
      </div>
      {recent.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("routines.scripts.noChecks")}</p>
      ) : (
        <div className="flex h-6 items-stretch gap-px" aria-hidden>
          {recent.map((c) => (
            <span
              key={c.at}
              title={formatWhen(c.at, i18n.language)}
              className={cn("flex-1 rounded-[2px]", !c.ok ? "bg-destructive/70" : c.fired > 0 ? "bg-amber-400" : "bg-emerald-400/70")}
            />
          ))}
        </div>
      )}
      {last && (
        <p className="text-[11px] text-muted-foreground">
          {t("routines.scripts.lastCheck", { when: formatWhen(last.at, i18n.language) })}
        </p>
      )}
      {failing && (
        <p className="flex items-start gap-1.5 text-[11px] text-destructive">
          <TriangleAlertIcon className="mt-px size-3 shrink-0" />
          {t("routines.scripts.failing", { error: lastError ?? "" })}
        </p>
      )}
      <p className="border-t pt-2 text-[11px] text-muted-foreground">{t("routines.scripts.onlyWhileOpen")}</p>
    </div>
  )
}
