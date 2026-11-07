import { Check, ChevronDown, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Hint } from "@/components/ui/hint"
import { AGENT_META } from "@/src/components/agent-meta"
import { cn } from "@/lib/utils"
import type { ArtifactKind } from "@shared/artifacts"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Header controls of an artifact's conversation card — the same for fragments, motion and
 * design: pick among the chats that worked on the artifact, or start a new (embedded) one.
 * Every chat in the list wears the icon of the artifact's kind, whether it was made inside
 * the artifact or is a subchat of a chat in the sidebar.
 *
 * The list tells two kinds of chat apart: the ones made inside the artifact, and the ones
 * that are subchats of a chat in the sidebar (which is where the artifact usually starts).
 */
export function ArtifactChatTools({
  kind,
  chats,
  sessionId,
  onSelect,
  onNew,
}: {
  kind?: ArtifactKind
  chats: string[]
  sessionId?: string
  onSelect: (id: string) => void
  onNew: () => void
}) {
  const { t } = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const items = chats
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    .reverse()
  const embedded = items.filter((s) => !s.parentId)
  const subchats = items.filter((s) => s.parentId)

  const meta = kind ? AGENT_META[kind] : undefined
  const row = (s: (typeof items)[number]) => (
    <DropdownMenuItem key={s.id} onClick={() => onSelect(s.id)}>
      {meta && <meta.icon className={cn("size-3.5 shrink-0", meta.color)} />}
      <span className="min-w-0 flex-1 truncate">{s.title}</span>
      {s.id === sessionId && <Check className="size-3.5" />}
    </DropdownMenuItem>
  )

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("artifact.chats")}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 min-w-60 overflow-y-auto">
          {embedded.length > 0 && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("artifact.embedded")}</DropdownMenuLabel>
              {embedded.map(row)}
            </DropdownMenuGroup>
          )}
          {embedded.length > 0 && subchats.length > 0 && <DropdownMenuSeparator />}
          {subchats.length > 0 && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("artifact.subchats")}</DropdownMenuLabel>
              {subchats.map(row)}
            </DropdownMenuGroup>
          )}
          {items.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onClick={onNew}>
            <Plus className="size-3.5" />
            {t("artifact.newChat")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Hint label={t("artifact.newChat")}>
        <button
          type="button"
          aria-label={t("artifact.newChat")}
          onClick={onNew}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </Hint>
    </>
  )
}
