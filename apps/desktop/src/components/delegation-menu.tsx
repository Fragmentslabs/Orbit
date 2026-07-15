import { Bot, Network, Settings2 } from "lucide-react"
import { DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu"

/**
 * Itens de menu dos modos de delegação (dropdown "+" dos inputs):
 * Subagents (workers efêmeros em background) e Orchestra (plano + sessões
 * filhas no painel direito). Mutuamente exclusivos; a engrenagem abre o modal
 * de configuração do worker sem alternar o toggle.
 */
export function DelegationMenuItems({ subagents, orchestra, onSubagentsChange, onOrchestraChange, onOpenConfig }: {
  subagents: boolean
  orchestra: boolean
  onSubagentsChange: (value: boolean) => void
  onOrchestraChange: (value: boolean) => void
  onOpenConfig: () => void
}) {
  const gear = (
    <button
      type="button"
      className="ml-auto flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onOpenConfig()
      }}
    >
      <Settings2 className="!size-3.5" />
      <span className="sr-only">Configurar workers</span>
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
        <span className="flex-1">Subagents</span>
        {gear}
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem
        checked={orchestra}
        onCheckedChange={(checked) => {
          onOrchestraChange(checked)
          if (checked) onSubagentsChange(false)
        }}
      >
        <Network className="size-4" />
        <span className="flex-1">Orchestra</span>
        {gear}
      </DropdownMenuCheckboxItem>
    </>
  )
}
