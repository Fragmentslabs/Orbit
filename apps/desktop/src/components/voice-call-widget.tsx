import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowUpRight, Hand, Phone, PhoneOff } from "lucide-react"
import type { WorkspaceView } from "@/lib/workspace-context"
import { CallCaption } from "@/src/components/voice-call"
import { useVoiceCallHost } from "@/src/components/voice-call-host"
import { cn } from "@/lib/utils"

/**
 * Indicador flutuante da chamada. Fechado é só o telefone no canto inferior
 * direito; no hover (ou foco) abre o card com fase, legenda e controles.
 * O card abre para CIMA e nunca cobre o botão de enviar do composer.
 */
export function VoiceCallWidget({
  activeSessionId,
  view,
}: {
  activeSessionId?: string
  view: WorkspaceView
}) {
  const { t } = useTranslation()
  const host = useVoiceCallHost()
  const { call, callSessionId, callSessionTitle, openCall } = host
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  if (!call.active) return null

  // Na conversa da chamada o painel do composer é o lugar certo; o card
  // flutuante só serve quando a pessoa está em outra conversa/aba.
  if (view === "chat" && callSessionId != null && activeSessionId === callSessionId) return null

  const phase = call.phase
  const caption = phase === "speaking" ? call.caption : null
  const text = phase === "listening" ? call.partial : phase === "thinking" ? call.heard : call.saying
  const placeholder =
    phase === "listening" ? t("voice.call.listeningShort") : phase === "thinking" ? t("voice.call.thinking") : t("voice.call.speaking")
  const errorText = call.error === "reply" ? t("voice.call.replyError") : call.error
  const title = callSessionTitle || t("voice.call.inCall")

  return (
    <div
      ref={rootRef}
      className={cn(
        "absolute right-4 z-30 flex flex-col-reverse items-end",
        // Na conversa o composer ocupa o rodapé: o ícone sobe para ficar logo
        // acima dele e nunca cobrir o botão de enviar. Nas outras páginas não
        // há composer, então ele encosta no canto de verdade.
        view === "chat" ? "bottom-32" : "bottom-6",
      )}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node)) setOpen(false)
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("voice.call.inCall")}
        aria-expanded={open}
        title={t("voice.call.inCall")}
        className="relative flex size-9 items-center justify-center rounded-full border border-border bg-card text-primary shadow-lg transition-colors hover:bg-muted"
      >
        <Phone className="size-4" />
        <span aria-hidden className="absolute right-1.5 top-1.5 size-1.5 animate-pulse rounded-full bg-primary" />
      </button>

      {open && (
        <div
          role="region"
          aria-label={t("voice.call.inCall")}
          className="mb-2 w-[min(18rem,calc(100vw-2rem))] animate-in fade-in-0 slide-in-from-bottom-1 rounded-xl border border-border bg-card/95 p-2.5 shadow-lg backdrop-blur duration-150"
        >
          <div className="flex items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Phone className="size-3" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-foreground">{title}</p>
              <p className="text-[11px] text-muted-foreground">{placeholder}</p>
            </div>
          </div>

          <div aria-live="polite" className="mt-2 min-w-0">
            {errorText && !text ? (
              <p className="line-clamp-2 text-xs leading-snug text-destructive">{errorText}</p>
            ) : caption ? (
              <CallCaption lines={caption.lines} current={caption.current} />
            ) : (
              // Mesma altura da legenda para o card não pular quando a fala começa.
              <div title={text || placeholder} className="flex h-[2.75em] min-w-0 items-end overflow-hidden text-xs leading-snug">
                <span
                  className={cn(
                    "line-clamp-2",
                    !text
                      ? "text-muted-foreground"
                      : phase === "thinking" || call.waiting
                        ? "text-muted-foreground italic"
                        : "text-foreground",
                  )}
                >
                  {text || placeholder}
                </span>
              </div>
            )}
          </div>

          <div className="mt-2 flex items-center gap-1">
            <button
              type="button"
              onClick={openCall}
              disabled={!callSessionId}
              className="flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/85 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="truncate">{t("voice.call.open")}</span>
              <ArrowUpRight className="size-3.5 shrink-0" />
            </button>
            {phase !== "listening" && (
              <button
                type="button"
                onClick={call.interrupt}
                title={t("voice.call.interrupt")}
                aria-label={t("voice.call.interrupt")}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Hand className="size-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={call.hangUp}
              title={t("voice.call.hangUp")}
              aria-label={t("voice.call.hangUp")}
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-destructive text-white transition-colors hover:bg-destructive/90"
            >
              <PhoneOff className="size-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
