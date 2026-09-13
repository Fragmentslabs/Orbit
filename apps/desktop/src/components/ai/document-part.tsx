import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Download, FileText, Maximize2, RotateCw } from "lucide-react"
import type { DocumentPart } from "@shared/chat"
import type { DocumentFormat } from "@shared/media"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ArtifactFrame } from "@/src/components/ai/artifact-part"
import { documentApi, artifactApi } from "@/src/lib/ipc"
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

const PREVIEW_HEIGHT = 460

const FORMAT_LABEL: Record<DocumentFormat, string> = { pdf: "PDF", docx: "DOCX" }

export function DocumentPartView({ part }: { part: DocumentPart }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [reloads, setReloads] = useState(0)

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
        <ArtifactFrame
          src={src}
          title={part.title}
          nonce={nonce}
          className={cn("bg-neutral-100 dark:bg-neutral-900")}
          style={{ height: PREVIEW_HEIGHT }}
        />
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="h-[90vh] max-w-[min(1100px,92vw)] gap-0 p-0">
          <DialogTitle className="border-b px-4 py-2.5 text-sm">{part.title}</DialogTitle>
          <ArtifactFrame src={src} title={part.title} nonce={`${nonce}:full`} className="h-full" />
        </DialogContent>
      </Dialog>
    </>
  )
}
