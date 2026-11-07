import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Copy, Eye, Pencil, PlusIcon, Trash2 } from "lucide-react"
import { BUILTIN_PROFILES, type AgentDefinition } from "@shared/agents"
import { userProfileId } from "@shared/agents"
import type { ProfileId } from "@shared/chat"
import { agentsApi } from "@/src/lib/ipc"
import { CardMenu } from "@/src/components/card-menu"
import { agentView, userAgentView, type AgentView } from "@/src/components/agent-meta"
import { useAgents } from "@/src/stores/agents-store"
import { cn } from "@/lib/utils"
import { AgentEditorDialog } from "./agent-editor-dialog"
import { ProfileDialog } from "./profile-dialog"

function AgentCard({ view, badge, description, onOpen, menu }: {
  view: AgentView
  badge?: string
  description: string
  onOpen: () => void
  menu: React.ReactNode
}) {
  const Icon = view.icon
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
        <Icon className={cn("size-4", view.color)} />
      </div>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{view.name}</span>
          {badge && <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{badge}</span>}
        </div>
        <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{description}</p>
      </button>
      {menu}
    </div>
  )
}

/**
 * The Specialists section of the Tools page: the agents that ship with Orbit (read-only, with
 * a view of what each injects) and the ones the person made.
 */
export function SpecialistsPanel({ query = "" }: { query?: string }) {
  const { t } = useTranslation()
  const agents = useAgents()
  const [editing, setEditing] = useState<AgentDefinition | null | undefined>(undefined)
  const [viewing, setViewing] = useState<ProfileId | null>(null)
  const needle = query.trim().toLowerCase()
  const matches = (...fields: string[]) => !needle || fields.some((f) => f.toLowerCase().includes(needle))

  const builtins = BUILTIN_PROFILES.map((id) => ({ id, view: agentView(id, agents, t)! })).filter(({ view }) =>
    matches(view.name, view.description),
  )
  const mine = agents.filter((a) => matches(a.name, a.prompt))

  return (
    <div className="flex flex-col gap-5">
      <section>
        <div className="mb-2">
          <p className="text-sm font-semibold">{t("specialists.builtin.title")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("specialists.builtin.description")}</p>
        </div>
        <div className="flex flex-col gap-2">
          {builtins.map(({ id, view }) => (
            <AgentCard
              key={id}
              view={view}
              badge={t("specialists.builtin.badge")}
              description={view.description}
              onOpen={() => setViewing(id)}
              menu={
                <CardMenu items={[{ id: "view", label: t("specialists.menu.view"), icon: Eye, onSelect: () => setViewing(id) }]} />
              }
            />
          ))}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">{t("specialists.mine.title")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("specialists.mine.description")}</p>
          </div>
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <PlusIcon className="size-3.5" />
            {t("specialists.mine.new")}
          </button>
        </div>
        {agents.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">{t("specialists.mine.empty")}</div>
        ) : mine.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
            {t("toolsPage.noResults", { query: query.trim() })}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {mine.map((agent) => (
              <AgentCard
                key={agent.id}
                view={userAgentView(agent, t)}
                description={agent.prompt.trim() || t("specialists.mine.noPrompt")}
                onOpen={() => setViewing(userProfileId(agent.id))}
                menu={
                  <CardMenu
                    items={[
                      { id: "view", label: t("specialists.menu.view"), icon: Eye, onSelect: () => setViewing(userProfileId(agent.id)) },
                      { id: "edit", label: t("common.edit"), icon: Pencil, onSelect: () => setEditing(agent) },
                      {
                        id: "duplicate",
                        label: t("specialists.menu.duplicate"),
                        icon: Copy,
                        onSelect: () => void agentsApi.duplicate(agent.id, t("specialists.menu.copySuffix")),
                      },
                      { id: "remove", label: t("common.remove"), icon: Trash2, destructive: true, onSelect: () => void agentsApi.remove(agent.id) },
                    ]}
                  />
                }
              />
            ))}
          </div>
        )}
      </section>

      {editing !== undefined && (
        // Remounted per agent so the form always starts from that agent's values.
        <AgentEditorDialog key={editing?.id ?? "new"} agent={editing} open onOpenChange={(open) => !open && setEditing(undefined)} />
      )}
      {viewing && <ProfileDialog profile={viewing} open onOpenChange={(open) => !open && setViewing(null)} />}
    </div>
  )
}
