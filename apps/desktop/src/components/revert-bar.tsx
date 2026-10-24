import { useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, ChevronDown, History, Undo2, MessageSquareText, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SessionInfo } from "@shared/chat"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Barra exibida acima do input enquanto um revert está ativo:
 * - Modo código: resumo dos arquivos alterados desfeitos + "Desfazer" (unrevert).
 * - Modo código sem snapshot: aviso de que a conversa foi truncada, mas os
 *   arquivos não puderam ser desfeitos (filesRestored === false).
 * - Modo chat: indica que a conversa foi truncada até o ponto revertido.
 * - Nos dois modos: o que foi desfeito fora do repositório — peças (motion,
 *   design, slides) e itens da galeria —, e o que foi PRESERVADO por ter
 *   mudado depois (outra conversa, edição no painel, arquivo externo).
 * Pode ser fechada com o X (não desfaz o revert, só esconde a barra).
 *
 * Depois de um unrevert com conflitos, a mesma barra mostra o aviso
 * transitório do que ficou intacto.
 */
export function RevertBar({ session }: { session: SessionInfo }) {
  const { t } = useTranslation()
  const unrevert = useSessionStore((s) => s.unrevert)
  const revertUncertain = useSessionStore((s) => s.revertUncertain)
  const [revertingUncertain, setRevertingUncertain] = useState(false)
  const notice = useSessionStore((s) => (s.revertNotice?.sessionId === session.id ? s.revertNotice : null))
  const dismissNotice = useSessionStore((s) => s.dismissRevertNotice)
  const [showDiff, setShowDiff] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const revert = session.revert

  // Unrevert com conflitos: não há mais revert ativo, mas o que ficou intacto
  // precisa ser dito — senão a pessoa acha que tudo voltou.
  if (!revert) {
    if (!notice) return null
    const kept = notice.files.length + (notice.media?.conflicts ?? 0)
    const detail = [...notice.files, ...(notice.media?.conflictLabels ?? [])].join("\n")
    const noticeLabel = notice.filesError
      ? t("revert.unrevertFilesError")
      : kept === 1
        ? t("revert.unrevertKeptOne")
        : t("revert.unrevertKeptMany", { n: kept })
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 text-xs">
        <div className="flex items-center gap-2 px-3 py-2">
          <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
          <span className="flex-1 truncate" title={detail || undefined}>
            {noticeLabel}
            {!notice.filesError && <span className="text-muted-foreground"> {t("revert.keptHint")}</span>}
          </span>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={dismissNotice}
            title={t("common.close")}
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    )
  }
  if (dismissed) return null

  const isCode = Boolean(revert.files || revert.diff)
  const count = revert.files?.length ?? 0
  // Modo código sem snapshot: o truncamento aconteceu, mas o filesystem não
  // pôde ser restaurado — aviso explícito em vez de tratar como revert de chat.
  // 'capture-failed' (restore falhou) tem mensagem própria vs. 'no-snapshot'
  // (snapshot indisponível para a mensagem) e 'no-end-snapshot' (o turno pode
  // ter escrito, mas o estado final não foi registrado).
  const filesNotRestored = Boolean(session.directory) && revert.filesRestored === false
  const label = filesNotRestored
    ? revert.reason === "capture-failed"
      ? t("revert.filesRestoreFailed")
      : revert.reason === "no-end-snapshot"
        ? t("revert.filesNoEndSnapshot")
        : t("revert.filesNotRestored")
    : isCode
      ? count === 0
        ? t("revert.filesRevertedNone")
        : count === 1
          ? t("revert.filesRevertedOne")
          : t("revert.filesRevertedMany", { n: count })
      : t("revert.conversationReverted")

  // Mídia: peças e galeria moram no armazenamento do app e têm diário próprio,
  // nos dois modos (ver session/media-revert.ts).
  const media = revert.media
  const mediaFailed = media?.restored === false
  const mediaParts = [
    media?.pieces ? t("revert.mediaPieces", { count: media.pieces }) : null,
    media?.items ? t("revert.mediaItems", { count: media.items }) : null,
  ].filter(Boolean)
  const mediaLabel = mediaFailed
    ? t("revert.mediaFailed")
    : mediaParts.length > 0
      ? t("revert.mediaReverted", { what: mediaParts.join(", ") })
      : null

  // O que mudou depois do turno e ficou intacto.
  const filesKept = revert.conflicts ?? []
  const mediaKept = media?.conflicts ?? 0
  const keptParts = [
    filesKept.length > 0
      ? filesKept.length === 1
        ? t("revert.filesKeptOne")
        : t("revert.filesKeptMany", { n: filesKept.length })
      : null,
    mediaKept > 0
      ? mediaKept === 1
        ? t("revert.mediaKeptOne")
        : t("revert.mediaKeptMany", { n: mediaKept })
      : null,
  ].filter(Boolean)
  const keptLabel = keptParts.length > 0 ? keptParts.join(", ") : null
  // Mudou durante o turno, mas não pelas ferramentas de escrita do Orbit (bash,
  // MCP, algo de fora): não foi revertido — a pessoa decide.
  const uncertain = revert.uncertain ?? []
  const uncertainLabel =
    uncertain.length === 0
      ? null
      : uncertain.length === 1
        ? t("revert.uncertainOne")
        : t("revert.uncertainMany", { n: uncertain.length })
  const uncertainDetail = uncertain.join("\n")
  const keptDetail = [...filesKept, ...(media?.conflictLabels ?? [])].join("\n")
  const warn = filesNotRestored || mediaFailed || Boolean(keptLabel)
  const title = [
    mediaLabel,
    keptLabel && `${keptLabel}${keptDetail ? `\n${keptDetail}` : ""}`,
    uncertainLabel && `${uncertainLabel}\n${uncertainDetail}`,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <div className="rounded-lg border bg-muted/40 text-xs">
      <div className="flex items-center gap-2 px-3 py-2">
        {warn
          ? <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
          : isCode || mediaLabel
            ? <History className="size-3.5 shrink-0 text-muted-foreground" />
            : <MessageSquareText className="size-3.5 shrink-0 text-muted-foreground" />
        }
        <span className="flex-1 truncate" title={title || label}>
          {label}
          {mediaLabel && <span className={cn(mediaFailed && "text-amber-600 dark:text-amber-400")}> · {mediaLabel}</span>}
          {keptLabel && (
            <span
              className="text-amber-600 dark:text-amber-400"
              title={keptDetail || undefined}
            >
              {" "}· {keptLabel}
            </span>
          )}
          {uncertainLabel && (
            <span className="text-muted-foreground" title={uncertainDetail}>
              {" "}· {uncertainLabel}
            </span>
          )}
          <span className="text-muted-foreground"> — {t("revert.continueFromHere")}</span>
        </span>
        {revert.diff && (
          <button
            type="button"
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => setShowDiff((v) => !v)}
          >
            {t("revert.diff")}
            <ChevronDown className={cn("size-3 transition-transform", showDiff && "rotate-180")} />
          </button>
        )}
        {uncertainLabel && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={revertingUncertain}
            title={uncertainDetail}
            onClick={() => {
              setRevertingUncertain(true)
              void revertUncertain(session.id).finally(() => setRevertingUncertain(false))
            }}
          >
            {t("revert.revertUncertain")}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          onClick={() => void unrevert(session.id)}
        >
          <Undo2 className="size-3" />
          {t("revert.unrevert")}
        </Button>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setDismissed(true)}
          title={t("common.close")}
        >
          <X className="size-3.5" />
        </button>
      </div>
      {showDiff && revert.diff && (
        <pre className="max-h-56 overflow-auto border-t px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {revert.diff}
        </pre>
      )}
    </div>
  )
}
