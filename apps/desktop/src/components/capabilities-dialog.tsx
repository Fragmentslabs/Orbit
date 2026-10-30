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
 * The map of what Orbit does — opened by the discreet link on the start screen.
 *
 * A dialog and not navigation: switching screens would throw away what the person has already
 * typed in the composer. And "Try it" fills the field instead of sending:
 * the example is a starting suggestion, not an order.
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
  // The voice state comes from the same Preferences the engine reads: turned off, the
  // tool is not even registered in the turn. Enabling here is the same as enabling there — the
  // store pushes the copy to the main process right away.
  const voice = useAppSettings((s) => s.settings.voice)
  // Video recording depends on the browser tools: without them the
  // `browser_record` tool does not exist in the turn, and the row would promise an MP4 that does not
  // come out. Same logic as voice, another feature.
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
            // The mode filters the catalog: in code it makes no sense to offer
            // "talk by voice" as if it were a task of the repository.
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
                    // Turned off, the feature does not exist for the agent — the row
                    // promises no example at all, it offers to turn it on.
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
                            {/* Without an example (voice call, dictation) the row says
                                where the feature lives, instead of promising a button. */}
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
