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
import { usePermissionPrefs } from "@/src/stores/permission-prefs"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSessionModel } from "@/src/stores/session-model-prefs"
import { useReasoningPrefs } from "@/src/stores/reasoning-prefs"
import type { PermissionMode } from "@shared/chat"

const PERMISSION_MODES: PermissionMode[] = ["ask", "approve", "full"]

/** Submenu controlado por hover, com atraso de 100ms ao sair — mesmo padrão
 *  do botão de tema no dropdown de conta da sidebar. */
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
 * Menu de configurações rápidas do input: modo do agente (permissão, só modo
 * code), nível de thinking e modelo — as opções abrem como submenus ao passar
 * o hover, e o item de modelo abre o diálogo de seleção. Aparece ao lado do
 * botão "+" apenas em containers estreitos (`@xl:hidden` no trigger) — onde
 * os seletores individuais (ReasoningPicker, ModelPicker) saem da linha e o
 * botão de enviar estouraria o input.
 */
export function QuickSettingsMenu({ sessionId, showPermission }: { sessionId?: string; showPermission?: boolean }) {
  const { t } = useTranslation()
  const [modelOpen, setModelOpen] = useState(false)
  const permission = useHoverSubmenu()
  const thinking = useHoverSubmenu()
  const selected = useSessionModel(sessionId)
  const catalog = useProviderStore((s) => s.catalog)
  const model = selected ? catalog[selected.providerId]?.models[selected.modelId] : undefined
  const { enabled, variantId, update } = useReasoningPrefs(selected?.providerId, selected?.modelId)
  const permissionMode = usePermissionPrefs((s) => s.mode)
  const setPermissionMode = usePermissionPrefs((s) => s.setMode)

  const variants = model?.variants ?? []
  // Modelos reasoningAlwaysOn não podem desligar: o valor exibido é sempre um nível.
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
          className="flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground @xl:hidden"
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
                  onValueChange={(value) => value && setPermissionMode(value as PermissionMode)}
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
              // Aguarda o menu fechar (animação ~100ms) antes de abrir o diálogo
              // de modelo, para evitar conflito de foco com o input autofocus.
              setTimeout(() => setModelOpen(true), 120)
            }}
          >
            <Sparkles className="size-4" />
            <span className="flex-1">{t("input.quickSettingsModel")}</span>
            <span className="max-w-32 truncate text-xs text-muted-foreground">{modelName}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ModelPicker sessionId={sessionId} hideTrigger open={modelOpen} onOpenChange={setModelOpen} />
    </>
  )
}
