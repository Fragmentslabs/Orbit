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
    /*
      A barra FLUTUA sobre a conversa, e precisa dizer isso.

      A lista de mensagens é puxada para cima (`-mt-10`) para correr por baixo
      do degradê do topo, e, sendo irmã posterior, pintava por cima da barra
      inteira: os botões existiam mas o clique caía na conversa. O z-index
      resolve o clique; a sombra e o véu resolvem a outra metade, que é a barra
      parecer perdida no meio do texto que passa por trás dela.
    */
    <div className="relative z-30 mx-auto w-full max-w-3xl px-1 pb-2">
      {/* Véu: escurece e apaga o que passa por baixo, terminando num degradê
          para a conversa não ser cortada por uma linha reta. Fica atrás do
          cartão, mas dentro do mesmo nível — por isso cobre as mensagens. */}
      <div
        className="pointer-events-none absolute inset-x-0 -bottom-8 top-0 backdrop-blur-[2px]"
        style={{
          // Atrás do cartão, à frente da conversa: o z-index negativo vale
          // dentro do contexto criado pelo z-30 do pai, então ele não escapa
          // para trás das mensagens.
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
    </div>
  )
}
