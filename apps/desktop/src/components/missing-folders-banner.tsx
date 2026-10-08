import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { FolderSearch, TriangleAlert, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useWorkspace } from "@/lib/workspace-context"
import { fsApi, windowApi } from "@/src/lib/ipc"
import { collectFolderPaths, missingFolders, type MissingFolder } from "@/src/lib/relocate"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Pastas que sumiram do disco.
 *
 * O caminho é guardado como string, então renomear a pasta no Finder é
 * invisível para o Orbit até alguém tentar usá-la. Como o VS Code, a gente
 * confere na abertura e oferece a única saída que não perde trabalho:
 * relocalizar.
 *
 * A checagem compara os caminhos guardados com o disco AGORA — não vigia
 * renomes. É por isso que uma pasta renomeada antes disto existir aparece do
 * mesmo jeito, sem precisar de migração. O preço é não haver watcher: a lista é
 * conferida na abertura e quando ela muda.
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
  // A string é a identidade da lista: `sessions` troca de referência a cada
  // mensagem, e sem isso a checagem iria ao main a cada token escrito.
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
        // Sem resposta do main a checagem não aconteceu. O silêncio é melhor do
        // que um alerta que ninguém consegue confirmar.
      })
    return () => {
      cancelled = true
    }
  }, [pathsKey])

  const relocate = useCallback(
    async (path: string) => {
      const picked = await windowApi.selectFolder()
      if (!picked) return
      // As pastas do workspace vivem fora do store: quem religa as duas pontas
      // é aqui.
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
              <p className="truncate text-xs/relaxed font-medium">{folder.name}</p>
              <p className="truncate text-[11px] text-muted-foreground" title={folder.path}>
                {folder.path}
              </p>
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
