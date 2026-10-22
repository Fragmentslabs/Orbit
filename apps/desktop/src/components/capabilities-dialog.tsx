import { useCallback } from "react"
import { useTranslation } from "react-i18next"

import { VOICE_DEFAULTS, type VoiceSettings } from "@shared/voice"

import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { CapabilityIcon } from "@/src/components/capability-icon"
import {
  CAPABILITIES,
  CAPABILITY_GROUPS,
  type CapabilityMode,
  type CapabilityRequirement,
} from "@/src/lib/capabilities"
import { useAppSettings } from "@/src/stores/app-settings"

/**
 * O mapa do que o Orbit faz — aberto pelo link discreto da tela inicial.
 *
 * Dialog e não navegação: trocar de tela jogaria fora o que a pessoa já
 * digitou no composer. E "Experimentar" preenche o campo em vez de enviar:
 * o exemplo é uma sugestão de partida, não uma ordem.
 */
export function CapabilitiesDialog({
  open,
  onOpenChange,
  mode,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: CapabilityMode
  onPick: (example: string) => void
}) {
  const { t } = useTranslation()
  // O estado da voz vem das mesmas Preferências que o engine lê: desligada, a
  // tool nem é registrada no turno. Ativar aqui é o mesmo que ativar lá — o
  // store empurra a cópia para o main na hora.
  const voice = useAppSettings((s) => s.settings.voice)
  // A gravação de vídeo depende das ferramentas de navegador: sem elas a tool
  // `browser_record` não existe no turno, e a linha prometeria um MP4 que não
  // sai. Mesma lógica da voz, outro recurso.
  const browserTools = useAppSettings((s) => s.settings.browser.agentTools)
  const update = useAppSettings((s) => s.update)

  const isOn = useCallback(
    (requirement: CapabilityRequirement) => {
      if (requirement === "browser") return browserTools
      if (requirement === "tts") return voice?.tts?.enabled ?? VOICE_DEFAULTS.tts.enabled
      return voice?.stt?.enabled ?? VOICE_DEFAULTS.stt.enabled
    },
    [browserTools, voice],
  )

  const enable = useCallback(
    (requirement: CapabilityRequirement) => {
      if (requirement === "browser") {
        update({ browser: { agentTools: true } })
        return
      }
      const current: VoiceSettings = {
        tts: { ...VOICE_DEFAULTS.tts, ...(voice?.tts ?? {}) },
        stt: { ...VOICE_DEFAULTS.stt, ...(voice?.stt ?? {}) },
        call: { ...VOICE_DEFAULTS.call, ...(voice?.call ?? {}) },
      }
      update({
        voice: {
          ...current,
          tts: requirement === "tts" ? { ...current.tts, enabled: true } : current.tts,
          stt: requirement === "stt" ? { ...current.stt, enabled: true } : current.stt,
        },
      })
    },
    [update, voice],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 p-0">
        <DialogHeader className="border-b border-border/60 px-4 py-3 pr-10 text-left">
          <DialogTitle className="text-sm">{t("chat.start.title")}</DialogTitle>
          <DialogDescription className="text-xs">{t("chat.start.subtitle")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(60vh,26rem)] overflow-y-auto px-2 py-2">
          {CAPABILITY_GROUPS.map((group) => {
            // O modo filtra o catálogo: no código não faz sentido oferecer
            // "converse por voz" como se fosse uma tarefa do repositório.
            const items = CAPABILITIES.filter(
              (capability) => capability.group === group && capability.modes.includes(mode),
            )
            if (items.length === 0) return null

            return (
              <section key={group} className="mb-3 last:mb-0">
                <h3 className="px-2 pb-1 text-[0.625rem] font-medium tracking-wide text-muted-foreground uppercase">
                  {t(`chat.start.groups.${group}`)}
                </h3>
                <ul>
                  {items.map((capability) => {
                    const example = capability.hasExample
                      ? t(`chat.start.items.${capability.id}.example`)
                      : null
                    // Desligado, o recurso não existe para o agente — a linha
                    // não promete exemplo nenhum, oferece ligar.
                    const off = capability.requires ? !isOn(capability.requires) : false
                    return (
                      <li
                        key={capability.id}
                        className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/60"
                      >
                        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground">
                          <CapabilityIcon capability={capability.id} className="size-3.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-foreground">
                            {t(`chat.start.items.${capability.id}.label`)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t(`chat.start.items.${capability.id}.desc`)}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground/80">
                            {/* Sem exemplo (chamada de voz, ditado) a linha diz
                                onde o recurso fica, em vez de prometer botão. */}
                            {off
                              ? t("chat.start.disabledHint")
                              : example
                                ? `“${example}”`
                                : t(`chat.start.items.${capability.id}.howTo`)}
                          </p>
                        </div>
                        {off && capability.requires ? (
                          <Button
                            size="sm"
                            className="mt-0.5 shrink-0"
                            onClick={() => enable(capability.requires!)}
                          >
                            {t(`chat.start.enable.${capability.requires}`)}
                          </Button>
                        ) : example ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="mt-0.5 shrink-0"
                            onClick={() => onPick(example)}
                          >
                            {t("chat.start.tryIt")}
                          </Button>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
