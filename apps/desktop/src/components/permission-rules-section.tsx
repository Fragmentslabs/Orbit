import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ShieldCheck, ShieldQuestion, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/hint"
import { permissionsApi, type LearnedRule, type TrustedRule } from "@/src/lib/ipc"

/**
 * The rules Orbit learned: what it stopped asking for good, and what it is still
 * counting.
 *
 * Without this screen the allowlist is invisible — the user allowed something
 * once, in a dropdown, and has no way to see what was released or to take it
 * back. The second list is the point of the counting: a rule the user keeps
 * allowing can be settled from here, without waiting for the next request to
 * open the dropdown again.
 */
export function PermissionRulesSection() {
  const { t } = useTranslation()
  const [trusted, setTrusted] = useState<TrustedRule[]>([])
  const [learned, setLearned] = useState<LearnedRule[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const data = await permissionsApi.rules()
    setTrusted(data.trusted)
    setLearned(data.learned)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
      await load()
    } finally {
      setBusy(false)
    }
  }

  // A rule approved a single time is noise; repetition is the signal.
  const pending = learned.filter((rule) => rule.approvals > 1)

  return (
    <div className="border-t pt-4">
      <p className="text-xs font-medium text-muted-foreground">{t("preferences.rules.title")}</p>
      <p className="mt-1 text-[11px] leading-tight text-muted-foreground/70">
        {t("preferences.rules.description")}
      </p>

      <div className="mt-3 flex flex-col gap-1.5">
        {trusted.map((rule) => (
          <div key={rule.ruleId} className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5">
            <ShieldCheck className="size-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate text-[11px]" title={rule.label ?? rule.ruleId}>
              {rule.label ?? rule.ruleId}
            </span>
            <Hint label={t("preferences.rules.revoke")}>
              <button
                type="button"
                disabled={busy}
                aria-label={t("preferences.rules.revoke")}
                onClick={() => void run(() => permissionsApi.revoke(rule.ruleId))}
                className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-destructive disabled:opacity-40"
              >
                <X className="size-3.5" />
              </button>
            </Hint>
          </div>
        ))}

        {pending.length > 0 && (
          <>
            <p className="mt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
              {t("preferences.rules.pending")}
            </p>
            {pending.map((rule) => (
              <div key={rule.ruleId} className="flex items-center gap-2 rounded-lg border border-dashed border-border px-2.5 py-1.5">
                <ShieldQuestion className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={rule.label}>
                  {rule.label}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                  {t("preferences.rules.times", { count: rule.approvals })}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[10px]"
                  disabled={busy}
                  onClick={() => void run(() => permissionsApi.allowAlways(rule.ruleId, rule.label))}
                >
                  {t("preferences.rules.makePermanent")}
                </Button>
              </div>
            ))}
          </>
        )}

        {trusted.length === 0 && pending.length === 0 && (
          <p className="text-[11px] leading-tight text-muted-foreground/60">
            {t("preferences.rules.empty")}
          </p>
        )}
      </div>
    </div>
  )
}
