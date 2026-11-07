import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Check,
  Loader2,
  MessagesSquare,
  MoreHorizontalIcon,
  PanelRight,
  Pencil,
  PinIcon,
  RotateCw,
  Sparkles,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/hint"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { ActionsFeed, FullscreenComposer, useEdgeHover } from "@/src/components/fullscreen-dock"
import { ModelPicker } from "@/src/components/model-picker"
import { DeleteFragmentDialog, FragmentAiBanner, FragmentFrame, useFragment } from "@/src/components/fragment-tab"
import { fragmentApi } from "@/src/lib/ipc"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { usePanelStore } from "@/src/stores/panel-store"
import { useSessionStatus, useSessionStore } from "@/src/stores/session-store"
import { describeFragmentAction } from "./fragment-actions"

/**
 * One fragment on the page: the whole area is the fragment — no border, no header of its
 * own (the app header carries back, icon and name). A floating bar sits in the corner;
 * touching it opens the options. EDIT mode docks Orbit's prompt at the bottom edge and
 * opens the activity feed on the right, so the person sees what the agent is doing
 * without a chat on screen; the frame reloads on every write.
 */
export function FragmentScreen({ fragmentId }: { fragmentId: string }) {
  const { t } = useTranslation()
  const { manifest, missing } = useFragment(fragmentId)
  const leave = useFragmentsStore((s) => s.leave)
  const sessions = useSessionStore((s) => s.sessions)
  const [reloads, setReloads] = useState(0)
  const [editing, setEditing] = useState(false)
  const [composerPinned, setComposerPinned] = useState(true)
  const [feedPinned, setFeedPinned] = useState(false)

  // A fragment deleted from anywhere sends the page back to the gallery.
  useEffect(() => {
    if (missing) leave()
  }, [missing, leave])

  // The chat that builds this fragment. When it is gone (deleted, or the fragment came from
  // elsewhere) edit mode makes a new lean one; it needs no briefing, because each turn of a
  // fragment chat is told which fragment it is looking at.
  const sessionId = manifest?.sessionId && sessions.some((s) => s.id === manifest.sessionId) ? manifest.sessionId : undefined
  const status = useSessionStatus(sessionId)
  const working = status === "submitted" || status === "streaming"

  if (!manifest) return <div className="flex-1" />

  const toggleEdit = async () => {
    if (editing) {
      setEditing(false)
      return
    }
    setEditing(true)
    setComposerPinned(true)
    if (sessionId) return
    const store = useSessionStore.getState()
    const session = await store.createSession("chat", { setActive: false, fragment: { kind: manifest.kind } })
    await fragmentApi.update(manifest.id, { sessionId: session.id })
  }

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background">
      <FragmentFrame
        manifest={manifest}
        sessionId={manifest.sessionId}
        reloads={reloads}
        className="absolute inset-0 size-full border-0 bg-white"
      />

      {/* The fragment asked for the model: only the person can say yes. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center">
        <div className="pointer-events-auto w-full max-w-md overflow-hidden rounded-b-xl border border-t-0 bg-background/95 shadow-md backdrop-blur">
          <FragmentAiBanner manifest={manifest} />
        </div>
      </div>

      {editing && sessionId && (
        <>
          <ActionsFeed
            sessionId={sessionId}
            pinned={feedPinned}
            onTogglePin={() => setFeedPinned((v) => !v)}
            title={t("fragments.activity")}
            icon={Sparkles}
            filter={(part) => part.tool.startsWith("fragment_")}
            describe={(part) => describeFragmentAction(t, part)}
          />
          <FullscreenComposer
            sessionId={sessionId}
            pinned={composerPinned}
            onTogglePin={() => setComposerPinned((v) => !v)}
          />
        </>
      )}

      <FragmentFab
        manifest={manifest}
        editing={editing}
        working={working}
        sessionId={sessionId}
        onToggleEdit={() => void toggleEdit()}
        onReload={() => setReloads((n) => n + 1)}
      />
    </div>
  )
}

/**
 * The floating bar. Collapsed it is a small pill in the corner (always visible, with a
 * pulse while the agent works); hovering it unfolds the options to its left. Everything
 * stays mounted while collapsed — only hidden — so a menu or the model dialog opened from
 * here is not torn down when the mouse leaves the bar.
 */
function FragmentFab({
  manifest,
  editing,
  working,
  sessionId,
  onToggleEdit,
  onReload,
}: {
  manifest: import("@shared/fragments").FragmentManifest
  editing: boolean
  working: boolean
  sessionId?: string
  onToggleEdit: () => void
  onReload: () => void
}) {
  const { t } = useTranslation()
  const { hovered, handleEnter, handleLeave } = useEdgeHover()
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const sessionTitle = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.title)
  const open = hovered || menuOpen
  const asksAi = manifest.requests.includes("ai")
  const aiOn = manifest.grants.includes("ai")

  return (
    <div
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      className="absolute bottom-4 right-4 z-40 flex items-center rounded-full border bg-background/90 p-1 shadow-lg backdrop-blur"
    >
      <div
        className={cn(
          "flex items-center gap-0.5 overflow-hidden transition-all duration-300 ease-out",
          open ? "max-w-[34rem] pl-1 pr-1 opacity-100" : "max-w-0 opacity-0",
        )}
        aria-hidden={!open}
      >
        {asksAi && (
          <ModelPicker
            value={manifest.model ?? null}
            onValueChange={(model) =>
              void fragmentApi.update(manifest.id, {
                model: model ? { providerId: model.providerId, modelId: model.modelId } : null,
              })
            }
            nullLabel={t("fragments.modelFollowChat")}
            hideRotationOptions
            triggerClassName="h-7 text-xs"
          />
        )}
        {asksAi && (
          <FabButton
            icon={Sparkles}
            label={t(aiOn ? "fragments.aiRevoke" : "fragments.aiAllow")}
            active={aiOn}
            onClick={() => void fragmentApi.grant(manifest.id, "ai", !aiOn)}
          />
        )}
        <Button
          size="sm"
          variant={editing ? "secondary" : "ghost"}
          className={cn("h-7 shrink-0 gap-1.5 rounded-full px-2.5 text-xs", editing && "text-primary")}
          aria-pressed={editing}
          onClick={onToggleEdit}
        >
          <Pencil className="size-3.5" />
          {t("fragments.edit")}
        </Button>
        <FabButton icon={RotateCw} label={t("fragments.reload")} onClick={onReload} />
        {sessionId && (
          <FabButton
            icon={MessagesSquare}
            label={t("fragments.seeChat")}
            onClick={() => usePanelStore.getState().openChatTab(sessionId, sessionTitle ?? manifest.name)}
          />
        )}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            aria-label={t("fragments.more")}
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <MoreHorizontalIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="min-w-56">
            <DropdownMenuItem onClick={() => void fragmentApi.update(manifest.id, { pinned: { sidebar: !manifest.pinned.sidebar } })}>
              {manifest.pinned.sidebar ? <Check className="size-3.5" /> : <PinIcon className="size-3.5" />}
              {t("fragments.pinSidebar")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void fragmentApi.update(manifest.id, { pinned: { panel: !manifest.pinned.panel } })}>
              {manifest.pinned.panel ? <Check className="size-3.5" /> : <PanelRight className="size-3.5" />}
              {t("fragments.pinPanel")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => usePanelStore.getState().openFragmentTab({ id: manifest.id, title: manifest.name })}
            >
              <PanelRight className="size-3.5" />
              {t("fragments.openInPanel")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-3.5" />
              {t("fragments.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* The part that is always visible. */}
      <span
        className="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
        aria-hidden
      >
        {working ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
      </span>

      <DeleteFragmentDialog open={confirmDelete} onOpenChange={setConfirmDelete} fragmentId={manifest.id} />
    </div>
  )
}

function FabButton({
  icon: Icon,
  label,
  onClick,
  active,
}: {
  icon: typeof Sparkles
  label: string
  onClick: () => void
  active?: boolean
}) {
  return (
    <Hint label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-accent hover:text-foreground",
          active ? "bg-primary/15 text-primary" : "text-muted-foreground",
        )}
      >
        <Icon className="size-3.5" />
      </button>
    </Hint>
  )
}
