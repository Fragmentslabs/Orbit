import { useTranslation } from "react-i18next"
import { Plug, X } from "lucide-react"
import { useSettingsUi } from "@/src/stores/settings-ui"

/**
 * Warning card shown above the input when the user tries to send a
 * message with no provider configured (first run). Sending is
 * blocked (the text is preserved) and the card offers the direct shortcut to the
 * settings. It goes away by itself when a provider is connected.
 */
export function ProviderHintCard({ visible, onDismiss }: {
  visible: boolean
  onDismiss: () => void
}) {
  const { t } = useTranslation()
  const openSettings = useSettingsUi((s) => s.openSettings)

  if (!visible) return null

  return (
    <div className="mx-auto w-full max-w-2xl pb-2">
      <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground/80">
        <Plug className="size-4 shrink-0 text-primary" />
        <span className="flex-1">{t("providerHint.hint")}</span>
        <button
          type="button"
          onClick={() => openSettings("providers")}
          className="shrink-0 rounded-md bg-foreground/10 px-2 py-1 font-medium text-foreground transition-colors hover:bg-foreground/20"
        >
          {t("providerHint.configure")}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("providerHint.dismiss")}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}