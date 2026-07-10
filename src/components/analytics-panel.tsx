import { useEffect, useMemo, useState } from "react"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts"
import { CalendarDays, Clock, GanttChartSquare, Hash, MessageSquare, Sparkles, Timer, TrendingUp, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { formatTokens } from "@/src/lib/format"
import { useAnalyticsStore } from "@/src/stores/analytics-store"
import { ModelSelectorLogo } from "@/src/components/ai/model-selector"
import { ActivityHeatmap } from "@/src/components/activity-heatmap"
import type { AnalyticsRange, AnalyticsSummary } from "@/shared/analytics"

const RANGE_LABELS: Record<AnalyticsRange, string> = {
  total: "Total",
  "30d": "30 dias",
  "7d": "7 dias",
  today: "Hoje",
}

const RANGE_ORDER: AnalyticsRange[] = ["total", "30d", "7d", "today"]

function ModelBarChart({ data }: { data: AnalyticsSummary }) {
  const [hoveredModel, setHoveredModel] = useState<string | null>(null)
  const [chartMode, setChartMode] = useState<"tokens" | "hours">("tokens")

  const chartData = useMemo(() => {
    return data.byModel.map((m) => ({
      key: `${m.providerId}/${m.modelId}`,
      label: m.modelId,
      providerId: m.providerId,
      value: chartMode === "tokens" ? m.tokens : Math.round(m.hours * 100) / 100,
      tokens: m.tokens,
      hours: Math.round(m.hours * 100) / 100,
    }))
  }, [data, chartMode])

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed p-8 text-xs text-muted-foreground">
        Nenhum dado de uso disponível.
      </div>
    )
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">Uso por modelo</p>
        <div className="flex gap-1">
          <button
            type="button"
            className={cn(
              "rounded px-2 py-0.5 text-[11px] transition-colors",
              chartMode === "tokens"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setChartMode("tokens")}
          >
            Tokens
          </button>
          <button
            type="button"
            className={cn(
              "rounded px-2 py-0.5 text-[11px] transition-colors",
              chartMode === "hours"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setChartMode("hours")}
          >
            Horas
          </button>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart
          data={chartData}
          margin={{ top: 5, right: 5, left: -10, bottom: 5 }}
          onMouseLeave={() => setHoveredModel(null)}
        >
          <XAxis
            dataKey="label"
            tick={false}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
            width={50}
            tickFormatter={(v) => (chartMode === "tokens" ? formatTokens(v) : `${v}h`)}
          />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted))", opacity: 0.3 }}
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null
              const d = payload[0].payload as typeof chartData[number]
              return (
                <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
                  <p className="mb-1 flex items-center gap-1 font-medium">
                    <ModelSelectorLogo provider={d.providerId} className="size-3" />
                    {d.label}
                  </p>
                  <p className="text-muted-foreground">
                    {formatTokens(d.tokens)} tokens · {d.hours}h
                  </p>
                </div>
              )
            }}
          />
          <Bar
            dataKey="value"
            radius={[4, 4, 0, 0]}
            maxBarSize={40}
            onMouseEnter={(d) => setHoveredModel(typeof d.key === "string" ? d.key : null)}
          >
            {chartData.map((entry) => (
              <Cell
                key={entry.key}
                fill={
                  hoveredModel === null || hoveredModel === entry.key
                    ? "hsl(var(--primary))"
                    : "hsl(var(--primary) / 0.25)"
                }
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* Legend */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {chartData.map((entry) => (
          <div
            key={entry.key}
            className={cn(
              "flex items-center gap-1 text-[11px] transition-opacity",
              hoveredModel === null || hoveredModel === entry.key
                ? "opacity-100"
                : "opacity-25",
            )}
            onMouseEnter={() => setHoveredModel(entry.key)}
            onMouseLeave={() => setHoveredModel(null)}
          >
            <ModelSelectorLogo provider={entry.providerId} className="size-3" />
            <span className="font-medium">{entry.label}</span>
            <span className="text-muted-foreground">
              {chartMode === "tokens" ? formatTokens(entry.tokens) : `${entry.hours}h`}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function StatsGrid({ data }: { data: AnalyticsSummary }) {
  const stats = useMemo(
    () => [
      { label: "Sessões", value: data.totalSessions, icon: GanttChartSquare },
      { label: "Mensagens", value: data.totalMessages, icon: MessageSquare },
      { label: "Dias ativos", value: data.activeDays, icon: CalendarDays },
      { label: "Sequência atual", value: `${data.currentStreak} dias`, icon: Timer },
      { label: "Maior sequência", value: `${data.longestStreak} dias`, icon: TrendingUp },
      { label: "Horário de pico", value: `${String(data.peakHour).padStart(2, "0")}h`, icon: Clock },
      {
        label: "Favorito",
        value: data.favoriteModel.modelId,
        icon: Sparkles,
        extra: data.favoriteModel.providerId !== "unknown" ? (
          <ModelSelectorLogo provider={data.favoriteModel.providerId} className="size-3" />
        ) : null,
      },
    ],
    [data],
  )

  return (
    <div className="mt-1 grid grid-cols-4 gap-2">
      {stats.map((s) => {
        const Icon = s.icon
        return (
          <div key={s.label} className="flex items-center gap-2 rounded-lg border p-2.5">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
              <Icon className="size-3.5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] text-muted-foreground">{s.label}</p>
              <p className="flex items-center gap-1 truncate text-sm font-medium tabular-nums">
                {s.extra}
                {s.value}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LimitsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [tokenLimit, setTokenLimit] = useState("")
  const [costLimit, setCostLimit] = useState("")

  const save = async () => {
    console.log("[limits] salvar:", { tokenLimit, costLimit })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Limites de uso</DialogTitle>
          <DialogDescription>
            Defina limites mensais para controlar o consumo. Ainda sem enforcement — apenas
            monitoramento.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <p className="mb-1 text-xs font-medium">Limite mensal de tokens</p>
            <Input
              type="number"
              placeholder="ex: 1000000"
              value={tokenLimit}
              onChange={(e) => setTokenLimit(e.target.value)}
            />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">Limite mensal de gasto (USD)</p>
            <Input
              type="number"
              step="0.01"
              placeholder="ex: 10.00"
              value={costLimit}
              onChange={(e) => setCostLimit(e.target.value)}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={() => void save()}>Salvar</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function AnalyticsPanel() {
  const { data, range, loading, load, setRange } = useAnalyticsStore()
  const [limitsOpen, setLimitsOpen] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">Uso do Orbit</p>
        <Button size="sm" variant="outline" className="gap-1" onClick={() => setLimitsOpen(true)}>
          <Zap className="size-3.5" />
          Adicionar limites
        </Button>
      </div>

      {/* Range toggle */}
      <SegmentedControl
        options={RANGE_ORDER.map((r) => ({ value: r, label: RANGE_LABELS[r] }))}
        value={range}
        onChange={(v) => setRange(v as AnalyticsRange)}
        className="self-start"
      />

      {loading && !data ? (
        <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
          Carregando...
        </div>
      ) : data ? (
        <>
          {/* Summary heatmap + chart side by side */}
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border p-3">
              <p className="mb-2 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <Hash className="size-3.5" />
                Atividade diária
              </p>
              <ActivityHeatmap days={data.days} />
            </div>
            <div className="rounded-lg border p-3">
              <ModelBarChart data={data} />
            </div>
          </div>

          {/* Stats */}
          <StatsGrid data={data} />

          {/* Tokens/hora totals */}
          <div className="flex gap-4 text-xs">
            <div className="flex items-center gap-1.5 rounded-lg border px-3 py-2">
              <Hash className="size-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Total de tokens:</span>
              <span className="font-medium tabular-nums">{formatTokens(data.totalTokens)}</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border px-3 py-2">
              <Clock className="size-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Horas:</span>
              <span className="font-medium tabular-nums">{data.totalHours.toFixed(1)}h</span>
            </div>
          </div>
        </>
      ) : null}

      <LimitsDialog open={limitsOpen} onOpenChange={setLimitsOpen} />
    </div>
  )
}
