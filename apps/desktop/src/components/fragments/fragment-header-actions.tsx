import { Loader2, Pencil, RotateCw, Sparkles, type LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/hint"
import { cn } from "@/lib/utils"
import type { FragmentManifest } from "@shared/fragments"
import { useFragment } from "@/src/components/fragment-tab"
import { ThinkingMenu } from "@/src/components/thinking-menu"
import { useFragmentHeaderCompact } from "@/src/hooks/use-fragment-header-compact"
import { useArtifactActivity } from "@/src/hooks/use-artifact-activity"
import { fragmentApi } from "@/src/lib/ipc"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { useSessionModel } from "@/src/stores/session-model-prefs"
import { FragmentModelPicker } from "./fragment-model-picker"

/**
 * The controls of the open fragment, on the right of the app header: whether an agent is
 * working on it, the model it uses, whether it may use the AI, reload, and edit mode. Under a width threshold the model and reload
 * move into the actions menu of the title (`FragmentHeaderTitle`). The
 * fragment page has no bar of its own — the fragment gets the whole area.
 */
export function FragmentHeaderActions({ fragmentId }: { fragmentId: string }) {
  const { t } = useTranslation()
  const { manifest } = useFragment(fragmentId)
  const editing = useFragmentsStore((s) => s.editing)
  const toggleEditing = useFragmentsStore((s) => s.toggleEditing)
  const reload = useFragmentsStore((s) => s.reload)
  const { working } = useArtifactActivity({ kind: "fragment", id: fragmentId })
  const compact = useFragmentHeaderCompact()
  if (!manifest) return null

  const asksAi = manifest.requests.includes("ai")
  const aiOn = manifest.grants.includes("ai")

  return (
    <div className="flex shrink-0 items-center gap-1">
      {working && <Loader2 aria-label={t("artifact.working")} className="mr-1 size-4 animate-spin text-primary" />}
      {/* The fragment's AI. Allowed: its model and thinking. Not allowed: only a small badge
          (clicking it allows) — the controls of a model nobody can use would be noise. */}
      {asksAi && aiOn && !compact && (
        <>
          <FragmentModelPicker manifest={manifest} />
          {/* Next to the model it belongs to: the thinking level of the fragment's own model. */}
          <FragmentThinkingMenu manifest={manifest} />
        </>
      )}
      {asksAi && !aiOn && (
        <Hint label={t("fragments.aiAllow")}>
          <button
            type="button"
            onClick={() => void fragmentApi.grant(manifest.id, "ai", true)}
            className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-dashed border-border px-2 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            <Sparkles className="size-3" />
            {t("fragments.aiOff")}
          </button>
        </Hint>
      )}
      <Button
        size="sm"
        variant={editing ? "secondary" : "ghost"}
        className={cn("h-7 shrink-0 gap-1.5 px-2.5 text-xs", editing && "text-primary")}
        aria-pressed={editing}
        onClick={toggleEditing}
      >
        <Pencil className="size-3.5" />
        {t("fragments.edit")}
      </Button>
      {!compact && <HeaderIconButton icon={RotateCw} label={t("fragments.reload")} onClick={reload} />}
    </div>
  )
}

/**
 * The thinking level of the fragment's OWN model (what its page gets when it calls
 * `orbit.ai`) — not the agent that edits it, whose model and thinking are in the edit prompt.
 * It follows the model picked for the fragment, else the chat's model it would follow.
 */
function FragmentThinkingMenu({ manifest }: { manifest: FragmentManifest }) {
  const followed = useSessionModel(manifest.sessionId)
  return (
    <ThinkingMenu
      model={manifest.model ?? followed}
      value={manifest.reasoning ?? null}
      onChange={(next) => void fragmentApi.update(manifest.id, { reasoning: next })}
    />
  )
}

function HeaderIconButton({
  icon: Icon,
  label,
  onClick,
  active,
}: {
  icon: LucideIcon
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
          "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground",
          active ? "bg-primary/15 text-primary" : "text-muted-foreground",
        )}
      >
        <Icon className="size-3.5" />
      </button>
    </Hint>
  )
}
