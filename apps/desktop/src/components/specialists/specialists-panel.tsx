import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Copy, Eye, Pencil, PenLine, Share, Trash2, Upload, Wand2 } from "lucide-react"
import { BUILTIN_PROFILES, type AgentDefinition, type AgentInput } from "@shared/agents"
import { userProfileId } from "@shared/agents"
import type { ProfileId } from "@shared/chat"
import { agentsApi } from "@/src/lib/ipc"
import { useStartCreationChat } from "@/src/hooks/use-creation-chat"
import { CreateMenu } from "@/src/components/create-menu"
import { CardMenu } from "@/src/components/card-menu"
import { agentView, userAgentView, type AgentView } from "@/src/components/agent-meta"
import { useAgents, useAgentsStore } from "@/src/stores/agents-store"
import { cn } from "@/lib/utils"
import { AgentEditorDialog } from "./agent-editor-dialog"
import { ProfileDialog } from "./profile-dialog"
import { TemplatesMenu } from "./templates-menu"
import { AgentImportDialog, AgentImportProblemNote, useAgentImport } from "./agent-import-dialog"
import { Button } from "@/components/ui/button"
import { BuiltinEditorDialog } from "./builtin-editor-dialog"

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
  const builtinDescriptions = useAgentsStore((s) => s.builtins)
  const startCreation = useStartCreationChat()
  const importer = useAgentImport()
  const [draft, setDraft] = useState<AgentInput | undefined>()
  const [editingBuiltin, setEditingBuiltin] = useState<ProfileId | null>(null)
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
              badge={builtinDescriptions.find((b) => b.id === id)?.edited ? t("specialists.builtin.edited") : t("specialists.builtin.badge")}
              description={builtinDescriptions.find((b) => b.id === id)?.whenToUse || view.description}
              onOpen={() => setViewing(id)}
              menu={
                <CardMenu
                  items={[
                    { id: "view", label: t("specialists.menu.view"), icon: Eye, onSelect: () => setViewing(id) },
                    { id: "edit", label: t("common.edit"), icon: Pencil, onSelect: () => setEditingBuiltin(id) },
                  ]}
                />
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
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={importer.pickFile} disabled={importer.busy}>
              <Upload className="size-3.5" />
              {t("specialists.share.importButton")}
            </Button>
            <TemplatesMenu />
          <CreateMenu
            label={t("specialists.mine.new")}
            options={[
              {
                id: "ask",
                icon: Wand2,
                title: t("askOrbit.menu.agents.title"),
                description: t("askOrbit.menu.agents.description"),
                onSelect: () => void startCreation("agent"),
              },
              {
                id: "manual",
                icon: PenLine,
                title: t("askOrbit.menu.manual"),
                description: t("askOrbit.menu.agents.manualDescription"),
                onSelect: () => { setDraft(undefined); setEditing(null) },
              },
            ]}
          />
          </div>
        </div>
        <AgentImportProblemNote problem={importer.problem} onDismiss={importer.dismissProblem} />
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
                badge={agent.origin === "imported" ? t("specialists.share.badge") : undefined}
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
                      { id: "export", label: t("specialists.share.export"), icon: Share, onSelect: () => void agentsApi.exportFile(agent.id) },
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
        <AgentEditorDialog key={editing?.id ?? "new"} agent={editing} draft={draft} open onOpenChange={(open) => { if (!open) { setEditing(undefined); setDraft(undefined) } }} />
      )}
      {editingBuiltin && builtinDescriptions.find((b) => b.id === editingBuiltin) && (
        <BuiltinEditorDialog
          key={editingBuiltin}
          description={builtinDescriptions.find((b) => b.id === editingBuiltin)!}
          name={agentView(editingBuiltin, agents, t)?.name ?? editingBuiltin}
          open
          onOpenChange={(open) => !open && setEditingBuiltin(null)}
        />
      )}
      <AgentImportDialog preview={importer.preview} busy={importer.busy} onConfirm={importer.confirm} onCancel={importer.cancel} />
      {viewing && <ProfileDialog profile={viewing} open onOpenChange={(open) => !open && setViewing(null)} />}
    </div>
  )
}
