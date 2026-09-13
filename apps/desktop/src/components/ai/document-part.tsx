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

/**
 * Documento entregável na resposta (tool create_document): relatório,
 * proposta, ata.
 *
 * O que aparece aqui é o HTML de preview, não o PDF — o Electron não embarca
 * o visualizador de PDF do Chrome (carregar um .pdf falha até como página de
 * topo). PDF e DOCX ficam como entrega, nos botões de exportar.
 *
 * O PDF nasce DESTE mesmo HTML, então o conteúdo é o mesmo; o que difere é a
 * margem, porque o documento traz um bloco @media screen com margem de
 * leitura e um @media print com margem de documento. Consequência: a quebra
 * de linha do preview não é a do arquivo impresso.
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
 *
 * Refluindo, o texto sai no tamanho real e sem nenhuma reamostragem. O preço
 * é a quebra de linha diferir do PDF, o que num preview é aceitável: o
 * arquivo entregue continua sendo gerado em A4 com margem de impressão
 * (@media print), e quem quer ver a paginação exata abre o PDF.
 */

/**
 * Teto de altura do preview, como fração da JANELA — e não em pixels fixos.
 *
 * O que decide se um card "domina" a conversa não é o número de pixels, é
 * quanto da tela ele ocupa: o mesmo card é enorme num notebook e modesto num
 * monitor grande.
 *
 * O preview mostra o TOPO do documento, cortado, com esmaecimento na base;
 * ver o resto é o clique, o botão de expandir ou a aba do painel.
 */
const PREVIEW_VIEWPORT_RATIO = 0.6

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

        {/* O documento ocupa a largura do card e renderiza no tamanho natural;
            o teto corta a altura, mostrando o topo. */}
        {/*
          O documento ROLA dentro do card. Cheguei a deixar o iframe inerte
          para a roda do mouse nunca ser capturada pelo preview, mas isso
          tirou do usuário a leitura no próprio card, que é o uso mais comum —
          e o Chromium encadeia a rolagem: ao chegar no fim do documento, a
          conversa volta a rolar sozinha.
        */}
        <div className="relative overflow-hidden bg-white" style={{ height: previewHeight }}>
          <ArtifactFrame src={src} title={part.title} nonce={nonce} className="h-full w-full" />
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
