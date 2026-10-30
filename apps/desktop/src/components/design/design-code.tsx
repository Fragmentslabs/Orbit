import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Loader2, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CodeEditor, type CodeEditorHandle } from "@/src/components/code-editor"
import { designApi } from "@/src/lib/ipc"
import type { DesignBoardView } from "./design-properties"

/**
 * The SOURCE of an artboard, editable — the same editor as the files panel. What
 * is saved here is the whole file, and the canvas reloads with it.
 *
 * A change on disk (the agent edited, or the person touched a property)
 * reloads the editor only if there is no draft: with a draft, it warns and lets the
 * person choose, instead of throwing away what they typed.
 */

interface Props {
  designId: string
  boards: DesignBoardView[]
  file: string | null
  /** Path of the element selected on the canvas, when it is from THIS file. */
  selectionPath: number[] | null
  /** Goes up on every change on disk — it is the signal to re-read the file. */
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

  // Selection on the canvas -> highlights and scrolls to the element in the source. It depends on the
  // KEY of the path (not of the array) so as not to re-scroll on every render, and it only acts
  // when the content has already loaded (before that the editor is not even mounted).
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
