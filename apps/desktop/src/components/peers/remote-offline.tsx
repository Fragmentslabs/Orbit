import { useTranslation } from "react-i18next"
import { WifiOff } from "lucide-react"

/** A page that reads the other desktop's data while that desktop is unreachable. */
export function RemoteOffline({ name, error }: { name: string; error?: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
      <WifiOff className="size-5" />
      <p>{t("peers.env.offline", { name })}</p>
      {error ? <p className="text-xs">{t(`peers.error_${error}`)}</p> : null}
    </div>
  )
}
