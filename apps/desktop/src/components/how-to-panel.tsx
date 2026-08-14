import { useTranslation } from "react-i18next"
import { AlignLeft, Bot, Brain, BrainCircuit, Eye, FileText, Globe, KeyRound, Network, RefreshCw, Search, Shield } from "lucide-react"

interface ModeInfo {
  id: string
  label: string
  modes: string[]
  description: string
  detail: string
  combo?: string[]
}

interface ComboInfo {
  label: string
  items: string[]
  description: string
}

const MODE_ICONS: Record<string, typeof Shield> = {
  search: Search,
  browser: Globe,
  thinking: Brain,
  simple: AlignLeft,
  brain: BrainCircuit,
  subagents: Bot,
  orchestra: Network,
  loop: RefreshCw,
  plan: FileText,
  permissions: KeyRound,
  vision: Eye,
}

export function HowToPanel() {
  const { t } = useTranslation()
  const modes = t("howto.modes", { returnObjects: true }) as ModeInfo[]
  const combos = t("howto.combos", { returnObjects: true }) as ComboInfo[]

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto pr-1">
      <div>
        <p className="text-sm font-semibold">{t("howto.title")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("howto.description")}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {modes.map((mode) => {
          const Icon = MODE_ICONS[mode.id] ?? Shield
          return (
            <div key={mode.id} className="flex flex-col gap-1.5 rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <Icon className="size-4 shrink-0 text-primary" />
                <span className="text-sm font-medium">{mode.label}</span>
                <div className="flex gap-1">
                  {mode.modes.map((m) => (
                    <span key={m} className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {m}
                    </span>
                  ))}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{mode.description}</p>
              <p className="text-xs leading-relaxed">{mode.detail}</p>
              {mode.combo && mode.combo.length > 0 && (
                <p className="text-[10px] text-muted-foreground">
                  {t("howto.combosWith")} {mode.combo.join(", ")}
                </p>
              )}
            </div>
          )
        })}
      </div>

      <div>
        <p className="text-sm font-semibold">{t("howto.recommended.title")}</p>
        <p className="mt-0.5 mb-3 text-xs text-muted-foreground">
          {t("howto.recommended.description")}
        </p>
        <div className="flex flex-col gap-3">
          {combos.map((combo) => (
            <div key={combo.label} className="flex flex-col gap-1.5 rounded-lg border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {combo.items.map((item) => {
                  const mode = modes.find((m) => m.label === item)
                  const Icon = mode ? (MODE_ICONS[mode.id] ?? Shield) : Shield
                  return (
                    <span key={item} className="flex items-center gap-1 rounded-md bg-background px-1.5 py-0.5 text-[10px] font-medium">
                      <Icon className="size-3" />
                      {item}
                    </span>
                  )
                })}
              </div>
              <p className="text-xs leading-relaxed">{combo.description}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
        <p className="text-xs font-medium text-primary">{t("howto.tip.title")}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t("howto.tip.text")}
        </p>
      </div>
    </div>
  )
}
