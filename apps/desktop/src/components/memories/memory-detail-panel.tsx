import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { FileText, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { Memory } from "@shared/memory"
import { AssistantMarkdown } from "@/src/components/messages/shared"
import { useMemoryStore } from "@/src/stores/memory-store"
import { MemoryCard } from "./memory-card"

/**
 * Painel lateral da memória selecionada — compartilhado pelas abas Lista e
 * Grafo, para que clicar num card e clicar num nó levem ao mesmo lugar.
 *
 * O card fica fixo no topo e o conteúdo ocupa o resto da altura: o documento
 * markdown anexado quando existe, senão o texto completo da memória (o card o
 * corta em duas linhas, então aqui é onde ele aparece por inteiro).
 */
export function MemoryDetailPanel({ memory, related, onSelectRelated, onClose }: {
  memory: Memory
  related: Memory[]
  onSelectRelated: (id: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const openDoc = useMemoryStore((s) => s.openDoc)
  const [doc, setDoc] = useState<string | null>(null)
  const [loadingDoc, setLoadingDoc] = useState(false)

  useEffect(() => {
    if (!memory.hasDoc) {
      setDoc(null)
      return
    }
    let active = true
    setLoadingDoc(true)
    void openDoc(memory.id).then((content) => {
      // A memória pode ter trocado enquanto o doc carregava — sem esta guarda,
      // uma resposta atrasada sobrescreveria o conteúdo da memória atual.
      if (!active) return
      setDoc(content)
      setLoadingDoc(false)
    })
    return () => {
      active = false
    }
  }, [memory.id, memory.hasDoc, openDoc])

  return (
    <aside className="flex w-96 shrink-0 flex-col gap-2 overflow-hidden">
      {/* O fechar fica na própria linha: ao lado do card ele roubava largura e
          deixava o card mais estreito que a caixa do documento abaixo. */}
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          title={t("common.close")}
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <MemoryCard memory={memory} related={related} onSelectRelated={onSelectRelated} />

      <div className="flex min-h-0 flex-1 flex-col rounded-lg border bg-card">
        <div className="flex items-center gap-1.5 border-b px-3 py-2 text-[11px] font-medium text-muted-foreground">
          <FileText className="size-3" />
          {memory.hasDoc ? t("memories.attachedDoc") : t("memories.fullText")}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {memory.hasDoc && loadingDoc ? (
            <p className="text-xs text-muted-foreground">{t("memories.loadingDoc")}</p>
          ) : doc ? (
            <div className="w-full break-words text-xs">
              <AssistantMarkdown>{doc}</AssistantMarkdown>
            </div>
          ) : (
            <p className="text-xs leading-relaxed whitespace-pre-wrap text-foreground/80">
              {memory.text}
            </p>
          )}
        </div>
      </div>
    </aside>
  )
}
