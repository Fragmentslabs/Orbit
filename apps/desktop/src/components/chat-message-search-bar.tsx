import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CalendarDays, ChevronDown, ChevronUp, Search, X } from "lucide-react"
import { normalizeText } from "@shared/memory"
import type { ChatMessage } from "@shared/chat"
import { Button } from "@/components/ui/button"
import { messageText } from "@/src/lib/message-utils"
import { useChatSearchStore } from "@/src/stores/chat-search-store"
import { scrollToMessage, clearTextHighlight, highlightTextIn } from "@/src/lib/message-jump"
import { Hint } from "@/components/ui/hint"

export function ChatMessageSearchBar({ messages }: { messages: ChatMessage[] }) {
  const { t } = useTranslation()
  const close = useChatSearchStore((s) => s.close)
  const [query, setQuery] = useState("")
  const [matchIndex, setMatchIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const matches = useMemo(() => {
    const q = normalizeText(query.trim())
    if (!q) return []
    return messages.filter((m) => !m.summary && normalizeText(messageText(m)).includes(q))
  }, [messages, query])

  useEffect(() => {
    setMatchIndex(0)
  }, [query])

  // The result highlight is the TERM itself marked inside the message —
  // no painting the message (see highlightTextIn). The `flash` of the scroll
  // is turned off here precisely for that reason.
  useEffect(() => {
    const current = matches[matchIndex]
    const term = query.trim()
    if (!current || !term) {
      clearTextHighlight()
      return
    }
    let alive = true
    void scrollToMessage(current.id, { flash: false }).then((el) => {
      if (alive && el) highlightTextIn(el, term)
    })
    return () => {
      alive = false
    }
  }, [matches, matchIndex, query])

  // Closing the search erases the mark too: the highlight belongs to the search, not to the message.
  useEffect(() => clearTextHighlight, [])

  const goNext = () => matches.length > 0 && setMatchIndex((i) => (i + 1) % matches.length)
  const goPrev = () => matches.length > 0 && setMatchIndex((i) => (i - 1 + matches.length) % matches.length)

  const handleDateChange = (value: string) => {
    if (!value) return
    const [year, month, day] = value.split("-").map(Number)
    const hit = messages.find((m) => {
      const d = new Date(m.createdAt)
      return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day
    })
    if (hit) void scrollToMessage(hit.id)
  }

  return (
    /*
      The bar FLOATS over the conversation, and it needs to say so.

      The message list is pulled up (`-mt-10`) to run under the
      gradient at the top, and, being a later sibling, it painted over the whole
      bar: the buttons existed but the click fell on the conversation. The z-index
      solves the click; the shadow and the veil solve the other half, which is the bar
      looking lost in the middle of the text passing behind it.

      z-[70], and not z-30: the bar floats at the top of the conversation, but what is
      floating there is ABOVE it — the top persona (z-40) and the header
      (z-50, with the popovers trapped in it at z-[60]) —, and the typing field
      ended up below those pieces. z-[70] is above all of them and still
      below the modals (z-[80]) and the portaled menus (z-[999]).
    */
    <div className="relative z-[70] mx-auto w-full max-w-3xl px-1 pb-2">
      {/* Veil: darkens and fades what passes underneath, ending in a gradient
          so the conversation is not cut by a straight line. It stays behind the
          card, but within the same level — that is why it covers the messages. */}
      <div
        className="pointer-events-none absolute inset-x-0 -bottom-8 top-0 backdrop-blur-[2px]"
        style={{
          // Behind the card, in front of the conversation: the negative z-index applies
          // within the context created by the parent's z-[70], so it does not escape
          // behind the messages.
          zIndex: -10,
          backgroundImage:
            'linear-gradient(to bottom, var(--panel-bg, var(--background)) 55%, color-mix(in oklab, var(--panel-bg, var(--background)) 70%, transparent) 80%, transparent)',
        }}
      />
      <div className="flex items-center gap-1 rounded-xl border border-border bg-popover py-1.5 pl-2.5 pr-1.5 shadow-lg shadow-black/25">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("chatSearch.placeholder")}
          className="w-full min-w-0 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              e.shiftKey ? goPrev() : goNext()
            }
            if (e.key === "Escape") close()
          }}
        />
        {query.trim() && (
          <span className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground">
            {matches.length === 0 ? t("chatSearch.noMatches") : t("chatSearch.of", { current: matchIndex + 1, total: matches.length })}
          </span>
        )}
        <Hint label={t("chatSearch.previousMatch")}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0"
            onClick={goPrev}
            disabled={matches.length === 0}

          >
            <ChevronUp className="size-4" />
          </Button>
        </Hint>
        <Hint label={t("chatSearch.nextMatch")}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0"
            onClick={goNext}
            disabled={matches.length === 0}

          >
            <ChevronDown className="size-4" />
          </Button>
        </Hint>
        <label
          className="relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("chatSearch.dateFilter")}
        >
          <CalendarDays className="size-4" />
          <input
            type="date"
            className="absolute inset-0 size-full cursor-pointer opacity-0"
            onChange={(e) => handleDateChange(e.target.value)}
          />
        </label>
        <Hint label={t("chatSearch.close")}>
          <Button variant="ghost" size="icon-sm" className="size-7 shrink-0" onClick={close} >
            <X className="size-4" />
          </Button>
        </Hint>
      </div>
    </div>
  )
}
