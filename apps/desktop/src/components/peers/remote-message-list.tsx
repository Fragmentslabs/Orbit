import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Loader2 } from "lucide-react"
import { ChatMessages } from "@/src/components/chat-messages"
import { usePeersStore } from "@/src/stores/peers-store"
import { useRemoteMessagesSource } from "./remote-messages-source"

/**
 * The conversation of a chat on another desktop: the app's own message list fed by
 * peers-store, plus the states that only a remote read has (loading, load error) and the
 * start screen of an empty routine chat.
 */
export function RemoteMessageList({ sessionId, mode, startScreen }: {
  sessionId: string
  mode: "chat" | "code"
  startScreen?: ReactNode
}) {
  const { t } = useTranslation()
  const source = useRemoteMessagesSource(sessionId, mode)
  const loaded = usePeersStore((s) => !!s.messages[sessionId])
  const loading = usePeersStore((s) => !!s.loading[sessionId])
  const error = usePeersStore((s) => s.errors[sessionId])

  if (!loaded && error) {
    return <p className="flex-1 py-10 text-center text-sm text-destructive">{t("peers.remote.loadError", { error })}</p>
  }
  if (loaded && !loading && source.messages.length === 0 && startScreen) {
    return <div className="flex w-full flex-1 flex-col items-center overflow-y-auto pt-24">{startScreen}</div>
  }
  return (
    <>
      {!loaded && loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("peers.remote.loading")}
        </div>
      ) : (
        <ChatMessages {...source} />
      )}
    </>
  )
}
