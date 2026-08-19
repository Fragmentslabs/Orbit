import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Globe, Heart, Star } from "lucide-react"

const KO_FI_URL = "https://ko-fi.com/fragmentslabs"
const WEBSITE_URL = "https://fragmentslabs.com"
const GITHUB_URL = "https://github.com/fragmentslabs"

export function AboutPanel() {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      <div>
        <p className="text-sm font-semibold">{t("settings.about.title")}</p>
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