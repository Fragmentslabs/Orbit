import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, Folder, Plus, X } from "lucide-react"
import { useWorktreeStore } from "@/src/stores/worktree-store"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

const RECENT_FOLDERS_KEY = "orbit-recent-folders"

/** Recent folders of the selector (`orbit-recent-folders`), written by the
 *  code-input. They serve as candidates for the project of a new folder. */
export function loadRecentFolders(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_FOLDERS_KEY)
    if (stored) return JSON.parse(stored)
  } catch {
    return []
  }
  return []
}

export async function pickFolder(): Promise<string | null> {
  try {
    const result = await window.ipcRenderer.invoke("select-folder")
    return result as string | null
  } catch {
    return null
  }
}

/**
 * Name of the main folder of the chat. In a worktree, it is the name of the project (the
 * main repository): the worktree itself already appears in the selector next to it, and the
 * name of its folder does not say which project it is about.
 */
export function useMainFolderName(folder: string | undefined): string {
  const main = useWorktreeStore((s) => (folder ? s.mainByFolder[folder] : undefined))
  return folder ? getFolderName(main ?? folder) : ""
}

export function getFolderName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/")
  return parts[parts.length - 1] || path
}

interface FolderSelectorProps {
  folders: string[]
  onFoldersChange: (folders: string[]) => void
  /** Smaller trigger style (used in the header). It does not change the behavior —
   * see hideTrigger for where the full dropdown is used. */
  compact?: boolean
  /** Controls the opening of the dropdown externally (used together with hideTrigger) */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Omits the trigger button — used when another component opens this dropdown */
  hideTrigger?: boolean
  /** Folder not chosen yet (sending blocked in code mode): the line
   *  that opens around the trigger draws the eye to what solves it. */
  pulse?: boolean
}

