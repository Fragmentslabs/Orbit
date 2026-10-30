import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { createPortal } from "react-dom"
import { Quote, SquareIcon, Volume2Icon } from "lucide-react"
import { readTtsEngine, readTtsPrefs, useSpeak, useTtsStatus } from "@/src/hooks/use-speak"
import { useAppSettings } from "@/src/stores/app-settings"
import { usePanelStore } from "@/src/stores/panel-store"

/**
 * Select an excerpt in a viewer and send it to the chat.
 *
 * It lives here, and not inside each viewer, because the gesture is the same in
 * all of them: once selected, the button appears, it became a chip in the composer. What changes from
 * one to the other is only HOW the page and the line of the excerpt are found — and that
 * comes in through `resolve`, which each viewer implements its own way (the
 * living Markdown document does not implement it: it has no page).
 *
 * The button is rendered in a portal with a fixed position because the selection box
 * comes in viewport coordinates: inside the container it would be cut by the
 * overflow of the panel, which is exactly where the text scrolls.
 */

export interface QuoteAnchor {
  page?: number
  fromLine?: number
  toLine?: number
}

const MAX_TEXT = 4_000

export function QuoteSelection({
  containerRef,
  kind,
  docId,
  name,
  resolve,
  readAloud = false,
}: {
  containerRef: RefObject<HTMLElement | null>
  /** What the agent can do with the id — see DocumentQuotePayload. */
  kind: "document" | "source"
  docId: string
  name: string
  /**
   * Where the excerpt is in the document. Absent = it quotes only the text.
   *
   * It receives the text already extracted from the selection because not every viewer
   * finds the position through the DOM: in a drawn PDF the only clue is the text
   * itself, searched back in the lines of the page.
   */
  resolve?: (range: Range, text: string) => QuoteAnchor
  /**
   * Offers "Read excerpt" next to "Quote in chat".
   *
   * It is opt-in: whoever does not ask keeps the single-button bar. The Markdown
   * document asks for it, because there the reading aloud is the same gesture as the
   * conversation's; in a viewer that already has its own speech controls the decision
   * is another one.
   */
  readAloud?: boolean
}) {
  const { t } = useTranslation()
  const addQuote = usePanelStore((s) => s.addQuote)
  // The same rules as the speak button of the whole message (messages/speak-action):
  // it disappears with TTS off in the preferences and, without the model downloaded, it
  // does not appear either — here there is no room for the shortcut that leads to Preferences, and
  // a button that only fails is worse than a missing button.
  const voice = useAppSettings((s) => (s.settings as unknown as { voice?: unknown }).voice)
  const prefs = useMemo(() => readTtsPrefs(voice), [voice])
  const engine = useMemo(() => readTtsEngine(voice), [voice])
  const { ready, known } = useTtsStatus(prefs.enabled, engine)
  // `known: false` = nobody answered (old main process or no engine): it does not block.
  const canSpeak = readAloud && prefs.enabled && (!known || ready)
  const { speak, stop, speaking } = useSpeak()
  // Kept in a ref so the caller can pass an inline arrow without the
  // listener being re-bound on every render.
  const resolveRef = useRef(resolve)
  resolveRef.current = resolve
  const [pending, setPending] = useState<
    { x: number; y: number; text: string; anchor: QuoteAnchor } | null
  >(null)

  const capture = useCallback(() => {
    const container = containerRef.current
    const selection = window.getSelection()
    if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setPending(null)
      return
    }
    const range = selection.getRangeAt(0)
    if (!container.contains(range.commonAncestorContainer)) {
      setPending(null)
      return
    }
    const text = selection.toString().trim()
    if (!text) {
      setPending(null)
      return
    }
    const rect = range.getBoundingClientRect()
    setPending({
      x: rect.left + rect.width / 2,
      y: rect.top,
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
      anchor: resolveRef.current?.(range, text) ?? {},
    })
  }, [containerRef])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // The button is born when the selection ENDS (mouseup/keyup), not on every
    // cursor move: during the drag it would be jumping along.
    container.addEventListener("mouseup", capture)
    container.addEventListener("keyup", capture)
    // ...and it disappears as soon as the selection comes undone, by click or by a scroll that
    // takes it off screen.
    const onSelectionChange = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) setPending(null)
    }
    document.addEventListener("selectionchange", onSelectionChange)
    return () => {
      container.removeEventListener("mouseup", capture)
      container.removeEventListener("keyup", capture)
      document.removeEventListener("selectionchange", onSelectionChange)
    }
  }, [containerRef, capture])

  if (!pending) return null

  return createPortal(
    <div
      style={{ left: pending.x, top: pending.y - 8 }}
      className="fixed z-[999] flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-md border bg-popover p-0.5 text-popover-foreground shadow-md"
    >
      {canSpeak && (
        <button
          type="button"
          // Without the preventDefault the click undoes the selection and the bar disappears in
          // the middle of the speech — with it the same excerpt can be interrupted right
          // after.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (speaking) stop()
            else speak(pending.text, { voice: prefs.voice, lang: prefs.lang, speed: prefs.speed, engine })
          }}
          className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium hover:bg-accent"
        >
          {speaking ? <SquareIcon className="size-3" /> : <Volume2Icon className="size-3" />}
          {speaking ? t("voice.tts.stop") : t("sources.speak")}
        </button>
      )}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          addQuote({ kind, docId, name, text: pending.text, ...pending.anchor })
          window.getSelection()?.removeAllRanges()
          setPending(null)
        }}
        className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium hover:bg-accent"
      >
        <Quote className="size-3" />
        {t("sources.quoteInChat")}
      </button>
    </div>,
    document.body,
  )
}
