import { useMemo, useState } from "react"
import { GitCompareArrows, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { cn } from "@/lib/utils"
import type { ModelBenchmarks, OrbitModel } from "@shared/models"
import { useModelsStore } from "@/src/stores/models-store"
import { formatContext, formatPrice, SCORE_CATEGORIES } from "./meta"

/**
 * Sistema de comparação: card flutuante que aparece ao selecionar modelos na
 * tabela e dialog com barras por categoria (Simplified) ou benchmarks crus
 * (Technical: SWE-Bench, GPQA, HLE, TTFT, tokens/s…).
 */

/** Cores por posição para distinguir os modelos nas barras empilhadas */
const MODEL_COLORS = ["bg-sky-500", "bg-violet-500", "bg-emerald-500", "bg-amber-500"]

export function CompareFloatingCard() {
  const selected = useModelsStore((s) => s.selected)
  const clearSelected = useModelsStore((s) => s.clearSelected)
  const setCompareOpen = useModelsStore((s) => s.setCompareOpen)

  if (selected.length === 0) return null

  return (
    <div className="absolute bottom-4 right-4 z-20 flex items-center gap-1 rounded-lg border bg-popover/80 p-1.5 shadow-lg backdrop-blur-xl">
      <Button
        size="sm"
        className="h-7 gap-1.5 text-xs"
        disabled={selected.length < 2}
        onClick={() => setCompareOpen(true)}
      >
        <GitCompareArrows className="size-3.5" />
        {selected.length < 2
          ? `${selected.length} modelo selecionado`
          : `Comparing ${selected.length} Models`}
      </Button>
      <Button variant="ghost" size="icon-sm" className="size-7" onClick={clearSelected}>
        <X className="size-3.5" />
        <span className="sr-only">Limpar seleção</span>
      </Button>
    </div>
  )
}

const TECHNICAL_ROWS: { key: keyof ModelBenchmarks; label: string; unit: "percent" | "index" | "seconds" | "tps" }[] = [
  { key: "swebench", label: "SWE-Bench", unit: "percent" },
  { key: "livecodebench", label: "LiveCodeBench", unit: "percent" },
  { key: "gpqa", label: "GPQA", unit: "percent" },
  { key: "hle", label: "Humanity's Last Exam", unit: "percent" },
  { key: "mmluPro", label: "MMLU-Pro", unit: "percent" },
  { key: "intelligenceIndex", label: "AA Intelligence Index", unit: "index" },
  { key: "codingIndex", label: "AA Coding Index", unit: "index" },
  { key: "agenticIndex", label: "AA Agentic Index", unit: "index" },
  { key: "ttft", label: "TTFT", unit: "seconds" },
  { key: "tokensPerSecond", label: "Tokens/s", unit: "tps" },
]

function formatBenchmark(value: number | undefined, unit: "percent" | "index" | "seconds" | "tps"): string {
  if (value === undefined) return "—"
  switch (unit) {
    case "percent": {
      // A AA reporta benchmarks como fração 0-1
      const pct = value <= 1 ? value * 100 : value
      return `${pct.toFixed(1)}%`
    }
    case "index":
      return value.toFixed(1)
    case "seconds":
      return `${value.toFixed(2)}s`
    case "tps":
      return value.toFixed(0)
  }
}

export function CompareDialog() {
  const snapshot = useModelsStore((s) => s.snapshot)
  const selected = useModelsStore((s) => s.selected)
  const compareOpen = useModelsStore((s) => s.compareOpen)
  const setCompareOpen = useModelsStore((s) => s.setCompareOpen)
  const [view, setView] = useState<"simplified" | "technical">("simplified")

  const models = useMemo(() => {
    const byId = new Map((snapshot?.models ?? []).map((m) => [m.id, m]))
    return selected.map((id) => byId.get(id)).filter((m): m is OrbitModel => m != null)
  }, [snapshot, selected])

  if (models.length < 2) return null

  return (
    <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 pr-8 text-sm">
            {models.map((model, i) => (
              <span key={model.id} className="flex items-center gap-2">
                {i > 0 && <span className="text-[10px] font-normal text-muted-foreground">VS</span>}
                <span className="flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-full", MODEL_COLORS[i % MODEL_COLORS.length])} />
                  {model.name}
                </span>
              </span>
            ))}
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between">
          <SegmentedControl
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "simplified", label: "Simplified" },
              { value: "technical", label: "Technical" },
            ]}
          />
        </div>

        {view === "simplified" ? (
          <div className="space-y-4">
            {SCORE_CATEGORIES.map((cat) => (
              <div key={cat.key}>
                <div className="mb-1.5 text-xs font-medium">{cat.label}</div>
                <div className="space-y-1">
                  {models.map((model, i) => {
                    const score = model.scores[cat.key]
                    return (
                      <div key={model.id} className="flex items-center gap-2">
                        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                          {score !== undefined && (
                            <div
                              className={cn("h-full rounded-full", MODEL_COLORS[i % MODEL_COLORS.length])}
                              style={{ width: `${score}%` }}
                            />
                          )}
                        </div>
                        <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                          {score ?? "—"}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
            <div>
              <div className="mb-1.5 text-xs font-medium">Cost</div>
              <div className="space-y-1">
                {models.map((model, i) => (
                  <div key={model.id} className="flex items-center gap-2 text-xs">
                    <span className={cn("size-2 shrink-0 rounded-full", MODEL_COLORS[i % MODEL_COLORS.length])} />
                    <span className="truncate text-muted-foreground">{model.name}</span>
                    <span className="ml-auto shrink-0 tabular-nums">
                      {formatPrice(model.pricing.input)} in · {formatPrice(model.pricing.output)} out
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="p-1.5 text-left font-medium text-muted-foreground">Benchmark</th>
                  {models.map((model, i) => (
                    <th key={model.id} className="p-1.5 text-right font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={cn("size-2 rounded-full", MODEL_COLORS[i % MODEL_COLORS.length])} />
                        <span className="max-w-28 truncate">{model.name}</span>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {TECHNICAL_ROWS.filter((row) => models.some((m) => m.benchmarks[row.key] !== undefined)).map((row) => (
                  <tr key={row.key} className="border-t">
                    <td className="p-1.5 text-muted-foreground">{row.label}</td>
                    {models.map((model) => (
                      <td key={model.id} className="p-1.5 text-right tabular-nums">
                        {formatBenchmark(model.benchmarks[row.key], row.unit)}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="border-t">
                  <td className="p-1.5 text-muted-foreground">Contexto</td>
                  {models.map((model) => (
                    <td key={model.id} className="p-1.5 text-right tabular-nums">
                      {formatContext(model.contextWindow)}
                    </td>
                  ))}
                </tr>
                <tr className="border-t">
                  <td className="p-1.5 text-muted-foreground">Preço (in/out $1M)</td>
                  {models.map((model) => (
                    <td key={model.id} className="p-1.5 text-right tabular-nums">
                      {formatPrice(model.pricing.input)} / {formatPrice(model.pricing.output)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
