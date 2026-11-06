import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronLeft, File, Folder, Loader2, X } from "lucide-react"
import type { RemoteFileContent, RemoteFileTree } from "@shared/peers"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { peersApi } from "@/src/lib/ipc"

/**
 * The project folders of a remote chat, read-only (the "see project files"
 * grant). The other machine resolves every path inside the chat's own folders and
 * hides secrets (.env, keys, .git); this side only names a root, a path and a file.
 */
export function RemoteFiles({ sessionId, peerName, onClose }: { sessionId: string; peerName: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [root, setRoot] = useState(0)
  const [dir, setDir] = useState("")
  const [tree, setTree] = useState<RemoteFileTree | null>(null)
  const [file, setFile] = useState<RemoteFileContent | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    peersApi
      .fsTree(sessionId, root, dir)
      .then((next) => !cancelled && setTree(next))
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [sessionId, root, dir])

  const openFile = async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      setFile(await peersApi.fsRead(sessionId, root, path))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : ""

  return (
    <aside className="flex w-[44%] min-w-[280px] max-w-[560px] flex-col overflow-hidden rounded-lg border bg-card">
      <header className="flex items-center gap-2 border-b px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium">{t("peers.files.title", { name: peerName })}</span>
        {tree && tree.roots.length > 1 ? (
          <select
            value={root}
            onChange={(e) => {
              setRoot(Number(e.target.value))
              setDir("")
              setFile(null)
            }}
            className="rounded border bg-background px-1 py-0.5 text-xs"
          >
            {tree.roots.map((r) => (
              <option key={r.index} value={r.index}>
                {r.name}
              </option>
            ))}
          </select>
        ) : null}
        <Button variant="ghost" size="icon" className="size-6" onClick={onClose} aria-label={t("peers.files.close")}>
          <X className="size-3.5" />
        </Button>
      </header>

      {file ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b px-2 py-1.5 text-xs">
            <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs" onClick={() => setFile(null)}>
              <ChevronLeft className="size-3.5" />
              {t("peers.files.up")}
            </Button>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{file.path}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {file.encoding === "utf8" ? (
              <pre className="whitespace-pre p-3 font-mono text-[12px] leading-relaxed">{file.content}</pre>
            ) : file.mime.startsWith("image/") && file.content ? (
              <img src={`data:${file.mime};base64,${file.content}`} alt={file.path} className="m-3 max-w-[calc(100%-1.5rem)] rounded border" />
            ) : (
              <p className="p-4 text-xs text-muted-foreground">{t("peers.files.binary")}</p>
            )}
            {file.truncated && file.encoding === "utf8" ? (
              <p className="px-3 pb-3 text-[11px] text-muted-foreground">{t("peers.files.truncated")}</p>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {dir ? (
            <button
              type="button"
              onClick={() => setDir(parent)}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
            >
              <ChevronLeft className="size-3.5" />
              {dir}
            </button>
          ) : null}
          {tree && tree.roots.length === 0 ? <p className="p-3 text-xs text-muted-foreground">{t("peers.files.noFolder")}</p> : null}
          {tree && tree.roots.length > 0 && tree.entries.length === 0 && !loading ? (
            <p className="p-3 text-xs text-muted-foreground">{t("peers.files.empty")}</p>
          ) : null}
          {tree?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => (entry.dir ? setDir(entry.path) : void openFile(entry.path))}
              className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted")}
            >
              {entry.dir ? <Folder className="size-3.5 shrink-0 text-sky-500" /> : <File className="size-3.5 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {entry.size !== undefined ? <span className="text-[10px] text-muted-foreground">{formatSize(entry.size)}</span> : null}
            </button>
          ))}
        </div>
      )}
      {loading ? (
        <div className="flex items-center gap-2 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
        </div>
      ) : null}
      {error ? <p className="border-t px-3 py-1.5 text-[11px] text-destructive">{t("peers.files.error", { error })}</p> : null}
    </aside>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
