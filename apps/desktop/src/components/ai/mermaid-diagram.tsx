import { memo, useEffect, useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, CopyIcon, DownloadIcon, Maximize2Icon } from "lucide-react"
import type { CustomRendererProps } from "streamdown"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { diagramApi } from "@/src/lib/ipc"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Diagrama Mermaid direto na conversa: sem moldura, sem fundo próprio, com as
 * cores do tema do Orbit.
 *
 * Substitui o bloco padrão do streamdown (que vem com caixa, borda e barra de
 * ferramentas) registrando-se como renderer da linguagem `mermaid`.
 *
 * O Mermaid não entende `oklch()` nem `var()` — os tokens do app são oklch —,
 * então cada cor é resolvida para rgb por um canvas antes de entrar em
 * `themeVariables`. O diagrama é redesenhado quando o tema claro/escuro troca.
 */

const TOKENS = [
  "background",
  "foreground",
  "card",
  "secondary",
  "muted-foreground",
  "border",
  "primary",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "destructive",
] as const

type Rgb = [number, number, number]

function resolveTokens(): Record<(typeof TOKENS)[number], Rgb> {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  const style = getComputedStyle(document.documentElement)
  const out = {} as Record<(typeof TOKENS)[number], Rgb>
  for (const name of TOKENS) {
    let rgb: Rgb = [128, 128, 128]
    const raw = style.getPropertyValue(`--${name}`).trim()
    if (ctx && raw) {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = "#808080"
      ctx.fillStyle = raw
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
      rgb = [r, g, b]
    }
    out[name] = rgb
  }
  return out
}

const css = ([r, g, b]: Rgb) => `rgb(${r}, ${g}, ${b})`
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
]

function buildConfig() {
  const c = resolveTokens()
  const node = mix(c.background, c.foreground, 0.06)
  const line = mix(c.background, c.foreground, 0.45)
  const stroke = mix(c.background, c.foreground, 0.22)
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    theme: "base" as const,
    fontFamily: "'Geist Variable', ui-sans-serif, system-ui, sans-serif",
    themeVariables: {
      background: css(c.background),
      mainBkg: css(node),
      primaryColor: css(node),
      primaryTextColor: css(c.foreground),
      primaryBorderColor: css(stroke),
      secondaryColor: css(mix(c.background, c.primary, 0.22)),
      secondaryTextColor: css(c.foreground),
      secondaryBorderColor: css(stroke),
      tertiaryColor: css(mix(c.background, c.foreground, 0.03)),
      tertiaryTextColor: css(c.foreground),
      tertiaryBorderColor: css(stroke),
      textColor: css(c.foreground),
      lineColor: css(line),
      nodeBorder: css(stroke),
      nodeTextColor: css(c.foreground),
      clusterBkg: css(mix(c.background, c.foreground, 0.03)),
      clusterBorder: css(stroke),
      titleColor: css(c.foreground),
      edgeLabelBackground: css(c.background),
      noteBkgColor: css(mix(c.background, c.primary, 0.22)),
      noteTextColor: css(c.foreground),
      noteBorderColor: css(c.primary),
      actorBkg: css(node),
      actorBorder: css(stroke),
      actorTextColor: css(c.foreground),
      actorLineColor: css(line),
      signalColor: css(c.foreground),
      signalTextColor: css(c.foreground),
      labelBoxBkgColor: css(node),
      labelBoxBorderColor: css(stroke),
      labelTextColor: css(c.foreground),
      loopTextColor: css(c.foreground),
      activationBkgColor: css(mix(c.background, c.primary, 0.3)),
      activationBorderColor: css(c.primary),
      sequenceNumberColor: css(c.background),
      pie1: css(c.primary),
      pie2: css(c["chart-2"]),
      pie3: css(c["chart-4"]),
      pie4: css(c["chart-1"]),
      pie5: css(c["chart-5"]),
      pie6: css(c["chart-3"]),
      pieTitleTextColor: css(c.foreground),
      pieSectionTextColor: css(c.background),
      pieLegendTextColor: css(c.foreground),
      pieStrokeColor: css(c.background),
      pieOuterStrokeColor: "transparent",
      errorBkgColor: css(mix(c.background, c.destructive, 0.2)),
      errorTextColor: css(c.destructive),
    },
    flowchart: { curve: "basis" as const, padding: 12 },
  }
}

