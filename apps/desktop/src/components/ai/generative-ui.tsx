import { createContext, memo, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  InfoIcon,
  MinusIcon,
  SendIcon,
  TriangleAlertIcon,
} from "lucide-react"
import type { CustomRendererProps } from "streamdown"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { useMessageQueueStore } from "@/src/stores/message-queue-store"
import { useSessionStore } from "@/src/stores/session-store"
import {
  evalCondition,
  evalNumber,
  formatValue,
  interpolate,
  sampleFn,
  type Scope,
  type Value,
} from "@/src/lib/orbit-expr"
import { INPUT_TYPES, parseOrbitUi, type OrbitUiBlock } from "@/src/lib/orbit-ui"

/**
 * Blocos inline da resposta do assistente (fence ```orbit-ui, ver
 * src/lib/orbit-ui.ts). São componentes do próprio app — sem iframe, sem moldura
 * própria — que herdam fonte, cor e tema do chat. Cada bloco entra com um fade
 * curto ao montar, e como o parser entrega uma linha por vez, a resposta parece
 * ser montada ao vivo.
 *
 * Interatividade: os componentes de entrada gravam num estado local do fence
 * (`Scope`), e todo o resto lê dele — texto com `{expr}`, números como
 * expressão, `showIf`. O estado vive só na tela: reabrir a conversa devolve os
 * valores iniciais.
 */

const SERIES = [
  "var(--primary)",
  "var(--chart-2)",
  "var(--chart-4)",
  "var(--chart-1)",
  "var(--chart-5)",
  "var(--chart-3)",
]

const ENTER = "animate-in fade-in-0 slide-in-from-bottom-1 duration-300"

const TONES = {
  info: { icon: InfoIcon, box: "bg-secondary", icon_: "text-muted-foreground" },
  success: {
    icon: CircleCheckIcon,
    box: "bg-emerald-500/10",
    icon_: "text-emerald-600 dark:text-emerald-400",
  },
  warning: {
    icon: TriangleAlertIcon,
    box: "bg-amber-500/10",
    icon_: "text-amber-600 dark:text-amber-400",
  },
  danger: { icon: CircleAlertIcon, box: "bg-destructive/10", icon_: "text-destructive" },
} as const

type Of<T extends OrbitUiBlock["type"]> = Extract<OrbitUiBlock, { type: T }>

// ── Estado e contexto ──────────────────────────────────────────────────────

/** Onde o renderer está: a sessão de quem os botões `send` falam. */
export const OrbitUiHostContext = createContext<{ sessionId?: string }>({})

type UiState = {
  scope: Scope
  /** Há algum componente de entrada: gráficos param de animar a cada mudança. */
  interactive: boolean
  setValue: (id: string, value: Value) => void
  send: (text: string) => boolean
}

const UiContext = createContext<UiState>({
  scope: {},
  interactive: false,
  setValue: () => {},
  send: () => false,
})

/** Texto do bloco com os `{expr}` resolvidos contra o estado atual. */
function useText() {
  const { scope } = useContext(UiContext)
  return (text: string | undefined) => (text ? interpolate(text, scope) : "")
}

const isInputBlock = (block: OrbitUiBlock) => (INPUT_TYPES as readonly string[]).includes(block.type)

function defaultsOf(blocks: OrbitUiBlock[]): Scope {
  const out: Scope = {}
  for (const block of blocks) {
    if (out[(block as { id?: string }).id ?? ""] !== undefined) continue
    switch (block.type) {
      case "slider":
        out[block.id] = block.value ?? block.min
        break
      case "number":
        out[block.id] = block.value
        break
      case "select":
      case "tabs":
        out[block.id] = block.value ?? block.options[0].value
        break
      case "toggle":
        out[block.id] = block.value ?? false
        break
      case "text":
        out[block.id] = block.value ?? ""
        break
    }
  }
  return out
}

