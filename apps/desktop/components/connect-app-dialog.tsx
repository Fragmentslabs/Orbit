import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import QRCode from "qrcode"
import { ChevronDown, Keyboard, QrCode, RefreshCw, ShieldAlert, Smartphone } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { MOBILE_DOWNLOAD_URL } from "@/src/lib/appLinks"
import { formatTime } from "@/src/lib/format"
import { companionApi, type CompanionStatus } from "@/src/lib/ipc"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ConnectAppDialog({ open, onOpenChange }: Props) {
  const { t, i18n } = useTranslation()
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<"qr" | "manual">("qr")
  const [devicesOpen, setDevicesOpen] = useState(false)
  const pollingRef = useRef<ReturnType<typeof setInterval>>()

  const fetchStatus = async () => {
    try {
      const s = await companionApi.status()
      setStatus(s)
      setError(null)
    } catch {
      setError(t("connectApp.statusError"))
    }
  }

  useEffect(() => {
    if (!open) return
    setTab("qr")
    setDevicesOpen(false)
    fetchStatus()
    pollingRef.current = setInterval(fetchStatus, 3000)
    // Pairing mode: while the modal is open, the current PIN stays
    // available via /api/ping so the app can connect with one tap when it finds
    // the desktop on the network (the PIN is already shown as text right here).
    void companionApi.setPairingMode(true)
    return () => {
      clearInterval(pollingRef.current)
      void companionApi.setPairingMode(false)
    }
    // Only the opening restarts the polling; fetchStatus is recreated on every render
    // and would enter a loop of clearing/recreating the interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!status?.running || !status.ip) return
    const payload = JSON.stringify({ h: status.ip, p: status.port, v: 1, pin: status.pin ?? undefined })
    QRCode.toDataURL(payload, {
      width: 256,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null))
    // `status.pin` goes into the deps on purpose: the PIN is regenerated every 5
    // minutes (PIN_TTL_MS) and without this the QR would keep offering the old one,
    // diverging from the PIN in text right below it.
  }, [status?.ip, status?.port, status?.running, status?.pin])

  const running = status?.running ?? false
  const deviceCount = status?.connectedClients?.length ?? 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex w-full items-center gap-2">
            <Smartphone className="size-5" />
            <span>{t("connectApp.title")}</span>
            <span
              className={cn("size-2 rounded-full", running ? "bg-green-500" : "bg-muted-foreground/60")}
              aria-hidden
            />
          </DialogTitle>
          <DialogDescription>{t("connectApp.description")}</DialogDescription>
        </DialogHeader>

        {/* Tabs: QR Code | Manual */}
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
          <button
            type="button"
            onClick={() => setTab("qr")}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              tab === "qr"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <QrCode className="size-3.5" />
            {t("connectApp.tabQr")}
          </button>
          <button
            type="button"
            onClick={() => setTab("manual")}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              tab === "manual"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Keyboard className="size-3.5" />
            {t("connectApp.tabManual")}
          </button>
        </div>

        <div className="flex flex-col items-center gap-4 py-1">
          {!running ? (
            <div className="flex size-56 flex-col items-center justify-center gap-2 rounded-xl bg-card px-4 text-center">
              <ShieldAlert className="size-8 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">{t("connectApp.serverInactive")}</span>
              {status?.bindError ? (
                <span className="text-[11px] text-destructive">{t("connectApp.portInUse")}</span>
              ) : null}
            </div>
          ) : tab === "qr" ? (
            qrDataUrl ? (
              <img src={qrDataUrl} alt={t("connectApp.qrAlt")} className="size-56 rounded-lg" />
            ) : (
              <div className="flex size-56 items-center justify-center rounded-xl bg-card">
                <RefreshCw className="size-6 animate-spin text-muted-foreground" />
              </div>
            )
          ) : (
            <>
              {status?.pin ? (
                <div className="text-center">
                  <p className="mb-1 text-xs text-muted-foreground">{t("connectApp.pinHint")}:</p>
                  <div className="flex items-center justify-center gap-1.5">
                    {status.pin.split("").map((d, i) => (
                      <span
                        key={i}
                        className="flex h-10 w-8 items-center justify-center rounded-md bg-muted font-mono text-2xl font-bold text-foreground"
                      >
                        {d}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {status?.ip ? (
                <div className="w-full rounded-lg bg-muted px-3 py-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">{t("connectApp.host")}</span>
                    <span className="font-mono text-foreground">{status.ip}</span>
                  </div>
                  <div className="mt-1 flex justify-between text-xs">
                    <span className="text-muted-foreground">{t("connectApp.portWs")}</span>
                    <span className="font-mono text-foreground">{status.port}</span>
                  </div>
                </div>
              ) : null}
            </>
          )}

          {/* Connected devices (accordion — hidden when there is none) */}
          {deviceCount > 0 ? (
            <div className="w-full">
              <button
                type="button"
                onClick={() => setDevicesOpen((v) => !v)}
                className="flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left hover:bg-muted/60"
              >
                <Smartphone className="size-3.5 text-muted-foreground" />
                <span className="flex-1 text-xs font-medium">
                  {t("connectApp.connectedDevices", { count: deviceCount })}
                </span>
                <ChevronDown
                  className={cn(
                    "size-3.5 text-muted-foreground transition-transform",
                    devicesOpen && "rotate-180",
                  )}
                />
              </button>
              {devicesOpen ? (
                <div className="mt-1.5 space-y-1.5">
                  {status?.connectedClients?.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-xs">
                      <Smartphone className="size-3 text-green-500" />
                      <span className="text-foreground">{c.deviceName}</span>
                      <span className="ml-auto text-muted-foreground">
                        {formatTime(c.connectedAt, i18n.language)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Don't have the app? — discreet link to the smart link /mobile (download on the phone) */}
          <p className="text-xs text-muted-foreground">
            {t("connectApp.noAppTitle")}{" "}
            <a
              href={MOBILE_DOWNLOAD_URL}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              {t("connectApp.downloadLink")}
            </a>
          </p>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
