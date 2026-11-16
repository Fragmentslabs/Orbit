import { useEffect, useMemo, useState } from 'react'
import { loadRecentFolders } from '~/lib/folder-recents'
import { collectKnownFolders, type KnownFolder } from '~/lib/known-folders'
import { useDraftFolders } from '~/stores/draft-folders-store'
import { useFolderPrefs } from '~/stores/folder-prefs-store'
import { usePipelineStore } from '~/stores/pipeline-store'
import { useSessionStore } from '~/stores/session-store'

/**
 * The project folders known to the phone: where its chats work, the folders of the pipeline
 * projects and the recent picks — minus the ones removed from the phone's list, with the
 * phone's own names. Re-derives when any of them changes.
 */
export function useKnownFolders(): KnownFolder[] {
  const sessions = useSessionStore((s) => s.sessions)
  const projects = usePipelineStore((s) => s.projects)
  const aliases = useFolderPrefs((s) => s.aliases)
  const hidden = useFolderPrefs((s) => s.hidden)
  const draftFolders = useDraftFolders((s) => s.folders)
  const [recents, setRecents] = useState<string[]>([])

  useEffect(() => {
    void useFolderPrefs.getState().hydrate()
    void useDraftFolders.getState().hydrate()
    void loadRecentFolders().then(setRecents)
  }, [])

  return useMemo(
    () =>
      collectKnownFolders({
        sessions,
        projectFolders: projects.flatMap((p) => p.folders),
        recents: [...draftFolders, ...recents],
        hidden,
        aliases,
      }),
    [sessions, projects, draftFolders, recents, hidden, aliases],
  )
}
