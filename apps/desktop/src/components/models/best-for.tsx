import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Bot, Brain, Code2, Eye, Zap } from "lucide-react"

import { cn } from "@/lib/utils"
import type { ModelScores, OrbitModel } from "@shared/models"
import { useModelsStore } from "@/src/stores/models-store"

/**
 * Orbit Intelligence — rankings "Best For": top 3 por categoria, calculado
 * dos scores normalizados do dataset completo (ignora filtros da tabela).
 */

const CATEGORIES: { key: keyof ModelScores; labelKey: string; icon: React.ElementType }[] = [
  { key: "coding", labelKey: "models.bestFor.coding", icon: Code2 },
  { key: "agentic", labelKey: "models.bestFor.agentic", icon: Bot },
  { key: "intelligence", labelKey: "models.bestFor.intelligence", icon: Brain },
  { key: "vision", labelKey: "models.bestFor.vision", icon: Eye },
  { key: "speed", labelKey: "models.bestFor.speed", icon: Zap },
]

function topThree(models: OrbitModel[], key: keyof ModelScores): OrbitModel[] {
  return models
    .filter((m) => m.scores[key] !== undefined)
    .sort((a, b) => (b.scores[key] ?? 0) - (a.scores[key] ?? 0))
    .slice(0, 3)
}

export function BestForSection({ models, className }: { models: OrbitModel[]; className?: string }) {
  const { t } = useTranslation()
  const setDetailId = useModelsStore((s) => s.setDetailId)

  const rankings = useMemo(
    () => CATEGORIES.map((cat) => ({ ...cat, top: topThree(models, cat.key) })).filter((c) => c.top.length > 0),
    [models],
  )

  if (rankings.length === 0) return null

  return (
    <div className={cn("grid gap-2", className)} style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
      {rankings.map((cat) => (
        <div key={cat.key} className="rounded-lg border bg-card p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <cat.icon className="size-3.5" />
            {t(cat.labelKey)}
          </div>
          <ol className="space-y-0.5">
            {cat.top.map((model, i) => (
              <li key={model.id}>
                <button
                  type="button"
                  className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-muted"
                  onClick={() => setDetailId(model.id)}
                >
                  <span className={cn("w-3 shrink-0 tabular-nums text-[10px]", i === 0 ? "text-amber-500" : "text-muted-foreground")}>
                    {i + 1}
                  </span>
                  <span className="truncate">{model.name}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-[10px] text-muted-foreground">
                    {model.scores[cat.key]}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  )
}
