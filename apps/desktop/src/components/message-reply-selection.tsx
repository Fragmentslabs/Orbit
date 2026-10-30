import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { createPortal } from "react-dom"
import { MessageSquareQuoteIcon, SquareIcon, Volume2Icon } from "lucide-react"
import { useStickToBottomContext } from "use-stick-to-bottom"
import { replyExcerpt, type MessageReplyQuote } from "@shared/chat"
import { readTtsEngine, readTtsPrefs, useSpeak, useTtsStatus } from "@/src/hooks/use-speak"
import { useAppSettings } from "@/src/stores/app-settings"
import { useMessageReply } from "@/src/stores/message-reply"

/**
 * Select an excerpt of a message and reply only to it.
 *
 * The same gesture as the QuoteSelection of the document viewers (once selected,
 * the button appears), with one deep difference: there the excerpt becomes an ATTACHMENT of the
 * document; here it becomes a reply, and enters the sent text. That is why the
 * button here does not choose page or line — it chooses the message.
 *
 * It needs to be mounted inside the <Conversation> to read the scroll element
 * of the context, and it is that one that delimits the valid area: without that check,
 * a selection in the file viewer (with the chat open alongside) would offer
 * to reply to a message that has nothing to do with what was marked.
 *
 * The button goes in a portal with a fixed position because the selection box comes in
 * viewport coordinates: inside the container it would be cut by the overflow
 * of the conversation, which is exactly where the text scrolls.
 *
 * With TTS on a second button appears, which reads ONLY the marked excerpt. The
 * rules are those of the speak button of the whole message (`SpeakAction`): it disappears with
 * TTS off in the preferences and, without the model downloaded, it does not appear either —
 * here there is no room for the shortcut that leads to Preferences, and a button that only
 * fails is worse than a missing button.
 */
export function MessageReplySelection({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation()
  const { scrollRef } = useStickToBottomContext()
  const setReply = useMessageReply((s) => s.setReply)
  const [pending, setPending] = useState<{ x: number; y: number; quote: MessageReplyQuote } | null>(null)
  // The shared type may not carry the `voice` block yet (another worker):
  // it reads defensively from the store, with the app defaults.
  const voice = useAppSettings((s) => (s.settings as unknown as { voice?: unknown }).voice)
  const prefs = useMemo(() => readTtsPrefs(voice), [voice])
  const engine = useMemo(() => readTtsEngine(voice), [voice])
  const { ready, known } = useTtsStatus(prefs.enabled, engine)
  // `known: false` = nobody answered (old main process or no engine): it does not block.
  const speakEnabled = prefs.enabled && (!known || ready)
  const { speak, stop, speaking } = useSpeak()

  const capture = useCallback(() => {
    const container = scrollRef.current
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
    // Role read from the DOM: the selection may be in any part of the message
    // (text, markdown, code block), and the closest ancestor with the
    // attribute says which message it belongs to. A selection that crosses two
    // messages falls into the container, without the attribute, and offers nothing.
    const node = range.commonAncestorContainer
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
    const role = element?.closest("[data-msg-role]")?.getAttribute("data-msg-role")
    if (role !== "user" && role !== "assistant") {
      setPending(null)
      return
    }
    const text = replyExcerpt(selection.toString())
    if (!text) {
      setPending(null)
      return
    }
    const rect = range.getBoundingClientRect()
    setPending({ x: rect.left + rect.width / 2, y: rect.top, quote: { role, text } })
  }, [scrollRef])

  useEffect(() => {
    // The button is born when the selection ENDS (mouseup/keyup), not on every
    // cursor move: during the drag it would be jumping along.
    document.addEventListener("mouseup", capture)
    document.addEventListener("keyup", capture)
    // ...and it disappears as soon as the selection comes undone.
    const onSelectionChange = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) setPending(null)
    }
    document.addEventListener("selectionchange", onSelectionChange)
    return () => {
      document.removeEventListener("mouseup", capture)
      document.removeEventListener("keyup", capture)
      document.removeEventListener("selectionchange", onSelectionChange)
    }
  }, [capture])

  if (!pending) return null

  return createPortal(
    <div
      style={{ left: pending.x, top: pending.y - 8 }}
      className="fixed z-[999] flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-md border bg-popover p-0.5 text-popover-foreground shadow-md"
    >
      {speakEnabled && (
        <button
          type="button"
          // Without the preventDefault the click undoes the selection and the button disappears in
          // the middle of the speech — with it the menu stays where it is and the same excerpt can
          // be interrupted right after.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (speaking) stop()
            else speak(pending.quote.text, { voice: prefs.voice, lang: prefs.lang, speed: prefs.speed, engine })
          }}
          className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium hover:bg-accent"
        >
          {speaking ? <SquareIcon className="size-3" /> : <Volume2Icon className="size-3" />}
          {speaking ? t("voice.tts.stop") : t("reply.speak")}
        </button>
      )}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setReply(sessionId, pending.quote)
          window.getSelection()?.removeAllRanges()
          setPending(null)
        }}
        className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium hover:bg-accent"
      >
        <MessageSquareQuoteIcon className="size-3" />
        {t("reply.excerpt")}
      </button>
    </div>,
    document.body,
  )
}
