import { useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, FileTextIcon, GlobeIcon, KeyRoundIcon, Loader2, PlayIcon, ShieldAlertIcon } from "lucide-react"
import type { RoutineScript, ScriptTestResult } from "@shared/routines"
import { scriptApproved } from "@shared/routines"
import { Button } from "@/components/ui/button"

/**
 * One script of a routine: what it does, what it is allowed to touch, its code, and (on the
 * routine screen) the button that approves exactly this version. Used by the proposal card
 * (read-only: creating the routine is the approval) and by the Scripts tab.
 */
export function ScriptCard({ script, trigger, onApprove, approving, onTest, onEdit, onRemove }: {
  script: RoutineScript
  /** This script is what wakes the routine. */
  trigger?: boolean
  /** Absent = read-only (the proposal card). */
  onApprove?: () => void
  approving?: boolean
  /** Runs it once and returns what happened; nothing is kept or fired. */
  onTest?: () => Promise<ScriptTestResult>
  /** Opens a chat to change it with the agent. */
  onEdit?: () => void
  /** Absent for the script that triggers the routine. */
  onRemove?: () => void
}) {
  const { t } = useTranslation()
  const approved = scriptApproved(script)
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState<ScriptTestResult | null>(null)
  const test = async () => {
    if (!onTest) return
    setTesting(true)
    try {
      setTested(await onTest())
    } finally {
      setTesting(false)
    }
  }
  return (
    <div className="space-y-2 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">{script.name}</span>
        {trigger && (
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
            {t("routines.scripts.triggerBadge")}
          </span>
        )}
        {onApprove &&
          (approved ? (
            <span className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-600">
              <CheckIcon className="size-3" />
              {t("routines.scripts.approved")}
            </span>
          ) : (
            <Button size="sm" className="h-7 text-xs" disabled={approving} onClick={onApprove}>
              {t("routines.scripts.approve")}
            </Button>
          ))}
      </div>
      <p className="text-xs text-muted-foreground">{script.summary}</p>
      <div className="flex flex-wrap gap-1.5">
        {script.hosts.map((host) => (
          <span key={host} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-px text-[11px]">
            <GlobeIcon className="size-3" />
            {host}
          </span>
        ))}
        {script.readFiles && (
          <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-px text-[11px]">
            <FileTextIcon className="size-3" />
            {t("routines.scripts.readsFiles")}
          </span>
        )}
        {script.secrets?.map((secret) => (
          <span key={secret} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-px font-mono text-[11px]">
            <KeyRoundIcon className="size-3" />
            {secret}
          </span>
        ))}
        {script.hosts.length === 0 && !script.readFiles && !script.secrets?.length && (
          <span className="text-[11px] text-muted-foreground">{t("routines.scripts.noAccess")}</span>
        )}
      </div>
      {onApprove && !approved && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <ShieldAlertIcon className="mt-px size-3 shrink-0" />
          {script.approvedFingerprint ? t("routines.scripts.changed") : t("routines.scripts.notApproved")}
        </p>
      )}
      {(onTest || onEdit || onRemove) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {onTest && (
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={testing} onClick={() => void test()}>
              {testing ? <Loader2 className="size-3 animate-spin" /> : <PlayIcon className="size-3" />}
              {t("routines.scripts.test")}
            </Button>
          )}
          {onEdit && (
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onEdit}>
              {t("routines.scripts.edit")}
            </Button>
          )}
          {onRemove && (
            <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={onRemove}>
              {t("routines.scripts.remove")}
            </Button>
          )}
        </div>
      )}
      {tested && (
        <div className="space-y-1 rounded-md border bg-muted/30 p-2 text-[11px]">
          <p className={tested.ok ? "font-medium text-emerald-600" : "font-medium text-destructive"}>
            {tested.ok ? t("routines.scripts.testOk") : t("routines.scripts.testFailed", { error: tested.error })}
          </p>
          {tested.ok && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono">
              {JSON.stringify(tested.result, null, 2)?.slice(0, 4000)}
            </pre>
          )}
          {tested.ok && tested.fires.length > 0 && (
            <p className="text-amber-600 dark:text-amber-400">{t("routines.scripts.testFires", { count: tested.fires.length })}</p>
          )}
          {tested.logs.length > 0 && <pre className="whitespace-pre-wrap break-words font-mono text-muted-foreground">{tested.logs.join("\n")}</pre>}
        </div>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">{t("routines.scripts.code")}</summary>
        <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 font-mono text-[11px]">
          {script.code}
        </pre>
      </details>
    </div>
  )
}
