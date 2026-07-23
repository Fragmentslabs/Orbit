import { useEffect, useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Clock, Hash, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatCost, formatTokens } from "@/src/lib/format";
import { useAnalyticsStore } from "@/src/stores/analytics-store";
import { ModelSelectorLogo } from "@/src/components/ai/model-selector";
import { ActivityHeatmap } from "@/src/components/activity-heatmap";
import type { AnalyticsRange, AnalyticsSummary } from "@shared/analytics";

const RANGE_LABELS: Record<AnalyticsRange, string> = {
  total: "Total",
  "30d": "30d",
  "7d": "7d",
  today: "Hoje",
};

const RANGE_ORDER: AnalyticsRange[] = ["total", "30d", "7d", "today"];

function ModelBarChart({ data }: { data: AnalyticsSummary }) {
  const [chartMode, setChartMode] = useState<"tokens" | "hours">("tokens")

  const chartData = useMemo(() => {
    const vals = data.byModel.map((m) =>
      chartMode === "tokens" ? m.tokens : m.hours,
    )
    const maxVal = Math.max(...vals, 1)
    return data.byModel.map((m) => {
      const raw = chartMode === "tokens" ? m.tokens : m.hours
      return {
        key: `${m.providerId}/${m.modelId}`,
        label: m.modelId,
        providerId: m.providerId,
        value: chartMode === "tokens" ? raw : Math.round(raw * 100) / 100,
        tokens: m.tokens,
        hours: Math.round(m.hours * 100) / 100,
        cost: m.cost,
        opacity: 0.25 + (raw / maxVal) * 0.7,
      }
    })
  }, [data, chartMode])

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed p-8 text-xs text-muted-foreground">
        Nenhum dado de uso disponível.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">
          Uso por modelo
        </p>
        <div className="flex gap-1">
          <button
            type="button"
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] transition-colors",
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
              "rounded px-1.5 py-0.5 text-[10px] transition-colors",
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
      <ResponsiveContainer width="100%" height={180}>
        <BarChart
          data={chartData}
          margin={{ top: 5, right: 5, left: -10, bottom: 5 }}
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
            width={45}
            tickFormatter={(v) =>
              chartMode === "tokens" ? formatTokens(v) : `${v}h`
            }
          />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted))", opacity: 0.3 }}
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null;
              const d = payload[0].payload as (typeof chartData)[number];
              const val = chartMode === "tokens"
                ? formatTokens(d.value)
                : `${d.value}h`
              return (
                <div className="w-max min-w-[200px] rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
                  <p className="mb-1 flex items-center gap-1.5 font-medium">
                    <ModelSelectorLogo
                      provider={d.providerId}
                      className="size-3.5"
                    />
                    {d.label}
                  </p>
                  <div className="flex items-center justify-between gap-4 text-muted-foreground">
                    <span>{chartMode === "tokens" ? "Tokens" : "Horas"}:</span>
                    <span className="font-medium text-foreground">{val}</span>
                  </div>
                  <div className="flex items-center justify-between gap-4 text-muted-foreground">
                    <span>Tokens totais:</span>
                    <span className="tabular-nums text-foreground">{formatTokens(d.tokens)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-4 text-muted-foreground">
                    <span>Horas:</span>
                    <span className="tabular-nums text-foreground">{d.hours}h</span>
                  </div>
                  <div className="flex items-center justify-between gap-4 text-muted-foreground">
                    <span>Custo:</span>
                    <span className="tabular-nums text-foreground">{d.cost > 0 ? formatCost(d.cost) : "—"}</span>
                  </div>
                </div>
              );
            }}
          />
          <Bar
            dataKey="value"
            radius={[4, 4, 0, 0]}
            maxBarSize={36}
          >
            {chartData.map((entry) => (
              <Cell
                key={entry.key}
                fill={`oklch(from var(--primary) l c h / ${entry.opacity})`}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {chartData.map((entry) => (
          <div
            key={entry.key}
            className="flex items-center gap-1 text-[10px]"
          >
            <ModelSelectorLogo
              provider={entry.providerId}
              className="size-2.5"
            />
            <span className="font-medium text-foreground">{entry.label}</span>
            <span className="text-muted-foreground">
              {chartMode === "tokens"
                ? formatTokens(entry.tokens)
                : `${entry.hours}h`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatsGrid({ data }: { data: AnalyticsSummary }) {
  const stats = useMemo(
    () => [
      { label: "Sessões", value: data.totalSessions },
      { label: "Mensagens", value: data.totalMessages },
      { label: "Dias ativos", value: data.activeDays },
      { label: "Sequência atual", value: `${data.currentStreak} dias` },
      { label: "Maior sequência", value: `${data.longestStreak} dias` },
      {
        label: "Horário de pico",
        value: `${String(data.peakHour).padStart(2, "0")}h`,
      },
    ],
    [data],
  );

  return (
    <div className="grid grid-cols-2 gap-1.5">
      {stats.map((s) => (
        <div
          key={s.label}
          className="flex items-center gap-2 rounded-lg border px-2.5 py-2"
        >
          <div className="min-w-0">
            <p className="text-[10px] text-muted-foreground">{s.label}</p>
            <p className="truncate text-xs font-medium tabular-nums">
              {s.value}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function LimitsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [tokenLimit, setTokenLimit] = useState("");
  const [costLimit, setCostLimit] = useState("");

  const save = async () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Limites de uso</DialogTitle>
          <DialogDescription>
            Defina limites mensais para controlar o consumo.
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
            <p className="mb-1 text-xs font-medium">
              Limite mensal de gasto (USD)
            </p>
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void save()}>Salvar</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AnalyticsPanel() {
  const { data, range, loading, load, setRange } = useAnalyticsStore();
  const [limitsOpen, setLimitsOpen] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full min-w-0 flex-col gap-3 overflow-y-auto overflow-x-hidden pr-1">
      {/* Top bar: title (left) ─ toggle (center, separated) ─ limits (right) */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold shrink-0">Uso do Orbit</p>
        <div className="flex gap-2">
          <SegmentedControl
          options={RANGE_ORDER.map((r) => ({
            value: r,
            label: RANGE_LABELS[r],
          }))}
          value={range}
          onChange={(v) => setRange(v as AnalyticsRange)}
          size="xs"
        />
        <Button
          size="sm"
          variant="outline"
          className="gap-1 shrink-0 h-7 px-2"
          onClick={() => setLimitsOpen(true)}
        >
          <Zap className="size-3" />
          <span className="text-[11px]">Limites</span>
        </Button>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
          Carregando...
        </div>
      ) : data ? (
        <>
          <div className="w-full flex justify-between">
            {/* Stats grid (left side) */}
            <StatsGrid data={data} />

            <div className="flex flex-col gap-4">
              {/* Heatmap (full width, no card wrapper) */}
              <ActivityHeatmap days={data.days} />

              {/* Totals */}
              <div className="flex justify-end gap-3 text-xs">
                <div className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5">
                  <Hash className="size-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">Tokens:</span>
                  <span className="font-medium tabular-nums text-foreground">
                    {formatTokens(data.totalTokens)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5">
                  <Clock className="size-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">Horas:</span>
                  <span className="font-medium tabular-nums text-foreground">
                    {data.totalHours.toFixed(1)}h
                  </span>
                </div>
                <div className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5">
                  <span className="font-medium tabular-nums text-foreground">
                    {formatCost(data.totalCost)}
                  </span>
                  <span className="text-muted-foreground">gasto</span>
                </div>
              </div>
            </div>
          </div>
          
          {/* Full-width bar chart */}
          <div className="rounded-lg border p-3">
            <ModelBarChart data={data} />
          </div>

        </>
      ) : null}

      <LimitsDialog open={limitsOpen} onOpenChange={setLimitsOpen} />
    </div>
  );
}
