import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { FileText, Maximize2, PanelRight, RotateCw, X } from "lucide-react"
import type { DocumentPart } from "@shared/chat"
import { documentOpensAsFile } from "@shared/media"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ArtifactFrame } from "@/src/components/ai/artifact-part"
import { DocumentDownloadMenu, DocumentSourceBadge } from "@/src/components/ai/document-actions"
import { MessageResponse } from "@/src/components/ai/message"
import { documentApi, artifactApi } from "@/src/lib/ipc"
import { openDocumentInPanel } from "@/src/lib/open-document"

/**
 * Documento entregável na resposta (tool create_document): relatório,
 * proposta, ata, documentação.
 *
 * O card mostra o documento de DUAS formas, porque são dois objetos:
 *
 * - Documento vivo em Markdown: render NATIVO, no tema do Orbit, igual à
 *   pré-visualização de .md do modo files. Ele não é um arquivo — é texto que
 *   se lê e se edita —, então fingir uma folha A4 branca no meio de uma
 *   conversa escura é enfeite que atrapalha.
 * - Documento PEDIDO como arquivo (PDF, Word) ou derivado de um: o preview de
 *   documento mesmo, branco e paginado, num iframe. Ali a folha é o assunto:
 *   é o que vai sair impresso.
 *
 * Qual dos dois vem do REGISTRO, não desta part: a part é o retrato do turno
 * em que foi criada, e o destino do documento pode mudar depois.
 */

/**
 * O preview renderiza no TAMANHO NATURAL, refluindo na largura do card — não
 * escala uma A4 para baixo.
 *
 * A versão anterior renderizava o documento em 794px (A4 a 96dpi) e reduzia
 * com transform. Medi: o transform não borra, o Chromium rasteriza certo até
 * em DPR 1.5. O que incomodava era a REDUÇÃO em si — a 78%, um serifado de
 * 11pt vira ~8.6pt, pequeno e mole; ao abrir em tamanho cheio ficava nítido.
 * Reduzir menos era impossível sem cortar a página.
 */

/**
 * Teto de altura do preview, como fração da JANELA — e não em pixels fixos.
 *
 * O que decide se um card "domina" a conversa não é o número de pixels, é
 * quanto da tela ele ocupa: o mesmo card é enorme num notebook e modesto num
 * monitor grande.
 */
const PREVIEW_VIEWPORT_RATIO = 0.6

/** O que o card precisa saber do registro para se desenhar. */
interface CardDocument {
  /** true = preview de arquivo (iframe branco); false = Markdown nativo. */
  asFile: boolean
  markdown: string | null
}

