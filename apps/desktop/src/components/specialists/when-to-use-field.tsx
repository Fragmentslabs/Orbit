import { useTranslation } from "react-i18next"
import { AGENT_LIMITS } from "@shared/agents"
import { Input } from "@/components/ui/input"

/** The one line that says when an agent is the right one — it drives suggestions and routing. */
export function WhenToUseField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const { t } = useTranslation()
  return (
    <label className="flex flex-col gap-1.5 text-xs font-medium">
      {t("specialists.editor.whenToUse")}
      <Input
        value={value}
        maxLength={AGENT_LIMITS.whenToUse}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("specialists.editor.whenToUsePlaceholder")}
        className="h-8 text-sm"
      />
      <span className="text-[11px] font-normal text-muted-foreground">{t("specialists.editor.whenToUseHint")}</span>
    </label>
  )
}
