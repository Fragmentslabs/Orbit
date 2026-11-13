import { Check, ChevronDown, CornerDownRight, MessageSquare, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Hint } from "@/components/ui/hint"
import { isEmbeddedArtifactChat, type ArtifactKind } from "@shared/artifacts"
import { AGENT_META, sessionIcon } from "@/src/components/agent-meta"
import { cn } from "@/lib/utils"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Header controls of an artifact's conversation card — the same for fragments, motion and
 * design: pick among the chats that worked on the artifact, or start a new (embedded) one.
 *
 * One flat list, newest first, and nothing else: what a chat IS shows in its icon — the
 * artifact's own icon when it was made inside the artifact, a branch when it is a subchat of
 * a chat in the sidebar, and the conversation bubble when it is a chat of the sidebar itself.
 * With `title`, the title itself is the trigger (the fragment conversation column).
 */
export function ArtifactChatTools({
  kind,
  title,
  chats,
  sessionId,
  onSelect,
  onNew,
}: {
  kind?: ArtifactKind
  /** The trigger shows this title itself (the conversation column); without it, only a chevron. */
  title?: string
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

  const meta = kind ? AGENT_META[kind] : undefined
  const row = (s: (typeof items)[number]) => {
    const own = meta && isEmbeddedArtifactChat(s) ? meta : undefined
    const Icon = own?.icon ?? (s.parentId ? CornerDownRight : sessionIcon(s) ?? MessageSquare)
    return (
      <DropdownMenuItem key={s.id} onClick={() => onSelect(s.id)}>
        <Icon className={cn("size-3.5 shrink-0", own?.color ?? "text-muted-foreground")} />
        <span className="min-w-0 flex-1 truncate">{s.title}</span>
        {s.id === sessionId && <Check className="size-3.5" />}
      </DropdownMenuItem>
    )
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("artifact.chats")}
          className={cn(
            "flex items-center gap-1.5 rounded text-muted-foreground transition-colors hover:text-foreground",
            title
              ? "w-fit max-w-full min-w-0 px-1 py-1 text-left text-xs font-medium text-foreground hover:bg-accent"
              : "size-6 shrink-0 justify-center",
          )}
        >
          {title ? (
            <>
              {meta && <meta.icon className={cn("size-3.5 shrink-0", meta.color)} />}
              <span className="truncate">{title}</span>
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            </>
          ) : (
            <ChevronDown className="size-3.5" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 min-w-60 overflow-y-auto">
          {items.map(row)}
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
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            title ? "ml-auto size-7" : "size-6",
          )}
        >
          <Plus className="size-3.5" />
        </button>
      </Hint>
    </>
  )
}
