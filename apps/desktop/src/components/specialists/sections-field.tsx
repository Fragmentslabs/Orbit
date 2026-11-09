import { useTranslation } from "react-i18next"
import { AGENT_PROMPT_SECTIONS, type AgentPromptSection } from "@shared/agents"
import { Switch } from "@/components/ui/switch"
import { useAgentsStore } from "@/src/stores/agents-store"

/**
 * Which parts of the general chat's prompt this agent also takes, after its own prompt. Each
 * shows what it weighs, because a part costs tokens on every turn.
 */
export function SectionsField({ value, onChange }: { value: AgentPromptSection[]; onChange: (value: AgentPromptSection[]) => void }) {
  const { t } = useTranslation()
  const weights = useAgentsStore((s) => s.sectionWeights)
  const toggle = (id: AgentPromptSection, on: boolean) =>
    onChange(AGENT_PROMPT_SECTIONS.filter((s) => (s === id ? on : value.includes(s))))
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <span className="text-xs font-medium">{t("specialists.editor.sections")}</span>
        <p className="text-[11px] text-muted-foreground">{t("specialists.editor.sectionsHint")}</p>
      </div>
      <ul className="flex flex-col gap-1.5">
        {AGENT_PROMPT_SECTIONS.map((id) => (
          <li key={id} className="flex items-center gap-3 rounded-md border px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">{t(`specialists.piece.${id}`)}</div>
              <div className="text-[11px] text-muted-foreground">{t(`specialists.pieceHint.${id}`)}</div>
            </div>
            {weights[id] ? <span className="text-[11px] tabular-nums text-muted-foreground">~{weights[id]} tok</span> : null}
            <Switch checked={value.includes(id)} onCheckedChange={(on) => toggle(id, on)} aria-label={t(`specialists.piece.${id}`)} />
          </li>
        ))}
      </ul>
    </div>
  )
}
