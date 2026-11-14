import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Settings2, Wrench } from "lucide-react"
import type { McpServerStatus } from "@shared/mcp"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace-context"
import { useSessionTools, useToolsServers } from "@/src/stores/session-tools"
import { useSkillsStore } from "@/src/stores/skills-store"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * MCP servers of the conversation — FIXED control of the composer, next to the context
 * meter, with the same drawing as the mode buttons.
 *
 * The tools have no on/off: they exist whenever there is a server on
 * in the app. What this popover decides is WHICH servers enter this conversation;
 * turning the server itself on/off is on the MCP & Skills page (popover footer,
 * or right click on the button).
 */
export function ToolsPopover({ sessionId, iconOnly }: { sessionId?: string; iconOnly?: boolean }) {
  const servers = useSkillsStore((s) => s.mcpServers)
  const selection = useToolsServers(sessionId)
  const setServers = useSessionTools((s) => s.setServers)
  return <ToolsPopoverView servers={servers} selection={selection} onChange={(next) => setServers(sessionId, next)} iconOnly={iconOnly} />
}

/**
 * The menu itself, fed by whoever owns the chat: this machine's stores for a local chat, the
 * other desktop's mirrors for a remote one (RemoteComposer). `selection` null = every server on.
 */
export function ToolsPopoverView({ servers, selection, onChange, iconOnly }: {
  servers: McpServerStatus[]
  selection: string[] | null
  onChange: (servers: string[] | null) => void
  iconOnly?: boolean
}) {
  const { t } = useTranslation()
  const { setView } = useWorkspace()
  const [open, setOpen] = useState(false)

  // With no server configured there is nothing to narrow: a fixed and
  // permanently inert control would only take space in the composer.
  if (servers.length === 0) return null

  // Servers on in the app (the "ceiling" of the conversation). The off ones appear
  // on the MCP & Skills page, not here.
  const available = servers.filter((server) => server.config.enabled !== false)
  // `null` = all — it follows a new server without needing to re-choose.
  const selected = selection ?? available.map((server) => server.config.name)

  const toggle = (name: string) => {
    const next = selected.includes(name)
      ? selected.filter((item) => item !== name)
      : [...selected, name]
    // Selecting all again goes back to "all": the selection does not freeze the
    // list when the user did not make a real narrowing.
    onChange(next.length === available.length ? null : next)
  }

  const manage = () => {
    setOpen(false)
    setView("tools")
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t("toolsPopover.title")}
            onContextMenu={(event) => {
              event.preventDefault()
              manage()
            }}
            className={cn(
              "flex items-center rounded-md text-xs transition-colors",
              iconOnly ? "size-7 justify-center px-0" : "gap-1 px-1.5 py-1",
              // Always in the INACTIVE mode drawing: there is no on/off to
              // signal here — what is on is seen in the popover.
              "text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50",
            )}
          >
            <Wrench className="size-3.5" />
            {!iconOnly && (
              <span className="hidden @xl:inline shrink-0 whitespace-nowrap">
                {t("toolsPopover.label")}
              </span>
            )}
          </button>
        }
      />

      <PopoverContent side="top" align="end" sideOffset={6} className="w-64 p-0">
        <div className="flex items-baseline justify-between gap-2 px-3 pt-2.5 pb-1">
          <p className="text-xs font-medium">{t("toolsPopover.title")}</p>
          <p className="text-[10px] text-muted-foreground/70">{t("toolsPopover.scope")}</p>
        </div>

        <div className="max-h-64 overflow-y-auto px-1 pb-1">
          {available.length === 0 ? (
            <p className="px-2 py-2 text-[11px] text-muted-foreground">{t("toolsPopover.empty")}</p>
          ) : (
            available.map((server) => {
              const on = selected.includes(server.config.name)
              const detail =
                server.state === "connected" ? null : t(`mcp.servers.status.${server.state}`)
              return (
                <div
                  key={server.config.name}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50"
                >
                  <div className="min-w-0 flex-1">
                    <Truncate text={server.config.name}>
                      <p className="truncate text-xs">{server.config.name}</p>
                    </Truncate>
                    {detail && (
                      <Truncate text={detail}>
                        <p className="truncate text-[10px] text-muted-foreground">{detail}</p>
                      </Truncate>
                    )}
                  </div>
                  <Switch
                    checked={on}
                    onCheckedChange={() => toggle(server.config.name)}
                    aria-label={server.config.name}
                  />
                </div>
              )
            })
          )}
        </div>

        <div className="border-t border-border p-1">
          <button
            type="button"
            onClick={manage}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <Settings2 className="size-3.5" />
            {t("toolsPopover.manage")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
