import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { agentIdOf, type UserProfileId } from "@shared/agents"
import { agentsApi } from "@/src/lib/ipc"

/**
 * The strip above a temporary agent's view: it says the agent was made for one plan and offers
 * "Save as agent". The prompt it saves is the one shown right below it, so the person reads it
 * before it can become one of their agents.
 */
export function SaveTemporary({ id, onSaved }: { id: UserProfileId; onSaved: () => void }) {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const save = async () => {
    setSaving(true)
    setError("")
    try {
      const result = await agentsApi.saveEphemeral(agentIdOf(id))
      if (result.ok) onSaved()
      else setError(t(`specialists.error.${result.reason}`))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium">{t("specialists.temporary.title")}</div>
        <p className="text-[11px] text-muted-foreground">{t("specialists.temporary.description")}</p>
        {error && <p className="text-[11px] text-destructive">{error}</p>}
      </div>
      <Button size="sm" disabled={saving} onClick={() => void save()}>
        {t("specialists.temporary.save")}
      </Button>
    </div>
  )
}
