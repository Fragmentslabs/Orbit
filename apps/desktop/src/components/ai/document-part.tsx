import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Download, FileText, Maximize2, PanelRight, RotateCw } from "lucide-react"
import type { DocumentPart } from "@shared/chat"
import type { DocumentFormat } from "@shared/media"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ArtifactFrame } from "@/src/components/ai/artifact-part"
import { documentApi, artifactApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"
import { cn } from "@/lib/utils"

/**
 * Documento entregável na resposta (tool create_document): relatório,
 * proposta, ata.
 *
 * O que aparece aqui é o HTML de preview, não o PDF — o Electron não embarca
 * o visualizador de PDF do Chrome (carregar um .pdf falha até como página de
 * topo). Como o PDF é gerado A PARTIR desse mesmo HTML, com o mesmo CSS de
 * impressão, o preview é fiel ao que sai no arquivo; PDF e DOCX ficam como
 * entrega, nos botões de exportar.
 */

/**
 * O preview é uma PÁGINA, não um quadro: o iframe é renderizado no tamanho
 * real de uma A4 a 96dpi e reduzido por transform.
 *
 * Encolher o iframe direto (largura de ~370px) deixaria o texto espremido
 * entre as margens de 2cm do documento — cerca de 220px úteis. Renderizando em
 * 794×1123 e escalando, a proporção e os tamanhos relativos ficam fiéis ao
 * impresso, que é o ponto de um preview de documento.
 */
const A4_WIDTH = 794
const A4_HEIGHT = 1123
const PREVIEW_HEIGHT = 520
const PREVIEW_SCALE = PREVIEW_HEIGHT / A4_HEIGHT
const PREVIEW_WIDTH = Math.round(A4_WIDTH * PREVIEW_SCALE)

const FORMAT_LABEL: Record<DocumentFormat, string> = { pdf: "PDF", docx: "DOCX" }

export function DocumentPartView({
  part,
  sessionId,
}: {
  part: DocumentPart
  /** Ausente em contextos sem sessão: o botão de abrir no painel some, já que
   *  as abas do painel são por sessão. */
  sessionId?: string
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [reloads, setReloads] = useState(0)
  const openArtifactTab = usePanelStore((s) => s.openArtifactTab)

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

  const onExport = useCallback(
    (format: DocumentFormat) => {
      void documentApi.export(part.documentId, format)
    },
    [part.documentId],
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
            {part.formats.map((format) => (
              <Button
                key={format}
                variant="outline"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => onExport(format)}
                title={t("documents.exportFormat", { format: FORMAT_LABEL[format] })}
              >
                <Download className="size-3" />
                {FORMAT_LABEL[format]}
              </Button>
            ))}
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
                onClick={() => openArtifactTab(sessionId, part.documentId, part.title)}
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

        {/* Fundo neutro em volta da "folha", como um visualizador de documento */}
        <div
          className={cn("flex justify-center overflow-hidden bg-neutral-200 py-4 dark:bg-neutral-800")}
          style={{ height: PREVIEW_HEIGHT + 32 }}
        >
          <div
            className="shadow-md ring-1 ring-black/10"
            style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }}
          >
            <ArtifactFrame
              src={src}
              title={part.title}
              nonce={nonce}
              style={{
                width: A4_WIDTH,
                height: A4_HEIGHT,
                transform: `scale(${PREVIEW_SCALE})`,
                transformOrigin: "top left",
              }}
            />
          </div>
        </div>
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        {/* flex-col pelo mesmo motivo do artefato: com altura fixa, as linhas
            do grid padrão são esticadas e o título come metade do diálogo. */}
        <DialogContent className="flex h-[90vh] max-w-[min(900px,92vw)] flex-col gap-0 p-0">
          <DialogTitle className="shrink-0 border-b px-4 py-2.5 pr-12 text-sm">
            {part.title}
          </DialogTitle>
          <ArtifactFrame
            src={src}
            title={part.title}
            nonce={`${nonce}:full`}
            className="min-h-0 flex-1"
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
