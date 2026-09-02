import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Globe, Heart, Star } from "lucide-react"
import { windowApi } from "@/src/lib/ipc"

const KO_FI_URL = "https://ko-fi.com/fragmentslabs"
const WEBSITE_URL = "https://fragmentslabs.com"
const GITHUB_URL = "https://github.com/fragmentslabs"

export function AboutPanel() {
  const { t } = useTranslation()
  // A versão vive no main (app.getVersion) — é a mesma dos artefatos do
  // electron-builder e a que o mobile mostra na sua tela Sobre.
  const [version, setVersion] = useState("")
  useEffect(() => {
    void windowApi.version().then(setVersion)
  }, [])

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{t("settings.about.title")}</p>
        {version && (
          <span className="shrink-0 rounded-full border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
            {t("settings.about.version", { version })}
          </span>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("settings.about.intro")}</p>
      <div className="rounded-lg border bg-muted/20 p-3">
        <p className="text-xs font-medium">Fragments Labs</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("settings.about.fraglab")}</p>
      </div>
      <div className="flex flex-col items-start gap-3">
        <Button className="gap-1.5" onClick={() => window.open(KO_FI_URL, "_blank")}>
          <Heart className="size-3.5" />
          {t("settings.about.support")}
        </Button>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <a
            href={WEBSITE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
          >
            <Globe className="size-3" />
            {t("settings.about.website")}
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
          >
            <Star className="size-3" />
            {t("settings.about.github")}
          </a>
        </div>
      </div>
    </div>
  )
}