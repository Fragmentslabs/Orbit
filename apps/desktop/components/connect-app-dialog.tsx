import { useEffect, useRef, useState } from "react"
import QRCode from "qrcode"
import { Smartphone, RefreshCw, ShieldAlert, Wifi, WifiOff } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { companionApi, type CompanionStatus } from "@/src/lib/ipc"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ConnectAppDialog({ open, onOpenChange }: Props) {
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollingRef = useRef<ReturnType<typeof setInterval>>()

  const fetchStatus = async () => {
    try {
      const s = await companionApi.status()
      setStatus(s)
      setError(null)
    } catch {
      setError("Não foi possível obter o status do servidor.")
    }
  }

  useEffect(() => {
    if (!open) return
    fetchStatus()
    pollingRef.current = setInterval(fetchStatus, 3000)
    return () => clearInterval(pollingRef.current)
  }, [open])

  useEffect(() => {
    if (!status?.running || !status.ip) return
    const payload = JSON.stringify({ h: status.ip, p: status.port, v: 1 })
    QRCode.toDataURL(payload, {
      width: 256,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null))
  }, [status?.ip, status?.port, status?.running])

  const running = status?.running ?? false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="size-5" />
            Conectar App
          </DialogTitle>
          <DialogDescription>
            Escaneie o QR code com o app Orbit para conectar.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          {/* Server Status */}
          <div className="flex items-center gap-2 text-sm">
            {running ? (
              <>
                <Wifi className="size-4 text-green-500" />
                <span className="text-green-600 dark:text-green-400">Servidor ativo</span>
              </>
            ) : (
              <>
                <WifiOff className="size-4 text-muted-foreground" />
                <span className="text-muted-foreground">Servidor inativo</span>
              </>
            )}
          </div>

          {/* QR Code */}
          {running && qrDataUrl ? (
            <div className="rounded-xl border-4 border-primary/20 p-2">
              <img
                src={qrDataUrl}
                alt="QR Code de conexão"
                className="size-56"
              />
            </div>
          ) : running ? (
            <div className="flex size-56 items-center justify-center rounded-xl border border-border bg-card">
              <RefreshCw className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="flex size-56 items-center justify-center rounded-xl border border-border bg-card">
              <ShieldAlert className="size-8 text-muted-foreground" />
            </div>
          )}

          {/* PIN */}
          {running && status?.pin ? (
            <div className="text-center">
              <p className="mb-1 text-xs text-muted-foreground">Ou digite o PIN no app:</p>
              <p className="tracking-[0.3em] text-2xl font-bold text-foreground">
                {status.pin.split("").map((d, i) => (
                  <span
                    key={i}
                    className={cn(
                      "inline-block mx-0.5 rounded-md bg-muted px-2 py-1 font-mono",
                    )}
                  >
                    {d}
                  </span>
                ))}
              </p>
            </div>
          ) : null}

          {/* Connection Info */}
          {running && status?.ip ? (
            <div className="w-full rounded-lg bg-muted px-3 py-2">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Host</span>
                <span className="font-mono text-foreground">{status.ip}</span>
              </div>
              <div className="flex justify-between text-xs mt-1">
                <span className="text-muted-foreground">Porta WS</span>
                <span className="font-mono text-foreground">{status.port}</span>
              </div>
            </div>
          ) : null}

          {/* Connected Clients */}
          {running && (status?.connectedClients?.length ?? 0) > 0 ? (
            <div className="w-full">
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                Dispositivos conectados
              </p>
              <div className="space-y-1">
                {status!.connectedClients.map((c, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-xs"
                  >
                    <Smartphone className="size-3 text-green-500" />
                    <span className="text-foreground">{c.deviceName}</span>
                    <span className="ml-auto text-muted-foreground">
                      {new Date(c.connectedAt).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <div className="flex justify-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchStatus}>
            <RefreshCw className="mr-1 size-3" />
            Atualizar
          </Button>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
