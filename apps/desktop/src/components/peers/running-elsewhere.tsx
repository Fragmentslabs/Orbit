import { useTranslation } from "react-i18next"
import { EMPTY_LIST, usePeersStore } from "@/src/stores/peers-store"
import { cn } from "@/lib/utils"

/**
 * The chats running on the other desktops, at the top of the list, in ANY
 * environment — the reason to pair is following them without switching. A click
 * switches to that machine and opens the chat. Hidden when nothing runs.
 */
export function RunningElsewhere({ onOpen }: { onOpen?: () => void }) {
  const { t } = useTranslation()
  const running = usePeersStore((s) => s.snapshot?.running ?? EMPTY_LIST)
  const activeByPeer = usePeersStore((s) => s.activeByPeer)
  const env = usePeersStore((s) => s.env)
  const openSession = usePeersStore((s) => s.openSession)
  if (running.length === 0) return null

  return (
    <div className="mx-2 mb-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-1.5">
      <p className="px-1.5 pb-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">{t("peers.running.title")}</p>
      {running.map((item) => {
        const active = env === item.peerId && activeByPeer[item.peerId] === item.sessionId
        return (
          <button
            key={item.sessionId}
            type="button"
            onClick={() => {
              openSession(item.sessionId)
              onOpen?.()
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-amber-500/10",
              active && "bg-amber-500/15",
            )}
          >
            <span className="relative flex size-2 shrink-0" aria-hidden>
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-500 opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-amber-500" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-foreground">{item.title || "…"}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {item.peerName}
                {item.waiting ? ` · ${t("peers.running.waiting")}` : ""}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
