import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { EyeIcon, PenLineIcon, X } from "lucide-react"
import { DocumentDownloadMenu, DocumentSourceBadge } from "@/src/components/ai/document-actions"
import { MessageResponse } from "@/src/components/ai/message"
import { QuoteSelection } from "@/src/components/quote-selection"
import { artifactApi, documentApi } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"

/**
 * O documento vivo, aberto ao lado da conversa: lê-se em Markdown renderizado
 * e edita-se no mesmo lugar, enquanto o agente continua escrevendo nele.
 *
 * Aqui o fonte é o Markdown, e não o HTML de preview que o card da conversa
 * mostra num iframe — é o que torna a edição possível. O card continua sendo
 * um retrato: assim que esta aba grava, ele recebe o aviso e recarrega.
 *
 * Quem foi PEDIDO como arquivo (PDF, Word) não chega aqui: aquele abre no
 * visualizador de documento, com sumário, zoom e impressão, que é o que se
 * quer de um arquivo pronto.
 *
 * DUAS MÃOS NO MESMO ARQUIVO. O agente reescreve o documento inteiro a cada
 * update_document, então gravar sem saber da versão do outro apaga trabalho —
 * nos dois sentidos. Por isso toda gravação leva a revisão de que partiu: se o
 * documento andou, ela é RECUSADA e quem decide é o usuário, aqui no aviso, em
 * vez de o último a gravar vencer em silêncio.
 */

/** Pausa da digitação que dispara a gravação. Curta o bastante para o card da
 *  conversa acompanhar, longa o bastante para não gravar a cada tecla. */
const AUTOSAVE_MS = 1200

