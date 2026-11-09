import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { AGENT_LIMITS } from "@shared/agents"
import type { Skill } from "@shared/skills"
import { cn } from "@/lib/utils"
import { skillsApi } from "@/src/lib/ipc"

/**
 * Chooses the skills fixed on an agent. Their full text goes into its system prompt, so each
 * row shows its size: pinning is a choice with a price, and the total is shown next to it.
 */
export function PinnedSkillsPicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const { t } = useTranslation()
  const [skills, setSkills] = useState<Skill[]>([])
  useEffect(() => {
    void skillsApi.list().then(setSkills)
  }, [])

  const toggle = (slug: string) =>
    onChange(value.includes(slug) ? value.filter((s) => s !== slug) : [...value, slug].slice(0, AGENT_LIMITS.pinnedSkills))
  const chars = skills.filter((s) => value.includes(s.slug)).reduce((sum, s) => sum + s.content.length, 0)

  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <span className="text-xs font-medium">{t("specialists.editor.pinned")}</span>
        <p className="text-[11px] text-muted-foreground">{t("specialists.editor.pinnedHint")}</p>
      </div>
      {skills.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{t("specialists.editor.pinnedNone")}</p>
      ) : (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {skills.map((skill) => {
            const on = value.includes(skill.slug)
            return (
              <li key={skill.slug}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(skill.slug)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted",
                    on && "border-primary bg-primary/10",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">@{skill.slug}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">~{Math.ceil(skill.content.length / 4)} tok</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {value.length > 0 && (
        <p className="text-[11px] text-muted-foreground">{t("specialists.editor.pinnedWeight", { count: value.length, tokens: Math.ceil(chars / 4) })}</p>
      )}
    </div>
  )
}
