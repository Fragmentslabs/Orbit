import { useTranslation } from "react-i18next"
import { BUILTIN_PROFILES } from "@shared/agents"
import type { SpecialistProfile } from "@shared/chat"
import { cn } from "@/lib/utils"
import { AGENT_META } from "@/src/components/agent-meta"

/**
 * The craft an agent works in, if any. A craft agent brings that craft's tools and artifact
 * (its Motion tab, its Design canvas) while the words stay its own — which is how a person
 * ends up with several Motion agents, one per kind of video.
 */
export function CraftField({ value, onChange }: { value: SpecialistProfile | undefined; onChange: (next: SpecialistProfile | undefined) => void }) {
  const { t } = useTranslation()
  const options: Array<SpecialistProfile | undefined> = [undefined, ...BUILTIN_PROFILES]
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <span className="text-xs font-medium">{t("specialists.editor.craft")}</span>
        <p className="text-[11px] text-muted-foreground">{value ? t("specialists.editor.craftOn") : t("specialists.editor.craftHint")}</p>
      </div>
      <div className="flex flex-wrap gap-1">
        {options.map((craft) => (
          <button
            key={craft ?? "none"}
            type="button"
            aria-pressed={value === craft}
            onClick={() => onChange(craft)}
            className={cn("rounded-md border px-2.5 py-1 text-xs hover:bg-muted", value === craft && "border-primary bg-primary/10 text-primary")}
          >
            {craft ? t(AGENT_META[craft].name) : t("specialists.editor.craftNone")}
          </button>
        ))}
      </div>
    </div>
  )
}
