import { Fragment, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { BrainIcon, FileTextIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "~/components/ui/hover-card"
import { cn } from "@/lib/utils"
import { splitMemoryIds } from "@/src/lib/citations"
import { CATEGORY_LABEL, KIND_BADGE, KIND_LABEL } from "@/src/components/memories/meta"
import { useMemoryById } from "@/src/hooks/use-memory"
import { ORPHAN_KEY, usePanelStore } from "@/src/stores/panel-store"

/** Rótulo curto o bastante para caber no meio de uma frase. */
function shortLabel(text: string, max = 40): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean
}

/**
 * Citação de memória na conversa: `[idioma do usuário](#orbit-memory/mem_xxx)`.
 *
 * Chip no meio da frase (mesma linguagem da citação de documento), hover card
 * com o resumo, clique abre a memória no painel lateral — a conversa continua
 * visível ao lado. O id cru nunca aparece como texto: quando o modelo escreve
 * `mem_xxx` solto, linkifyMemoryIds o converte no mesmo chip.
 *
 * A memória é resolvida pelo índice do store; um id que não existe (memória
 * excluída, ou link inventado pelo modelo) não vira clique morto: o chip
 * aparece esmaecido e o cartão diz que não encontrou.
 */
export function MemoryCitation({ memoryId, label, sessionId }: {
  memoryId: string
  label: string
  sessionId?: string
}) {
  const { t } = useTranslation()
  const memory = useMemoryById(memoryId)
  const openMemoryTab = usePanelStore((s) => s.openMemoryTab)

  // O texto do link manda (foi escrito para aquela frase); quando ele é só o
  // id — o caso do linkify — vale o título da memória.
  const bareId = label.trim() === memoryId
  const title = bareId
    ? memory?.title?.trim() || (memory ? shortLabel(memory.text) : memoryId)
    : shortLabel(label)

  const open = () => {
    openMemoryTab(sessionId ?? ORPHAN_KEY, { memoryId, title: memory?.title?.trim() || title })
  }

  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <button
            type="button"
            onClick={open}
            title={t("memories.citationHint")}
            className={cn(
              // font-sans: o chip também aparece dentro do output monoespaçado
              // de uma ferramenta, onde herdaria a fonte do <pre>.
              "mx-0.5 inline-flex cursor-pointer items-center gap-0.5 rounded px-1.5 align-baseline font-sans text-[0.7rem] font-medium",
              memory
                ? "bg-primary/10 text-primary hover:bg-primary/20"
                : "bg-muted text-muted-foreground hover:bg-muted/70",
            )}
          />
        }
      >
        <BrainIcon className="size-2.5" />
        {title}
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-80 p-3">
        {memory ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-start gap-2">
              <BrainIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <p className="min-w-0 flex-1 text-xs leading-snug font-medium">
                {memory.title?.trim() || shortLabel(memory.text, 80)}
              </p>
            </div>
            <p className="line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">{memory.text}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className={cn("px-1.5 py-0 text-[10px]", KIND_BADGE[memory.kind])}>
                {t(`memories.kinds.${memory.kind}`, { defaultValue: KIND_LABEL[memory.kind] })}
              </Badge>
              {memory.category && (
                <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                  {t(`memories.categories.${memory.category}`, { defaultValue: CATEGORY_LABEL[memory.category] })}
                </Badge>
              )}
              {memory.hasDoc && <FileTextIcon className="size-3 text-muted-foreground" />}
              {memory.tags.slice(0, 5).map((tag) => (
                <span key={tag} className="text-[10px] text-muted-foreground">#{tag}</span>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2 border-t pt-2 text-[10px] text-muted-foreground">
              <span>{t("memories.uses", { count: memory.hits })}</span>
              <button
                type="button"
                onClick={open}
                className="cursor-pointer font-medium text-primary hover:underline"
              >
                {t("memories.openInPanel")}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            <p>{t("memories.notFound")}</p>
            <p className="font-mono break-all">{memoryId}</p>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}

/**
 * Texto CRU (saída de ferramenta) com os ids de memória virando chip. A divisão
 * mora em citations.ts — aqui só o desenho.
 */
export function MemoryIdText({ text, sessionId }: { text: string; sessionId?: string }) {
  const parts = useMemo(() => splitMemoryIds(text), [text])
  if (parts.length < 2) return <>{text}</>

  return (
    <>
      {parts.map((part, i) =>
        typeof part === "string" ? (
          <Fragment key={i}>{part}</Fragment>
        ) : (
          <MemoryCitation key={i} memoryId={part.memoryId} label={part.memoryId} sessionId={sessionId} />
        ),
      )}
    </>
  )
}
