import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { BrainCircuit, Layers, Sparkles, Wrench, Zap } from "lucide-react"
import { cn } from "@/lib/utils"
import { normalizeText } from "@shared/memory"
import { SLASH_ACTION_COMMANDS } from "@/src/lib/slash-actions"
import { commandMatches, type SlashCommand } from "@/src/lib/slash-commands"
import { usePromptInputController } from "@/src/components/ai/prompt-input"

/**
 * Paleta "/" dos inputs: abre quando o texto começa com "/", filtra conforme
 * digita e navega por teclado. A captura de teclas usa onKeyDownCapture no
 * wrapper — roda ANTES do handler interno do PromptInputTextarea, então o
 * Enter-para-enviar continua intacto quando a paleta está fechada.
 *
 * A "/" é de COMANDOS E MODOS: o que se executa (pipelines como /init) e o
 * que se liga (Pesquisa, Plano, Loop, Visão…). As REFERÊNCIAS (skills, MCP,
 * arquivos) ficam na paleta "@".
 */

export type { SlashCommand } from "@/src/lib/slash-commands"

const GROUP_ICON: Record<SlashCommand["group"], typeof Sparkles> = {
  Modos: Wrench,
  Skills: Sparkles,
  MCP: Layers,
  Memória: BrainCircuit,
  Ações: Zap,
}

/** Ordem de exibição das seções: ações primeiro, modos por último (já têm chips na UI) */
const GROUP_ORDER: SlashCommand["group"][] = ["Ações", "Modos"]

/** Chave i18n de cada seção: o valor do grupo é identificador, não rótulo. */
const GROUP_KEY: Record<SlashCommand["group"], string> = {
  Ações: "actions",
  Skills: "skills",
  MCP: "mcp",
  Memória: "memory",
  Modos: "modes",
}

/** Comandos literais enviados como texto — a paleta não abre sobre eles.
 * Inclui as ações "/" (resolvidas no submit dos inputs): depois de selecionar
 * "/code-review " a paleta fecha e o usuário completa/envia. */
const LITERAL_COMMANDS = ["/create-skill", "/document", ...SLASH_ACTION_COMMANDS.map((c) => c + " ")]

export function SlashPalette({ commands, children, className }: {
  commands: SlashCommand[]
  children: ReactNode
  className?: string
}) {
  const { t } = useTranslation()
  const controller = usePromptInputController()
  const value = controller.textInput.value
  const open =
    value.startsWith("/") && !LITERAL_COMMANDS.some((literal) => value.startsWith(literal))
  const query = open ? normalizeText(value.slice(1)) : ""

  const filtered = useMemo(
    () =>
      open
        ? commands
            .filter((c) => commandMatches(c, query))
            .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
        : [],
    [commands, open, query],
  )
  const [highlight, setHighlight] = useState(0)

  useEffect(() => {
    setHighlight(0)
  }, [query, open])

  const select = (command: SlashCommand) => {
    if (command.disabled) return
    command.run({ setText: controller.textInput.setInput })
  }

  const handleKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open || filtered.length === 0) return
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      e.stopPropagation()
      setHighlight((h) => {
        const delta = e.key === "ArrowDown" ? 1 : -1
        return (h + delta + filtered.length) % filtered.length
      })
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault()
      e.stopPropagation()
      select(filtered[Math.min(highlight, filtered.length - 1)])
    } else if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      controller.textInput.clear()
    }
  }

  // Agrupa preservando a ordem de `filtered` (já ordenado por seção)
  const groups = useMemo(() => {
    const map = new Map<SlashCommand["group"], SlashCommand[]>()
    for (const command of filtered) {
      const bucket = map.get(command.group) ?? []
      bucket.push(command)
      map.set(command.group, bucket)
    }
    return [...map.entries()]
  }, [filtered])

  return (
    <div className={cn("relative", className)} onKeyDownCapture={handleKeyDownCapture}>
      {open && filtered.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-80 overflow-y-auto rounded-xl border-2 border-sidebar-border bg-popover p-1.5 text-popover-foreground shadow-lg">
          {groups.map(([group, items]) => {
            const Icon = GROUP_ICON[group]
            return (
              <div key={group}>
                <p className="flex items-center gap-1 px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Icon className="size-3" /> {t(`input.slash.groups.${GROUP_KEY[group]}`)}
                </p>
                {items.map((command) => {
                  const index = filtered.indexOf(command)
                  return (
                    <button
                      key={command.id}
                      type="button"
                      disabled={command.disabled}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                        index === highlight && "bg-accent text-accent-foreground",
                        command.disabled && "cursor-not-allowed opacity-50",
                      )}
                      onMouseEnter={() => setHighlight(index)}
                      onMouseDown={(e) => {
                        // mousedown para não roubar o foco do textarea
                        e.preventDefault()
                        select(command)
                      }}
                    >
                      <span className="shrink-0 font-medium">{command.label}</span>
                      {command.description && (
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                          {command.description}
                        </span>
                      )}
                      {command.active !== undefined && (
                        <span
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            command.active ? "bg-emerald-500" : "bg-muted-foreground/30",
                          )}
                        />
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
