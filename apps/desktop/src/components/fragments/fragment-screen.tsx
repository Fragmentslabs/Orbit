import { useEffect, useRef, useState } from "react"
import { FragmentChatRail } from "@/src/components/fragments/fragment-chat-rail"
import { useArtifactChat } from "@/src/hooks/use-artifact-chat"
import { useMarkArtifactSeen } from "@/src/hooks/use-artifact-activity"
import { useStacked } from "@/src/hooks/use-stacked"
import { FragmentDetailsPanel } from "@/src/components/fragments/fragment-details-panel"
import { FragmentAiBadge, FragmentFrame, useFragment } from "@/src/components/fragment-tab"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { FragmentUntrustedBanner } from "./share/fragment-untrusted-banner"

/** The conversation needs its own column: below this it slides over the fragment instead. */
const CHAT_COLUMN_PX = 880

/**
 * One fragment on the page: the whole area is the fragment — no border, no bar of its own
 * (the app header carries back, icon, name, actions and the controls). EDIT mode opens its
 * conversation as a column on the right: the chat, what the agent did and the prompt in ONE
 * place, so the fragment gets narrower instead of being covered. Closing the column leaves
 * edit mode.
 */
export function FragmentScreen({ fragmentId }: { fragmentId: string }) {
  const { manifest, missing } = useFragment(fragmentId)
  const leave = useFragmentsStore((s) => s.leave)
  const pickElement = useFragmentsStore((s) => s.pickElement)
  const stopInspecting = useFragmentsStore((s) => s.toggleInspecting)
  const toggleEditing = useFragmentsStore((s) => s.toggleEditing)
  const reloads = useFragmentsStore((s) => s.reloads)
  const editing = useFragmentsStore((s) => s.editing)
  const detailsOpen = useFragmentsStore((s) => s.detailsOpen)
  const inspecting = useFragmentsStore((s) => s.inspecting)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const overlaid = useStacked(root, CHAT_COLUMN_PX)

  // A fragment deleted from anywhere sends the page back to the gallery.
  useEffect(() => {
    if (missing) leave()
  }, [missing, leave])

  // The chat that builds this fragment: the one the person picked, else its author. With
  // none (deleted, or the fragment came from elsewhere) edit mode makes an embedded one; it
  // needs no briefing, because each turn of a fragment chat is told which fragment it is.
  // The person is looking at the fragment: what its chats did counts as seen.
  useMarkArtifactSeen({ kind: "fragment", id: fragmentId }, true)
  const chat = useArtifactChat({ kind: "fragment", id: fragmentId }, { fallback: manifest?.sessionId, fragmentKind: manifest?.kind })
  const sessionId = chat.sessionId

  // Edit mode needs a chat: make an embedded one the first time it is turned on with none.
  const ensuring = useRef(false)
  useEffect(() => {
    if (!editing || chat.sessionId || ensuring.current) return
    ensuring.current = true
    void chat.ensure().finally(() => {
      ensuring.current = false
    })
  }, [editing, chat])

  if (!manifest) return <div className="flex-1" />

  return (
    <div ref={setRoot} className="relative flex min-h-0 flex-1 overflow-hidden bg-background">
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <FragmentFrame
          manifest={manifest}
          sessionId={manifest.sessionId}
          reloads={reloads}
          inspecting={inspecting}
          onInspect={(element) => {
            if (element) pickElement({ id: manifest.id, name: manifest.name }, element)
            else stopInspecting()
          }}
          className="absolute inset-0 size-full border-0 bg-white"
        />

        {/* The fragment asked for the model: only the person can say yes. */}
        <FragmentAiBadge manifest={manifest} />

        <FragmentUntrustedBanner fragmentId={manifest.id} />

        {detailsOpen && <FragmentDetailsPanel manifest={manifest} />}
      </div>

      {editing && sessionId && (
        <FragmentChatRail chat={chat} sessionId={sessionId} overlaid={overlaid} onClose={toggleEditing} />
      )}
    </div>
  )
}
