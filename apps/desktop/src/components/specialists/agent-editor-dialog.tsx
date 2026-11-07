import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AGENT_FEATURES,
  AGENT_ICONS,
  AGENT_LIMITS,
  emptyAgentInput,
  type AgentDefinition,
  type AgentInput,
} from "@shared/agents"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { agentsApi } from "@/src/lib/ipc"
import { AGENT_ICON_COMPONENTS } from "@/src/components/agent-meta"

/** The editable part of a saved agent. */
function inputOf(agent: AgentDefinition): AgentInput {
  const { name, icon, prompt, features, allowedTools, defaultModel, thinking } = agent
  return { name, icon, prompt, features: { ...features }, allowedTools, defaultModel, thinking }
}

/**
 * Create or edit an agent. A new one starts empty — no prompt, every switch off — and the
 * form says what each switch gives, so nothing is on by surprise.
 */
export function AgentEditorDialog({ agent, open, onOpenChange }: { agent: AgentDefinition | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<AgentInput>(() => (agent ? inputOf(agent) : emptyAgentInput()))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const save = async () => {
    setSaving(true)
    setError("")
    try {
      const result = await agentsApi.save(draft, agent?.id)
      if (result.ok) onOpenChange(false)
      else setError(t(`specialists.error.${result.reason}`))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent style={{ maxWidth: "40rem" }}>
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">{agent ? t("specialists.editor.editTitle") : t("specialists.editor.newTitle")}</DialogTitle>
          <DialogDescription className="text-xs">{t("specialists.editor.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto pr-1">
          <label className="flex flex-col gap-1.5 text-xs font-medium">
            {t("specialists.editor.name")}
            <Input
              value={draft.name}
              maxLength={AGENT_LIMITS.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder={t("specialists.editor.namePlaceholder")}
              className="h-8 text-sm"
              autoFocus
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">{t("specialists.editor.icon")}</span>
            <div className="flex flex-wrap gap-1">
              {AGENT_ICONS.map((icon) => {
                const Icon = AGENT_ICON_COMPONENTS[icon]
                return (
                  <button
                    key={icon}
                    type="button"
                    aria-label={icon}
                    aria-pressed={draft.icon === icon}
                    onClick={() => setDraft({ ...draft, icon })}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-muted",
                      draft.icon === icon && "border-primary bg-primary/10 text-primary",
                    )}
                  >
                    <Icon className="size-4" />
                  </button>
                )
              })}
            </div>
          </div>

          <label className="flex flex-col gap-1.5 text-xs font-medium">
            {t("specialists.editor.prompt")}
            <Textarea
              value={draft.prompt}
              maxLength={AGENT_LIMITS.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              placeholder={t("specialists.editor.promptPlaceholder")}
              className="min-h-40 font-mono text-xs"
            />
            <span className="text-[11px] font-normal text-muted-foreground">
              {t("specialists.editor.promptHint")} · {draft.prompt.length}/{AGENT_LIMITS.prompt}
            </span>
          </label>

          <div className="flex flex-col gap-1.5">
            <div>
              <span className="text-xs font-medium">{t("specialists.editor.features")}</span>
              <p className="text-[11px] text-muted-foreground">{t("specialists.editor.featuresHint")}</p>
            </div>
            <ul className="flex flex-col gap-1.5">
              {AGENT_FEATURES.map((feature) => (
                <li key={feature} className="flex items-center gap-3 rounded-md border px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium">{t(`specialists.block.${feature}.title`)}</div>
                    <div className="text-[11px] text-muted-foreground">{t(`specialists.block.${feature}.description`)}</div>
                  </div>
                  <Switch
                    checked={draft.features[feature]}
                    onCheckedChange={(on) => setDraft({ ...draft, features: { ...draft.features, [feature]: on } })}
                    aria-label={t(`specialists.block.${feature}.title`)}
                  />
                </li>
              ))}
            </ul>
          </div>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={saving || !draft.name.trim()} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
