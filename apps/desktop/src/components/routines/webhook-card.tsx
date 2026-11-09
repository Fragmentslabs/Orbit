import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, CopyIcon, RefreshCwIcon } from "lucide-react"
import type { WebhookInfo } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatWhen } from "@/src/lib/format"
import { routinesApi } from "@/src/lib/ipc"
import { useRoutinesStore } from "@/src/stores/routines-store"

/** How many of the latest calls the card lists. */
const SHOWN = 6

function CopyField({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 select-all break-all rounded-md bg-muted px-2 py-1 text-[11px]">{value}</code>
        <Button size="sm" variant="outline" onClick={copy} aria-label={t("routines.webhook.copy")}>
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {copied ? t("routines.webhook.copied") : t("routines.webhook.copy")}
        </Button>
      </div>
    </div>
  )
}

/**
 * The address of a webhook-triggered routine and what has called it. The address only works on
 * this computer; the card says so and leaves exposing it to the person's own tunnel.
 */
export function WebhookCard({ routineId, signed }: { routineId: string; signed: boolean }) {
  const { t, i18n } = useTranslation()
  const [info, setInfo] = useState<WebhookInfo | null>(null)
  const live = useRoutinesStore((s) => s.webhookActivity[routineId])

  const refresh = useCallback(() => routinesApi.webhook(routineId).then(setInfo, () => setInfo(null)), [routineId])
  // The first load and every change of the call log (or of the signature requirement).
  useEffect(() => {
    void refresh()
  }, [refresh, live, signed])

  const activity = live ?? info?.activity
  const deliveries = (activity?.deliveries ?? []).slice(-SHOWN).reverse()
  const waiting = activity?.pending.length ?? 0

  return (
    <div className="space-y-2.5 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-[13px] font-semibold">{t("routines.webhook.title")}</p>
        <Button size="sm" variant="ghost" title={t("routines.webhook.rotateHint")} onClick={() => void routinesApi.rotateWebhook(routineId).then(setInfo)}>
          <RefreshCwIcon className="size-3.5" />
          {t("routines.webhook.rotate")}
        </Button>
      </div>
      {info?.url ? (
        <CopyField label={t("routines.webhook.address")} value={info.url} />
      ) : (
        <p className="text-[11px] text-muted-foreground">{t("routines.webhook.notListening")}</p>
      )}
      {info?.secret && (
        <>
          <CopyField label={t("routines.webhook.secret")} value={info.secret} />
          <p className="text-[11px] text-muted-foreground">{t("routines.webhook.signHint")}</p>
        </>
      )}
      <div className="space-y-1">
        <p className="text-[11px] text-muted-foreground">
          {t("routines.webhook.deliveries")}
          {waiting > 0 && ` · ${t("routines.webhook.pending", { count: waiting })}`}
        </p>
        {deliveries.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t("routines.webhook.none")}</p>
        ) : (
          deliveries.map((d) => (
            <p key={d.at} className="flex gap-2 text-[11px]">
              <span className="w-28 shrink-0 text-muted-foreground">{formatWhen(d.at, i18n.language)}</span>
              <span className={cn(d.accepted ? "text-emerald-600" : "text-destructive")}>{d.accepted ? t("routines.webhook.accepted") : d.error}</span>
            </p>
          ))
        )}
      </div>
      <p className="border-t pt-2 text-[11px] text-muted-foreground">{t("routines.webhook.only")}</p>
      <p className="text-[11px] text-muted-foreground">{t("routines.webhook.gap")}</p>
    </div>
  )
}
