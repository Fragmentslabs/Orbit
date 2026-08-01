import { Bot, Network, RefreshCw, Settings2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu"

/**
 * Itens de menu dos modos de delegação (dropdown "+" dos inputs):
 * Subagents (workers efêmeros em background) e Orchestra (plano + sessões
 * filhas no painel direito). Mutuamente exclusivos; a engrenagem abre o modal
 * de configuração do worker sem alternar o toggle.
 * Loop mode (modo código): revisa e itera até completar a tarefa.
 */
export function DelegationMenuItems({ subagents, orchestra, loop, onSubagentsChange, onOrchestraChange, onLoopChange, onOpenConfig, onOpenLoopConfig, mode }: {
  subagents: boolean
  orchestra: boolean
  loop?: boolean
  onSubagentsChange: (value: boolean) => void
  onOrchestraChange: (value: boolean) => void
  onLoopChange?: (value: boolean) => void
  onOpenConfig: () => void
  onOpenLoopConfig?: () => void
  /** Orquestração é exclusiva do modo code */
  mode?: "chat" | "code"
}) {
  const { t } = useTranslation()
  const gear = (onClick: () => void) => (
    <button
      type="button"
      className="ml-auto flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onClick()
      }}
    >
      <Settings2 className="!size-3.5" />
      <span className="sr-only">{t("delegation.configure")}</span>
    </button>
  )

  return (
    <>
      <DropdownMenuCheckboxItem
        checked={subagents}
        onCheckedChange={(checked) => {
          onSubagentsChange(checked)
          if (checked) onOrchestraChange(false)
        }}
      >
        <Bot className="size-4" />
        <span className="flex-1">{t("delegation.subagents")}</span>
        {gear(onOpenConfig)}
      </DropdownMenuCheckboxItem>
      {mode !== "chat" && (
      <DropdownMenuCheckboxItem
        checked={orchestra}
        onCheckedChange={(checked) => {
          onOrchestraChange(checked)
          if (checked) onSubagentsChange(false)
        }}
      >
        <Network className="size-4" />
        <span className="flex-1">{t("delegation.orchestra")}</span>
        {gear(onOpenConfig)}
      </DropdownMenuCheckboxItem>
      )}
      {onLoopChange && (
        <DropdownMenuCheckboxItem
          checked={loop ?? false}
          onCheckedChange={(checked) => onLoopChange(checked)}
        >
          <RefreshCw className="size-4" />
          <span className="flex-1">{t("delegation.loop")}</span>
          {onOpenLoopConfig && gear(onOpenLoopConfig)}
        </DropdownMenuCheckboxItem>
      )}
    </>
  )
}
