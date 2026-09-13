import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { CodeXml, Download, Maximize2, PanelRight, RotateCw } from "lucide-react"
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
 */

/** Altura do preview embutido — alto o bastante pra um dashboard fazer sentido,
 *  baixo o bastante pra não sequestrar a rolagem da conversa. */
const PREVIEW_HEIGHT = 420

const SANDBOX = "allow-scripts allow-popups allow-forms allow-modals"

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
      <div className="not-prose my-2 w-full overflow-hidden rounded-lg border bg-background shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b bg-muted/50 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <CodeXml className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-xs font-medium">{part.title}</span>
            {(part.revision ?? 1) > 1 && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t("artifacts.revision", { n: part.revision })}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
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
            <IconAction icon={Download} label={t("artifacts.export")} onClick={onExport} />
            <IconAction
              icon={Maximize2}
              label={t("artifacts.expand")}
              onClick={() => setExpanded(true)}
            />
          </div>
        </div>
        <ArtifactFrame
          src={src}
          title={part.title}
          nonce={nonce}
          style={{ height: PREVIEW_HEIGHT }}
        />
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        {/*
          flex-col, e não o grid padrão do DialogContent: com altura fixa, as
          linhas implícitas do grid são ESTICADAS (align-content normal vira
          stretch), e a linha do título ficava com metade do diálogo — a faixa
          vazia no topo, com o conteúdo empurrado para baixo. Mesmo padrão do
          plan-dialog e do process-output-dialog.
        */}
        <DialogContent className="flex h-[88vh] max-w-[92vw] flex-col gap-0 p-0">
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

function IconAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof RotateCw
  label: string
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6"
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <Icon className="size-3.5" />
    </Button>
  )
}

export { ArtifactFrame }
