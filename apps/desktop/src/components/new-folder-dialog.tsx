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
  /** Só o modo código tem repositório — no chat o diálogo é só o nome. */
  mode: WorkspaceMode
  onCreate: (name: string, workspace?: string[]) => void
}

/**
 * Diálogo de nova pasta. Em modo código aceita o projeto de destino, e a pasta
 * já nasce com o workspace guardado: o "+" dela abre no repositório escolhido
 * em vez de herdar o workspace da tela até o primeiro chat entrar
 * (aprenderWorkspaceDaPasta, session-store).
 *
 * As opções são as pastas recentes do seletor do composer — não há caminho
 * digitado à mão, que erraria sem ninguém validar.
 */
export function NewFolderDialog({ open, onOpenChange, mode, onCreate }: NewFolderDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState("")
  const [project, setProject] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const [recentFolders, setRecentFolders] = useState<string[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const isCode = mode === "code"

  // Recomeça a cada abertura: o diálogo é reaproveitado, e o projeto da pasta
  // anterior não pode vazar para a próxima.
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

  // A lista de recentes pode estar vazia — ou não ter o projeto que a pessoa
  // quer. O diálogo nativo é a saída, em vez de mandar abrir um chat antes.
  // Não grava em `orbit-recent-folders`: isso é feito por quem de fato usa a
  // pasta (code-input), e aqui a escolha pode ser abandonada no Cancelar.
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