export function DocumentTab({
  documentId,
  title,
  sessionId,
}: {
  documentId?: string
  title: string
  /** Escopo das Fontes: promover é sempre para a conversa em que se está. */
  sessionId?: string
}) {
  const { t } = useTranslation()
  const [markdown, setMarkdown] = useState<string | null>(null)
  /** Área de leitura — é dela que sai a seleção citável. */
  const readRef = useRef<HTMLDivElement>(null)
  const [missing, setMissing] = useState(false)
  const [mode, setMode] = useState<"edit" | "preview">("preview")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** A revisão que está em disco quando o agente escreveu por cima do que
   *  estamos editando. Não-nula = o aviso está de pé e nada é gravado até o
   *  usuário escolher. */
  const [conflict, setConflict] = useState<number | null>(null)

  /** O que está em disco — é a comparação que diz se há algo por gravar. */
  const savedRef = useRef<string | null>(null)
  /** A revisão de que o texto atual partiu. Vai em toda gravação. */
  const baseRef = useRef<number | null>(null)
  const timerRef = useRef<number | undefined>(undefined)
  /** Gravações em voo: o aviso que elas disparam volta para cá, e não pode ser
   *  lido como "alguém mexeu no documento". */
  const savingRef = useRef(0)
  /** O texto mais recente. A gravação de saída não pode depender do estado: o
   *  cleanup do efeito o enxergaria congelado no valor de quando montou. */
  const latestRef = useRef<string | null>(null)
  latestRef.current = markdown
  const conflictRef = useRef<number | null>(null)
  conflictRef.current = conflict

  const load = useCallback(async () => {
    if (!documentId) return
    const found = await documentApi.source(documentId)
    if (!found) {
      setMissing(true)
      return
    }
    savedRef.current = found.markdown
    baseRef.current = found.revision
    setMarkdown(found.markdown)
    conflictRef.current = null
    setConflict(null)
  }, [documentId])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async () => {
    const text = latestRef.current
    if (!documentId || text === null || text === savedRef.current) return
    // Conflito conhecido: insistir só colheria a mesma recusa. O texto continua
    // aqui, inteiro, até o usuário dizer o que fazer com ele.
    if (conflictRef.current !== null) return
    window.clearTimeout(timerRef.current)
    savingRef.current += 1
    setSaving(true)
    try {
      const result = await documentApi.saveSource(documentId, text, baseRef.current ?? undefined)
      if (result.ok) {
        savedRef.current = text
        baseRef.current = result.revision
      } else if (result.reason === "stale") {
        conflictRef.current = result.revision
        setConflict(result.revision)
      } else {
        setError(t("documents.saveFailed"))
      }
    } finally {
      savingRef.current -= 1
      setSaving(false)
    }
  }, [documentId, t])

  const onChange = useCallback(
    (value: string) => {
      setMarkdown(value)
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => void save(), AUTOSAVE_MS)
    },
    [save],
  )

  // Sair da aba (ou do chat) não pode engolir o que estava na pausa da
  // digitação: o que ainda não foi gravado vai agora.
  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current)
      void save()
    },
    [save],
  )

  // O agente escrevendo no MESMO documento. O aviso carrega o id do preview
  // (.html); o documento é o .md irmão.
  useEffect(() => {
    if (!documentId) return
    return artifactApi.onUpdated((payload) => {
      if (payload.artifactId.replace(/\.html$/, "") !== documentId.replace(/\.md$/, "")) return
      if (savingRef.current > 0 || payload.revision === baseRef.current) return
      // Recarregar por cima de uma edição não gravada apagaria o que o usuário
      // acabou de escrever. Com o texto limpo, a versão nova entra sozinha;
      // com texto sujo, quem decide é ele.
      if (latestRef.current !== savedRef.current) {
        conflictRef.current = payload.revision
        setConflict(payload.revision)
      } else {
        void load()
      }
    })
  }, [documentId, load])

  /** "Manter o meu": adota a revisão do disco como base e grava por cima — um
   *  descarte DELIBERADO da versão do agente, e não o acaso de quem gravou por
   *  último. */
  const keepMine = useCallback(() => {
    baseRef.current = conflictRef.current
    conflictRef.current = null
    setConflict(null)
    void save()
  }, [save])

  const status = useMemo(() => {
    if (saving) return t("documents.saving")
    if (markdown !== null && markdown !== savedRef.current) return t("documents.unsaved")
    return t("documents.saved")
  }, [saving, markdown, t])

  if (!documentId || missing) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {t("documents.unavailable")}
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-medium">{title}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{status}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Gravam antes de agir: o arquivo e a fonte saem do que está EM
              DISCO, e o que ficou na pausa da digitação sairia de fora. */}
          {sessionId && (
            <DocumentSourceBadge
              documentId={documentId}
              sessionId={sessionId}
              onError={setError}
              beforeAdd={save}
            />
          )}
          <DocumentDownloadMenu
            documentId={documentId}
            onError={setError}
            beforeDownload={save}
          />
          <div className="flex items-center gap-0.5 rounded-full border border-border bg-popover/90 p-0.5 shadow-sm backdrop-blur-xl">
            <button
              type="button"
              onClick={() => setMode("edit")}
              title={t("folders.editMode")}
              className={cn(
                "flex size-6 items-center justify-center rounded-full transition-colors",
                mode === "edit"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <PenLineIcon className="size-3.5" />
            </button>
            <button
              type="button"
              // Voltar para a leitura grava antes: o card na conversa mostra o
              // que está em disco, e ficar atrás do que se acabou de escrever
              // pareceria que a edição se perdeu.
              onClick={() => {
                void save()
                setMode("preview")
              }}
              title={t("folders.previewMode")}
              className={cn(
                "flex size-6 items-center justify-center rounded-full transition-colors",
                mode === "preview"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <EyeIcon className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      {conflict !== null && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-primary/10 px-3 py-1.5 text-[11px]">
          <p className="min-w-0 flex-1">{t("documents.externalChange")}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-medium hover:bg-primary/20"
          >
            {t("documents.loadTheirs")}
          </button>
          <button
            type="button"
            onClick={keepMine}
            className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-medium hover:bg-primary/20"
          >
            {t("documents.keepMine")}
          </button>
        </div>
      )}

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

      {markdown === null ? (
        <div className="p-4 text-sm text-muted-foreground">{t("common.loading")}</div>
      ) : mode === "edit" ? (
        <textarea
          value={markdown}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none bg-transparent px-4 py-4 font-mono text-xs leading-5 text-foreground outline-none"
        />
      ) : (
        <div
          ref={readRef}
          className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-4 text-sm text-foreground"
        >
          {/* Sem resolve: o documento vivo não tem página nem linha — o
              trecho citado é o texto, e é só isso que o chip carrega. */}
          {documentId && (
            <QuoteSelection containerRef={readRef} docId={documentId} name={title} />
          )}
          <MessageResponse>{markdown}</MessageResponse>
        </div>
      )}
    </div>
  )
}
