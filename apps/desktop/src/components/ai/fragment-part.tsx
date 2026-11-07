import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { AppWindow } from "lucide-react"
import type { ToolPart } from "@shared/chat"
import { isOwnArtifact } from "@/src/lib/artifact-session"
import { fragmentRefOf } from "@/src/lib/fragment-part-ref"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { usePanelStore } from "@/src/stores/panel-store"
import { useSessionStore } from "@/src/stores/session-store"
import { PieceCard } from "@/src/components/ai/piece-card"

/**
 * Card of a fragment (fragment_create, fragment_write_file, fragment_edit_file): the way back
 * to it when its panel tab was closed. It opens the fragment in the side panel of the
 * conversation it is shown in (and hides in the chat of that same fragment). Drawn from the tool part itself, so it is in the history when
 * the conversation is reopened.
 */
export function FragmentPartView({ part, sessionId }: { part: ToolPart; sessionId?: string }) {
  const { t } = useTranslation()
  const ref = fragmentRefOf(part)
  const load = useFragmentsStore((s) => s.load)
  const loaded = useFragmentsStore((s) => s.loaded)
  const fragment = useFragmentsStore((s) => s.items.find((f) => f.id === ref?.id))
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId))

  useEffect(() => {
    void load()
  }, [load])

  if (!ref || part.state === "error") return null
  // The conversation card of this very fragment already sits beside its chat.
  if (isOwnArtifact(session, "fragment", ref.id)) return null
  // Before the list loads we cannot tell "deleted" from "not read yet": the card stays clickable
  // and the open answers.
  const label = fragment?.name ?? ref.name ?? ref.id
  return (
    <PieceCard
      icon={AppWindow}
      label={label}
      subtitle={t("fragments.card")}
      openTitle={t("fragments.openInPanel")}
      goneText={t("fragments.gone")}
      canOpen={!loaded || Boolean(fragment)}
      onOpen={() => {
        if (loaded && !fragment) return false
        usePanelStore.getState().openFragmentTab({ id: ref.id, title: label, sessionId })
        return true
      }}
    />
  )
}
