import { ChevronDown } from "lucide-react"
import { useTranslation } from "react-i18next"
import { AGENT_TEMPLATE_IDS, agentFromTemplate } from "@shared/agent-templates"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { agentsApi } from "@/src/lib/ipc"

/** Adds a ready-made agent. It is saved as an ordinary agent the person then owns. */
export function TemplatesMenu() {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" variant="outline" className="h-8 gap-1 text-xs" />}>
        {t("specialists.templates.add")}
        <ChevronDown className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {AGENT_TEMPLATE_IDS.map((id) => (
          <DropdownMenuItem key={id} onClick={() => void agentsApi.save(agentFromTemplate(id, t(`specialists.templates.${id}.name`)))}>
            <div>
              <div className="text-xs font-medium">{t(`specialists.templates.${id}.name`)}</div>
              <div className="text-[11px] text-muted-foreground">{t(`specialists.templates.${id}.description`)}</div>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
