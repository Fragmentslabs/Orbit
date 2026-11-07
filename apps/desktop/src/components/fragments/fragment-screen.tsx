import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Sparkles } from "lucide-react"
import { ArtifactChatFeed } from "@/src/components/artifact/artifact-chat-feed"
import { useArtifactChat } from "@/src/hooks/use-artifact-chat"
import { useMarkArtifactSeen } from "@/src/hooks/use-artifact-activity"
import { FragmentComposer } from "@/src/components/fragments/fragment-composer"
import { ActionsFeed } from "@/src/components/actions-feed"
import { FragmentAiBadge, FragmentFrame, useFragment } from "@/src/components/fragment-tab"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { describeFragmentAction } from "./fragment-actions"

/**
 * One fragment on the page: the whole area is the fragment — no border, no bar of its own
 * (the app header carries back, icon, name, actions and the controls). EDIT mode, turned on
 * from the header, docks Orbit's prompt at the bottom edge and opens the activity feed on the
 * right, so the person sees what the agent is doing; the frame reloads on every write.
 */
export function FragmentScreen({ fragmentId }: { fragmentId: string }) {
  const { t } = useTranslation()
  const { manifest, missing } = useFragment(fragmentId)
  const leave = useFragmentsStore((s) => s.leave)
  const reloads = useFragmentsStore((s) => s.reloads)
  const editing = useFragmentsStore((s) => s.editing)
  const [composerPinned, setComposerPinned] = useState(true)
  const [feedPinned, setFeedPinned] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)

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
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background">
      <FragmentFrame
        manifest={manifest}
        sessionId={manifest.sessionId}
        reloads={reloads}
        className="absolute inset-0 size-full border-0 bg-white"
      />

      {/* The fragment asked for the model: only the person can say yes. */}
      <FragmentAiBadge manifest={manifest} />

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
          <ArtifactChatFeed chat={chat} title={manifest.name} pinned={chatOpen} onTogglePin={() => setChatOpen((v) => !v)} />
          <FragmentComposer
            sessionId={sessionId}
            pinned={composerPinned}
            onTogglePin={() => setComposerPinned((v) => !v)}
          />
        </>
      )}
    </div>
  )
}

