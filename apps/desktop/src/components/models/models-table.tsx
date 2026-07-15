import { useMemo, useState } from "react"
import { ArrowDown, ArrowUp } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { OrbitModel } from "@shared/models"
import { useModelsStore } from "@/src/stores/models-store"
import { formatContext, formatPrice, SPEED_LABELS } from "./meta"
import { ModelCheckbox, ScoreBar } from "./shared"

/** Tabela de exploração de modelos — ordenável, com checkbox de comparação. */

type SortKey = "name" | "coding" | "agentic" | "intelligence" | "speed" | "context" | "price"

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: "name", label: "Modelo", className: "min-w-44" },
  { key: "coding", label: "Coding", className: "w-24" },
  { key: "agentic", label: "Agentic", className: "w-24" },
  { key: "intelligence", label: "Intel.", className: "w-24" },
  { key: "speed", label: "Speed", className: "w-24" },
  { key: "context", label: "Contexto", className: "w-20 text-right" },
  { key: "price", label: "In / Out $1M", className: "w-28 text-right" },
]

function sortValue(model: OrbitModel, key: SortKey): number | string {
  switch (key) {
    case "name":
      return model.name.toLowerCase()
    case "context":
      return model.contextWindow
    case "price":
      return (3 * model.pricing.input + model.pricing.output) / 4
    default:
      return model.scores[key] ?? -1
  }
}

export function ModelsTable({ models }: { models: OrbitModel[] }) {
  const selected = useModelsStore((s) => s.selected)
  const toggleSelected = useModelsStore((s) => s.toggleSelected)
  const setDetailId = useModelsStore((s) => s.setDetailId)
  const [sortKey, setSortKey] = useState<SortKey>("intelligence")
  const [sortAsc, setSortAsc] = useState(false)

  const sorted = useMemo(() => {
    const copy = [...models]
    copy.sort((a, b) => {
      const va = sortValue(a, sortKey)
      const vb = sortValue(b, sortKey)
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number)
      return sortAsc ? cmp : -cmp
    })
    return copy
  }, [models, sortKey, sortAsc])

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc((prev) => !prev)
    else {
      setSortKey(key)
      setSortAsc(key === "name")
    }
  }

  if (models.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Nenhum modelo corresponde à busca ou aos filtros.
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead className="sticky top-0 z-10">
          <tr className="bg-background/95 backdrop-blur">
            <th className="w-8 border-b p-2" />
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                className={cn(
                  "cursor-pointer select-none border-b p-2 text-left font-medium text-muted-foreground hover:text-foreground",
                  col.className,
                )}
                onClick={() => handleSort(col.key)}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {sortKey === col.key &&
                    (sortAsc ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((model) => (
            <tr
              key={model.id}
              className="cursor-pointer transition-colors hover:bg-muted/50"
              onClick={() => setDetailId(model.id)}
            >
              <td className="border-b p-2">
                <ModelCheckbox
                  checked={selected.includes(model.id)}
                  onToggle={() => toggleSelected(model.id)}
                />
              </td>
              <td className="border-b p-2">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{model.name}</span>
                  <span className="flex items-center gap-1.5 truncate text-[10px] text-muted-foreground">
                    {model.providerName}
                    {model.speedTier === "deep" && (
                      <Badge variant="secondary" className="h-3.5 px-1 text-[9px]">
                        {SPEED_LABELS.deep}
                      </Badge>
                    )}
                  </span>
                </div>
              </td>
              <td className="border-b p-2"><ScoreBar score={model.scores.coding} /></td>
              <td className="border-b p-2"><ScoreBar score={model.scores.agentic} /></td>
              <td className="border-b p-2"><ScoreBar score={model.scores.intelligence} /></td>
              <td className="border-b p-2"><ScoreBar score={model.scores.speed} /></td>
              <td className="border-b p-2 text-right tabular-nums">{formatContext(model.contextWindow)}</td>
              <td className="border-b p-2 text-right tabular-nums text-muted-foreground">
                {formatPrice(model.pricing.input)} / {formatPrice(model.pricing.output)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
