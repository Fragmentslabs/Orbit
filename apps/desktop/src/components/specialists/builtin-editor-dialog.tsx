import { useState } from "react"
import { useTranslation } from "react-i18next"
import { AGENT_LIMITS, type BuiltinOverride, type ProfileDescription } from "@shared/agents"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { agentsApi } from "@/src/lib/ipc"
import { PinnedSkillsPicker } from "./pinned-skills-picker"
import { WhenToUseField } from "./when-to-use-field"

/**
 * Edits a built-in agent. What ships stays underneath: the craft's tools and the context it
 * reads each turn cannot be changed here, only the instructions, the "when to use" line and
 * the pinned skills — and "Restore default" removes the whole override.
 */
export function BuiltinEditorDialog({ description, name, open, onOpenChange }: {
  description: ProfileDescription
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Required<BuiltinOverride>>({
    prompt: description.systemPrompt,
    whenToUse: description.whenToUse,
    pinnedSkills: description.pinnedSkills,
  })

  const save = async () => {
    await agentsApi.saveBuiltin(description.id, draft)
    onOpenChange(false)
  }
  const restore = async () => {
    await agentsApi.resetBuiltin(description.id)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent style={{ maxWidth: "40rem" }}>
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">{t("specialists.editor.editBuiltin", { name })}</DialogTitle>
          <DialogDescription className="text-xs">{t("specialists.editor.builtinDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto pr-1">
          <WhenToUseField value={draft.whenToUse} onChange={(whenToUse) => setDraft({ ...draft, whenToUse })} />
          <label className="flex flex-col gap-1.5 text-xs font-medium">
            {t("specialists.editor.prompt")}
            <Textarea
              value={draft.prompt}
              maxLength={AGENT_LIMITS.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              className="min-h-48 font-mono text-xs"
            />
            <span className="text-[11px] font-normal text-muted-foreground">
              ~{Math.ceil(draft.prompt.length / 4)} tok · {draft.prompt.length}/{AGENT_LIMITS.prompt}
            </span>
          </label>
          <PinnedSkillsPicker value={draft.pinnedSkills} onChange={(pinnedSkills) => setDraft({ ...draft, pinnedSkills })} />
        </div>
        <div className="flex justify-between gap-2">
          <Button variant="ghost" size="sm" disabled={!description.edited} onClick={() => void restore()}>
            {t("specialists.editor.restore")}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
