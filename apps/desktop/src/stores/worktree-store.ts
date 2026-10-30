import { create } from "zustand"
import type { CreateWorktreeResult, WorktreeList } from "@shared/worktrees"
import { worktreeApi } from "@/src/lib/ipc"

/**
 * Worktrees of each folder's repository (header selector) and the map
 * "folder inside a worktree → same folder in the main repository".
 *
 * The map exists because the rest of the app identifies the project by path: without
 * it, a chat opened in a worktree would land in a new sidebar folder, with the
 * worktree's name, instead of staying with the other chats of the project.
 */
interface WorktreeState {
  /** Per folder queried (the chat's main folder); null = not a git repository */
  byFolder: Record<string, WorktreeList | null>
  loading: Record<string, boolean>
  /** folder in a worktree → equivalent folder in the main one */
  mainByFolder: Record<string, string>
  load: (folder: string) => Promise<WorktreeList | null>
  create: (folder: string, name: string, base?: string) => Promise<CreateWorktreeResult>
  remove: (folder: string, path: string, deleteBranch?: boolean) => Promise<void>
  /** Resolves (and keeps) the main one of a folder that came from outside — e.g.: a switch made by the agent */
  resolveMain: (folder: string) => Promise<string>
}

const queries = new Map<string, Promise<WorktreeList | null>>()

export const useWorktreeStore = create<WorktreeState>((set, get) => ({
  byFolder: {},
  loading: {},
  mainByFolder: {},

  load: (folder) => {
    // The header chip and the compact menu mount together and ask for the same list:
    // a query in progress is shared (each one runs git status on
    // every worktree).
    const inFlight = queries.get(folder)
    if (inFlight) return inFlight
    const query = loadNow(folder).finally(() => queries.delete(folder))
    queries.set(folder, query)
    return query
  },

  create: async (folder, name, base) => {
    const created = await worktreeApi.create(folder, name, base)
    await get().load(folder)
    // The list above was queried by the old folder; the new one also needs
    // the map (it is to it that the chat is going).
    const main = await worktreeApi.main(created.folder)
    set((s) => ({ mainByFolder: { ...s.mainByFolder, [created.folder]: main } }))
    return created
  },

  remove: async (folder, path, deleteBranch) => {
    await worktreeApi.remove(folder, path, deleteBranch)
    await get().load(folder)
  },

  resolveMain: async (folder) => {
    const known = get().mainByFolder[folder]
    if (known) return known
    const main = await worktreeApi.main(folder)
    if (main !== folder) set((s) => ({ mainByFolder: { ...s.mainByFolder, [folder]: main } }))
    return main
  },
}))

/** Folder in the main repository, when already known (synchronous, for the sidebar). */
export function knownMain(folder: string): string {
  return useWorktreeStore.getState().mainByFolder[folder] ?? folder
}

/** The query itself: lists the worktrees and updates the worktree → main map. */
async function loadNow(folder: string): Promise<WorktreeList | null> {
  const set = useWorktreeStore.setState
  set((s) => ({ loading: { ...s.loading, [folder]: true } }))
  try {
    const list = await worktreeApi.list(folder)
    set((s) => {
      const mainByFolder = { ...s.mainByFolder }
      const main = list?.worktrees.find((w) => w.primary)
      if (list && main) {
        // When the chat's subfolder does not exist in a worktree, its folder is the
        // root — and the equivalent in the main one is also the root.
        for (const w of list.worktrees) {
          if (!w.primary) mainByFolder[w.folder] = w.folder === w.path ? main.path : main.folder
        }
      }
      return { byFolder: { ...s.byFolder, [folder]: list }, mainByFolder }
    })
    return list
  } finally {
    set((s) => ({ loading: { ...s.loading, [folder]: false } }))
  }
}

/**
 * Folders of the active chat after its main folder changed off-screen
 * (the agent switched worktree). The session on disk only has the extras from the last
 * send; the workspace has the current ones — a folder associated (or removed) after
 * that send only exists in it. That is why the extras come from the workspace: copying
 * the session would lose the newly associated folder and bring the removed one back.
 */
export function foldersAfterSwitch(main: string, workspaceFolders: string[]): string[] {
  return [main, ...new Set(workspaceFolders.slice(1).filter((p) => p !== main))]
}
