import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CodeXml, Download, Maximize2, Minus, PanelRight, Plus, RotateCw } from "lucide-react"
import type { ArtifactPart } from "@shared/chat"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { artifactApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"
import { cn } from "@/lib/utils"

/**
 * Artefato HTML na resposta do assistente (tool create_artifact): a página
 * renderiza AQUI, no fluxo da conversa.
 *
 * O conteúdo é escrito pelo modelo — que pode ter lido a web no mesmo turno —
 * então roda num iframe `sandbox="allow-scripts"` SEM `allow-same-origin`: o
 * documento fica em origem opaca, sem acesso ao window do Orbit, sem cookies
 * e sem storage. Script roda (um dashboard sem JS não serve pra nada), mas
 * confinado. Essa combinação é intencional: `allow-scripts` +
 * `allow-same-origin` juntos permitiriam ao artefato remover o próprio
 * sandbox.
 *
 * É essa origem opaca que explica por que a barra de rolagem NÃO pode vir do
 * ScrollArea do app: o componente só estiliza o que ele mesmo rola, e daqui não
 * se alcança o DOM de dentro do iframe. Quem resolve isso é o main, injetando o
 * estilo no HTML servido (ver ARTIFACT_CHROME em electron/lib/media.ts).
 */

/**
 * Altura do preview como fração da JANELA, não em pixels fixos: 420px fixos
 * ficavam apertados para um dashboard, e a mesma altura pesa diferente num
 * notebook e num monitor grande. A fração mantém a presença relativa
 * constante — alto o bastante para o artefato fazer sentido, baixo o bastante
 * para a conversa continuar visível em volta.
 */
const PREVIEW_VIEWPORT_RATIO = 0.6
const MIN_PREVIEW_HEIGHT = 420

const SANDBOX = "allow-scripts allow-popups allow-forms allow-modals"

/**
 * Zoom da tela cheia. O iframe é elemento NOSSO (ao contrário do scroll de
 * dentro dele), então dá para escalar de fora. `transform: scale` com o tamanho
 * INVERTIDO (width/height = 100/z) encolhe o viewport interno do iframe, e o
 * artefato reflui como no zoom do navegador; só `scale` escalaria o raster e o
 * texto sairia borrado.
 *
 * `webFrame.setZoomFactor` não serve aqui: é por webContents, e o iframe divide
 * o renderer com o app — zoomsaria a interface inteira do Orbit.
 */
const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_STEP = 0.25

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100))

function ArtifactFrame({
  src,
  title,
  className,
  style,
  nonce,
}: {
  src: string
  title: string
  className?: string
  style?: React.CSSProperties
  /** Muda para forçar o remount do iframe (revisão nova ou "recarregar"). */
  nonce: string
}) {
  return (
    <iframe
      key={nonce}
      src={src}
      title={title}
      sandbox={SANDBOX}
      // O artefato não deve poder pedir câmera/microfone/geolocalização —
      // nada no caso de uso justifica, e o sandbox sozinho não cobre isso.
      allow=""
      referrerPolicy="no-referrer"
      className={cn("w-full border-0 bg-white", className)}
      style={style}
    />
  )
}

/**
 * Cabeçalho compartilhado das três superfícies do artefato (card na conversa,
 * aba do painel, tela cheia).
 *
 * O que o deixava "marcado" era a faixa cinza (bg-muted/50) somada à borda
 * cheia; aqui o fundo fica o do próprio card e sobra só um fio de separação. O
 * título desce para `text-muted-foreground` — continua legível e para de
 * competir com o conteúdo, que é o que o usuário veio ver.
 */
function ArtifactToolbar({
  title,
  badge,
  actions,
  icon: Icon = CodeXml,
  className,
}: {
  title: string
  badge?: React.ReactNode
  actions: React.ReactNode
  icon?: typeof CodeXml
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-2.5 py-1.5",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium text-muted-foreground">{title}</span>
        {badge}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover/artifact:opacity-100 focus-within:opacity-100">
        {actions}
      </div>
    </div>
  )
}