export function FolderSelector({ folders, onFoldersChange, compact, open: openProp, onOpenChange, hideTrigger, pulse }: FolderSelectorProps) {
  const { t } = useTranslation()
  const mainName = useMainFolderName(folders[0])
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const recentOpen = openProp ?? uncontrolledOpen
  const setRecentOpen = onOpenChange ?? setUncontrolledOpen
  const recentRef = useRef<HTMLDivElement>(null)
  const [recentFolders] = useState<string[]>(loadRecentFolders)

  // The full dropdown (sections, switch/add/remove) only exists in
  // hideTrigger mode — used by CompactWorkspaceSelector in the header on
  // small screens. Outside it (header on large screens, or the selector above the
  // input) the trigger never opens a dropdown, so it does not need to close on
  // outside click.
  useEffect(() => {
    if (!hideTrigger) return
    function handleClickOutside(e: MouseEvent) {
      if (recentRef.current && !recentRef.current.contains(e.target as Node)) {
        setRecentOpen(false)
      }
    }
    if (recentOpen) {
      document.addEventListener("mousedown", handleClickOutside)
      return () => document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [hideTrigger, recentOpen, setRecentOpen])

  const setPrimaryFolder = useCallback(async (path?: string) => {
    const folderPath = path ?? (await pickFolder())
    if (!folderPath) return
    setRecentOpen(false)
    if (folders[0] === folderPath) return
    onFoldersChange(
      folders.includes(folderPath)
        // Already attached (chosen in the list): it becomes the main one and the old one goes down
        // to the extras.
        ? [folderPath, ...folders.filter((f) => f !== folderPath)]
        // New folder through the selector: it swaps the main repository, preserving
        // the extras already attached.
        : [folderPath, ...folders.slice(1)],
    )
  }, [folders, onFoldersChange, setRecentOpen])

  const addAdditionalFolder = useCallback(async () => {
    const picked = await pickFolder()
    if (!picked || folders.includes(picked)) return
    onFoldersChange([...folders, picked])
  }, [folders, onFoldersChange])

  const removeFolder = useCallback((path: string, e: React.MouseEvent) => {
    e.stopPropagation()
    onFoldersChange(folders.filter(f => f !== path))
  }, [folders, onFoldersChange])

  const sectionLabel = (label: string) => (
    <p className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
  )

  const folderRow = (
    folder: string,
    { active, removable, onSelect }: { active?: boolean; removable?: boolean; onSelect?: () => void },
  ) => (
    <button
      key={folder}
      onClick={onSelect ?? (() => setPrimaryFolder(folder))}
      className="group flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-foreground/10"
    >
      <Folder className="size-3.5 shrink-0 text-sidebar-foreground/60" />
      
        <Truncate>
            <span className="truncate">{getFolderName(folder)}</span>
        </Truncate>
      {active && <Check className="ml-auto size-3.5 shrink-0 text-primary" />}
      {removable && (
        <span
          role="button"
          onClick={(e) => removeFolder(folder, e)}
          className="ml-auto flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-foreground/10 group-hover:opacity-60 hover:opacity-100"
        >
          <X className="size-2.5" />
        </span>
      )}
    </button>
  )

  const primaryFolder = folders[0]
  const otherFolders = folders.slice(1)
  const recentUnassociated = recentFolders.filter((f) => !folders.includes(f))

  const folderItems = (
    <>
      {primaryFolder && (
        <div className="pt-1">
          {sectionLabel(t("folderSelector.primary"))}
          {/* Clicking the main folder opens the native selector to swap it —
              selecting the one that is already the main one would do nothing. */}
          {folderRow(primaryFolder, { active: true, onSelect: () => void setPrimaryFolder() })}
        </div>
      )}
      <div className={primaryFolder ? "mt-1 border-t border-border pt-1" : "pt-1"}>
        {sectionLabel(t("folderSelector.others"))}
        {otherFolders.map((folder) => folderRow(folder, { removable: true }))}
        <button
          onClick={() => addAdditionalFolder()}
          className="flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-xs font-medium hover:bg-foreground/10"
        >
          <Plus className="size-3.5" />
          {t("folderSelector.newFolder")}
        </button>
      </div>
      {recentUnassociated.length > 0 && (
        <div className="mt-1 border-t border-border pt-1">
          {sectionLabel(t("folderSelector.recent"))}
          {recentUnassociated.map((folder) => folderRow(folder, {}))}
        </div>
      )}
    </>
  )

  const triggerClassName = compact
    ? "group flex h-7 min-w-0 max-w-28 cursor-pointer select-none items-center gap-1 rounded-md border border-border/50 px-1.5 text-xs transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 sm:max-w-40"
    : "group flex h-8 min-w-0 max-w-40 cursor-pointer select-none items-center gap-1.5 rounded-md border border-border px-1.5 text-sm font-medium transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {hideTrigger ? (
        <div className="relative min-w-0" ref={recentRef}>
          {recentOpen && (
            <div className="absolute left-0 top-full z-[60] mt-1 w-56 rounded-lg border bg-popover/70 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150">
              {folderItems}
            </div>
          )}
        </div>
      ) : (
        // With no dropdown outside the header on small screens (hideTrigger, above):
        // the click swaps the main folder straight through the native selector, as
        // it was before the dropdown existed.
        <span className="relative inline-flex min-w-0 max-w-full">
          {/* Without a folder code mode has nowhere to work: the same pulse of the
              connect provider button marks the only control that solves it. */}
          {pulse && (
            <span
              aria-hidden
              className="folder-pulse-ring pointer-events-none absolute inset-0 rounded-md"
            />
          )}
          <button type="button" onClick={() => setPrimaryFolder()} className={triggerClassName}>
            <Folder className="size-3 shrink-0 text-sidebar-foreground/60" />
            
              <Truncate>
                  <span className="truncate">{folders.length === 0 ? t("folderSelector.associate") : mainName}</span>
              </Truncate>
          </button>
        </span>
      )}
      {/* Extra folders + "+" next to the trigger. In the header (compact) what
          hides this row on small screens is the container query of the
          header itself — there it is replaced by CompactWorkspaceSelector,
          which brings all of that inside the dropdown. Only hideTrigger (the dropdown
          itself) never shows the row. */}
      {!hideTrigger && (
        <div className={compact ? "flex min-w-0 items-center gap-1.5" : "hidden min-w-0 items-center gap-1.5 sm:flex"}>
          {folders.slice(1).map((folder) => (
            <div
              key={folder}
              className={compact
                ? "group relative flex h-7 max-w-28 cursor-default select-none items-center gap-1 rounded-md border border-border/50 px-1.5 text-xs transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 sm:max-w-40"
                : "group relative flex h-8 max-w-40 cursor-default select-none items-center gap-1.5 rounded-md border border-border px-1.5 text-sm font-medium transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
              }
            >
              <Folder className="size-2.5 shrink-0 text-sidebar-foreground/60" />
              <Truncate text={getFolderName(folder)}>
                <span className="truncate">{getFolderName(folder)}</span>
              </Truncate>
              <button onClick={(e) => removeFolder(folder, e)} className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded opacity-60 hover:bg-foreground/10 hover:opacity-100">
                <X className="size-2" />
                <span className="sr-only">{t("folderSelector.remove")}</span>
              </button>
            </div>
          ))}
          {folders.length > 0 && (
            <Hint label={t("common.addFolder")}>
              <button
                onClick={() => addAdditionalFolder()}
                className={compact
                  ? "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/50 text-xs hover:bg-accent"
                  : "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border text-sm hover:bg-accent"
                }
              >
                <Plus className="size-2.5" />
              </button>
            </Hint>
          )}
        </div>
      )}
    </div>
  )
}
