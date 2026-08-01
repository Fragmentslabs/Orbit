import { Sun, Moon, Monitor, List, Square, Layers, Smile } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useTheme } from "@/components/theme-provider"
import { useAppearanceStore, type DisplayMode } from "@/src/stores/appearance-store"

type ThemePref = "light" | "dark" | "system"

function useThemeChips(): { value: ThemePref; label: string; icon: typeof Sun }[] {
  const { t } = useTranslation()
  return [
    { value: "light", label: t("appearance.theme.light"), icon: Sun },
    { value: "dark", label: t("appearance.theme.dark"), icon: Moon },
    { value: "system", label: t("appearance.theme.system"), icon: Monitor },
  ]
}

function useModeChips(): { value: DisplayMode; label: string; icon: typeof List; hint: string }[] {
  const { t } = useTranslation()
  return [
    { value: "toggles", label: t("appearance.displayMode.toggles.label"), icon: List, hint: t("appearance.displayMode.toggles.hint") },
    { value: "actions", label: t("appearance.displayMode.actions.label"), icon: Square, hint: t("appearance.displayMode.actions.hint") },
    { value: "both", label: t("appearance.displayMode.both.label"), icon: Layers, hint: t("appearance.displayMode.both.hint") },
  ]
}

export function AppearancePanel() {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const displayMode = useAppearanceStore((s) => s.displayMode)
  const setDisplayMode = useAppearanceStore((s) => s.setDisplayMode)
  const personaVisible = useAppearanceStore((s) => s.personaVisible)
  const setPersonaVisible = useAppearanceStore((s) => s.setPersonaVisible)
  const themeChips = useThemeChips()
  const modeChips = useModeChips()

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
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("appearance.displayMode.title")}</p>
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            {modeChips.map(({ value, label, icon: Icon }) => {
              const active = displayMode === value
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDisplayMode(value)}
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
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            {modeChips.find((c) => c.value === displayMode)?.hint}
          </p>
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
