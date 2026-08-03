import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CalendarDays, ChevronDown, ChevronUp, Search, X } from "lucide-react"
import { normalizeText } from "@shared/memory"
import type { ChatMessage } from "@shared/chat"
import { Button } from "@/components/ui/button"
import { messageText } from "@/src/lib/message-utils"
import { useChatSearchStore } from "@/src/stores/chat-search-store"

function scrollToMessage(id: string) {
  const el = document.querySelector<HTMLElement>(`[data-msg-id="${id}"]`)
  if (!el) return
  el.scrollIntoView({ behavior: "smooth", block: "center" })
  const prevBg = el.style.backgroundColor
  const prevTransition = el.style.transition
  el.style.transition = "background-color 0.4s ease"
  el.style.backgroundColor = "var(--accent)"
  setTimeout(() => {
    el.style.backgroundColor = prevBg
    setTimeout(() => { el.style.transition = prevTransition }, 400)
  }, 700)
}

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

  useEffect(() => {
    const current = matches[matchIndex]
    if (current) scrollToMessage(current.id)
  }, [matches, matchIndex])

  const goNext = () => matches.length > 0 && setMatchIndex((i) => (i + 1) % matches.length)
  const goPrev = () => matches.length > 0 && setMatchIndex((i) => (i - 1 + matches.length) % matches.length)

  const handleDateChange = (value: string) => {
    if (!value) return
    const [year, month, day] = value.split("-").map(Number)
    const hit = messages.find((m) => {
      const d = new Date(m.createdAt)
      return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day
    })
    if (hit) scrollToMessage(hit.id)
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-1 pb-2">
      <div className="flex flex-1 items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("chatSearch.placeholder")}
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              e.shiftKey ? goPrev() : goNext()
            }
            if (e.key === "Escape") close()
          }}
        />
        {query.trim() && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {matches.length === 0 ? t("chatSearch.noMatches") : t("chatSearch.of", { current: matchIndex + 1, total: matches.length })}
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-7 shrink-0"
        onClick={goPrev}
        disabled={matches.length === 0}
        title={t("chatSearch.previousMatch")}
      >
        <ChevronUp className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-7 shrink-0"
        onClick={goNext}
        disabled={matches.length === 0}
        title={t("chatSearch.nextMatch")}
      >
        <ChevronDown className="size-4" />
      </Button>
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
      <Button variant="ghost" size="icon-sm" className="size-7 shrink-0" onClick={close} title={t("chatSearch.close")}>
        <X className="size-4" />
      </Button>
    </div>
  )
}
