import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { FileText, X } from "lucide-react"
import type { DocumentPart } from "@shared/chat"
import { documentOpensAsFile } from "@shared/media"
import { DocumentDownloadMenu } from "@/src/components/ai/document-actions"
import { artifactApi, documentApi } from "@/src/lib/ipc"
import { openDocumentInPanel } from "@/src/lib/open-document"
import { firstLine } from "@/src/lib/document-preview"

/**
 * Documento entregável na resposta (create_document, update_document,
 * docx_edit): relatório, proposta, ata, prova.
 *
 * Na conversa ele é um CARD — título, tipo e o clique para abrir —, e o
 * documento mesmo mora no painel lateral. Era o contrário: o card desenhava o
 * documento inteiro no meio da conversa, e um relatório longo empurrava a
 * resposta do agente para longe da pergunta que a pediu. Além disso havia
 * dois lugares mostrando o mesmo texto, e só um deles editava.
 *
 * O painel abre SOZINHO quando o documento nasce, no turno em andamento — é o
 * momento em que ele é o assunto. Não abre ao voltar a uma conversa antiga
 * nem ao rolar o histórico, e abre uma vez só por documento: quem fechou o
 * painel depois disso não o vê reabrir a cada update_document.
 */

/** Documentos já abertos automaticamente nesta execução do app. */
const autoOpened = new Set<string>()

/**
 * Largura mínima da janela para abrir o painel sem pedir. Abaixo disso o
 * painel espremeria a conversa até ela ficar ilegível — o card continua lá
 * para quem quiser abrir.
 */
const AUTO_OPEN_MIN_WIDTH = 1100

/** Tipo e primeira linha, lidos do registro — a part é só o retrato do turno. */
interface CardInfo {
  kind: string
  preview: string | null
}

export function DocumentPartView({
  part,
  sessionId,
  live = false,
}: {
  part: DocumentPart
  /** Ausente em contextos sem sessão: o painel é por sessão, então o card
   *  fica sem o clique de abrir. */
  sessionId?: string
  /** A mensagem está sendo escrita agora — é o único momento em que o
   *  documento abre sozinho no painel. */
  live?: boolean
}) {
  const { t } = useTranslation()
  const [info, setInfo] = useState<CardInfo | null>(null)
  const [reloads, setReloads] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const entry = await documentApi.info(part.documentId)
      if (!alive) return
      if (!entry || documentOpensAsFile(entry)) {
        const formats = entry?.delivery?.length ? entry.delivery : (entry?.formats ?? [])
        setInfo({
          kind: formats.length ? formats.map((f) => f.toUpperCase()).join(" · ") : t("documents.kindFile"),
          preview: null,
        })
        return
      }
      const source = await documentApi.source(part.documentId)
      if (alive) setInfo({ kind: "Markdown", preview: source ? firstLine(source.markdown) : null })
    })()
    return () => {
      alive = false
    }
  }, [part.documentId, reloads, t])

  // update_document reescreve no lugar: sem isto a primeira linha do card
  // ficaria a da versão anterior.
  useEffect(
    () =>
      artifactApi.onUpdated(({ artifactId }) => {
        if (artifactId.replace(/\.html$/, "") === part.documentId.replace(/\.md$/, "")) {
          setReloads((n) => n + 1)
        }
      }),
    [part.documentId],
  )

  useEffect(() => {
    if (!live || !sessionId) return
    const key = `${sessionId}:${part.documentId}`
    if (autoOpened.has(key)) return
    autoOpened.add(key)
    if (window.innerWidth < AUTO_OPEN_MIN_WIDTH) return
    void openDocumentInPanel(sessionId, part.documentId, part.title)
  }, [live, sessionId, part.documentId, part.title])

  const open = () => {
    if (sessionId) void openDocumentInPanel(sessionId, part.documentId, part.title)
  }

  return (
    <div className="not-prose my-2 w-full max-w-md">
      <div
        role={sessionId ? "button" : undefined}
        tabIndex={sessionId ? 0 : undefined}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            open()
          }
        }}
        title={sessionId ? t("artifacts.openInPanel") : undefined}
        className={`flex items-center gap-3 rounded-lg border bg-background px-3 py-2.5 transition-colors ${
          sessionId ? "cursor-pointer hover:bg-accent/50" : ""
        }`}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
          <FileText className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{part.title}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {info?.kind ?? " "}
            {(part.revision ?? 1) > 1 && ` · ${t("artifacts.revision", { n: part.revision })}`}
            {info?.preview && ` · ${info.preview}`}
          </p>
        </div>
        {/* Baixar não abre o painel: o clique para aqui. */}
        <div className="shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <DocumentDownloadMenu documentId={part.documentId} onError={setError} compact />
        </div>
      </div>

      {error && (
        <div className="mt-1 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          <p className="min-w-0 flex-1">{error}</p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-destructive/20"
            aria-label={t("common.close")}
          >
            <X className="size-3" />
          </button>
        </div>
      )}
    </div>
  )
}
