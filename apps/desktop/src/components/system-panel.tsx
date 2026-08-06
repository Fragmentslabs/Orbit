import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { FolderOpen, Loader2, MonitorCog } from "lucide-react"
import { openWithApi } from "@/src/lib/ipc"

interface OpenWithStatus {
  supported: boolean
  registered: boolean
  error?: string
}

/**
 * Integrações com o sistema operacional. Hoje só o "Abrir com Orbit" do
 * Explorer (Windows) — registrado em HKCU, sem necessidade de admin.
 */
export function SystemPanel() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<OpenWithStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void openWithApi.status().then(setStatus)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const toggle = async () => {
    if (!status?.supported || busy) return
    setBusy(true)
    try {
      if (status.registered) {
        await openWithApi.unregister()
      } else {
        await openWithApi.register()
      }
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const enabled = status?.registered ?? false

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto pr-1">
      <div>
        <p className="text-sm font-semibold">{t("system.title")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("system.description")}
        </p>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("system.openWith.title")}</p>
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-input bg-background px-3 py-2.5 transition-colors hover:bg-accent/50">
          <FolderOpen className="size-4 text-muted-foreground" />
          <span className="flex-1">
            <span className="block text-sm">{t("system.openWith.enabled")}</span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground/70">
              {t("system.openWith.description")}
            </span>
          </span>
          {busy ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              disabled={!status?.supported}
              onClick={() => void toggle()}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                enabled ? "bg-primary" : "bg-input"
              } ${!status?.supported ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <span
                className={`pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform ${
                  enabled ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          )}
        </label>
        {status && !status.supported && (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
            <MonitorCog className="size-3 shrink-0" />
            {t("system.openWith.devHint")}
          </p>
        )}
      </div>
    </div>
  )
}
