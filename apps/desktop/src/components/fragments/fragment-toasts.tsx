import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { X } from "lucide-react"
import type { FragmentNotifyEvent } from "@shared/fragments"
import { fragmentApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"
import { FragmentIcon } from "./fragment-icon"

const VISIBLE_MS = 6_000
const MAX_ON_SCREEN = 3

/**
 * The app's toast for a fragment notification: a heads-up card at the top centre, with the
 * fragment's own icon and the app's notification sound (played by the main process, the same
 * one a new message uses).
 *
 * Mounted at the root, so it shows over any screen — chat, settings, another fragment. The
 * schedule is not here: the app keeps it (fragment-notify.ts) and this only draws what arrives.
 */
export function FragmentToasts() {
  const [items, setItems] = useState<FragmentNotifyEvent[]>([])

  useEffect(() => {
    const offNotify = fragmentApi.onNotify((event) => {
      setItems((prev) => [...prev, event].slice(-MAX_ON_SCREEN))
    })
    // A native banner was clicked while Orbit was not in front: the fragment comes back.
    const offOpen = fragmentApi.onOpenRequest(({ id, title, sessionId }) => {
      usePanelStore.getState().openFragmentTab({ id, title, sessionId })
    })
    return () => {
      offNotify()
      offOpen()
    }
  }, [])

  const dismiss = useCallback((fragmentId: string, at: number) => {
    setItems((prev) => prev.filter((item) => !(item.fragmentId === fragmentId && item.at === at)))
  }, [])

  if (items.length === 0) return null

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-3 z-[120] flex flex-col items-center gap-2 px-4"
    >
      {items.map((item) => (
        <Toast
          key={`${item.fragmentId}-${item.at}`}
          event={item}
          onDone={() => dismiss(item.fragmentId, item.at)}
        />
      ))}
    </div>
  )
}

function Toast({ event, onDone }: { event: FragmentNotifyEvent; onDone: () => void }) {
  const { t } = useTranslation()
  const [leaving, setLeaving] = useState(false)
  // The parent re-renders while the toast is on screen; the removal must not depend on that.
  const done = useRef(onDone)
  done.current = onDone

  useEffect(() => {
    const fade = setTimeout(() => setLeaving(true), VISIBLE_MS)
    // Never rely only on transitionend: with reduced motion it does not fire.
    const remove = setTimeout(() => done.current(), VISIBLE_MS + 320)
    return () => {
      clearTimeout(fade)
      clearTimeout(remove)
    }
  }, [])

  const open = () => {
    usePanelStore.getState().openFragmentTab({
      id: event.fragmentId,
      title: event.fragmentName,
    })
    onDone()
  }

  return (
    <div
      role="status"
      onClick={open}
      className={`pointer-events-auto flex w-full max-w-md cursor-pointer items-start gap-3 rounded-2xl border border-border/70 bg-popover/95 px-3 py-2.5 shadow-lg backdrop-blur-md transition-all duration-300 ${
        leaving ? "pointer-events-none translate-y-[-6px] opacity-0" : "animate-in fade-in-0 slide-in-from-top-2"
      }`}
      onTransitionEnd={() => {
        if (leaving) onDone()
      }}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
        <FragmentIcon name={event.icon} className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {event.fragmentName}
        </p>
        <p className="truncate text-xs font-semibold text-foreground">{event.title}</p>
        {event.body && (
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{event.body}</p>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onDone()
        }}
        aria-label={t("common.close")}
        className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
