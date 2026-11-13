import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import QRCode from "qrcode"
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Laptop,
  Loader2,
  Plug,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  XCircle,
} from "lucide-react"
import { PEER_PORT, type GrantedDevice, type OutgoingPairState } from "@shared/peers"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { MOBILE_DOWNLOAD_URL } from "@/src/lib/appLinks"
import { formatTime } from "@/src/lib/format"
import { companionApi, peersApi, type CompanionStatus } from "@/src/lib/ipc"
import { EMPTY_LIST, usePeersStore } from "@/src/stores/peers-store"

/** How long the search listens before saying nothing was found. */
const SEARCH_MS = 6000

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * "Connect devices": the phone (QR + PIN, the companion app — unchanged) and
 * another computer (Orbit ↔ Orbit over mutual TLS, see electron/lib/peers).
 */
export function ConnectAppDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation()
  const tab = usePeersStore((s) => s.connectTab)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex w-full items-center gap-2">
            <Plug className="size-5" />
            <span>{t("peers.title")}</span>
          </DialogTitle>
          <DialogDescription>{t("peers.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2">
          {(["phone", "computer"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => usePeersStore.setState({ connectTab: value })}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors",
                tab === value ? "border-primary bg-primary/5 text-foreground" : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              {value === "phone" ? <Smartphone className="size-4" /> : <Laptop className="size-4" />}
              {value === "phone" ? t("peers.tabPhone") : t("peers.tabComputer")}
            </button>
          ))}
        </div>

        {open && tab === "phone" ? <PhonePane /> : null}
        {open && tab === "computer" ? <ComputerPane /> : null}
      </DialogContent>
    </Dialog>
  )
}

// ─── Phone ───────────────────────────────────────────────────────────────────

