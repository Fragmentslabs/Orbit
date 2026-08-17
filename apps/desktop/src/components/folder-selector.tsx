import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, ChevronDown, Folder, Plus, X } from "lucide-react"

const RECENT_FOLDERS_KEY = "orbit-recent-folders"

function loadRecentFolders(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_FOLDERS_KEY)
    if (stored) return JSON.parse(stored)
  } catch {
    return []
  }
  return []
}

async function pickFolder(): Promise<string | null> {
  try {
    const result = await window.ipcRenderer.invoke("select-folder")
    return result as string | null
  } catch {
    return null
  }
}

export function getFolderName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/")
  return parts[parts.length - 1] || path
}

interface FolderSelectorProps {
  folders: string[]
  onFoldersChange: (folders: string[]) => void
  /** Header em telas grandes: só um botão que troca a pasta principal direto
   * pelo seletor nativo, sem dropdown (o dropdown completo fica reservado pro
   * CompactWorkspaceSelector, em telas pequenas). Fora disso (ex.: seletor
   * acima do input em NewChatTab) mantém o dropdown de sempre. */
  compact?: boolean
  /** Controla a abertura do dropdown externamente (uso combinado com hideTrigger) */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Omite o botão gatilho — usado quando outro componente abre este dropdown */
  hideTrigger?: boolean
}

export function FolderSelector({ folders, onFoldersChange, compact, open: openProp, onOpenChange, hideTrigger }: FolderSelectorProps) {
  const { t } = useTranslation()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const recentOpen = openProp ?? uncontrolledOpen
  const setRecentOpen = onOpenChange ?? setUncontrolledOpen
  const recentRef = useRef<HTMLDivElement>(null)
  const [recentFolders] = useState<string[]>(loadRecentFolders)

  // compact (sem hideTrigger) não abre dropdown nenhum — só hideTrigger e o
  // seletor não-compacto (acima do input) precisam fechar por clique fora.
  const manualClose = hideTrigger || !compact
  useEffect(() => {
    if (!manualClose) return
    function handleClickOutside(e: MouseEvent) {
      if (recentRef.current && !recentRef.current.contains(e.target as Node)) {
        setRecentOpen(false)
      }
    }
    if (recentOpen) {
      document.addEventListener("mousedown", handleClickOutside)
      return () => document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [manualClose, recentOpen, setRecentOpen])

  const setPrimaryFolder = useCallback(async (path?: string) => {
    let folderPath: string | undefined = path
    if (!folderPath) {
      const picked = await pickFolder()
      if (!picked) return
      folderPath = picked
    }
    setRecentOpen(false)
    if (folders[0] === folderPath) return
    onFoldersChange([folderPath, ...folders.filter((f) => f !== folderPath)])
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

  const folderRow = (folder: string, { active, removable }: { active?: boolean; removable?: boolean }) => (
    <button
      key={folder}
      onClick={() => setPrimaryFolder(folder)}
      className="group flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-foreground/10"
    >
      <Folder className="size-3.5 shrink-0 text-sidebar-foreground/60" />
      <span className="truncate">{getFolderName(folder)}</span>
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
          {folderRow(primaryFolder, { active: true })}
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

  const triggerContent = (
    <>
      <Folder className="size-3 shrink-0 text-sidebar-foreground/60" />
      <span className="truncate">{folders.length === 0 ? t("folderSelector.associate") : getFolderName(folders[0])}</span>
      <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
    </>
  )

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
      ) : compact ? (
        // Em telas grandes o header mostra branch + pasta lado a lado — aqui
        // não há espaço/necessidade de um dropdown: o clique troca a pasta
        // principal direto pelo seletor nativo, como era antes de existir o
        // dropdown. O menu completo (trocar/adicionar/remover) só aparece em
        // telas pequenas, dentro do CompactWorkspaceSelector.
        <button type="button" onClick={() => setPrimaryFolder()} className={triggerClassName}>
          <Folder className="size-3 shrink-0 text-sidebar-foreground/60" />
          <span className="truncate">{folders.length === 0 ? t("folderSelector.associate") : getFolderName(folders[0])}</span>
        </button>
      ) : (
        <div className="relative min-w-0" ref={recentRef}>
          <button onClick={() => setRecentOpen(!recentOpen)} className={triggerClassName}>
            {triggerContent}
          </button>
          {recentOpen && (
            <div className="absolute left-0 top-full z-[60] mt-1 w-56 rounded-lg border bg-popover/70 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150">
              {folderItems}
            </div>
          )}
        </div>
      )}
      {/* No modo compact a gestão de pastas extras (adicionar/remover) já vive
          inteira dentro do dropdown acima — essa fileira full-size só faz
          sentido no seletor não-compacto (ex.: NewChatTab), senão duplica o
          "+ Nova pasta" e os itens que o menu já lista. */}
      {!compact && (
        <div className="hidden min-w-0 items-center gap-1.5 sm:flex">
          {folders.slice(1).map((folder) => (
            <div key={folder} className="group relative flex h-8 max-w-40 cursor-default select-none items-center gap-1.5 rounded-md border border-border px-1.5 text-sm font-medium transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50">
              <Folder className="size-2.5 shrink-0 text-sidebar-foreground/60" />
              <span className="truncate">{getFolderName(folder)}</span>
              <button onClick={(e) => removeFolder(folder, e)} className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded opacity-60 hover:bg-foreground/10 hover:opacity-100">
                <X className="size-2" />
                <span className="sr-only">{t("folderSelector.remove")}</span>
              </button>
            </div>
          ))}
          {folders.length > 0 && (
            <button onClick={() => addAdditionalFolder()} className="flex h-8 size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border text-sm hover:bg-accent">
              <Plus className="size-2.5" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