/** Manda `text` como mensagem do usuário na sessão; se o agente está ocupado, entra na fila. */
function sendToSession(sessionId: string | undefined, text: string): boolean {
  if (!sessionId || !text.trim()) return false
  const store = useSessionStore.getState()
  const mode = store.sessions.find((s) => s.id === sessionId)?.mode ?? "chat"
  const status = store.status[sessionId]
  if (!status || status === "idle" || status === "error") {
    void store.sendMessage(mode, text, { options: {}, sessionId })
  } else {
    useMessageQueueStore.getState().enqueueForSend(sessionId, text, {}, mode)
  }
  return true
}

// ── Componentes de exibição ────────────────────────────────────────────────

/**
 * Tamanho do número do card conforme o comprimento do texto já resolvido. O
 * card tem largura de coluna, então "R$ 1.234.567,89" não cabe no corpo grande
 * de "R$ 12k": em vez de cortar com reticências, a fonte desce um degrau por
 * faixa, e o que ainda assim não couber quebra linha.
 */
function statSize(value: string): string {
  const n = value.length
  if (n <= 9) return "text-2xl"
  if (n <= 13) return "text-xl"
  if (n <= 18) return "text-lg"
  return "text-base"
}

function Stats({ items }: Of<"stats">) {
  const tx = useText()
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
      {items.map((item, i) => {
        const Trend =
          item.trend === "up" ? ArrowUpRightIcon : item.trend === "down" ? ArrowDownRightIcon : MinusIcon
        return (
          <div key={i} className="rounded-xl bg-secondary/70 px-3.5 py-3">
            <div className="text-xs break-words text-muted-foreground">{tx(item.label)}</div>
            <div className={cn("mt-0.5 font-semibold tracking-tight break-words", statSize(tx(item.value)))}>
              {tx(item.value)}
            </div>
            {(item.delta || item.hint) && (
              <div className="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
                {item.delta && (
                  <span
                    className={cn(
                      "inline-flex items-center gap-0.5 font-medium",
                      item.trend === "up" && "text-emerald-600 dark:text-emerald-400",
                      item.trend === "down" && "text-destructive",
                    )}
                  >
                    {item.trend && <Trend className="size-3" />}
                    {tx(item.delta)}
                  </span>
                )}
                {item.hint && <span className="break-words">{tx(item.hint)}</span>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Callout({ tone, title, text }: Of<"callout">) {
  const tx = useText()
  const { icon: Icon, box, icon_ } = TONES[tone]
  return (
    <div className={cn("flex gap-2.5 rounded-xl px-3.5 py-3 text-sm", box)}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", icon_)} />
      <div className="min-w-0">
        {title && <div className="font-medium">{tx(title)}</div>}
        <div className={cn("text-foreground/90", title && "mt-0.5")}>{tx(text)}</div>
      </div>
    </div>
  )
}

function Steps({ items }: Of<"steps">) {
  const tx = useText()
  return (
    <ol className="flex flex-col">
      {items.map((item, i) => {
        const status = item.status ?? "todo"
        const last = i === items.length - 1
        return (
          <li key={i} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                  status === "done" && "bg-primary text-primary-foreground",
                  status === "active" && "bg-primary/20 text-foreground ring-2 ring-primary",
                  status === "todo" && "bg-secondary text-muted-foreground",
                )}
              >
                {status === "done" ? <CheckIcon className="size-3.5" /> : i + 1}
              </div>
              {!last && <div className="my-1 w-px flex-1 bg-border" />}
            </div>
            <div className={cn("min-w-0 pt-0.5", !last && "pb-3")}>
              <div className={cn("text-sm font-medium", status === "todo" && "text-muted-foreground")}>
                {tx(item.title)}
              </div>
              {item.text && <div className="mt-0.5 text-sm text-muted-foreground">{tx(item.text)}</div>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function DataTable({ columns, rows }: Of<"table">) {
  const tx = useText()
  return (
    <div className="overflow-x-auto rounded-xl bg-secondary/40">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            {columns.map((c, i) => (
              <th key={i} className="px-3.5 py-2 font-medium whitespace-nowrap">
                {tx(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-t border-border/60">
              {columns.map((_, c) => (
                <td key={c} className="px-3.5 py-2 align-top">
                  {tx(row[c] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const AXIS = { fontSize: 11, fill: "var(--muted-foreground)" }

const TOOLTIP = {
  contentStyle: {
    background: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    fontSize: 12,
  },
  cursor: { fill: "var(--secondary)", opacity: 0.6 },
} as const

type ChartRows = { rows: Record<string, string | number | null>[]; keys: { key: string; name: string }[] }

/** Linhas do gráfico: pontos prontos (valor pode ser expressão) ou funções amostradas. */
function chartRows(block: Of<"chart">, scope: Scope, tx: (s: string | undefined) => string): ChartRows {
  const finite = (n: number) => (Number.isFinite(n) ? n : null)
  if (block.data) {
    return {
      rows: block.data.map((d) => ({ label: tx(d.label), value: finite(evalNumber(d.value, scope)) })),
      keys: [{ key: "value", name: tx(block.title) }],
    }
  }
  const [from, to] = block.x!
  const fns = block.fns!
  const series = fns.map((f) => sampleFn(f.fn, from, to, block.steps ?? 24, scope))
  return {
    rows: series[0].map((p, i) => {
      const row: Record<string, string | number | null> = { label: formatValue(p.x) }
      series.forEach((points, j) => (row[`s${j}`] = finite(points[i].y)))
      return row
    }),
    keys: fns.map((f, j) => ({ key: `s${j}`, name: tx(f.name) || `#${j + 1}` })),
  }
}

function Chart(block: Of<"chart">) {
  const { scope, interactive } = useContext(UiContext)
  const tx = useText()
  const { kind, title, unit, xLabel } = block
  const { rows, keys } = useMemo(() => chartRows(block, scope, tx), [block, scope, tx])
  const fmt = (v: unknown) => (typeof v === "number" ? `${formatValue(v)}${unit ? ` ${unit}` : ""}` : "—")
  // Com entradas na tela o gráfico se redesenha a cada passo do slider: a
  // animação de entrada viraria um arrasto atrás do dedo.
  const animate = !interactive
  const multi = keys.length > 1
  const margin = { top: 4, right: 8, bottom: xLabel ? 14 : 0, left: -12 }
  const axes = (
    <>
      <CartesianGrid vertical={false} stroke="var(--border)" />
      <XAxis
        dataKey="label"
        tick={AXIS}
        tickLine={false}
        axisLine={false}
        label={xLabel ? { value: xLabel, position: "insideBottom", offset: -8, style: AXIS } : undefined}
      />
      <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => formatValue(Number(v), "compact")} />
      <Tooltip {...TOOLTIP} formatter={fmt} />
      {multi && <Legend verticalAlign="top" align="right" height={28} iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />}
    </>
  )
  return (
    <div className="rounded-xl bg-secondary/40 px-3.5 py-3">
      {title && <div className="mb-2 text-sm font-medium">{tx(title)}</div>}
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {kind === "pie" ? (
            <PieChart>
              <Pie
                data={rows}
                dataKey={keys[0].key}
                nameKey="label"
                innerRadius="55%"
                outerRadius="85%"
                stroke="none"
                isAnimationActive={animate}
              >
                {rows.map((_, i) => (
                  <Cell key={i} fill={SERIES[i % SERIES.length]} />
                ))}
              </Pie>
              <Tooltip {...TOOLTIP} formatter={fmt} />
            </PieChart>
          ) : kind === "line" ? (
            <LineChart data={rows} margin={margin}>
              {axes}
              {keys.map((k, j) => (
                <Line
                  key={k.key}
                  name={k.name}
                  dataKey={k.key}
                  stroke={SERIES[j % SERIES.length]}
                  strokeWidth={2.5}
                  dot={rows.length <= 12 ? { r: 3, strokeWidth: 0, fill: SERIES[j % SERIES.length] } : false}
                  type="monotone"
                  isAnimationActive={animate}
                />
              ))}
            </LineChart>
          ) : kind === "area" ? (
            <AreaChart data={rows} margin={margin}>
              {axes}
              {keys.map((k, j) => (
                <Area
                  key={k.key}
                  name={k.name}
                  dataKey={k.key}
                  stroke={SERIES[j % SERIES.length]}
                  fill={SERIES[j % SERIES.length]}
                  fillOpacity={0.18}
                  strokeWidth={2.5}
                  type="monotone"
                  isAnimationActive={animate}
                />
              ))}
            </AreaChart>
          ) : (
            <BarChart data={rows} margin={margin}>
              {axes}
              {keys.map((k, j) => (
                <Bar
                  key={k.key}
                  name={k.name}
                  dataKey={k.key}
                  fill={SERIES[j % SERIES.length]}
                  radius={[6, 6, 0, 0]}
                  isAnimationActive={animate}
                />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
      {kind === "pie" && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {rows.map((d, i) => (
            <span key={i} className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: SERIES[i % SERIES.length] }} />
              {d.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function Checklist({ items }: Of<"checklist">) {
  const tx = useText()
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2.5 text-sm">
          <span
            className={cn(
              "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-md",
              item.done ? "bg-primary text-primary-foreground" : "bg-secondary",
            )}
          >
            {item.done && <CheckIcon className="size-3" />}
          </span>
          <span className={cn(item.done && "text-muted-foreground line-through")}>{tx(item.text)}</span>
        </li>
      ))}
    </ul>
  )
}

function Compare({ items }: Of<"compare">) {
  const tx = useText()
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-2">
      {items.map((item, i) => (
        <div key={i} className="rounded-xl bg-secondary/70 px-3.5 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm font-semibold">{tx(item.title)}</div>
            {item.tag && (
              <span className="shrink-0 rounded-full bg-primary/20 px-2 py-0.5 text-[0.7rem] font-medium">
                {tx(item.tag)}
              </span>
            )}
          </div>
          <ul className="mt-2 flex flex-col gap-1.5">
            {item.points.map((point, p) => (
              <li key={p} className="flex gap-2 text-sm text-foreground/90">
                <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                {tx(point)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function KeyValue({ items }: Of<"kv">) {
  const tx = useText()
  return (
    <dl className="rounded-xl bg-secondary/40 px-3.5 py-1.5 text-sm">
      {items.map((item, i) => (
        <div key={i} className={cn("flex justify-between gap-4 py-1.5", i > 0 && "border-t border-border/60")}>
          <dt className="text-muted-foreground">{tx(item.label)}</dt>
          <dd className="text-right font-medium">{tx(item.value)}</dd>
        </div>
      ))}
    </dl>
  )
}

function Progress({ items }: Of<"progress">) {
  const { scope } = useContext(UiContext)
  const tx = useText()
  return (
    <div className="flex flex-col gap-3">
      {items.map((item, i) => {
        const raw = evalNumber(item.value, scope)
        const value = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0
        return (
          <div key={i}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate">{tx(item.label)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {item.hint ? tx(item.hint) : `${formatValue(value, "0")}%`}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                style={{ width: `${value}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Entradas ───────────────────────────────────────────────────────────────

const FIELD = "h-8 w-full rounded-lg bg-secondary px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"

function Field({ label, aside, children }: { label?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {(label || aside) && (
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="truncate text-muted-foreground">{label}</span>
          {aside && <span className="shrink-0 font-medium tabular-nums">{aside}</span>}
        </div>
      )}
      {children}
    </div>
  )
}

function useInput<T extends Value>(id: string, fallback: T) {
  const { scope, setValue } = useContext(UiContext)
  const value = (Object.hasOwn(scope, id) ? scope[id] : fallback) as T
  return [value, (v: Value) => setValue(id, v)] as const
}

/**
 * Slider sem o visual nativo do navegador (que desenha uma trilha com contorno):
 * trilha fina preenchida até o valor (`--fill`, em %) e uma bolinha com um anel
 * na cor do fundo, para ela "recortar" a trilha. A margem negativa da bolinha
 * centraliza os 16px dela nos 6px da trilha.
 */
const SLIDER = [
  "h-4 w-full cursor-pointer appearance-none bg-transparent outline-none",
  "[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:border-0",
  "[&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--primary)_var(--fill),var(--muted)_var(--fill))]",
  "[&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none",
  "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-primary",
  "[&::-webkit-slider-thumb]:shadow-[0_0_0_3px_var(--background)]",
  "focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-ring/50",
].join(" ")

function SliderInput(block: Of<"slider">) {
  const tx = useText()
  const [value, set] = useInput(block.id, block.value ?? block.min)
  const span = block.max - block.min
  const step = block.step ?? (Number.isInteger(block.min) && Number.isInteger(block.max) ? 1 : span / 100)
  return (
    <Field label={tx(block.label)} aside={`${formatValue(Number(value))}${block.unit ? ` ${block.unit}` : ""}`}>
      <input
        type="range"
        min={block.min}
        max={block.max}
        step={step}
        value={Number(value)}
        onChange={(e) => set(Number(e.target.value))}
        style={{ "--fill": `${span > 0 ? ((Number(value) - block.min) / span) * 100 : 0}%` } as React.CSSProperties}
        className={SLIDER}
        aria-label={block.label}
      />
    </Field>
  )
}

function NumberInput(block: Of<"number">) {
  const tx = useText()
  const [value, set] = useInput(block.id, block.value)
  // Rascunho em texto: "1." e "-" são estados legítimos de quem digita e não
  // sobreviveriam a um valor numérico controlado.
  const [draft, setDraft] = useState(String(value))
  useEffect(() => {
    if (Number(draft) !== Number(value)) setDraft(String(value))
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Field label={tx(block.label)} aside={block.unit}>
      <input
        type="number"
        inputMode="decimal"
        min={block.min}
        max={block.max}
        step={block.step}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          const n = Number(e.target.value)
          if (e.target.value !== "" && Number.isFinite(n)) set(n)
        }}
        className={FIELD}
        aria-label={block.label}
      />
    </Field>
  )
}

function SelectInput(block: Of<"select">) {
  const tx = useText()
  const [value, set] = useInput<Value>(block.id, block.value ?? block.options[0].value)
  return (
    <Field label={tx(block.label)}>
      <select
        value={String(value)}
        onChange={(e) => {
          const picked = block.options.find((o) => String(o.value) === e.target.value)
          if (picked) set(picked.value)
        }}
        className={cn(FIELD, "cursor-pointer")}
        aria-label={block.label ?? block.id}
      >
        {block.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {tx(o.label)}
          </option>
        ))}
      </select>
    </Field>
  )
}

function Tabs(block: Of<"tabs">) {
  const tx = useText()
  const [value, set] = useInput<Value>(block.id, block.value ?? block.options[0].value)
  return (
    <div role="tablist" className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-full bg-secondary p-0.5">
      {block.options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => set(o.value)}
            className={cn(
              "cursor-pointer rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors",
              active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tx(o.label)}
          </button>
        )
      })}
    </div>
  )
}

function ToggleInput(block: Of<"toggle">) {
  const tx = useText()
  const [value, set] = useInput(block.id, block.value ?? false)
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg bg-secondary/70 px-3 py-2 text-sm">
      <span className="min-w-0">{tx(block.label)}</span>
      <Switch checked={Boolean(value)} onCheckedChange={(checked) => set(checked)} />
    </label>
  )
}

function TextInput(block: Of<"text">) {
  const tx = useText()
  const [value, set] = useInput(block.id, block.value ?? "")
  return (
    <Field label={tx(block.label)}>
      <input
        type="text"
        value={String(value)}
        placeholder={block.placeholder}
        maxLength={200}
        onChange={(e) => set(e.target.value)}
        className={FIELD}
        aria-label={block.label ?? block.id}
      />
    </Field>
  )
}

function Buttons({ items }: Of<"buttons">) {
  const { scope, setValue, send } = useContext(UiContext)
  const tx = useText()
  const [done, setDone] = useState<number | null>(null)
  const flash = (i: number) => {
    setDone(i)
    setTimeout(() => setDone((d) => (d === i ? null : d)), 1500)
  }
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item, i) => {
        const text = tx(item.text ?? item.label)
        const selected = item.action === "set" && item.id !== undefined && scope[item.id] === item.value
        const Icon = done === i ? CheckIcon : item.action === "copy" ? CopyIcon : item.action === "send" ? SendIcon : null
        return (
          <Button
            key={i}
            type="button"
            size="lg"
            variant={item.variant === "primary" || selected ? "default" : "outline"}
            className="cursor-pointer rounded-full px-3.5"
            onClick={() => {
              if (item.action === "set") {
                if (item.id !== undefined && item.value !== undefined) setValue(item.id, item.value)
              } else if (item.action === "copy") {
                void navigator.clipboard.writeText(text).then(() => flash(i))
              } else if (send(text)) {
                flash(i)
              }
            }}
          >
            {Icon && <Icon />}
            {tx(item.label)}
          </Button>
        )
      })}
    </div>
  )
}

function Block({ block }: { block: OrbitUiBlock }) {
  switch (block.type) {
    case "stats":
      return <Stats {...block} />
    case "callout":
      return <Callout {...block} />
    case "steps":
      return <Steps {...block} />
    case "table":
      return <DataTable {...block} />
    case "chart":
      return <Chart {...block} />
    case "checklist":
      return <Checklist {...block} />
    case "compare":
      return <Compare {...block} />
    case "kv":
      return <KeyValue {...block} />
    case "progress":
      return <Progress {...block} />
    case "slider":
      return <SliderInput {...block} />
    case "number":
      return <NumberInput {...block} />
    case "select":
      return <SelectInput {...block} />
    case "tabs":
      return <Tabs {...block} />
    case "toggle":
      return <ToggleInput {...block} />
    case "text":
      return <TextInput {...block} />
    case "buttons":
      return <Buttons {...block} />
  }
}

type Layout = { start: number; blocks: OrbitUiBlock[]; grouped: boolean }

/**
 * Entradas consecutivas (exceto abas) dividem uma grade: quatro sliders em
 * sequência viram um painel, não uma coluna de quatro faixas.
 */
function layoutOf(blocks: OrbitUiBlock[]): Layout[] {
  const out: Layout[] = []
  blocks.forEach((block, index) => {
    const groupable = isInputBlock(block) && block.type !== "tabs"
    const last = out[out.length - 1]
    if (groupable && last?.grouped) last.blocks.push(block)
    else out.push({ start: index, blocks: [block], grouped: groupable })
  })
  return out
}

/** Renderer do fence `orbit-ui`, plugado no Streamdown (plugins.renderers). */
export const OrbitUiRenderer = memo(function OrbitUiRenderer({ code, isIncomplete }: CustomRendererProps) {
  const { sessionId } = useContext(OrbitUiHostContext)
  const { blocks, pending } = useMemo(() => parseOrbitUi(code, isIncomplete), [code, isIncomplete])
  const defaults = useMemo(() => defaultsOf(blocks), [blocks])
  const [overrides, setOverrides] = useState<Scope>({})
  const scope = useMemo(() => ({ ...defaults, ...overrides }), [defaults, overrides])
  const layout = useMemo(() => layoutOf(blocks), [blocks])

  const state = useMemo<UiState>(
    () => ({
      scope,
      interactive: blocks.some(isInputBlock),
      setValue: (id, value) => setOverrides((prev) => ({ ...prev, [id]: value })),
      send: (text) => sendToSession(sessionId, text),
    }),
    [scope, blocks, sessionId],
  )

  if (blocks.length === 0 && !pending) return null
  return (
    <UiContext.Provider value={state}>
      <div className="my-3 flex flex-col gap-3">
        {layout.map((group) => {
          const visible = group.blocks.filter((b) => evalCondition((b as { showIf?: string }).showIf, scope))
          if (visible.length === 0) return null
          if (!group.grouped) {
            return (
              <div key={group.start} className={ENTER}>
                <Block block={visible[0]} />
              </div>
            )
          }
          return (
            <div
              key={group.start}
              className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] items-end gap-x-4 gap-y-3 rounded-xl bg-secondary/40 px-3.5 py-3"
            >
              {visible.map((block, i) => (
                <div key={i} className={ENTER}>
                  <Block block={block} />
                </div>
              ))}
            </div>
          )
        })}
        {pending && <Skeleton className="h-16 w-full rounded-xl bg-secondary/60" />}
      </div>
    </UiContext.Provider>
  )
})
