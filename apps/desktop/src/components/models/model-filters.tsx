import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { OrbitModel } from "@shared/models"
import { hasActiveFilters, useModelsStore, type ContextFilter } from "@/src/stores/models-store"
import { availabilityLabel, CAPABILITY_LABELS, MODALITY_LABELS, PRICE_LABELS, SPEED_LABELS } from "./meta"

/** Linha de filtros da aba Models — dropdowns multi-seleção por dimensão. */

function FilterDropdown({ label, count, children }: {
  label: string
  count: number
  children: React.ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn("h-7 gap-1 text-xs", count > 0 && "border-primary/50 bg-primary/5")}
          />
        }
      >
        {label}
        {count > 0 && (
          <span className="flex size-4 items-center justify-center rounded-full bg-primary text-[9px] text-primary-foreground">
            {count}
          </span>
        )}
        <ChevronDown className="size-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-48 overflow-y-auto">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function MultiFilter({ label, options, values, onToggle }: {
  label: string
  options: { value: string; label: string; hint?: string }[]
  values: string[]
  onToggle: (value: string) => void
}) {
  return (
    <FilterDropdown label={label} count={values.length}>
      {options.map((opt) => (
        <DropdownMenuCheckboxItem
          key={opt.value}
          checked={values.includes(opt.value)}
          onCheckedChange={() => onToggle(opt.value)}
          closeOnClick={false}
        >
          <span className="flex-1 truncate">{opt.label}</span>
          {opt.hint && <span className="text-[10px] text-muted-foreground">{opt.hint}</span>}
        </DropdownMenuCheckboxItem>
      ))}
    </FilterDropdown>
  )
}

const CONTEXT_OPTIONS: { value: ContextFilter; labelKey: string }[] = [
  { value: "any", labelKey: "models.filters.contextAny" },
  { value: "32k", labelKey: "models.filters.context32k" },
  { value: "128k", labelKey: "models.filters.context128k" },
  { value: "1m", labelKey: "models.filters.context1m" },
]

export function ModelFiltersRow({ models }: { models: OrbitModel[] }) {
  const { t } = useTranslation()
  const filters = useModelsStore((s) => s.filters)
  const toggleFilter = useModelsStore((s) => s.toggleFilter)
  const setContext = useModelsStore((s) => s.setContext)
  const clearFilters = useModelsStore((s) => s.clearFilters)

  // Providers e disponibilidade derivados do dataset, ordenados por nº de modelos
  const providerOptions = useMemo(() => {
    const counts = new Map<string, { name: string; count: number }>()
    for (const m of models) {
      const entry = counts.get(m.provider) ?? { name: m.providerName, count: 0 }
      entry.count += 1
      counts.set(m.provider, entry)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 20)
      .map(([value, { name, count }]) => ({ value, label: name, hint: String(count) }))
  }, [models])

  const availabilityOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of models) {
      for (const a of m.availability) counts.set(a, (counts.get(a) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([value, count]) => ({ value, label: availabilityLabel(value), hint: String(count) }))
  }, [models])

  // Contagens por opção — deixam claro quando uma dimensão está sem dados
  // (ex: Speed sem a chave da Artificial Analysis)
  const counts = useMemo(() => {
    const capability = new Map<string, number>()
    const modality = new Map<string, number>()
    const price = new Map<string, number>()
    const speed = new Map<string, number>()
    for (const m of models) {
      for (const tag of m.tags) capability.set(tag, (capability.get(tag) ?? 0) + 1)
      for (const mod of m.modalities) modality.set(mod, (modality.get(mod) ?? 0) + 1)
      price.set(m.priceTier, (price.get(m.priceTier) ?? 0) + 1)
      speed.set(m.speedTier, (speed.get(m.speedTier) ?? 0) + 1)
    }
    return { capability, modality, price, speed }
  }, [models])

  const toOptions = (labels: Record<string, string>, countMap: Map<string, number>, ns: string) =>
    Object.entries(labels).map(([value, label]) => ({
      value,
      label: t(`models.${ns}.${value}`, { defaultValue: label }),
      hint: String(countMap.get(value) ?? 0),
    }))

  const contextLabel = CONTEXT_OPTIONS.find((o) => o.value === filters.context)?.labelKey

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <MultiFilter
        label={t("models.filters.provider")}
        options={providerOptions}
        values={filters.providers}
        onToggle={(v) => toggleFilter("providers", v)}
      />
      <MultiFilter
        label={t("models.filters.capability")}
        options={toOptions(CAPABILITY_LABELS, counts.capability, "capabilities")}
        values={filters.capabilities}
        onToggle={(v) => toggleFilter("capabilities", v)}
      />
      <MultiFilter
        label={t("models.filters.modality")}
        options={toOptions(MODALITY_LABELS, counts.modality, "modalities")}
        values={filters.modalities}
        onToggle={(v) => toggleFilter("modalities", v)}
      />
      <MultiFilter
        label={t("models.filters.price")}
        options={toOptions(PRICE_LABELS, counts.price, "prices")}
        values={filters.prices}
        onToggle={(v) => toggleFilter("prices", v)}
      />
      <MultiFilter
        label={t("models.filters.speed")}
        options={toOptions(SPEED_LABELS, counts.speed, "speeds")}
        values={filters.speeds}
        onToggle={(v) => toggleFilter("speeds", v)}
      />
      <FilterDropdown
        label={filters.context === "any" ? t("models.filters.context") : t("models.filters.contextSelected", { label: t(contextLabel!) })}
        count={filters.context !== "any" ? 1 : 0}
      >
        <DropdownMenuRadioGroup value={filters.context} onValueChange={(v) => setContext(v as ContextFilter)}>
          {CONTEXT_OPTIONS.map((opt) => (
            <DropdownMenuRadioItem key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </FilterDropdown>
      <MultiFilter
        label={t("models.filters.availability")}
        options={availabilityOptions}
        values={filters.availability}
        onToggle={(v) => toggleFilter("availability", v)}
      />
      {hasActiveFilters(filters) && (
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs text-muted-foreground" onClick={clearFilters}>
          <X className="size-3" />
          {t("models.clearFilters")}
        </Button>
      )}
    </div>
  )
}