export function ArtifactPartView({
  part,
  sessionId,
}: {
  part: ArtifactPart
  /** Ausente em contextos sem sessão (histórico avulso): o botão de abrir no
   *  painel some, já que as abas são por sessão. */
  sessionId?: string
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [reloads, setReloads] = useState(0)
  const openArtifactTab = usePanelStore((s) => s.openArtifactTab)

  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === 'undefined' ? 900 : window.innerHeight,
  )
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const previewHeight = Math.max(
    MIN_PREVIEW_HEIGHT,
    Math.round(viewportHeight * PREVIEW_VIEWPORT_RATIO),
  )

  // Recarrega quando o agente reescreve ESTE artefato. A `part` de uma
  // mensagem antiga guarda a revisão de quando ela foi criada e nunca muda —
  // sem o aviso do main, o card de cima continuaria mostrando a versão velha
  // do mesmo arquivo que o card de baixo já mostra atualizado.
  useEffect(
    () =>
      artifactApi.onUpdated(({ artifactId }) => {
        if (artifactId === part.artifactId) setReloads((n) => n + 1)
      }),
    [part.artifactId],
  )

  // O arquivo é reescrito no lugar pelo update_artifact, então a URL sozinha
  // não distingue as revisões — sem isto o iframe serviria a versão antiga.
  const src = useMemo(
    () => `${part.src}?rev=${part.revision ?? 1}&r=${reloads}`,
    [part.src, part.revision, reloads],
  )
  const nonce = `${part.artifactId}:${part.revision ?? 1}:${reloads}`

  const onExport = useCallback(() => {
    void artifactApi.export(part.artifactId)
  }, [part.artifactId])

  return (
    <>
      <div className="group/artifact not-prose my-2 w-full overflow-hidden rounded-lg border bg-background shadow-sm">
        <ArtifactToolbar
          title={part.title}
          badge={
            (part.revision ?? 1) > 1 && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t("artifacts.revision", { n: part.revision })}
              </span>
            )
          }
          actions={
            <>
              {/* Ordem igual à do card de documento: baixar, recarregar, painel,
                  tela cheia — o mesmo gesto na mesma posição nos dois cards. */}
              <IconAction icon={Download} label={t("artifacts.export")} onClick={onExport} />
              <IconAction
                icon={RotateCw}
                label={t("artifacts.reload")}
                onClick={() => setReloads((n) => n + 1)}
              />
              {sessionId && (
                <IconAction
                  icon={PanelRight}
                  label={t("artifacts.openInPanel")}
                  onClick={() => openArtifactTab(sessionId, part.artifactId, part.title)}
                />
              )}
              <IconAction
                icon={Maximize2}
                label={t("artifacts.expand")}
                onClick={() => setExpanded(true)}
              />
            </>
          }
        />
        <ArtifactFrame
          src={src}
          title={part.title}
          nonce={nonce}
          style={{ height: previewHeight }}
        />
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        {/*
          flex-col, e não o grid padrão do DialogContent: com altura fixa, as
          linhas implícitas do grid são ESTICADAS (align-content normal vira
          stretch), e a linha do título ficava com metade do diálogo — a faixa
          vazia no topo, com o conteúdo empurrado para baixo. Mesmo padrão do
          plan-dialog.
        */}
        <DialogContent className="flex h-[88vh] max-w-[92vw] flex-col gap-0 p-0">
          <DialogTitle className="shrink-0 border-b border-border/60 px-4 py-2 pr-12 text-sm font-medium">
            {part.title}
          </DialogTitle>
          {/* O zoom vive só aqui: no card o preview é uma fração da janela e
              não há espaço para o artefato crescer sem empurrar a conversa. */}
          <ArtifactStage src={src} title={part.title} nonce={`${nonce}:full`} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * Palco do artefato em tela cheia: aplica o zoom e ancora a barra de controles.
 *
 * Monta junto com o diálogo (o Dialog não mantém o conteúdo quando fechado),
 * então o zoom volta a 100% a cada abertura — que é o que se espera de uma
 * janela recém-aberta.
 */
function ArtifactStage({ src, title, nonce }: { src: string; title: string; nonce: string }) {
  const [zoom, setZoom] = useState(1)
  const stageRef = useRef<HTMLDivElement | null>(null)

  // Ctrl+roda. O listener é nativo porque `preventDefault` num handler passivo
  // (como o do React) é ignorado, e aí o Chromium aplicaria o zoom da JANELA em
  // vez do artefato.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoom((z) => clampZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Ctrl + / − / 0, o mesmo atalho de qualquer visualizador.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        setZoom((z) => clampZoom(z + ZOOM_STEP))
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        setZoom((z) => clampZoom(z - ZOOM_STEP))
      } else if (e.key === '0') {
        e.preventDefault()
        setZoom(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden">
      <ArtifactFrame
        src={src}
        title={title}
        nonce={nonce}
        className="absolute top-0 left-0"
        style={{
          width: `${100 / zoom}%`,
          height: `${100 / zoom}%`,
          transform: `scale(${zoom})`,
          transformOrigin: 'top left',
        }}
      />
      <ZoomBar zoom={zoom} onChange={setZoom} />
    </div>
  )
}

/** Controles flutuantes de zoom — discreto sobre o conteúdo, sem barra fixa. */
function ZoomBar({ zoom, onChange }: { zoom: number; onChange: (z: number) => void }) {
  const { t } = useTranslation()
  return (
    <div className="absolute right-3 bottom-3 z-10 flex items-center gap-0.5 rounded-full border border-border/60 bg-background/80 p-0.5 shadow-sm backdrop-blur-sm">
      <IconAction
        icon={Minus}
        label={t("artifacts.zoomOut")}
        disabled={zoom <= ZOOM_MIN}
        onClick={() => onChange(clampZoom(zoom - ZOOM_STEP))}
      />
      <button
        type="button"
        onClick={() => onChange(1)}
        title={t("artifacts.zoomReset")}
        aria-label={t("artifacts.zoomReset")}
        className="min-w-11 rounded-full px-1 text-[11px] font-medium tabular-nums text-muted-foreground transition-colors hover:text-foreground"
      >
        {Math.round(zoom * 100)}%
      </button>
      <IconAction
        icon={Plus}
        label={t("artifacts.zoomIn")}
        disabled={zoom >= ZOOM_MAX}
        onClick={() => onChange(clampZoom(zoom + ZOOM_STEP))}
      />
    </div>
  )
}

function IconAction({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof RotateCw
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6 text-muted-foreground"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <Icon className="size-3.5" />
    </Button>
  )
}

export { ArtifactFrame, ArtifactToolbar, IconAction }
