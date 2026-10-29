import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { BrainIcon, ExternalLink } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useWorkspace } from "@/lib/workspace-context"
import type { Memory } from "@shared/memory"
import { MemoryDetailPanel } from "@/src/components/memories/memory-detail-panel"
import { useMemoryById } from "@/src/hooks/use-memory"
import { useMemoryStore } from "@/src/stores/memory-store"
import { ORPHAN_KEY, usePanelStore } from "@/src/stores/panel-store"

/** Primeiras palavras do texto, para o título de uma aba aberta a partir de um vínculo. */
function excerpt(text: string, max = 40): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean
}

/**
 * Aba do painel com uma memória citada na conversa.
 *
 * Reusa o MemoryDetailPanel da tela de Memórias (card + texto completo ou
 * documento anexado), então o que se lê aqui é exatamente o que se edita lá —
 * sem uma segunda visão para manter em sincronia. Navegar por um vínculo abre
 * outra aba da mesma memória, e o atalho para a tela completa fica no rodapé.
 */
export function MemoryTab({ memoryId, sessionId }: { memoryId?: string; sessionId?: string }) {
  const { t } = useTranslation()
  const memory = useMemoryById(memoryId)
  const index = useMemoryStore((s) => s.index)
  const loading = useMemoryStore((s) => s.loading)
  const openMemoryTab = usePanelStore((s) => s.openMemoryTab)
  const { setView } = useWorkspace()

  const related = useMemo(() => {
    if (!memory) return []
    return memory.relatedIds
      .map((id) => index.find((m) => m.id === id))
      .filter((m): m is Memory => m != null)
  }, [memory, index])

  if (!memory) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
        {/* Skeleton só enquanto há um id para resolver: sem id o store nem
            inicializa, e o esqueleto ficaria girando para sempre. */}
        {loading && memoryId ? (
          <Skeleton className="h-4 w-40" />
        ) : (
          <>
            <BrainIcon className="size-5" />
            <p>{t("memories.notFound")}</p>
            <p className="font-mono break-all">{memoryId}</p>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden p-3">
      <MemoryDetailPanel
        memory={memory}
        related={related}
        onSelectRelated={(id) => {
          const target = related.find((m) => m.id === id)
          openMemoryTab(sessionId ?? ORPHAN_KEY, {
            memoryId: id,
            title: target?.title?.trim() || (target ? excerpt(target.text) : id),
          })
        }}
        className="w-full min-h-0 flex-1"
      />
      <Button
        variant="ghost"
        size="sm"
        className="self-start text-xs text-muted-foreground"
        onClick={() => setView("memories")}
      >
        <ExternalLink className="size-3" />
        {t("memories.openInMemoriesScreen")}
      </Button>
    </div>
  )
}
