import { AlignLeft, Bot, BrainCircuit, FileText, Globe, Moon, Monitor, Network, RefreshCw, Search, Smile, Sun } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useTheme } from "@/components/theme-provider"
import { MODE_IDS, useAppearanceStore, type ModeId, type ModeLabelStyle, type TabClosePosition } from "@/src/stores/appearance-store"

type ThemePref = "light" | "dark" | "system"

function useClosePositionChips(): { value: TabClosePosition; label: string }[] {
  const { t } = useTranslation()
  return [
    { value: "left", label: t("appearance.tabClosePosition.left") },
    { value: "right", label: t("appearance.tabClosePosition.right") },
  ]
}

function useThemeChips(): { value: ThemePref; label: string; icon: typeof Sun }[] {
  const { t } = useTranslation()
  return [
    { value: "light", label: t("appearance.theme.light"), icon: Sun },
    { value: "dark", label: t("appearance.theme.dark"), icon: Moon },
    { value: "system", label: t("appearance.theme.system"), icon: Monitor },
  ]
}

function useModeRowOptions(): { id: ModeId; label: string; icon: typeof Search }[] {
  const { t } = useTranslation()
  return [
    { id: "search", label: t("input.modes.search.label"), icon: Search },
    { id: "browser", label: t("input.modes.browser.label"), icon: Globe },
    { id: "plan", label: t("codeInput.modes.plan.label"), icon: FileText },
    { id: "simple", label: t("input.modes.simple.label"), icon: AlignLeft },
    { id: "brain", label: t("input.modes.brain.label"), icon: BrainCircuit },
    { id: "subagents", label: t("codeInput.modes.subagents.label"), icon: Bot },
    { id: "orchestra", label: t("codeInput.modes.orchestra.label"), icon: Network },
    { id: "loop", label: t("codeInput.modes.loop.label"), icon: RefreshCw },
  ]
}

function useLabelStyleChips(): { value: ModeLabelStyle; label: string }[] {
  const { t } = useTranslation()
  return [
    { value: "label", label: t("appearance.modeLabelStyle.label") },
    { value: "icon", label: t("appearance.modeLabelStyle.icon") },
  ]
}

export function AppearancePanel() {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const modesInRow = useAppearanceStore((s) => s.modesInRow)
  const setModesInRow = useAppearanceStore((s) => s.setModesInRow)
  const modeLabelStyle = useAppearanceStore((s) => s.modeLabelStyle)
  const setModeLabelStyle = useAppearanceStore((s) => s.setModeLabelStyle)
  const personaVisible = useAppearanceStore((s) => s.personaVisible)
  const setPersonaVisible = useAppearanceStore((s) => s.setPersonaVisible)
  const tabClosePosition = useAppearanceStore((s) => s.tabClosePosition)
  const setTabClosePosition = useAppearanceStore((s) => s.setTabClosePosition)
  const themeChips = useThemeChips()
  const modeRowOptions = useModeRowOptions()
  const labelStyleChips = useLabelStyleChips()
  const closePositionChips = useClosePositionChips()

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto pr-1">
      <div>
        <p className="text-sm font-semibold">{t("appearance.title")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("appearance.description")}
        </p>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("appearance.theme.title")}</p>
        <div className="flex gap-2">
          {themeChips.map(({ value, label, icon: Icon }) => {
            const active = theme === value
            return (
              <button
                key={value}
                type="button"
                onClick={() => setTheme(value)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  active
                    ? "border-ring bg-accent text-accent-foreground shadow-sm"
                    : "border-input bg-background text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }`}
              >
                <Icon className="size-4" />
                {label}
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("appearance.bottomModes.title")}</p>
        <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground/70">{t("appearance.bottomModes.hint")}</p>
        <div className="mb-2 flex gap-2">
          <button
            type="button"
            onClick={() => setModesInRow([...MODE_IDS])}
            className="flex-1 rounded-lg border border-input bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            {t("appearance.bottomModes.all")}
          </button>
          <button
            type="button"
            onClick={() => setModesInRow([])}
            className="flex-1 rounded-lg border border-input bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            {t("appearance.bottomModes.none")}
          </button>
        </div>
        <div className="flex flex-col gap-1">
          {modeRowOptions.map(({ id, label, icon: Icon }) => {
            const checked = modesInRow.includes(id)
            return (
              <label
                key={id}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent/50"
              >
                <Icon className="size-4 text-muted-foreground" />
                <span className="flex-1">{label}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={checked}
                  onClick={() => setModesInRow(checked ? modesInRow.filter((m) => m !== id) : [...modesInRow, id])}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                    checked ? "bg-primary" : "bg-input"
                  }`}
                >
                  <span
                    className={`pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform ${
                      checked ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
              </label>
            )
          })}
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("appearance.modeLabelStyle.title")}</p>
        <div className="flex gap-2">
          {labelStyleChips.map(({ value, label }) => {
            const active = modeLabelStyle === value
            return (
              <button
                key={value}
                type="button"
                onClick={() => setModeLabelStyle(value)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  active
                    ? "border-ring bg-accent text-accent-foreground shadow-sm"
                    : "border-input bg-background text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }`}
              >
                {label}
              </button>
            )
          })}
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">{t("appearance.modeLabelStyle.hint")}</p>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("appearance.tabClosePosition.title")}</p>
        <div className="flex gap-2">
          {closePositionChips.map(({ value, label }) => {
            const active = tabClosePosition === value
            return (
              <button
                key={value}
                type="button"
                onClick={() => setTabClosePosition(value)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  active
                    ? "border-ring bg-accent text-accent-foreground shadow-sm"
                    : "border-input bg-background text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }`}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="border-t pt-4">
        <p className="mb-3 text-xs font-medium text-muted-foreground">{t("appearance.persona.title")}</p>
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-input bg-background px-3 py-2.5 transition-colors hover:bg-accent/50">
          <Smile className="size-4 text-muted-foreground" />
          <span className="flex-1 text-sm">{t("appearance.persona.show")}</span>
          <button
            type="button"
            role="switch"
            aria-checked={personaVisible}
            onClick={() => setPersonaVisible(!personaVisible)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              personaVisible ? "bg-primary" : "bg-input"
            }`}
          >
            <span
              className={`pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform ${
                personaVisible ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </label>
      </div>
    </div>
  )
}
