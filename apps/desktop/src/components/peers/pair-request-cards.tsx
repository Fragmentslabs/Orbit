import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { MonitorSmartphone, ShieldCheck } from "lucide-react"
import type { IncomingPairRequest } from "@shared/peers"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { peersApi } from "@/src/lib/ipc"
import { EMPTY_LIST, usePeersStore } from "@/src/stores/peers-store"

/**
 * Someone on the network asking to see this computer — anywhere in the app, not
 * only inside the modal. Viewing is the default; sending and files are opt-in,
 * decided here, per request. The code must match the other screen.
 */
export function PairRequestCards() {
  const incoming = usePeersStore((s) => s.snapshot?.incoming ?? EMPTY_LIST)
  if (incoming.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[340px] flex-col gap-2">
      {incoming.map((request) => (
        <RequestCard key={request.requestId} request={request} />
      ))}
    </div>
  )
}

function RequestCard({ request }: { request: IncomingPairRequest }) {
  const { t } = useTranslation()
  const [send, setSend] = useState(false)
  const [files, setFiles] = useState(false)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const seconds = Math.max(0, Math.round((request.expiresAt - now) / 1000))
  const code = `${request.code.slice(0, 3)} ${request.code.slice(3)}`

  return (
    <div role="alertdialog" aria-label={t("peers.request.title", { name: request.name })} className="pointer-events-auto rounded-xl border bg-popover p-4 shadow-lg">
      <div className="flex items-start gap-2.5">
        <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("peers.request.title", { name: request.name })}</p>
          <p className="text-[11px] text-muted-foreground">{t("peers.request.address", { address: request.address })}</p>
        </div>
        <span className="text-[11px] text-muted-foreground">{t("peers.request.expires", { seconds })}</span>
      </div>

      <div className="mt-3 rounded-lg bg-muted px-3 py-2 text-center">
        <p className="text-[11px] text-muted-foreground">{t("peers.request.code")}</p>
        <p className="font-mono text-2xl font-semibold tracking-[0.2em]">{code}</p>
        <p className="mt-0.5 flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
          <ShieldCheck className="size-3" />
          {t("peers.request.codeHint")}
        </p>
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground">{t("peers.request.viewNote")}</p>
      <label className="mt-2 flex items-center justify-between gap-2 text-xs">
        {t("peers.request.allowSend")}
        <Switch checked={send} onCheckedChange={(v) => setSend(!!v)} />
      </label>
      <label className="mt-1.5 flex items-center justify-between gap-2 text-xs">
        {t("peers.request.allowFiles")}
        <Switch checked={files} onCheckedChange={(v) => setFiles(!!v)} />
      </label>

      <div className="mt-3 flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void peersApi.decline(request.requestId)
          }}
        >
          {t("peers.request.decline")}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void peersApi.accept(request.requestId, { send, files })
          }}
        >
          {t("peers.request.accept")}
        </Button>
      </div>
    </div>
  )
}