/** "dark" | "light", reagindo à troca de tema do app. */
function useColorScheme() {
  const read = () => (document.documentElement.classList.contains("dark") ? "dark" : "light")
  const [scheme, setScheme] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setScheme(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])
  return scheme
}

type Rendered = { svg: string } | { error: string }

/** Diagramas pesam; o mermaid só é baixado quando o primeiro aparece. */
async function renderMermaid(id: string, source: string): Promise<Rendered> {
  const { default: mermaid } = await import("mermaid")
  try {
    mermaid.initialize(buildConfig())
    await mermaid.parse(source)
    const { svg } = await mermaid.render(id, source)
    return { svg }
  } catch (error) {
    // O mermaid deixa um nó de erro solto no <body> quando o desenho falha.
    document.getElementById(`d${id}`)?.remove()
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

const SVG_BOX =
  "[&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full [&_svg]:overflow-visible"

/** Na tela cheia o desenho cabe na janela: a altura limita e a largura acompanha. */
const FIT_BOX = "[&_svg]:max-h-[calc(85vh-5rem)] [&_svg]:w-auto"

export const MermaidDiagram = memo(function MermaidDiagram({ code, isIncomplete }: CustomRendererProps) {
  const { t } = useTranslation()
  const scheme = useColorScheme()
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "")
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [downloadFailed, setDownloadFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Enquanto o fence ainda chega, espera um respiro: cada token novo mudaria
    // o código e dispararia um desenho (e a maioria dos prefixos nem é válida).
    const timer = setTimeout(
      async () => {
        const result = await renderMermaid(`orbit-mmd-${uid}-${Date.now().toString(36)}`, code)
        if (cancelled) return
        if ("svg" in result) {
          setSvg(result.svg)
          setError(null)
        } else {
          setError(result.error)
        }
      },
      isIncomplete ? 300 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [code, isIncomplete, scheme, uid])

  const download = (format: "svg" | "png" | "mmd") => {
    void diagramApi.export(code, format).then((result) => {
      if (!result.ok && !result.canceled) setDownloadFailed(true)
    })
  }

  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  // Fence ainda aberto e sem desenho válido: mantém o último bom (se houver) em
  // vez de piscar erro a cada prefixo inválido.
  if (!svg) {
    if (error && !isIncomplete) {
      return (
        <div className="my-3 rounded-xl bg-secondary/60 px-3.5 py-3 text-sm">
          <div className="text-muted-foreground">{t("mermaid.failed")}</div>
          <pre className="mt-2 max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap">{code}</pre>
        </div>
      )
    }
    return <Skeleton className="my-3 h-40 w-full rounded-xl bg-secondary/60" />
  }

  return (
    <>
      <div className="group/mermaid relative my-3">
        <div
          className={`${SVG_BOX} ${isIncomplete ? "opacity-80" : ""} transition-opacity`}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <div className="absolute top-0 right-0 flex gap-0.5 opacity-0 transition-opacity group-hover/mermaid:opacity-100 has-[[data-popup-open]]:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" title={t("mermaid.download")} />}
              onClick={() => setDownloadFailed(false)}
            >
              <DownloadIcon className={downloadFailed ? "text-destructive" : undefined} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => download("png")}>{t("mermaid.asPng")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => download("svg")}>{t("mermaid.asSvg")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => download("mmd")}>{t("mermaid.asMmd")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon-sm" onClick={copy} title={t("mermaid.copy")}>
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setOpen(true)} title={t("mermaid.expand")}>
            <Maximize2Icon />
          </Button>
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        {/*
          O scroll mora no filho, não no DialogContent: o botão de fechar é
          irmão do conteúdo e posicionado em relação ao diálogo, então só fica
          parado se quem rola for OUTRA caixa. E o diagrama é encolhido para
          caber inteiro na altura da janela (FIT_BOX), então na maioria das
          vezes nem há o que rolar.
        */}
        <DialogContent className="flex max-h-[85vh] w-[min(88vw,64rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
          <DialogTitle className="sr-only">{t("mermaid.expand")}</DialogTitle>
          <div className="min-h-0 flex-1 overflow-auto p-8">
            <div className={`${SVG_BOX} ${FIT_BOX}`} dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
})
