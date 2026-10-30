import { Bot, Network, RefreshCw, Settings2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

/**
 * Menu items of the delegation modes ("+" dropdown of the inputs):
 * Subagents (ephemeral workers in the background) and Orchestra (plan + child
 * sessions in the right panel). Mutually exclusive; the gear opens the worker
 * settings modal without toggling the switch.
 * Loop mode (code mode): reviews and iterates until the task is complete.
 */
export function DelegationMenuItems({ subagents, orchestra, loop, onSubagentsChange, onOrchestraChange, onLoopChange, onOpenConfig, onOpenLoopConfig, mode }: {
  subagents: boolean
  orchestra: boolean
  loop?: boolean
  onSubagentsChange: (value: boolean) => void
  onOrchestraChange: (value: boolean) => void
  onLoopChange?: (value: boolean) => void
  /** Subagents or Orchestra gear: each opens its own settings */
  onOpenConfig: (kind: "subagents" | "orchestra") => void
  onOpenLoopConfig?: () => void
  /** Orchestration is exclusive to code mode */
  mode?: "chat" | "code"
}) {
  const { t } = useTranslation()
  const gear = (onClick: () => void, checked: boolean) => (
    <button
      type="button"
      className={cn(
        "absolute top-1/2 -translate-y-1/2 flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
        checked ? "right-8" : "right-2",
      )}
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
        className={cn(subagents && "pr-14")}
      >
        <Bot className="size-4" />
        <span className="flex-1">{t("delegation.subagents")}</span>
        {gear(() => onOpenConfig("subagents"), subagents)}
      </DropdownMenuCheckboxItem>
      {mode !== "chat" && (
      <DropdownMenuCheckboxItem
        checked={orchestra}
        onCheckedChange={(checked) => {
          onOrchestraChange(checked)
          if (checked) onSubagentsChange(false)
        }}
        className={cn(orchestra && "pr-14")}
      >
        <Network className="size-4" />
        <span className="flex-1">{t("delegation.orchestra")}</span>
        {gear(() => onOpenConfig("orchestra"), orchestra)}
      </DropdownMenuCheckboxItem>
      )}
      {onLoopChange && (
        <DropdownMenuCheckboxItem
          checked={loop ?? false}
          onCheckedChange={(checked) => onLoopChange(checked)}
          // In the orchestra the reviewer is the orchestrator (Orchestra
          // Settings) — Loop does not apply.
          disabled={orchestra}
          title={orchestra ? t("delegation.loopOffInOrchestra") : undefined}
          className={cn(loop && "pr-14")}
        >
          <RefreshCw className="size-4" />
          <span className="flex-1">{t("delegation.loop")}</span>
          {onOpenLoopConfig && gear(onOpenLoopConfig, loop ?? false)}
        </DropdownMenuCheckboxItem>
      )}
    </>
  )
}
