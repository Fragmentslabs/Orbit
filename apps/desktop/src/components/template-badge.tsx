import { useTranslation } from "react-i18next"
import { X } from "lucide-react"
import { usePromptInputController } from "@/src/components/ai/prompt-input"
import { CREATIONS } from "@/src/lib/creation-kinds"
import { disarmTemplateInput, hasTemplateField } from "@/src/lib/template-fields"
import { cn } from "@/lib/utils"

/**
 * Above the field, while a ready-made message is in the input: which template it is and, as
 * long as there is a [field] left to fill, that Tab jumps to it. Dismissing it only removes the
 * badge and gives Tab back — the text stays, it is the person's now.
 */
export function TemplateBadge() {
  const { t } = useTranslation()
  const controller = usePromptInputController()
  const creation = CREATIONS.find((c) => c.kind === controller.template)
  if (!creation) return null
  const { kind, Icon, tone } = creation
  const hasFields = hasTemplateField(controller.textInput.value)

  return (
    <div className="mb-1 flex w-full flex-wrap items-center justify-start gap-2 self-start px-1">
      <span className={cn("inline-flex items-center gap-1.5 rounded-md py-0.5 pr-1 pl-2 text-[11px]", tone)}>
        <Icon className="size-3" />
        {t("input.template.badge", { name: t(`panel.hub.${kind}.label`) })}
        <button
          type="button"
          aria-label={t("input.template.dismiss")}
          onClick={() => {
            if (controller.textareaRef.current) disarmTemplateInput(controller.textareaRef.current)
            controller.setTemplate(null)
          }}
          className="flex size-4 cursor-pointer items-center justify-center rounded-sm hover:bg-foreground/10"
        >
          <X className="size-3" />
        </button>
      </span>
      {hasFields && <span className="text-[11px] text-muted-foreground">{t("input.template.hint")}</span>}
    </div>
  )
}
