import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { AGENT_LIMITS } from "@shared/agents"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { agentsApi } from "@/src/lib/ipc"

/**
 * Limits an agent to some tools. Off = every tool the conversation would have. On = only the
 * chosen ones (and only if the conversation has them anyway: a list never grants a tool).
 */
export function ToolLimitField({ value, onChange }: { value: string[] | undefined; onChange: (next: string[] | undefined) => void }) {
  const { t } = useTranslation()
  const [known, setKnown] = useState<string[]>([])
  const [extra, setExtra] = useState("")
  useEffect(() => {
    void agentsApi.toolNames().then(setKnown)
  }, [])

  const limited = value !== undefined
  const names = [...new Set([...known, ...(value ?? [])])]
  const toggle = (name: string) => {
    const current = value ?? []
    onChange(current.includes(name) ? current.filter((n) => n !== name) : [...current, name].slice(0, AGENT_LIMITS.allowedTools))
  }
  const addExtra = () => {
    const name = extra.trim()
    if (name && /^[A-Za-z0-9_.:-]+$/.test(name) && !(value ?? []).includes(name)) onChange([...(value ?? []), name])
    setExtra("")
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <span className="text-xs font-medium">{t("specialists.editor.toolLimit")}</span>
          <p className="text-[11px] text-muted-foreground">{limited ? t("specialists.editor.toolLimitOn") : t("specialists.editor.toolLimitOff")}</p>
        </div>
        <Switch checked={limited} onCheckedChange={(on) => onChange(on ? [] : undefined)} aria-label={t("specialists.editor.toolLimit")} />
      </div>
      {limited && (
        <>
          <div className="flex flex-wrap gap-1">
            {names.map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={value.includes(name)}
                onClick={() => toggle(name)}
                className={cn(
                  "rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted",
                  value.includes(name) && "border-primary bg-primary/10 text-primary",
                )}
              >
                {name}
              </button>
            ))}
          </div>
          <Input
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addExtra())}
            placeholder={t("specialists.editor.toolLimitAdd")}
            className="h-7 font-mono text-xs"
          />
        </>
      )}
    </div>
  )
}
