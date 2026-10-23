import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { FlaskConical, Image, KeyRound, Monitor, MousePointer2, ShieldCheck } from "lucide-react"
import { COMPUTER_SCREENSHOT_EDGES, type ComputerPointer } from "@shared/app-settings"
import type { ComputerStatus, ComputerTestResult } from "@shared/computer"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SettingRow, SettingSelect, SettingSwitch } from "@/src/components/settings-row"
import { computerApi } from "@/src/lib/ipc"
import { useAppSettings } from "@/src/stores/app-settings"

/** Preferências → Computador: o interruptor geral, o ponteiro e as permissões do macOS. */
export function ComputerPanel() {
  const { t } = useTranslation()
  const computer = useAppSettings((s) => s.settings.computer)
  const update = useAppSettings((s) => s.update)
  const [status, setStatus] = useState<ComputerStatus | null>(null)
  const [test, setTest] = useState<ComputerTestResult | "busy" | null>(null)

  const refresh = useCallback(() => {
    void computerApi.status().then(setStatus)
  }, [])

  // Permissão muda fora do app (Ajustes do Sistema): relê ao voltar o foco.
  useEffect(() => {
    refresh()
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [refresh])

  const runTest = async () => {
    setTest("busy")
    setTest(await computerApi.test())
    refresh()
  }

  const unavailable = status && !status.available
  const set = (patch: Partial<typeof computer>) => update({ computer: { ...computer, ...patch } })
  const screenOk = status?.screen === "granted"

  const testText = (result: ComputerTestResult) => {
    if (result.ok) {
      const [app, count] = result.message.split(": ")
      return count ? t("computerSettings.test.okApp", { app: `${app} — ${count}`, ms: result.ms }) : t("computerSettings.test.ok", { ms: result.ms })
    }
    if (result.message === "axDenied") return t("computerSettings.test.axDenied")
    return t("computerSettings.test.failed", { reason: result.message })
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      <div>
        <p className="text-sm font-semibold">{t("settings.tabs.computer.label")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("settings.tabs.computer.description")}</p>
      </div>

      {unavailable && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {t(`computerSettings.unavailable.${status.reason ?? "platform"}`)}
        </p>
      )}

      <div className={cn("flex flex-col gap-2", unavailable && "pointer-events-none opacity-50")}>
        <SettingRow icon={Monitor} title={t("computerSettings.master.title")} description={t("computerSettings.master.description")}>
          <SettingSwitch
            checked={computer.enabled && !unavailable}
            onChange={(enabled) => set({ enabled })}
            label={t("computerSettings.master.title")}
          />
        </SettingRow>

        <SettingRow icon={MousePointer2} title={t("computerSettings.pointer.title")} description={t("computerSettings.pointer.description")}>
          <SettingSelect<ComputerPointer>
            value={computer.pointer}
            onChange={(pointer) => set({ pointer })}
            options={[
              { value: "directed", label: t("computerSettings.pointer.directed") },
              { value: "global", label: t("computerSettings.pointer.global") },
            ]}
          />
        </SettingRow>

        <SettingRow icon={Image} title={t("computerSettings.edge.title")} description={t("computerSettings.edge.description")}>
          <SettingSelect<string>
            value={String(computer.maxScreenshotEdge)}
            onChange={(value) => set({ maxScreenshotEdge: Number(value) })}
            options={COMPUTER_SCREENSHOT_EDGES.map((edge) => ({ value: String(edge), label: `${edge} px` }))}
          />
        </SettingRow>

        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <div className="flex items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
              <KeyRound className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">{t("computerSettings.permissions.title")}</p>
              <p className="text-[11px] leading-tight text-muted-foreground">{t("computerSettings.permissions.description")}</p>
            </div>
          </div>
          <PermissionLine
            label={t("computerSettings.permissions.accessibility")}
            granted={Boolean(status?.accessibility)}
            onRequest={() => void computerApi.requestAccessibility().then(refresh)}
            onOpen={() => void computerApi.openPane("accessibility")}
          />
          <PermissionLine
            label={t("computerSettings.permissions.screen")}
            granted={screenOk}
            onRequest={() => void computerApi.requestScreen().then(refresh)}
            onOpen={() => void computerApi.openPane("screen")}
          />
          {/* Aberto por um terminal, o dono das permissões é o terminal — o
              usuário libera o "Electron" e nada muda (Fase 0). */}
          {status?.responsible ? (
            <p className="pl-11 text-[11px] text-amber-700 dark:text-amber-300">
              {t("computerSettings.permissions.responsible", { app: status.responsible })}
            </p>
          ) : (
            status?.dev && <p className="pl-11 text-[11px] text-muted-foreground">{t("computerSettings.permissions.dev")}</p>
          )}
        </div>

        <SettingRow icon={FlaskConical} title={t("computerSettings.test.title")} description={t("computerSettings.test.description")}>
          <div className="flex items-center gap-2">
            {test && test !== "busy" && (
              <span className={cn("max-w-48 truncate text-[11px]", test.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
                {testText(test)}
              </span>
            )}
            <Button variant="outline" size="sm" disabled={test === "busy"} onClick={() => void runTest()}>
              {t("computerSettings.test.button")}
            </Button>
          </div>
        </SettingRow>

        <SettingRow icon={ShieldCheck} title={t("computerSettings.safety.title")} description={t("computerSettings.safety.description")}>
          <span />
        </SettingRow>
      </div>
    </div>
  )
}

function PermissionLine({ label, granted, onRequest, onOpen }: { label: string; granted: boolean; onRequest?: () => void; onOpen: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2 pl-11">
      <span className="flex-1 text-xs">{label}</span>
      <Badge variant="outline" className={cn("text-[10px]", granted ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-amber-500/40 text-amber-600 dark:text-amber-400")}>
        {granted ? t("computerSettings.permissions.granted") : t("computerSettings.permissions.missing")}
      </Badge>
      {!granted && onRequest && (
        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onRequest}>
          {t("computerSettings.permissions.request")}
        </Button>
      )}
      <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onOpen}>
        {t("computerSettings.permissions.open")}
      </Button>
    </div>
  )
}
