import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Cpu, FolderKanban, LayoutDashboard, MessagesSquare, Waves } from "lucide-react"
import { cn } from "@/lib/utils"
import { useStacked } from "@/src/hooks/use-stacked"
import { useAnalyticsStore } from "@/src/stores/analytics-store"
import { ModelsTab } from "./models-tab"
import { OverviewTab } from "./overview-tab"
import { ProjectsTab } from "./projects-tab"
import { RhythmTab } from "./rhythm-tab"
import { SessionsTab } from "./sessions-tab"
import type { UsageSection } from "./usage-utils"

/** Below this width of the page the section menu becomes a row of tabs above the content. */
const STACK_BELOW_PX = 700

/**
 * Usage page: the sections on the right, the same shape as the Tools page. The title and the
 * period live in the page header (App.tsx). The overview is the summary of everything; each
 * other section opens the same numbers in detail (models, projects with their history, every
 * conversation, rhythm).
 */
export function UsageView() {
  const { t } = useTranslation()
  const { data, range, loading, load } = useAnalyticsStore()
  const [section, setSection] = useState<UsageSection>("overview")

  useEffect(() => {
    void load()
  }, [load])

  const nav: { id: UsageSection; label: string; icon: React.ComponentType<{ className?: string }>; count?: number | string }[] = [
    { id: "overview", label: t("usage.nav.overview"), icon: LayoutDashboard },
    { id: "models", label: t("usage.nav.models"), icon: Cpu, count: data?.byModel.length },
    { id: "projects", label: t("usage.nav.projects"), icon: FolderKanban, count: data?.byProject.length },
    { id: "sessions", label: t("usage.nav.sessions"), icon: MessagesSquare, count: data?.totalSessions },
    { id: "rhythm", label: t("usage.nav.rhythm"), icon: Waves },
  ]

  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const stacked = useStacked(root, STACK_BELOW_PX)

  // The sections: a menu on the right when there is room, a row of tabs above the content when
  // the page is narrow (the side panel is open) — the same sections, only laid out to fit.
  const buttons = nav.map(({ id, label, icon: Icon, count }) => (
    <button
      key={id}
      type="button"
      aria-current={section === id ? "page" : undefined}
      onClick={() => setSection(id)}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-3 py-2 text-left font-medium transition-colors",
        stacked ? "shrink-0 whitespace-nowrap text-xs" : "text-sm",
        section === id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className={cn(!stacked && "min-w-0 flex-1 truncate")}>{label}</span>
      {count !== undefined && <span className="text-[11px] font-normal text-muted-foreground">{count}</span>}
    </button>
  ))

  return (
    <div ref={setRoot} className="flex h-full min-w-0 flex-col overflow-hidden">
      {stacked && (
        <nav aria-label={t("usage.nav.label")} className="mb-3 flex shrink-0 gap-1 overflow-x-auto border-b pb-2">
          {buttons}
        </nav>
      )}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* The container of the sections: their grids and tables adapt to ITS width (container queries). */}
        <div className="@container min-w-0 flex-1 overflow-y-auto overflow-x-hidden pr-2">
          <div className="mx-auto w-full max-w-[112rem]">
          {loading && !data ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">{t("analytics.loading")}</div>
          ) : data ? (
            <>
              {section === "overview" && <OverviewTab data={data} onNavigate={setSection} />}
              {section === "models" && <ModelsTab data={data} />}
              {section === "projects" && <ProjectsTab data={data} range={range} />}
              {section === "sessions" && <SessionsTab data={data} />}
              {section === "rhythm" && <RhythmTab data={data} />}
            </>
          ) : null}
          </div>
        </div>

        {!stacked && (
          <nav aria-label={t("usage.nav.label")} className="flex w-60 shrink-0 flex-col gap-0.5 border-l pl-3">
            {buttons}
          </nav>
        )}
      </div>
    </div>
  )
}
