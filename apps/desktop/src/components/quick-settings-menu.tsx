import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Settings2, Sparkles, ShieldHalf, BrainCircuit } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ModelPicker } from "@/src/components/model-picker"
import { usePermissionMode, usePermissionPrefs } from "@/src/stores/permission-prefs"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSessionModel } from "@/src/stores/session-model-prefs"
import { useSessionReasoningPref } from "@/src/stores/session-reasoning"
import type { PermissionMode } from "@shared/chat"
import { Truncate } from "@/components/ui/truncated-text"

const PERMISSION_MODES: PermissionMode[] = ["ask", "approve", "full"]

/** Submenu controlled by hover, with a 100ms delay on leaving — the same pattern
 *  as the theme button in the sidebar account dropdown. */
function useHoverSubmenu() {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const onEnter = () => {
    clearTimeout(timer.current)
    setOpen(true)
  }
  const onLeave = () => {
    timer.current = setTimeout(() => setOpen(false), 100)
  }
  return { open, onOpenChange: setOpen, onEnter, onLeave }
}

/**
 * Quick settings menu of the input: agent mode (permission, code mode only),
 * thinking level and model — the options open as submenus on hover,
 * and the model item opens the selection dialog. It is the LAST step of the
 * composer collapsing: with no room left the individual selectors (ReasoningPicker,
 * ModelPicker) leave the row and this single button takes their place, glued to
 * the left of Send. Who decides that is the composer itself (useComposerLayout), not
 * a container-query class — so the button is rendered only when it is the one in use.
 * "showPermission" is likewise decided by the composer: the autonomy item only comes
 * in once the row no longer has room for the PermissionModePicker.
 */
export function QuickSettingsMenu({ sessionId, showPermission }: { sessionId?: string; showPermission?: boolean }) {
  const { t } = useTranslation()
  const [modelOpen, setModelOpen] = useState(false)
  const permission = useHoverSubmenu()
  const thinking = useHoverSubmenu()
  const selected = useSessionModel(sessionId)
  const catalog = useProviderStore((s) => s.catalog)
  const model = selected ? catalog[selected.providerId]?.models[selected.modelId] : undefined
  // Thinking and autonomy PER CHAT — the menu edits only the open conversation.
  const { enabled, variantId, update } = useSessionReasoningPref(sessionId, selected?.providerId, selected?.modelId)
  const permissionMode = usePermissionMode(sessionId)
  const setPermissionMode = usePermissionPrefs((s) => s.setMode)

  const variants = model?.variants ?? []
  // reasoningAlwaysOn models cannot turn it off: the displayed value is always a level.
  const canDisable = !model?.reasoningAlwaysOn
  const thinkingValue = !canDisable || enabled ? variantId ?? variants[0]?.id ?? "off" : "off"
  const activeVariant = variants.find((v) => v.id === thinkingValue)
  const thinkingLabel =
    thinkingValue === "off" || !activeVariant
      ? t("reasoning.off")
      : t(`reasoning.variants.${thinkingValue}`, { defaultValue: activeVariant.label })
  const modelName = model?.name ?? t("modelPicker.select")

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          title={t("input.quickSettings")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
        >
          <Settings2 className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-60 p-1.5">
          {showPermission && (
            <DropdownMenuSub open={permission.open} onOpenChange={permission.onOpenChange}>
              <DropdownMenuSubTrigger onMouseEnter={permission.onEnter} onMouseLeave={permission.onLeave}>
                <ShieldHalf className="size-4" />
                <span className="flex-1">{t("permissions.title")}</span>
                <span className="text-xs text-muted-foreground">{t(`permissions.${permissionMode}`)}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent onMouseEnter={permission.onEnter} onMouseLeave={permission.onLeave}>
                <DropdownMenuRadioGroup
                  value={permissionMode}
                  onValueChange={(value) => value && setPermissionMode(sessionId, value as PermissionMode)}
                >
                  {PERMISSION_MODES.map((id) => (
                    <DropdownMenuRadioItem key={id} value={id}>
                      {t(`permissions.${id}`)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {variants.length > 0 && (
            <DropdownMenuSub open={thinking.open} onOpenChange={thinking.onOpenChange}>
              <DropdownMenuSubTrigger onMouseEnter={thinking.onEnter} onMouseLeave={thinking.onLeave}>
                <BrainCircuit className="size-4" />
                <span className="flex-1">{t("input.modes.thinking.label")}</span>
                <span className="text-xs text-muted-foreground">{thinkingLabel}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent onMouseEnter={thinking.onEnter} onMouseLeave={thinking.onLeave}>
                <DropdownMenuRadioGroup
                  value={thinkingValue}
                  onValueChange={(value) => {
                    if (!value) return
                    if (value === "off") update({ enabled: false, variantId: undefined })
                    else update({ enabled: true, variantId: value })
                  }}
                >
                  {canDisable && <DropdownMenuRadioItem value="off">{t("reasoning.off")}</DropdownMenuRadioItem>}
                  {variants.map((variant) => (
                    <DropdownMenuRadioItem key={variant.id} value={variant.id}>
                      {t(`reasoning.variants.${variant.id}`, { defaultValue: variant.label })}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuItem
            onClick={() => {
              // Waits for the menu to close (animation ~100ms) before opening the
              // model dialog, to avoid a focus conflict with the autofocus input.
              setTimeout(() => setModelOpen(true), 120)
            }}
          >
            <Sparkles className="size-4" />
            <span className="flex-1">{t("input.quickSettingsModel")}</span>
            <Truncate text={modelName}>
              <span className="max-w-32 truncate text-xs text-muted-foreground">{modelName}</span>
            </Truncate>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ModelPicker sessionId={sessionId} hideTrigger open={modelOpen} onOpenChange={setModelOpen} />
    </>
  )
}