function PhonePane() {
  const { t, i18n } = useTranslation()
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  // The QR is the main way in; the manual data (PIN, host, port) is one badge away.
  const [view, setView] = useState<"qr" | "manual">("qr")
  const [devicesOpen, setDevicesOpen] = useState(false)
  const pollingRef = useRef<ReturnType<typeof setInterval>>()

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        setStatus(await companionApi.status())
        setError(null)
      } catch {
        setError(t("connectApp.statusError"))
      }
    }
    void fetchStatus()
    pollingRef.current = setInterval(fetchStatus, 3000)
    // Pairing mode: while the phone pane is open, the current PIN stays
    // available via /api/ping so the app can connect with one tap when it finds
    // the desktop on the network (the PIN is already shown as text right here).
    void companionApi.setPairingMode(true)
    return () => {
      clearInterval(pollingRef.current)
      void companionApi.setPairingMode(false)
    }
  }, [t])

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
    // diverging from the PIN shown in the manual view.
  }, [status?.ip, status?.port, status?.running, status?.pin])

  const running = status?.running ?? false
  const deviceCount = status?.connectedClients?.length ?? 0

  /** Brings the WS + HTTP servers back up when they are down. */
  const restart = async () => {
    setRestarting(true)
    setError(null)
    try {
      setStatus(await companionApi.restart())
    } catch {
      setError(t("connectApp.statusError"))
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!running ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl bg-card px-4 py-10 text-center">
          <ShieldAlert className="size-8 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">{t("connectApp.serverInactive")}</span>
          {status?.bindError ? <span className="text-[11px] text-destructive">{t("connectApp.portInUse")}</span> : null}
          {/* Only shown when the server is down: nothing in this pane works until it is back. */}
          {status ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void restart()}
              disabled={restarting}
              className="mt-1 h-7 gap-1.5 px-2 text-[11px] text-muted-foreground"
            >
              {restarting ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              {restarting ? t("connectApp.restarting") : t("connectApp.restartServer")}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          {/* Fixed height: switching views must not move the badges below. */}
          <div className="flex h-56 w-full items-center justify-center">
            {view === "qr" ? (
              <div className="flex flex-col items-center gap-2.5">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt={t("connectApp.qrAlt")} className="size-44 rounded-xl" />
                ) : (
                  <div className="flex size-44 items-center justify-center rounded-xl bg-card">
                    <RefreshCw className="size-5 animate-spin text-muted-foreground" />
                  </div>
                )}
                <p className="text-xs text-muted-foreground">{t("connectApp.description")}</p>
              </div>
            ) : (
              <div className="flex w-full flex-col items-center gap-4">
                {status?.pin ? (
                  <div className="text-center">
                    <p className="mb-1.5 text-[11px] text-muted-foreground">{t("connectApp.pinHint")}</p>
                    <div className="flex justify-center gap-1.5">
                      {status.pin.split("").map((d, i) => (
                        <span key={i} className="flex h-11 w-8 items-center justify-center rounded-lg bg-muted font-mono text-2xl font-semibold text-foreground">
                          {d}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                {status?.ip ? (
                  <div className="flex flex-wrap justify-center gap-2 text-xs">
                    <span className="rounded-full border bg-card px-3 py-1">
                      <span className="text-muted-foreground">{t("connectApp.host")} </span>
                      <span className="font-mono font-medium text-foreground">{status.ip}</span>
                    </span>
                    <span className="rounded-full border bg-card px-3 py-1">
                      <span className="text-muted-foreground">{t("connectApp.portWs")} </span>
                      <span className="font-mono font-medium text-foreground">{status.port}</span>
                    </span>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {/* Small pill tabs under the QR code. */}
          <div role="group" className="inline-flex gap-0.5 rounded-full bg-muted p-0.5">
            {(["qr", "manual"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                onClick={() => setView(value)}
                className={cn(
                  "rounded-full px-3.5 py-1 text-xs font-medium transition-colors",
                  view === value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value === "qr" ? t("connectApp.tabQr") : t("connectApp.tabManual")}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {t("connectApp.noAppTitle")}{" "}
        <a href={MOBILE_DOWNLOAD_URL} target="_blank" rel="noreferrer" className="font-medium text-primary underline-offset-2 hover:underline">
          {t("connectApp.downloadLink")}
        </a>
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {deviceCount > 0 ? (
        <div className="w-full">
          <button
            type="button"
            onClick={() => setDevicesOpen((v) => !v)}
            className="flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left hover:bg-muted/60"
          >
            <Smartphone className="size-3.5 text-muted-foreground" />
            <span className="flex-1 text-xs font-medium">{t("connectApp.connectedDevices", { count: deviceCount })}</span>
            <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", devicesOpen && "rotate-180")} />
          </button>
          {devicesOpen ? (
            <div className="mt-1.5 space-y-1.5">
              {status?.connectedClients?.map((c, i) => (
                <div key={i} className="flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-xs">
                  <Smartphone className="size-3 text-green-500" />
                  <span className="text-foreground">{c.deviceName}</span>
                  <span className="ml-auto text-muted-foreground">{formatTime(c.connectedAt, i18n.language)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <GrantedDevicesList kind="phone" />
    </div>
  )
}

// ─── Another computer ────────────────────────────────────────────────────────

function ComputerPane() {
  const { t } = useTranslation()
  const snapshot = usePeersStore((s) => s.snapshot)
  const [address, setAddress] = useState("")
  const [addressError, setAddressError] = useState<string | null>(null)
  const [addressOpen, setAddressOpen] = useState(false)
  const [connectedOpen, setConnectedOpen] = useState(false)

  // The search runs for a few seconds and then says so: "nothing found" with a
  // button to look again, instead of a spinner that never ends.
  const [searching, setSearching] = useState(true)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>()

  const startSearch = () => {
    setSearching(true)
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => setSearching(false), SEARCH_MS)
  }

  useEffect(() => {
    void peersApi.browse(true)
    startSearch()
    return () => {
      clearTimeout(searchTimer.current)
      void peersApi.browse(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Clears what the beacon saw and listens again. */
  const refresh = async () => {
    startSearch()
    await peersApi.browse(false)
    await peersApi.browse(true)
  }

  const connectManual = () => {
    const raw = address.trim()
    if (!raw) {
      setAddressError(t("peers.manualPlaceholder"))
      return
    }
    const [host, portText] = raw.split(":")
    const port = portText ? Number(portText) : undefined
    void peersApi.pair(host, port).catch((err: Error) => setAddressError(err.message))
  }

  const outgoing = snapshot?.outgoing ?? null
  const discovered = snapshot?.discovered ?? EMPTY_LIST
  const peers = snapshot?.peers ?? EMPTY_LIST
  const desktopDevices = useMemo(() => (snapshot?.devices ?? []).filter((d) => d.kind === "desktop"), [snapshot?.devices])
  const connectedCount = peers.length + desktopDevices.length
  const selfValue = snapshot?.selfAddress
    ? snapshot.selfAddress.port === PEER_PORT
      ? snapshot.selfAddress.ip
      : `${snapshot.selfAddress.ip}:${snapshot.selfAddress.port}`
    : null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 py-1">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("peers.discoverable")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("peers.discoverableHint")}</p>
        </div>
        <Switch
          aria-label={t("peers.discoverable")}
          checked={!!snapshot?.discoverable}
          onCheckedChange={(v) => void peersApi.setDiscoverable(!!v)}
        />
      </div>

      {snapshot?.serverError ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-[11px] text-destructive">{t("peers.serverError", { error: snapshot.serverError })}</p>
      ) : null}

      {outgoing ? (
        <OutgoingCard state={outgoing} />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div className="flex items-center gap-2 px-3 py-2.5">
            <span className="flex-1 text-sm font-medium">{t("peers.found")}</span>
            <span className="rounded-full bg-muted px-2 py-px text-[11px] text-muted-foreground">{discovered.length}</span>
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              disabled={searching}
              aria-label={t("peers.refresh")}
              title={t("peers.refresh")}
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn("size-3.5", searching && "animate-spin")} />
            </Button>
          </div>
          {discovered.length === 0 ? (
            <div className="flex items-start gap-2 border-t bg-muted/30 px-3 py-2.5 text-[11px] text-muted-foreground">
              {searching ? <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin" /> : null}
              <span>{searching ? t("peers.searching") : t("peers.nobody")}</span>
            </div>
          ) : (
            discovered.map((peer) => (
              <div key={peer.peerId} className="flex items-center gap-2.5 border-t px-3 py-2">
                <span className="size-1.5 shrink-0 rounded-full bg-green-500" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-xs">
                  {peer.name}
                  <span className="text-muted-foreground"> · {peer.host}</span>
                </span>
                {peer.paired ? (
                  <span className="text-[11px] text-green-600 dark:text-green-400">{t("peers.connected")}</span>
                ) : (
                  <Button size="sm" variant="outline" className="h-6 px-3 text-xs" onClick={() => void peersApi.pair(peer.host, peer.port)}>
                    {t("peers.connect")}
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      )}

      <Fold title={t("peers.address")} open={addressOpen} onToggle={() => setAddressOpen((v) => !v)}>
        <div className="flex flex-col gap-2.5">
          {snapshot?.discoverable && selfValue ? <SelfAddress value={selfValue} /> : null}
          <div>
            <div className="flex gap-2">
              <Input
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value)
                  setAddressError(null)
                }}
                onKeyDown={(e) => e.key === "Enter" && connectManual()}
                placeholder={t("peers.manualPlaceholder")}
                aria-label={t("peers.manualLabel")}
                className="h-8 text-xs"
              />
              <Button size="sm" className="h-8 text-xs" onClick={connectManual}>
                {t("peers.connect")}
              </Button>
            </div>
            {addressError ? <p className="mt-1 text-[11px] text-destructive">{addressError}</p> : null}
          </div>
        </div>
      </Fold>

      {connectedCount > 0 ? (
        <Fold title={t("peers.connectedComputers")} count={connectedCount} open={connectedOpen} onToggle={() => setConnectedOpen((v) => !v)}>
          <div className="-mx-3 -my-3 divide-y">
            {peers.map((peer) => (
              <div key={peer.peerId} className="flex items-center gap-2 px-3 py-2">
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{t("peers.youSee")}</span>
                <span className="min-w-0 flex-1 truncate text-xs">
                  {peer.name}
                  <span className="text-muted-foreground">
                    {" · "}
                    {peer.online ? t("peers.online") : peer.error ? t(`peers.error_${peer.error}`) : t("peers.offline")}
                  </span>
                </span>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-muted-foreground" onClick={() => void peersApi.forget(peer.peerId)}>
                  {t("peers.forget")}
                </Button>
              </div>
            ))}
            {desktopDevices.map((device) => (
              <div key={device.id} className="flex items-center gap-2 px-3 py-2">
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{t("peers.seesYou")}</span>
                <span className="min-w-0 flex-1 truncate text-xs">
                  {device.deviceName}
                  {device.grants ? <span className="text-muted-foreground"> · {grantLabels(t, device.grants)}</span> : null}
                </span>
                <span className={cn("size-1.5 shrink-0 rounded-full", device.connected ? "bg-green-500" : "bg-muted-foreground/50")} aria-hidden />
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-destructive" onClick={() => void peersApi.revokeDevice(device.id)}>
                  {t("peers.revoke")}
                </Button>
              </div>
            ))}
          </div>
        </Fold>
      ) : null}
    </div>
  )
}

/** A quiet collapsible block: title, optional count, chevron. */
function Fold({ title, count, open, onToggle, children }: { title: string; count?: number; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40"
      >
        <span className="flex-1 text-sm font-medium">{title}</span>
        {count !== undefined ? <span className="rounded-full bg-muted px-2 py-px text-[11px] text-muted-foreground">{count}</span> : null}
        <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open ? <div className="border-t bg-muted/30 p-3">{children}</div> : null}
    </div>
  )
}

/**
 * This computer's address, for the other side to type when discovery doesn't find
 * it (Wi-Fi that blocks broadcast). Only shown while discoverable is on — the same
 * condition under which this machine accepts requests at all.
 */
function SelfAddress({ value }: { value: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="flex-1 text-muted-foreground">{t("peers.thisComputer")}</span>
      <span className="font-mono font-medium">{value}</span>
      <Button
        size="icon"
        variant="ghost"
        className="size-6"
        aria-label={copied ? t("peers.copied") : t("peers.copy")}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  )
}

function OutgoingCard({ state }: { state: OutgoingPairState }) {
  const { t } = useTranslation()
  const name = state.name ?? state.host
  const code = state.code ? `${state.code.slice(0, 3)} ${state.code.slice(3)}` : null
  const failed = state.status === "declined" || state.status === "expired" || state.status === "error"
  const message =
    state.status === "connecting"
      ? t("peers.pairingConnecting")
      : state.status === "waiting"
        ? t("peers.pairingWaiting", { name })
        : state.status === "accepted"
          ? t("peers.pairingAccepted", { name })
          : state.status === "expired"
            ? t("peers.pairingExpired")
            : state.status === "declined" && state.reason && state.reason !== "declined"
              ? t(`peers.pairingError_${state.reason}`)
              : state.status === "declined"
                ? t("peers.pairingDeclined")
                : t(`peers.pairingError_${state.reason ?? "unreachable"}`)

  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center gap-2 text-xs">
        {state.status === "accepted" ? (
          <CheckCircle2 className="size-4 text-green-500" />
        ) : failed ? (
          <XCircle className="size-4 text-destructive" />
        ) : (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
        <span className="font-medium">{name}</span>
      </div>
      {code && state.status === "waiting" ? (
        <p className="mt-3 text-center font-mono text-3xl font-semibold tracking-[0.2em]">{code}</p>
      ) : null}
      <p className="mt-2 text-[11px] text-muted-foreground">{message}</p>
      <div className="mt-3 flex justify-end gap-2">
        {failed ? (
          <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => void peersApi.pair(state.host, state.port)}>
            {t("peers.tryAgain")}
          </Button>
        ) : null}
        <Button size="sm" variant={state.status === "accepted" ? "default" : "ghost"} className="h-7 text-xs" onClick={() => void peersApi.cancelPair()}>
          {state.status === "accepted" || failed ? t("peers.done") : t("peers.cancel")}
        </Button>
      </div>
    </div>
  )
}

function GrantedDevicesList({ kind }: { kind: GrantedDevice["kind"] }) {
  const { t } = useTranslation()
  // Filter outside the selector: a new array on every read loops zustand 5's subscription.
  const all = usePeersStore((s) => s.snapshot?.devices ?? EMPTY_LIST)
  const devices = useMemo(() => all.filter((d) => d.kind === kind), [all, kind])
  if (devices.length === 0) return null
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t("peers.seeYou")}</p>
      <div className="space-y-1.5">
        {devices.map((device) => (
          <div key={device.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
            {device.kind === "phone" ? <Smartphone className="size-3.5 text-muted-foreground" /> : <Laptop className="size-3.5 text-muted-foreground" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{device.deviceName}</span>
              <span className="block text-[11px] text-muted-foreground">
                {device.kind === "phone" ? t("peers.kindPhone") : t("peers.kindComputer")}
                {device.grants ? ` · ${grantLabels(t, device.grants)}` : ""}
              </span>
            </span>
            <span className={cn("size-2 rounded-full", device.connected ? "bg-green-500" : "bg-muted-foreground/50")} aria-hidden />
            <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => void peersApi.revokeDevice(device.id)}>
              {t("peers.revoke")}
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

function grantLabels(t: (key: string) => string, grants: { send: boolean; files: boolean }): string {
  return [t("peers.grantView"), grants.send ? t("peers.grantSend") : null, grants.files ? t("peers.grantFiles") : null]
    .filter(Boolean)
    .join(", ")
}