export function DocumentPartView({
  part,
  sessionId,
}: {
  part: DocumentPart
  /** Ausente em contextos sem sessão: os botões que dependem da conversa somem,
   *  já que as abas do painel e as Fontes são por sessão. */
  sessionId?: string
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [reloads, setReloads] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [doc, setDoc] = useState<CardDocument | null>(null)

  // Altura da janela para o teto proporcional.
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === "undefined" ? 900 : window.innerHeight,
  )
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  const previewHeight = Math.round(viewportHeight * PREVIEW_VIEWPORT_RATIO)

  useEffect(() => {
    let alive = true
    void (async () => {
      const info = await documentApi.info(part.documentId)
      if (!alive) return
      // Sem registro (documento apagado) fica o iframe, que ao menos mostra o
      // preview gravado em disco em vez de um card vazio.
      if (!info || documentOpensAsFile(info)) {
        setDoc({ asFile: true, markdown: null })
        return
      }
      const source = await documentApi.source(part.documentId)
      if (alive) setDoc({ asFile: false, markdown: source?.markdown ?? "" })
    })()
    return () => {
      alive = false
    }
  }, [part.documentId, reloads])

  // Mesmo motivo do artefato: update_document reescreve os arquivos no lugar,
  // então a URL sozinha não distingue as revisões.
  const src = useMemo(
    () => `${part.previewSrc}?rev=${part.revision ?? 1}&r=${reloads}`,
    [part.previewSrc, part.revision, reloads],
  )
  const nonce = `${part.documentId}:${part.revision ?? 1}:${reloads}`

  useEffect(
    () =>
      artifactApi.onUpdated(({ artifactId }) => {
        // O evento carrega o id do HTML de preview; o documento é o .md irmão.
        if (artifactId.replace(/\.html$/, "") === part.documentId.replace(/\.md$/, "")) {
          setReloads((n) => n + 1)
        }
      }),
    [part.documentId],
  )

  const body = useCallback(
    (full: boolean) => {
      if (doc?.asFile === false) {
        return (
          <div
            className={
              full
                ? "min-h-0 min-w-0 flex-1 overflow-auto px-5 py-4 text-sm"
                : "min-w-0 overflow-auto px-4 py-3 text-sm"
            }
            style={full ? undefined : { height: previewHeight }}
          >
            <MessageResponse>{doc.markdown ?? ""}</MessageResponse>
          </div>
        )
      }
      if (doc?.asFile) {
        return full ? (
          <ArtifactFrame
            src={src}
            title={part.title}
            nonce={`${nonce}:full`}
            className="min-h-0 flex-1"
          />
        ) : (
          // O documento ROLA dentro do card. Cheguei a deixar o iframe inerte
          // para a roda do mouse nunca ser capturada, mas isso tirou a leitura
          // no próprio card, que é o uso mais comum — e o Chromium encadeia a
          // rolagem: ao chegar no fim, a conversa volta a rolar sozinha.
          <div className="relative overflow-hidden bg-white" style={{ height: previewHeight }}>
            <ArtifactFrame src={src} title={part.title} nonce={nonce} className="h-full w-full" />
          </div>
        )
      }
      // Antes de saber qual dos dois é, só o espaço — trocar um preview pelo
      // outro na frente do usuário piscaria a cada abertura da conversa.
      return <div style={full ? undefined : { height: previewHeight }} className={full ? "flex-1" : ""} />
    },
    [doc, src, nonce, part.title, previewHeight],
  )

  return (
    <>
      <div className="not-prose my-2 w-full overflow-hidden rounded-lg border bg-background shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b bg-muted/50 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-xs font-medium">{part.title}</span>
            {(part.revision ?? 1) > 1 && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t("artifacts.revision", { n: part.revision })}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {sessionId && (
              <DocumentSourceBadge
                documentId={part.documentId}
                sessionId={sessionId}
                onError={setError}
              />
            )}
            <DocumentDownloadMenu documentId={part.documentId} onError={setError} />
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t("artifacts.reload")}
              title={t("artifacts.reload")}
              onClick={() => setReloads((n) => n + 1)}
            >
              <RotateCw className="size-3.5" />
            </Button>
            {sessionId && (
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={t("artifacts.openInPanel")}
                title={t("artifacts.openInPanel")}
                // Documento vivo abre no canvas de Markdown, para ler e
                // editar; o que foi pedido como arquivo abre no visualizador,
                // com sumario, zoom e impressao.
                onClick={() => void openDocumentInPanel(sessionId, part.documentId, part.title)}
              >
                <PanelRight className="size-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t("artifacts.expand")}
              title={t("artifacts.expand")}
              onClick={() => setExpanded(true)}
            >
              <Maximize2 className="size-3.5" />
            </Button>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 border-b bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
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

        {body(false)}
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        {/* flex-col pelo mesmo motivo do artefato: com altura fixa, as linhas
            do grid padrão são esticadas e o título come metade do diálogo. */}
        <DialogContent className="flex h-[90vh] max-w-[min(900px,92vw)] flex-col gap-0 p-0">
          <DialogTitle className="shrink-0 border-b px-4 py-2.5 pr-12 text-sm">
            {part.title}
          </DialogTitle>
          {body(true)}
        </DialogContent>
      </Dialog>
    </>
  )
}
