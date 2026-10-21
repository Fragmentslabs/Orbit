import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, Search, Type } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { fontsApi, type FontChoices } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"
import { FIELD_SHELL } from "./design-controls"

/**
 * Seletor de família tipográfica do inspetor.
 *
 * Duas listas, uma busca: as famílias INSTALADAS NO COMPUTADOR (o Chromium já as
 * carrega, basta o nome) e as da BIBLIOTECA DO ORBIT (baixadas pela tool
 * `font_use`). Cada linha é desenhada na própria fonte — é o jeito mais rápido de
 * escolher. O campo do topo filtra as duas; o que sobra no texto e não casa com
 * nada vira um valor livre ("Minha Fonte, serif"), para quem tem uma fonte que
 * não está em nenhuma das listas.
 *
 * A biblioteca do Orbit chega por IPC com o `@font-face` junto: a prévia aqui é a
 * MESMA fonte que o artboard vai usar, servida pelo scheme `orbit-font://`.
 */

/** `'Inter', sans-serif` → `Inter`. */
export function firstFamily(value: string): string {
  const first = value.split(",")[0]?.trim() ?? ""
  return first.replace(/^["']+|["']+$/g, "").trim()
}

/** Só uma busca por painel: a lista muda raramente e o popover abre toda hora. */
let cached: FontChoices | null = null

function commitFaces(css: string): void {
  if (!css.trim()) return
  let style = document.getElementById("orbit-font-faces") as HTMLStyleElement | null
  if (!style) {
    style = document.createElement("style")
    style.id = "orbit-font-faces"
    document.head.appendChild(style)
  }
  if (style.textContent !== css) style.textContent = css
}

const ROW = "flex h-7 w-full items-center gap-1.5 px-2 text-left text-[11px] transition-colors hover:bg-accent/60"

export function FontPicker({
  value,
  computed,
  onCommit,
}: {
  /** O valor no `style` do elemento (vazio quando ele herda). */
  value: string
  /** O valor calculado — o cinza do campo quando não há inline. */
  computed: string
  onCommit: (value: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [data, setData] = useState<FontChoices | null>(cached)
  const input = useRef<HTMLInputElement>(null)

  // Carrega ao montar (para a prévia da família atual) e de novo a cada abertura:
  // o agente pode ter instalado uma fonte no meio da conversa.
  useEffect(() => {
    let alive = true
    fontsApi
      .list()
      .then((next) => {
        if (!alive) return
        cached = next
        setData(next)
        commitFaces(next.css)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open])

  const current = firstFamily(value)
  const inherited = firstFamily(computed)

  const { system, orbit } = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const all = data?.system ?? []
    const families = data?.orbit ?? []
    const match = (name: string) => name.toLowerCase().includes(needle)
    return {
      system: needle ? all.filter(match) : all,
      orbit: needle ? families.filter((font) => match(font.family) || font.id.includes(needle)) : families,
    }
  }, [data, query])

  const exact = system.some((family) => family.toLowerCase() === query.trim().toLowerCase()) || orbit.some((font) => font.family.toLowerCase() === query.trim().toLowerCase())
  const typed = query.trim()

  const apply = (family: string) => {
    onCommit(family)
    setOpen(false)
    setQuery("")
  }

  /** Enter: a primeira opção se só houver uma; senão o texto digitado vira valor. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false)
      return
    }
    if (event.key !== "Enter") return
    event.preventDefault()
    const only = system.length + orbit.length === 1 ? (system[0] ?? orbit[0]?.family) : null
    if (only) apply(only)
    else if (typed) apply(typed)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery("")
        else requestAnimationFrame(() => input.current?.focus())
      }}
    >
      <PopoverTrigger
        title={t("design.props.typography")}
        className={cn(FIELD_SHELL, "cursor-pointer text-left")}
      >
        <span className="flex size-3 shrink-0 items-center justify-center text-muted-foreground/60 [&_svg]:size-3">
          <Type />
        </span>
        <span
          className={cn("w-0 min-w-0 flex-1 truncate text-[10px] font-semibold", !current && "font-normal text-muted-foreground/60")}
          style={{ fontFamily: current || inherited || undefined }}
        >
          {current || inherited || "—"}
        </span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground/60" />
      </PopoverTrigger>

      <PopoverContent align="start" side="bottom" className="w-64 max-w-[86vw] p-0">
        <div className="flex items-center gap-1.5 border-b border-border/60 px-2">
          <Search className="size-3 shrink-0 text-muted-foreground/60" />
          <Input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("design.props.fontFilter")}
            spellCheck={false}
            className="h-8 rounded-none border-0 bg-transparent px-0 text-[11px] shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>

        <div className="max-h-64 overflow-y-auto overscroll-contain py-1">
          {typed && !exact && (
            <button type="button" onClick={() => apply(typed)} className={ROW}>
              <span className="w-3 shrink-0 text-center text-[9px] text-primary">↵</span>
              <span className="min-w-0 flex-1 truncate" style={{ fontFamily: typed }}>
                {t("design.props.fontUse", { name: typed })}
              </span>
            </button>
          )}

          {orbit.length > 0 && (
            <>
              <div className="sticky top-0 z-10 bg-popover px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                {t("design.props.fontsOrbit")}
              </div>
              {orbit.map((font) => (
                <button key={`orbit:${font.id}`} type="button" onClick={() => apply(font.family)} className={ROW}>
                  <span className="w-3 shrink-0 text-center text-[9px] text-primary">{current === font.family ? "✓" : ""}</span>
                  <span className="min-w-0 flex-1 truncate" style={{ fontFamily: `'${font.family}'` }}>
                    {font.family}
                  </span>
                  <span className="shrink-0 text-[9px] text-muted-foreground/50">{font.category ?? ""}</span>
                </button>
              ))}
            </>
          )}

          {system.length > 0 && (
            <>
              <div className="sticky top-0 z-10 bg-popover px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                {t("design.props.fontsSystem")}
              </div>
              {system.map((family) => (
                <button key={`system:${family}`} type="button" onClick={() => apply(family)} className={ROW}>
                  <span className="w-3 shrink-0 text-center text-[9px] text-primary">{current === family ? "✓" : ""}</span>
                  <span className="min-w-0 flex-1 truncate" style={{ fontFamily: `'${family}'` }}>
                    {family}
                  </span>
                </button>
              ))}
            </>
          )}

          {data && system.length === 0 && orbit.length === 0 && (
            <p className="px-2 py-2 text-[10px] text-muted-foreground/60">{t("design.props.fontsNone")}</p>
          )}

          {/* A biblioteca do Orbit nasce vazia: a linha ensina como enchê-la. */}
          {data && data.orbit.length === 0 && !typed && (
            <p className="border-t border-border/40 px-2 pb-1.5 pt-2 text-[9px] leading-snug text-muted-foreground/60">
              {t("design.props.fontsOrbitEmpty")}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
