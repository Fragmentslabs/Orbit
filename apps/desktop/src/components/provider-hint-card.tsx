import { useTranslation } from "react-i18next"
import { Plug, X } from "lucide-react"
import { useSettingsUi } from "@/src/stores/settings-ui"

/**
 * Card de aviso exibido acima do input quando o usuário tenta enviar uma
 * mensagem sem nenhum provedor configurado (primeira execução). O envio é
 * bloqueado (o texto é preservado) e o card oferece o atalho direto para a
 * configuração. Some sozinho quando um provedor é conectado.
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