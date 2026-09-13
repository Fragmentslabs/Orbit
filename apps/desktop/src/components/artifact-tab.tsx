import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Download, RotateCw } from "lucide-react"
import { ARTIFACT_SCHEME } from "@shared/media"
import type { MediaEntry } from "@shared/media"
import { Button } from "@/components/ui/button"
import { ArtifactFrame } from "@/src/components/ai/artifact-part"
import { artifactApi, mediaApi } from "@/src/lib/ipc"

/**
 * Artefato em tela cheia na aba do painel direito — o mesmo arquivo do card na
 * conversa, com espaço pra valer (dashboard, protótipo de tela).
 *
 * A aba guarda só o `artifactId`: o título e a revisão vêm do registry a cada
 * abertura, então uma aba que ficou aberta enquanto o agente chamava
 * update_artifact mostra a versão nova ao voltar.
 */
export function ArtifactTab({ artifactId, title }: { artifactId?: string; title: string }) {
  const { t } = useTranslation()
  const [entry, setEntry] = useState<MediaEntry | null>(null)
  const [missing, setMissing] = useState(false)
  const [reloads, setReloads] = useState(0)

  useEffect(() => {
    if (!artifactId) return
    let cancelled = false
    // Artefato e documento usam a mesma aba: os dois são servidos como HTML
    // pelo orbit-artifact://.
    void mediaApi.list({ kind: ["artifact", "document"] }).then((entries) => {
      if (cancelled) return
      const found = entries.find((e) => e.id === artifactId) ?? null
      setEntry(found)
      setMissing(!found)
    })
    return () => {
      cancelled = true
    }
  }, [artifactId, reloads])

  // Mesma razão do card na conversa: a aba pode estar aberta enquanto o agente
  // reescreve o artefato. O bump do `reloads` refaz a leitura do registry (daí
  // ele estar nas deps do efeito acima) e remonta o iframe.
  useEffect(
    () =>
      artifactApi.onUpdated((payload) => {
        if (payload.artifactId === artifactId) setReloads((n) => n + 1)
      }),
    [artifactId],
  )

  const onExport = useCallback(() => {
    if (artifactId) void artifactApi.export(artifactId)
  }, [artifactId])

  if (!artifactId || missing) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {t("artifacts.unavailable")}
      </div>
    )
  }

  // Documento: o id do registro é o fonte .md, mas o que renderiza é o .html.
  const fileId = artifactId.endsWith(".md") ? artifactId.replace(/\.md$/, ".html") : artifactId
  const src = `${ARTIFACT_SCHEME}://${fileId}?rev=${entry?.revision ?? 1}&r=${reloads}`

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="truncate text-xs font-medium">{entry?.name || title}</span>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t("artifacts.reload")}
            onClick={() => setReloads((n) => n + 1)}
          >
            <RotateCw className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t("artifacts.export")}
            onClick={onExport}
          >
            <Download className="size-3.5" />
          </Button>
        </div>
      </div>
      <ArtifactFrame
        src={src}
        title={entry?.name || title}
        nonce={`${artifactId}:${entry?.revision ?? 1}:${reloads}`}
        className="flex-1"
      />
    </div>
  )
}
