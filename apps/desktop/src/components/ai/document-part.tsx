import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
 * topo). Como o PDF é gerado A PARTIR desse mesmo HTML, com o mesmo CSS de
 * impressão, o preview é fiel ao que sai no arquivo; PDF e DOCX ficam como
 * entrega, nos botões de exportar.
 */

/**
 * O preview é uma PÁGINA em retrato: o iframe é renderizado no tamanho real de
 * uma A4 a 96dpi e escalado para caber na LARGURA disponível — a altura do
 * card acompanha a proporção da folha.
 *
 * Duas coisas que não funcionam e por quê. Encolher o iframe direto (largura
 * de ~370px) espreme o texto entre as margens de 2cm do documento, sobrando
 * ~220px úteis. E fixar a altura do card escalando a página para baixo deixa
 * faixas laterais enormes com o conteúdo minúsculo — o card fica paisagem
 * exibindo um objeto retrato.
 *
 * Escalando pela largura, a página preenche o card, o texto sai no maior
 * tamanho possível e a proporção continua fiel ao impresso.
 */
const A4_WIDTH = 794
const A4_HEIGHT = 1123
/** Nunca amplia além do tamanho natural: acima de 794px o texto ficaria
 *  artificialmente grande em relação ao que sai impresso. */
const MAX_SCALE = 1
/**
 * Teto de altura do preview, como fração da JANELA — e não em pixels fixos.
 *
 * Uma A4 inteira na largura do chat passa de 900px e domina a conversa; um
 * teto baixo demais devolve um selo ilegível. O que decide se o card "domina"
 * não é o número de pixels, é quanto da tela ele ocupa: 72% da altura visível
 * deixa o documento grande e ainda mostra que há conversa em volta, num
 * monitor pequeno ou grande.
 *
 * O preview mostra o TOPO da folha, cortado, com esmaecimento na base; ver o
 * documento completo é o clique, o botão de expandir ou a aba do painel.
 */
const PREVIEW_VIEWPORT_RATIO = 0.72

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

  /**
   * A escala precisa da largura REAL do card, que depende do painel, da
   * largura da janela e do zoom — nada disso dá para saber em CSS puro, porque
   * o iframe tem que ser renderizado em 794px para o documento não reflowar.
   * Daí o ResizeObserver: ele reescala quando o usuário abre o painel lateral
   * ou redimensiona a janela.
   */
  const frameBoxRef = useRef<HTMLDivElement | null>(null)
  const [boxWidth, setBoxWidth] = useState(0)
  useEffect(() => {
    const el = frameBoxRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      setBoxWidth(entry.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Altura da janela para o teto proporcional. Não dá para usar 72vh em CSS
  // puro porque o `clipped` (o esmaecimento) precisa saber se houve corte.
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === "undefined" ? 900 : window.innerHeight,
  )
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  const scale = Math.min(MAX_SCALE, (boxWidth || A4_WIDTH) / A4_WIDTH)
  const fullHeight = Math.round(A4_HEIGHT * scale)
  const previewHeight = Math.min(fullHeight, Math.round(viewportHeight * PREVIEW_VIEWPORT_RATIO))
  const clipped = fullHeight > previewHeight

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

        {/*
          A folha ocupa a largura inteira do card, com a altura limitada pelo
          teto: o que aparece é o topo da página, no tamanho em que ela será
          impressa. A escala continua vindo da largura — cortar a altura
          preserva o tamanho do texto, enquanto reduzir a escala o encolheria.
        */}
        <div
          ref={frameBoxRef}
          role="button"
          tabIndex={0}
          title={t("artifacts.expand")}
          onClick={() => setExpanded(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") setExpanded(true)
          }}
          className="relative cursor-zoom-in overflow-hidden bg-white"
          style={{ height: previewHeight }}
        >
          {/*
            pointer-events-none no iframe: com a altura cortada, a roda do
            mouse rolaria o DOCUMENTO dentro de uma janelinha em vez da
            conversa — uma armadilha de rolagem. Inerte, o preview deixa a
            conversa rolar normalmente e o clique abre o documento inteiro.
          */}
          <ArtifactFrame
            src={src}
            title={part.title}
            nonce={nonce}
            className="pointer-events-none"
            style={{
              width: A4_WIDTH,
              height: A4_HEIGHT,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          />
          {clipped && (
            // Esmaecimento na base: sem ele o corte parece conteúdo faltando,
            // e não uma página que continua.
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white to-transparent" />
          )}
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
