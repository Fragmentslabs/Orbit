import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { FolderSearch, TriangleAlert, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useWorkspace } from "@/lib/workspace-context"
import { fsApi, windowApi } from "@/src/lib/ipc"
import { collectFolderPaths, missingFolders, type MissingFolder } from "@/src/lib/relocate"
import { useSessionStore } from "@/src/stores/session-store"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Folders that disappeared from the disk.
 *
 * The path is kept as a string, so renaming the folder in Finder is
 * invisible to Orbit until someone tries to use it. Like VS Code, we
 * check on opening and offer the only way out that does not lose work:
 * relocating.
 *
 * The check compares the stored paths with the disk NOW — it does not watch
 * renames. That is why a folder renamed before this existed appears the
 * same way, without needing a migration. The price is having no watcher: the list is
 * checked on opening and when it changes.
 */
export function MissingFoldersBanner() {
  const { t } = useTranslation()
  const { folders, setFolders } = useWorkspace()
  const sessions = useSessionStore((s) => s.sessions)
  const relocateFolder = useSessionStore((s) => s.relocateFolder)
  const forgetFolder = useSessionStore((s) => s.forgetFolder)
  const [missing, setMissing] = useState<MissingFolder[]>([])
  const [dismissed, setDismissed] = useState(false)

  const paths = useMemo(() => collectFolderPaths(folders, sessions), [folders, sessions])
  // The string is the identity of the list: `sessions` changes reference on every
  // message, and without it the check would go to the main process on every token written.
  const pathsKey = paths.join("\n")

  useEffect(() => {
    const current = pathsKey ? pathsKey.split("\n") : []
    if (current.length === 0) {
      setMissing([])
      return
    }
    let cancelled = false
    void fsApi
      .existingDirs(current)
      .then((existing) => {
        if (!cancelled) setMissing(missingFolders(current, existing))
      })
      .catch(() => {
        // Without an answer from the main process the check did not happen. Silence is better than
        // an alert nobody can confirm.
      })
    return () => {
      cancelled = true
    }
  }, [pathsKey])

  const relocate = useCallback(
    async (path: string) => {
      const picked = await windowApi.selectFolder()
      if (!picked) return
      // The workspace folders live outside the store: what reconnects the two ends
      // is here.
      if (folders.includes(path)) {
        setFolders(folders.map((folder) => (folder === path ? picked : folder)))
      }
      relocateFolder(path, picked)
      setMissing((prev) => prev.filter((item) => item.path !== path))
    },
    [folders, setFolders, relocateFolder],
  )

  const forget = useCallback(
    (path: string) => {
      if (folders.includes(path)) setFolders(folders.filter((folder) => folder !== path))
      forgetFolder(path)
      setMissing((prev) => prev.filter((item) => item.path !== path))
    },
    [folders, setFolders, forgetFolder],
  )

  if (dismissed || missing.length === 0) return null

  return (
    <div className="mb-3 shrink-0 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <p className="text-xs/relaxed font-medium">{t("missingFolders.title")}</p>
          <p className="text-[11px] text-muted-foreground">{t("missingFolders.description")}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("missingFolders.dismiss")}
          onClick={() => setDismissed(true)}
        >
          <X />
        </Button>
      </div>

      <ul className="mt-2 flex flex-col gap-1">
        {missing.map((folder) => (
          <li
            key={folder.path}
            className="flex items-center gap-2 rounded-md bg-background/60 px-2 py-1"
          >
            <div className="min-w-0 flex-1">
              <Truncate text={folder.name}>
                <p className="truncate text-xs/relaxed font-medium">{folder.name}</p>
              </Truncate>
              <Truncate text={folder.path}>
                <p className="truncate text-[11px] text-muted-foreground" >
                  {folder.path}
                </p>
              </Truncate>
            </div>
            <Button variant="outline" size="xs" onClick={() => void relocate(folder.path)}>
              <FolderSearch />
              {t("missingFolders.relocate")}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => forget(folder.path)}>
              {t("missingFolders.remove")}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
