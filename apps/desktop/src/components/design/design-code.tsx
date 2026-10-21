import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Loader2, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CodeEditor, type CodeEditorHandle } from "@/src/components/code-editor"
import { designApi } from "@/src/lib/ipc"
import type { DesignBoardView } from "./design-properties"

/**
 * O FONTE de um artboard, editável — o mesmo editor do painel de arquivos. O
 * que se salva aqui é o arquivo inteiro, e o canvas recarrega com ele.
 *
 * Mudança no disco (o agente editou, ou a pessoa mexeu numa propriedade)
 * recarrega o editor só se não houver rascunho: com rascunho, avisa e deixa a
 * pessoa escolher, em vez de jogar fora o que ela digitou.
 */

interface Props {
  designId: string
  boards: DesignBoardView[]
  file: string | null
  /** Caminho do elemento selecionado no canvas, quando é DESTE arquivo. */
  selectionPath: number[] | null
  /** Sobe a cada mudança no disco — é o sinal para reler o arquivo. */
  version: number
  onFileChange: (file: string) => void
  onSave: (file: string, html: string) => Promise<void>
}

export function DesignCode({ designId, boards, file, selectionPath, version, onFileChange, onSave }: Props) {
  const { t } = useTranslation()
  const editorRef = useRef<CodeEditorHandle | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [stale, setStale] = useState(false)
  const [saving, setSaving] = useState(false)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  const load = useCallback(() => {
    if (!file) return
    setError(null)
    designApi
      .readBoard(designId, file)
      .then((text) => {
        setContent(text)
        setStale(false)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [designId, file])

  useEffect(() => {
    setContent(null)
    setDirty(false)
    load()
  }, [load])

  useEffect(() => {
    if (version === 0) return
    if (dirtyRef.current) setStale(true)
    else load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  // Seleção no canvas -> realça e rola até o elemento no fonte. Depende da
  // CHAVE do caminho (não do array) para não rerolar a cada render, e só age
  // quando o conteúdo já carregou (antes disso o editor nem está montado).
  const pathKey = selectionPath ? selectionPath.join(".") : ""
  const ready = content !== null
  useEffect(() => {
    editorRef.current?.revealElement(selectionPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathKey, file, ready])

  const save = useCallback(
    async (text: string) => {
      if (!file) return
      setSaving(true)
      setError(null)
      try {
        await onSave(file, text)
        setContent(text)
        setDirty(false)
        setStale(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setSaving(false)
      }
    },
    [file, onSave],
  )

  if (boards.length === 0 || !file) {
    return <p className="px-3 py-3 text-[11px] text-muted-foreground">{t("design.empty")}</p>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1.5">
        <Select value={file} onValueChange={(next) => next && onFileChange(String(next))}>
          <SelectTrigger size="sm" className="h-6 min-w-0 flex-1 font-mono text-[11px]">
            <SelectValue>{file}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {boards.map((board) => (
              <SelectItem key={board.file} value={board.file}>
                {board.title ? `${board.title} · ${board.file}` : board.file}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {saving ? t("design.code.saving") : dirty ? t("design.code.unsaved") : t("design.code.saved")}
        </span>
        <Button
          variant="default"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px]"
          disabled={!dirty || saving}
          onClick={() => editorRef.current && void save(editorRef.current.getContent())}
        >
          {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
          {t("design.code.save")}
        </Button>
      </div>
      {stale && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <span className="min-w-0 flex-1">{t("design.code.stale")}</span>
          <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={load}>
            {t("design.code.reloadFromDisk")}
          </Button>
        </div>
      )}
      {error && <p className="shrink-0 px-3 py-1.5 text-[11px] text-destructive">{t("design.saveFailed", { error })}</p>}
      <div className="min-h-0 flex-1 overflow-hidden">
        {content === null ? (
          <div className="flex h-full items-center justify-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            {t("design.code.loading")}
          </div>
        ) : (
          <CodeEditor
            ref={editorRef}
            content={content}
            filePath={file}
            editable
            wrap
            onDirtyChange={setDirty}
            onSave={(text) => void save(text)}
          />
        )}
      </div>
    </div>
  )
}
