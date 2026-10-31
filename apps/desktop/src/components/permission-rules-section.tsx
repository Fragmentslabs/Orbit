import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronLeft, ChevronRight, ShieldCheck, ShieldQuestion, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/hint"
import { permissionsApi, type LearnedRule, type TrustedRule } from "@/src/lib/ipc"

/**
 * A rule for an MCP server is the server's own permission mode, edited in the
 * server dialog — and the mode is what decides. Showing the rule here as well
 * would be two controls for the same thing, in two different screens, with the
 * one that actually wins being the invisible one. Everything else — commands,
 * files, the computer — is what this screen is about.
 */
const isServerRule = (ruleId: string) => ruleId.startsWith("mcp:")

function usePermissionRules() {
  const [trusted, setTrusted] = useState<TrustedRule[]>([])
  const [learned, setLearned] = useState<LearnedRule[]>([])

  const load = useCallback(async () => {
    const data = await permissionsApi.rules()
    setTrusted(data.trusted.filter((rule) => !isServerRule(rule.ruleId)))
    setLearned(data.learned.filter((rule) => !isServerRule(rule.ruleId)))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // A rule approved a single time is noise; repetition is the signal.
  const pending = learned.filter((rule) => rule.approvals > 1)

  return { trusted, pending, load }
}

/**
 * The line that opens the screen, in the same shape as the other sub-screens
 * of the settings panel: full width, a border, a chevron and a quiet count.
 */
export function PermissionRulesRow({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation()
  const { trusted } = usePermissionRules()

  return (
    <div className="border-t pt-4">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center justify-between rounded-lg border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent/50 hover:text-foreground"
      >
        <span className="min-w-0 truncate">{t("preferences.rules.row")}</span>
        <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
          {trusted.length > 0 && (
            <span className="text-[11px] tabular-nums text-muted-foreground/70">
              {t("preferences.rules.allowed", { count: trusted.length })}
            </span>
          )}
          <ChevronRight className="size-4" />
        </span>
      </button>
    </div>
  )
}

/**
 * The screen itself: what Orbit stopped asking for, and what it is still
 * counting.
 *
 * Without it the allowlist is invisible — the user allowed something once, in
 * a dropdown, and has no way to see what was released or to take it back. The
 * second list is the point of the counting: a rule the user keeps allowing can
 * be settled from here, without waiting for the next request to open the
 * dropdown again.
 */
export function PermissionRulesPanel({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const { trusted, pending, load } = usePermissionRules()
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto pr-1">
      <button
        type="button"
        onClick={onBack}
        className="flex w-fit items-center gap-1.5 rounded-lg px-1 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {t("preferences.rules.back")}
      </button>

      <div>
        <p className="text-sm font-semibold">{t("preferences.rules.title")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("preferences.rules.description")}</p>
      </div>

      {trusted.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">{t("preferences.rules.trusted")}</p>
          <div className="flex flex-col gap-1.5">
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
          </div>
        </div>
      )}

      {pending.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">{t("preferences.rules.pending")}</p>
          <div className="flex flex-col gap-1.5">
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
          </div>
        </div>
      )}

      {trusted.length === 0 && pending.length === 0 && (
        <p className="text-[11px] leading-tight text-muted-foreground/60">{t("preferences.rules.empty")}</p>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground/60">{t("preferences.rules.mcpNote")}</p>
    </div>
  )
}
