import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, Folder, FolderSearch } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { WorkspaceMode } from "@/lib/workspace-context"
import { getFolderName, loadRecentFolders, pickFolder } from "@/src/components/folder-selector"
import { Truncate } from "@/components/ui/truncated-text"

interface NewFolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Only code mode has a repository — in chat the dialog is only the name. */
  mode: WorkspaceMode
  onCreate: (name: string, workspace?: string[]) => void
}

/**
 * New folder dialog. In code mode it accepts the destination project, and the folder
 * is born with the workspace already stored: its "+" opens in the chosen repository
 * instead of inheriting the screen workspace until the first chat enters
 * (learnFolderWorkspace, session-store).
 *
 * The options are the recent folders of the composer selector — there is no hand-typed
 * path, which would go wrong with nobody validating it.
 */
export function NewFolderDialog({ open, onOpenChange, mode, onCreate }: NewFolderDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState("")
  const [project, setProject] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const [recentFolders, setRecentFolders] = useState<string[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const isCode = mode === "code"

  // It restarts on every opening: the dialog is reused, and the previous folder's project
  // cannot leak into the next one.
  useEffect(() => {
    if (!open) return
    setName("")
    setProject(null)
    setListOpen(false)
    setRecentFolders(isCode ? loadRecentFolders() : [])
  }, [open, isCode])

  useEffect(() => {
    if (!listOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (!listRef.current?.contains(e.target as Node)) setListOpen(false)
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [listOpen])

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onCreate(trimmed, project ? [project] : undefined)
    onOpenChange(false)
  }

  // The recents list may be empty — or not have the project the person
  // wants. The native dialog is the way out, instead of sending them to open a chat first.
  // It does not write to `orbit-recent-folders`: that is done by whoever actually uses the
  // folder (code-input), and here the choice may be abandoned on Cancel.
  const chooseFolder = async () => {
    setListOpen(false)
    const picked = await pickFolder()
    if (!picked) return
    setProject(picked)
    setRecentFolders((prev) => (prev.includes(picked) ? prev : [picked, ...prev]))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("sidebar.folder.newFolderTitle")}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          placeholder={t("sidebar.folder.folderNamePlaceholder")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit()
          }}
        />
        {isCode && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t("sidebar.folder.project")}</span>
            <div className="relative" ref={listRef}>
              <button
                type="button"
                aria-expanded={listOpen}
                onClick={() => setListOpen((v) => !v)}
                className="group flex h-8 w-full cursor-pointer select-none items-center gap-1.5 rounded-md border border-border px-1.5 text-sm font-medium transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
              >
                <Folder className="size-3 shrink-0 text-muted-foreground" />
                
                  <Truncate>
                      <span className={cn("truncate", !project && "font-normal text-muted-foreground")}>
                      {project ? getFolderName(project) : t("sidebar.folder.noProject")}
                    </span>
                  </Truncate>
              </button>
              {listOpen && (
                <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
                  <button
                    type="button"
                    onClick={() => {
                      setProject(null)
                      setListOpen(false)
                    }}
                    className="flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-foreground/10"
                  >
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    
                      <Truncate>
                          <span className="truncate">{t("sidebar.folder.noProject")}</span>
                      </Truncate>
                    {!project && <Check className="ml-auto size-3.5 shrink-0 text-primary" />}
                  </button>
                  {recentFolders.map((folder) => (
                    <button
                      key={folder}
                      type="button"
                      onClick={() => {
                        setProject(folder)
                        setListOpen(false)
                      }}
                      className="flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-foreground/10"
                    >
                      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                      
                        <Truncate>
                            <span className="truncate">{getFolderName(folder)}</span>
                        </Truncate>
                      {project === folder && <Check className="ml-auto size-3.5 shrink-0 text-primary" />}
                    </button>
                  ))}
                  {recentFolders.length === 0 && (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                      {t("sidebar.folder.noRecentProjects")}
                    </p>
                  )}
                  <div className="my-1 border-t" />
                  <button
                    type="button"
                    onClick={() => void chooseFolder()}
                    className="flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-foreground/10"
                  >
                    <FolderSearch className="size-3.5 shrink-0 text-muted-foreground" />
                    
                      <Truncate>
                          <span className="truncate">{t("sidebar.folder.pickProject")}</span>
                      </Truncate>
                  </button>
                </div>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {project
                ? t("sidebar.folder.projectEffect", { project: getFolderName(project) })
                : t("sidebar.folder.projectNoneEffect")}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button onClick={submit} disabled={!name.trim()}>{t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
