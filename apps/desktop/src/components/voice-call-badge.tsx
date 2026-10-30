import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowUpRight, ChevronDown, Hand, Phone, PhoneOff } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { CallCaption } from "@/src/components/voice-call"
import { useVoiceCallHost } from "@/src/components/voice-call-host"
import { cn } from "@/lib/utils"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Call badge in the header, in the same drawing as the Computer Use "Controlling <app>"
 * chip: a pill with the phone and the pulse, which on hover (or click)
 * opens DOWNWARDS the call card with phase, caption and controls.
 *
 * It disappears when the person is in the call's own conversation — there the composer
 * panel is the right place — and appears in any other conversation or tab,
 * including the pages without a composer (memories, models, tools…).
 */

/** Hover wait before opening: passing the mouse over the header on the way to something else opens nothing. */
const PEEK_OPEN_MS = 300
/** Leaving tolerance: it gives time to take the mouse from the chip to the card buttons. */
const PEEK_CLOSE_MS = 200

export function VoiceCallBadge({ activeSessionId }: { activeSessionId?: string }) {
  const { t } = useTranslation()
  const host = useVoiceCallHost()
  const { call, callSessionId, callSessionTitle, openCall } = host
  const [held, setHeld] = useState(false)
  const [peek, setPeek] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The call is over: nothing stays open for the next time.
  useEffect(() => {
    if (call.active) return
    setHeld(false)
    setPeek(false)
  }, [call.active])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  if (!call.active) return null

  // In the call conversation the composer panel is the right place; the badge only
  // serves when the person is in another conversation/tab.
  if (callSessionId != null && activeSessionId === callSessionId) return null

  const phase = call.phase
  const caption = phase === "speaking" ? call.caption : null
  const text = phase === "listening" ? call.partial : phase === "thinking" ? call.heard : call.saying
  const placeholder =
    phase === "listening" ? t("voice.call.listeningShort") : phase === "thinking" ? t("voice.call.thinking") : t("voice.call.speaking")
  const errorText = call.error === "reply" ? t("voice.call.replyError") : call.error
  const title = callSessionTitle || t("voice.call.inCall")

  // The pill text IS the state indicator: "Listening" and "Speaking" share the
  // same gold and the same three dots — only the verb changes. "Thinking"
  // stays in gray and without dots: there no sound is happening.
  const stateLabel =
    phase === "listening"
      ? t("voice.call.listeningShort")
      : phase === "speaking"
        ? t("voice.call.speaking")
        : phase === "thinking"
          ? t("voice.call.thinking")
          : null
  const stateDots = phase === "listening" || phase === "speaking"

  const schedule = (next: boolean, ms: number) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setPeek(next), ms)
  }
  const hover = {
    onMouseEnter: () => schedule(true, PEEK_OPEN_MS),
    onMouseLeave: () => schedule(false, PEEK_CLOSE_MS),
  }
  const open = held || peek

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (next) {
          if (details.reason === "trigger-press") setHeld(true)
          return
        }
        // Click on the chip with the card only peeking: it pins instead of closing.
        if (details.reason === "trigger-press" && !held && peek) {
          setHeld(true)
          return
        }
        setHeld(false)
        setPeek(false)
      }}
    >
      <div
        {...hover}
        title={title}
        className="inline-flex max-w-full items-center self-center rounded-full border border-primary/60 bg-primary/10 shadow-sm backdrop-blur"
      >
        <PopoverTrigger
          aria-label={t("voice.call.inCall")}
          className="inline-flex min-w-0 items-center gap-1.5 rounded-full py-0.5 pl-2 pr-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary"
        >
          <Phone aria-hidden className="size-3.5 shrink-0 text-primary" />
          {stateLabel ? (
            <span
              className={cn(
                "hidden items-center gap-1 whitespace-nowrap @lg:inline-flex",
                phase === "thinking" ? "text-muted-foreground italic" : "text-primary",
              )}
            >
              {stateDots ? stateLabel.replace(/\s*…$/, "") : stateLabel}
              {stateDots && (
                <span aria-hidden className="voice-state-dots">
                  <span />
                  <span />
                  <span />
                </span>
              )}
            </span>
          ) : (
            <Truncate text={title}>
              <span className="hidden max-w-40 truncate @lg:inline">{title}</span>
            </Truncate>
          )}
          <ChevronDown className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </PopoverTrigger>
      </div>
      <PopoverContent align="end" side="bottom" sideOffset={6} className="w-80 p-2.5" {...hover}>
        <div className="flex items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Phone className="size-3" />
          </span>
          <div className="min-w-0 flex-1">
            <Truncate text={title}>
              <p className="truncate text-xs font-medium">{title}</p>
            </Truncate>
            <p className="text-[11px] text-muted-foreground">{placeholder}</p>
          </div>
        </div>

        <div aria-live="polite" className="mt-2 min-w-0">
          {errorText && !text ? (
            <p className="line-clamp-2 text-xs leading-snug text-destructive">{errorText}</p>
          ) : caption ? (
            <CallCaption lines={caption.lines} current={caption.current} />
          ) : (
            // Same height as the caption so the card does not jump when the speech starts.
            <div title={text || placeholder} className="flex h-[2.75em] min-w-0 items-end overflow-hidden text-xs leading-snug">
              <span
                className={cn(
                  "line-clamp-2",
                  !text
                    ? "text-muted-foreground"
                    : phase === "thinking" || call.waiting
                      ? "text-muted-foreground italic"
                      : "",
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
            
              <Truncate>
                  <span className="truncate">{t("voice.call.open")}</span>
              </Truncate>
            <ArrowUpRight className="size-3.5 shrink-0" />
          </button>
          {phase !== "listening" && (
            <Hint label={t("voice.call.interrupt")}>
              <button
                type="button"
                onClick={call.interrupt}

                aria-label={t("voice.call.interrupt")}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Hand className="size-3.5" />
              </button>
            </Hint>
          )}
          <Hint label={t("voice.call.hangUp")}>
            <button
              type="button"
              onClick={call.hangUp}

              aria-label={t("voice.call.hangUp")}
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-destructive text-white transition-colors hover:bg-destructive/90"
            >
              <PhoneOff className="size-3.5" />
            </button>
          </Hint>
        </div>
      </PopoverContent>
    </Popover>
  )
}
