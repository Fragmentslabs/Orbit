import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { CalendarIcon, Clock, Folder, Hash, Zap } from "lucide-react";
import { format } from "date-fns";
import { enUS, ptBR as dfPtBR } from "date-fns/locale";
import type { DateRange } from "react-day-picker";
import { enUS as rdpEnUS, ptBR as rdpPtBR } from "react-day-picker/locale";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import type { AnalyticsRange, AnalyticsSummary, ProjectBreakdown } from "@shared/analytics";

type PresetRange = "total" | "30d" | "7d" | "today";

const RANGE_ORDER: PresetRange[] = ["total", "30d", "7d", "today"];

function useRangeLabels(): Record<PresetRange, string> {
  const { t } = useTranslation();
  return {
    total: t("analytics.ranges.total"),
    "30d": t("analytics.ranges.30d"),
    "7d": t("analytics.ranges.7d"),
    today: t("analytics.ranges.today"),
  };
}

function ModelBarChart({ data }: { data: AnalyticsSummary }) {
  const { t } = useTranslation();
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
        {t("analytics.noData")}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">
          {t("analytics.usageByModel")}
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
            {t("analytics.tokens")}
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
            {t("analytics.hours")}
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
                    <span>{chartMode === "tokens" ? t("analytics.tokens") : t("analytics.hours")}:</span>
                    <span className="font-medium text-foreground">{val}</span>
                  </div>
                  <div className="flex items-center justify-between gap-4 text-muted-foreground">
                    <span>{t("analytics.totalTokens")}:</span>
                    <span className="tabular-nums text-foreground">{formatTokens(d.tokens)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-4 text-muted-foreground">
                    <span>{t("analytics.hours")}:</span>
                    <span className="tabular-nums text-foreground">{d.hours}h</span>
                  </div>
                  <div className="flex items-center justify-between gap-4 text-muted-foreground">
                    <span>{t("analytics.cost")}:</span>
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

function ProjectHoursList({ data }: { data: AnalyticsSummary }) {
  const { t } = useTranslation();
  const projects = useMemo(
    () => [...data.byProject].sort((a, b) => b.hours - a.hours),
    [data],
  );
  const maxHours = Math.max(...projects.map((p) => p.hours), 1);
  const fmtHours = (h: number) => (h >= 100 ? `${Math.round(h)}h` : `${Math.round(h * 10) / 10}h`);

  if (projects.length === 0) return null;

  return (
    <div className="rounded-lg border p-3">
      <p className="mb-3 text-xs font-medium text-muted-foreground">
        {t("analytics.hoursByProject")}
      </p>
      <div className="flex flex-col gap-2">
        {projects.map((p: ProjectBreakdown) => (
          <div key={p.projectId} className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              <span
                className="truncate text-xs font-medium text-foreground"
                title={p.directory ?? t("analytics.noProject")}
              >
                {p.directory ? p.name : t("analytics.noProject")}
              </span>
              <span className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">
                {t("analytics.messagesShort", { count: p.messages })} ·{" "}
                {formatTokens(p.tokens)}
              </span>
            </div>
            <div className="hidden h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-muted sm:block">
              <div
                className="h-full rounded-full bg-primary/60"
                style={{ width: `${Math.max((p.hours / maxHours) * 100, 2)}%` }}
              />
            </div>
            <span className="w-14 shrink-0 text-right text-xs font-semibold tabular-nums">
              {fmtHours(p.hours)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatsGrid({ data }: { data: AnalyticsSummary }) {
  const { t } = useTranslation();
  const stats = useMemo(
    () => [
      { label: t("analytics.stats.sessions"), value: data.totalSessions },
      { label: t("analytics.stats.messages"), value: data.totalMessages },
      { label: t("analytics.stats.activeDays"), value: data.activeDays },
      { label: t("analytics.stats.currentStreak"), value: t("analytics.stats.days", { count: data.currentStreak }) },
      { label: t("analytics.stats.longestStreak"), value: t("analytics.stats.days", { count: data.longestStreak }) },
      {
        label: t("analytics.stats.peakHour"),
        value: `${String(data.peakHour).padStart(2, "0")}h`,
      },
    ],
    [data, t],
  );

  return (
    <div className="grid grid-cols-2 gap-2">
      {stats.map((s) => (
        <div
          key={s.label}
          className="flex items-center gap-3 rounded-lg border px-4 py-3.5"
        >
          <div className="min-w-0">
            <p className="text-[11px] text-muted-foreground">{s.label}</p>
            <p className="truncate text-base font-semibold tabular-nums">
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
  const { t } = useTranslation();
  const [tokenLimit, setTokenLimit] = useState("");
  const [costLimit, setCostLimit] = useState("");

  const save = async () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("analytics.limits.title")}</DialogTitle>
          <DialogDescription>
            {t("analytics.limits.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <p className="mb-1 text-xs font-medium">{t("analytics.limits.tokenLimit")}</p>
            <Input
              type="number"
              placeholder="ex: 1000000"
              value={tokenLimit}
              onChange={(e) => setTokenLimit(e.target.value)}
            />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">
              {t("analytics.limits.costLimit")}
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
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()}>{t("common.save")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AnalyticsPanel() {
  const { t, i18n } = useTranslation();
  const { data, range, loading, load, setRange } = useAnalyticsStore();
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState<DateRange | undefined>();
  const rangeLabels = useRangeLabels();

  const isPt = i18n.language?.startsWith("pt") ?? true;
  const rangeIsCustom = typeof range === "object" && range.type === "custom";

  useEffect(() => {
    void load();
  }, [load]);

  const customLabel = useMemo(() => {
    if (!rangeIsCustom) return t("analytics.ranges.custom");
    const locale = isPt ? dfPtBR : enUS;
    return `${format(new Date(range.from), "dd MMM", { locale })} – ${format(
      new Date(range.to),
      "dd MMM",
      { locale },
    )}`;
  }, [rangeIsCustom, range, t, isPt]);

  const handleRangeSelect = (next?: DateRange) => {
    setCustomDraft(next);
    if (!next?.from || !next.to) return;
    const from = new Date(next.from);
    from.setHours(0, 0, 0, 0);
    const to = new Date(next.to);
    to.setHours(23, 59, 59, 999);
    setRange({ type: "custom", from: from.getTime(), to: to.getTime() });
    setCustomOpen(false);
  };

  return (
    <div className="flex h-full min-w-0 flex-col gap-3 overflow-y-auto overflow-x-hidden pr-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold shrink-0">{t("analytics.title")}</p>
        <div className="flex gap-2">
          <SegmentedControl
            options={RANGE_ORDER.map((r) => ({
              value: r,
              label: rangeLabels[r],
            }))}
            value={
              (typeof range === "string" ? range : RANGE_ORDER[0]) as PresetRange
            }
            onChange={(v) => setRange(v as AnalyticsRange)}
            size="xs"
          />
          <Popover
            open={customOpen}
            onOpenChange={(open) => {
              setCustomOpen(open);
              if (open) {
                setCustomDraft(
                  rangeIsCustom
                    ? { from: new Date(range.from), to: new Date(range.to) }
                    : undefined,
                );
              }
            }}
          >
            <PopoverTrigger
              render={
                <Button
                  size="sm"
                  variant={rangeIsCustom ? "secondary" : "outline"}
                  className="h-7 shrink-0 gap-1 px-2"
                >
                  <CalendarIcon className="size-3" />
                  <span className="text-[11px]">{customLabel}</span>
                </Button>
              }
            />
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="range"
                selected={customDraft}
                onSelect={handleRangeSelect}
                defaultMonth={customDraft?.from ?? new Date()}
                numberOfMonths={2}
                locale={isPt ? rdpPtBR : rdpEnUS}
              />
            </PopoverContent>
          </Popover>
          <Button
            size="sm"
            variant="outline"
            className="gap-1 shrink-0 h-7 px-2"
            onClick={() => setLimitsOpen(true)}
          >
            <Zap className="size-3" />
            <span className="text-[11px]">{t("analytics.limits.button")}</span>
          </Button>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
          {t("analytics.loading")}
        </div>
      ) : data ? (
        <>
          {/* Stats (left) + heatmap/totals (right) */}
          <div className="flex flex-col gap-4 xl:flex-row">
            <div className="xl:flex-1">
              <StatsGrid data={data} />
            </div>
            <div className="flex flex-col gap-3 xl:items-end">
              <ActivityHeatmap days={data.days} cellSize="size-4" />
              {/* Totals */}
              <div className="flex justify-end gap-3">
                <div className="flex min-w-[110px] flex-col items-end justify-center rounded-lg border px-4 py-2">
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Hash className="size-3" />
                    {t("analytics.tokens")}
                  </span>
                  <span className="text-sm font-semibold tabular-nums text-foreground">
                    {formatTokens(data.totalTokens)}
                  </span>
                </div>
                <div className="flex min-w-[110px] flex-col items-end justify-center rounded-lg border px-4 py-2">
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Clock className="size-3" />
                    {t("analytics.hours")}
                  </span>
                  <span className="text-sm font-semibold tabular-nums text-foreground">
                    {data.totalHours.toFixed(1)}h
                  </span>
                </div>
                <div className="flex min-w-[110px] flex-col items-end justify-center rounded-lg border px-4 py-2">
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    {t("analytics.spent")}
                  </span>
                  <span className="text-sm font-semibold tabular-nums text-foreground">
                    {formatCost(data.totalCost)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Full-width bar chart */}
          <div className="rounded-lg border p-3">
            <ModelBarChart data={data} />
          </div>

          {/* Hours worked per project */}
          <ProjectHoursList data={data} />

        </>
      ) : null}

      <LimitsDialog open={limitsOpen} onOpenChange={setLimitsOpen} />
    </div>
  );
}
