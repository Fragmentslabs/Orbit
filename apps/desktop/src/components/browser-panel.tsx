import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Bot, Cookie, ExternalLink, Trash2 } from "lucide-react"
import type { CookieRetention, LinkTarget } from "@shared/app-settings"
import { Button } from "@/components/ui/button"
import { SettingRow, SettingSelect, SettingSwitch } from "@/src/components/settings-row"
import { appSettingsApi } from "@/src/lib/ipc"
import { useAppSettings } from "@/src/stores/app-settings"

/** Preferências → Navegador: o navegador integrado e o que o agente pode fazer nele. */
export function BrowserPanel() {
  const { t } = useTranslation()
  const browser = useAppSettings((s) => s.settings.browser)
  const update = useAppSettings((s) => s.update)
  const [clearing, setClearing] = useState<"idle" | "busy" | "done">("idle")

  const clear = async () => {
    setClearing("busy")
    try {
      await appSettingsApi.clearBrowserData()
      setClearing("done")
      setTimeout(() => setClearing("idle"), 2000)
    } catch {
      setClearing("idle")
    }
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      <div>
        <p className="text-sm font-semibold">{t("settings.tabs.browser.label")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("settings.tabs.browser.description")}</p>
      </div>

      <div className="flex flex-col gap-2">
        <SettingRow icon={Bot} title={t("browserSettings.agent.title")} description={t("browserSettings.agent.description")}>
          <SettingSwitch
            checked={browser.agentTools}
            onChange={(agentTools) => update({ browser: { agentTools } })}
            label={t("browserSettings.agent.title")}
          />
        </SettingRow>

        <SettingRow icon={ExternalLink} title={t("browserSettings.links.title")} description={t("browserSettings.links.description")}>
          <SettingSelect<LinkTarget>
            value={browser.links}
            onChange={(links) => update({ browser: { links } })}
            options={[
              { value: "integrated", label: t("browserSettings.links.integrated") },
              { value: "external", label: t("browserSettings.links.external") },
            ]}
          />
        </SettingRow>

        <SettingRow icon={Cookie} title={t("browserSettings.cookies.title")} description={t("browserSettings.cookies.description")}>
          <SettingSelect<CookieRetention>
            value={browser.cookies}
            onChange={(cookies) => update({ browser: { cookies } })}
            options={[
              { value: "persistent", label: t("browserSettings.cookies.persistent") },
              { value: "until-quit", label: t("browserSettings.cookies.untilQuit") },
            ]}
          />
        </SettingRow>

        <SettingRow icon={Trash2} title={t("browserSettings.clear.title")} description={t("browserSettings.clear.description")}>
          <Button variant="outline" size="sm" disabled={clearing === "busy"} onClick={() => void clear()}>
            {clearing === "done" ? t("browserSettings.clear.done") : t("browserSettings.clear.button")}
          </Button>
        </SettingRow>
      </div>
    </div>
  )
}
