import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Settings2, Wrench } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace-context"
import { useSessionTools, useToolsServers } from "@/src/stores/session-tools"
import { useSkillsStore } from "@/src/stores/skills-store"

/**
 * Servidores MCP da conversa — controle FIXO do composer, ao lado do medidor
 * de contexto, com o mesmo desenho dos botões de modo.
 *
 * As ferramentas não têm liga/desliga: existem sempre que há servidor ligado
 * no app. O que este popover decide é QUAIS servidores entram nesta conversa;
 * ligar/desligar o servidor em si é na página MCP & Skills (rodapé do popover,
 * ou clique direito no botão).
 */
export function ToolsPopover({ sessionId, iconOnly }: { sessionId?: string; iconOnly?: boolean }) {
  const { t } = useTranslation()
  const { setView } = useWorkspace()
  const servers = useSkillsStore((s) => s.mcpServers)
  const selection = useToolsServers(sessionId)
  const setServers = useSessionTools((s) => s.setServers)
  const [open, setOpen] = useState(false)

  // Sem servidor configurado não há o que recortar: um controle fixo e
  // permanentemente inerte só ocuparia espaço no composer.
  if (servers.length === 0) return null

  // Servidores ligados no app (o "teto" da conversa). Os desligados aparecem
  // na página MCP & Skills, não aqui.
  const available = servers.filter((server) => server.config.enabled !== false)
  // `null` = todos — acompanha servidor novo sem precisar reescolher.
  const selected = selection ?? available.map((server) => server.config.name)

  const toggle = (name: string) => {
    const next = selected.includes(name)
      ? selected.filter((item) => item !== name)
      : [...selected, name]
    // Selecionar todos de novo volta para "todos": a seleção não engessa a
    // lista quando o usuário não fez um recorte de verdade.
    setServers(sessionId, next.length === available.length ? null : next)
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
            title={t("toolsPopover.title")}
            aria-label={t("toolsPopover.title")}
            onContextMenu={(event) => {
              event.preventDefault()
              manage()
            }}
            className={cn(
              "flex items-center rounded-md text-xs transition-colors",
              iconOnly ? "size-7 justify-center px-0" : "gap-1 px-1.5 py-1",
              // Sempre no desenho do modo INATIVO: não há liga/desliga para
              // sinalizar aqui — o que está ligado se vê no popover.
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
                    <p className="truncate text-xs">{server.config.name}</p>
                    {detail && (
                      <p className="truncate text-[10px] text-muted-foreground">{detail}</p>
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
