import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { FileIcon, Layers, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { normalizeText } from "@shared/memory"
import { usePromptInputController, usePromptInputAttachments } from "@/src/components/ai/prompt-input"
import { useReferenceCommands, commandMatches, type SlashCommand } from "@/src/lib/slash-commands"

/**
 * Paleta "@" — REFERÊNCIAS: tudo que entra no contexto do pedido.
 *
 * A "/" é de comandos e modos (o que se executa); a "@" é de referências (o que
 * se anexa): skills, servidores MCP e arquivos da pasta do projeto. Antes as
 * skills e o MCP apareciam na "/" com "@" na frente e a "@" abria só os
 * arquivos — o mesmo prefixo apontando para listas diferentes.
 *
 * A paleta fecha assim que há espaço depois do "@": o texto já é uma
 * referência completa ("@web_recon ").
 */

const MAX_FILES = 2000

type Item =
  | { kind: "command"; command: SlashCommand }
  | { kind: "file"; path: string; name: string }

function fileMatches(filePath: string, query: string): boolean {
  if (!query) return true
  const haystack = normalizeText(filePath.replace(/[/\\]/g, "/"))
  return query.split(" ").every((token) => haystack.includes(token))
}

export function ReferencePalette({ directory, children, className }: {
  directory?: string
  children: ReactNode
  className?: string
}) {
  const { t } = useTranslation()
  const controller = usePromptInputController()
  const attachments = usePromptInputAttachments()
  const value = controller.textInput.value
  const commands = useReferenceCommands()

  const open = value.startsWith("@") && !value.slice(1).includes(" ")
  const query = open ? normalizeText(value.slice(1)) : ""

  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const loadedDir = useRef<string | undefined>()
  const baseDir = useMemo(() => directory?.replace(/\\/g, "/") ?? "", [directory])

  useEffect(() => {
    if (!open || !directory) return
    if (loadedDir.current === directory) return
    loadedDir.current = directory
    setLoading(true)
    window.ipcRenderer
      .invoke("fs:listFilesRecursive", directory)
      .then((result: unknown) => {
        const r = result as { ok: true; files: string[] } | { ok: false; error: string }
        if (r.ok) {
          setFiles(r.files.slice(0, MAX_FILES))
        }
      })
      .finally(() => setLoading(false))
  }, [open, directory])

  const items = useMemo<Item[]>(() => {
    const list: Item[] = []
    for (const command of commands) {
      if (!commandMatches(command, query)) continue
      list.push({ kind: "command", command })
    }
    for (const path of files) {
      if (!fileMatches(path, query)) continue
      list.push({ kind: "file", path, name: path.split("/").pop() ?? path })
    }
    return list
  }, [commands, files, query])

  // Seções: skills, MCP e arquivos — a ordem das referências é a mesma em
  // que elas aparecem no texto (@skill, @mcp:nome, arquivo anexado).
  const sections = useMemo(() => {
    const skills = items.filter((i) => i.kind === "command" && i.command.group === "Skills")
    const mcp = items.filter((i) => i.kind === "command" && i.command.group === "MCP")
    const docs = items.filter((i) => i.kind === "file")
    return [
      { id: "skills", label: t("referencePalette.skills"), icon: Sparkles, items: skills },
      { id: "mcp", label: t("referencePalette.mcp"), icon: Layers, items: mcp },
      { id: "files", label: t("referencePalette.files"), icon: FileIcon, items: docs },
    ].filter((s) => s.items.length > 0)
  }, [items, t])

  const [highlight, setHighlight] = useState(0)

  useEffect(() => {
    setHighlight(0)
  }, [query, open])

  const select = async (item: Item) => {
    if (item.kind === "command") {
      item.command.run({ setText: controller.textInput.setInput })
      return
    }
    if (!directory) return
    const fullPath = `${baseDir}/${item.path}`
    const result = await window.ipcRenderer
      .invoke("fs:readFileAsDataUrl", fullPath)
      .then((r: unknown) => r as { dataUrl: string } | { error: string })
    if ("error" in result) return
    const response = await fetch(result.dataUrl)
    const blob = await response.blob()
    const filename = item.path.split("/").pop() ?? item.path
    const file = new File([blob], filename, { type: blob.type })
    attachments.add([file])
    controller.textInput.clear()
  }

  const handleKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open || items.length === 0) return
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      e.stopPropagation()
      setHighlight((h) => {
        const delta = e.key === "ArrowDown" ? 1 : -1
        return (h + delta + items.length) % items.length
      })
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault()
      e.stopPropagation()
      void select(items[Math.min(highlight, items.length - 1)])
    } else if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      controller.textInput.clear()
    }
  }

  return (
    <div className={cn("relative", className)} onKeyDownCapture={handleKeyDownCapture}>
      {open && (items.length > 0 || loading) && (
        <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-80 overflow-y-auto rounded-xl border-2 border-sidebar-border bg-popover p-1.5 text-popover-foreground shadow-lg">
          {loading && (
            <p className="px-2 py-2 text-xs text-muted-foreground">{t("referencePalette.loading")}</p>
          )}
          {sections.map((section) => {
            const Icon = section.icon
            return (
              <div key={section.id}>
                <p className="flex items-center gap-1 px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Icon className="size-3" /> {section.label}
                </p>
                {section.items.map((item) => {
                  const index = items.indexOf(item)
                  const label = item.kind === "command" ? item.command.label : item.name
                  const description =
                    item.kind === "command" ? item.command.description : item.kind === "file" ? item.path : undefined
                  return (
                    <button
                      key={item.kind === "command" ? item.command.id : `file:${item.path}`}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                        index === highlight && "bg-accent text-accent-foreground",
                      )}
                      onMouseEnter={() => setHighlight(index)}
                      onMouseDown={(e) => {
                        // mousedown para não roubar o foco do textarea
                        e.preventDefault()
                        void select(item)
                      }}
                    >
                      {item.kind === "file" ? (
                        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                      ) : null}
                      <span className="shrink-0 font-medium">{label}</span>
                      {description && (
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                          {description}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
      {children}
    </div>
  )
}
