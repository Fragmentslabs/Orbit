import { useTranslation } from "react-i18next"

/**
 * Cards at the top of the right column: how many memories are in view and how they split by
 * kind — the same shape as the Routines summary, so both pages read the same way.
 */

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="min-w-0 rounded-[9px] border bg-card px-2 py-1.5" title={hint}>
      <div className="truncate text-[9px] leading-tight text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-[13px] font-semibold leading-tight tabular-nums">{value}</div>
    </div>
  )
}

export function MemorySummary({ total, project, proposals, general }: {
  total: number
  project: number
  proposals: number
  general: number
}) {
  const { t } = useTranslation()
  return (
    <div className="grid grid-cols-2 gap-1.5">
      <Stat label={t("memories.summary.total")} hint={t("memories.summary.hints.total")} value={total} />
      <Stat label={t("memories.summary.project")} hint={t("memories.summary.hints.project")} value={project} />
      <Stat label={t("memories.summary.proposals")} hint={t("memories.summary.hints.proposals")} value={proposals} />
      <Stat label={t("memories.summary.general")} hint={t("memories.summary.hints.general")} value={general} />
    </div>
  )
}
