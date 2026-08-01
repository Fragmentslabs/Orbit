import { useEffect, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw, Search, Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { filterModels, hasActiveFilters, useModelsStore } from "@/src/stores/models-store"
import { AAKeyButton } from "./aa-key-dialog"
import { BestForSection } from "./best-for"
import { CompareDialog, CompareFloatingCard } from "./compare"
import { ModelDetailPanel } from "./model-detail-panel"
import { ModelFiltersRow } from "./model-filters"
import { ModelsTable } from "./models-table"

/**
 * Aba Models: exploração do catálogo unificado (OpenRouter + Artificial
 * Analysis + models.dev) com busca, filtros, rankings Best For, comparação
 * e painel de detalhe.
 */

export function ModelsView() {
  const { t } = useTranslation()
  const initialize = useModelsStore((s) => s.initialize)
  const refresh = useModelsStore((s) => s.refresh)
  const snapshot = useModelsStore((s) => s.snapshot)
  const loading = useModelsStore((s) => s.loading)
  const search = useModelsStore((s) => s.search)
  const setSearch = useModelsStore((s) => s.setSearch)
  const filters = useModelsStore((s) => s.filters)

  useEffect(() => {
    void initialize()
  }, [initialize])

  const models = snapshot?.models ?? null
  const filtered = useMemo(
    () => (models ? filterModels(models, search, filters) : []),
    [models, search, filters],
  )
  const exploring = Boolean(search.trim()) || hasActiveFilters(filters)

  if (!models) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <RefreshCw className="size-4 animate-spin" />
        {t("models.loadingCatalog")}
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-w-0 flex-col gap-3 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder={t("models.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t("models.refreshCatalog")}
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
        </Button>
      </div>

      <ModelFiltersRow models={models} />

      {/* Orbit Intelligence — some quando o usuário está buscando/filtrando */}
      {!exploring && (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Sparkles className="size-3.5" />
            {t("models.bestForTitle")}
          </div>
          <BestForSection models={models} />
        </div>
      )}

      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          {t("models.count", { count: filtered.length, total: models.length })}
        </span>
        <AAKeyButton />
      </div>

      <ModelsTable models={filtered} />

      <CompareFloatingCard />
      <CompareDialog />
      <ModelDetailPanel />
    </div>
  )
}
