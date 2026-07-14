import { useEffect, useMemo, useState } from "react"
import { FileCode, MessageSquare } from "lucide-react"

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog"
import { searchApi, type SearchHit } from "@/src/lib/ipc"
import { useSessionStore } from "@/src/stores/session-store"
import { useWorkspace } from "@/lib/workspace-context"

export function ChatSearch({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const { setMode } = useWorkspace()

  useEffect(() => {
    if (!open) {
      setQuery("")
      setResults([])
      return
    }
  }, [open])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const res = await searchApi.sessions(q)
        setResults(res)
      } finally {
        setLoading(false)
      }
    }, 200)
    return () => clearTimeout(timer)
  }, [query])

  const grouped = useMemo(() => {
    const map = new Map<string, { title: string; mode: string; hits: SearchHit[] }>()
    for (const r of results) {
      let group = map.get(r.sessionId)
      if (!group) {
        group = { title: r.sessionTitle, mode: r.mode, hits: [] }
        map.set(r.sessionId, group)
      }
      group.hits.push(r)
    }
    return [...map.entries()]
  }, [results])

  function handleSelect(hit: SearchHit) {
    setMode(hit.mode as "chat" | "code")
    useSessionStore.getState().selectSession(hit.mode as "chat" | "code", hit.sessionId)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[18%] max-w-lg translate-y-0 overflow-hidden rounded-xl! p-0!"
        showCloseButton={false}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Buscar conversas..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {loading && query.trim() && (
              <div className="flex items-center justify-center py-6">
                <div className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
              </div>
            )}
            {!loading && query.trim() && results.length === 0 && (
              <CommandEmpty>Nenhum resultado encontrado</CommandEmpty>
            )}
            {!loading &&
              grouped.map(([sessionId, group]) => (
                <CommandGroup key={sessionId} heading={group.title}>
                  {group.hits.map((hit, i) => (
                    <CommandItem key={`${sessionId}-${i}`} onSelect={() => handleSelect(hit)}>
                      {hit.mode === "code" ? (
                        <FileCode className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">{hit.snippet}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            {!query.trim() && (
              <div className="px-2.5 py-6 text-center text-xs text-muted-foreground">
                Digite para buscar em todas as conversas
              </div>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
