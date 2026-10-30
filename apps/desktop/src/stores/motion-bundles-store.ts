import { useEffect, useMemo, useRef } from "react"
import { create } from "zustand"
import type { ChatMessage } from "@shared/chat"
import type { MotionBundle } from "@shared/media"
import { motionApi } from "@/src/lib/ipc"
import {
  NO_BUNDLES,
  indexMotionBundles,
  motionBundleAnchors,
  type MotionBundleIndexes,
} from "@/src/lib/motion-bundle"

/**
 * The conversation's motion piece cards, on the side of whoever draws the chat.
 *
 * The file list is MAIN's (the piece folder is his): here live the per-conversation
 * cache, the map that links an `aud_…`/`img_…` to the piece that owns it and the card's
 * address — the FIRST message that showed media of that piece, which is where it
 * lives forever. Whoever decides what to do with each part is `motion-bundle`.
 *
 * Why a store and not message state: the card has to update when
 * the FOLDER changes (a re-recorded narration, a new file), and the old message
 * is not re-rendered because of that — it is memoized. Whoever subscribes to the store is the card.
 */

interface SessionBundles {
  bundles: MotionBundle[]
  /** motionId → id of the message where the card lives. */
  anchors: Record<string, string>
}

interface MotionBundlesState {
  bySession: Record<string, SessionBundles>
  load: (sessionId: string) => Promise<void>
  setAnchors: (sessionId: string, anchors: Record<string, string>) => void
}

const EMPTY: SessionBundles = { bundles: [], anchors: {} }
/** One load at a time per conversation: the folder reports every file copied. */
const inFlight = new Set<string>()
/** Requests that arrived during a load: the last one runs when it finishes. */
const queued = new Set<string>()

async function loadBundles(
  sessionId: string,
  set: (fn: (state: MotionBundlesState) => Partial<MotionBundlesState>) => void,
  get: () => MotionBundlesState,
): Promise<void> {
  if (inFlight.has(sessionId)) {
    // It does not lose the notice: without the repetition, the end of a turn that coincided
    // with a load in progress would leave the card with the previous list.
    queued.add(sessionId)
    return
  }
  inFlight.add(sessionId)
  try {
    const bundles = await motionApi.bundles(sessionId)
    // Keeps the addresses already computed: they belong to the MESSAGES, not to the folder.
    const anchors = get().bySession[sessionId]?.anchors ?? {}
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: { bundles, anchors } } }))
  } catch {
    // Without the list the chat stays exactly as it was (the loose players):
    // the card is an improvement of the conversation, not a dependency of it.
  } finally {
    inFlight.delete(sessionId)
    if (queued.delete(sessionId)) void loadBundles(sessionId, set, get)
  }
}

export const useMotionBundlesStore = create<MotionBundlesState>((set, get) => ({
  bySession: {},
  load: async (sessionId: string) => {
    if (!sessionId) return
    await loadBundles(sessionId, set, get)
  },
  setAnchors: (sessionId: string, anchors: Record<string, string>) => {
    const current = get().bySession[sessionId]
    const before = current?.anchors ?? {}
    const same =
      Object.keys(before).length === Object.keys(anchors).length &&
      Object.entries(anchors).every(([id, messageId]) => before[id] === messageId)
    if (same && current) return
    set((state) => ({
      bySession: {
        ...state.bySession,
        [sessionId]: { bundles: state.bySession[sessionId]?.bundles ?? [], anchors },
      },
    }))
  },
}))

/** A conversation's data (stable identity while nothing changes). */
export function useSessionBundles(sessionId?: string): SessionBundles {
  return useMotionBundlesStore((state) => (sessionId ? state.bySession[sessionId] ?? EMPTY : EMPTY))
}

/** The key → piece map + where each card lives, ready for the parts. */
export function useMotionBundleIndexes(sessionId?: string): MotionBundleIndexes {
  const data = useSessionBundles(sessionId)
  return useMemo(
    () => (data === EMPTY ? NO_BUNDLES : indexMotionBundles(data.bundles, data.anchors)),
    [data],
  )
}

/**
 * Keeps the list and the addresses up to date for the open conversation.
 *
 * Three triggers, and none of them is "on every stream delta": on opening the conversation,
 * when the turn ENDS (that is when the folder grew) and when main reports that
 * some piece's folder changed (the file was rewritten, the media came in). The
 * addresses are recalculated when the messages change, at the cost of one sweep
 * of parts — only the media ones take work.
 */
export function useMotionBundleAnchors(
  sessionId: string | undefined,
  messages: ChatMessage[],
  isBusy: boolean,
): void {
  const data = useSessionBundles(sessionId)
  const load = useMotionBundlesStore((state) => state.load)
  const setAnchors = useMotionBundlesStore((state) => state.setAnchors)
  const bundles = data.bundles

  useEffect(() => {
    if (!sessionId) return
    void load(sessionId)
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = motionApi.onChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(sessionId), 250)
    })
    return () => {
      if (timer) clearTimeout(timer)
      off()
    }
  }, [sessionId, load])

  const wasBusy = useRef(isBusy)
  useEffect(() => {
    const finished = wasBusy.current && !isBusy
    wasBusy.current = isBusy
    if (finished && sessionId) void load(sessionId)
  }, [isBusy, sessionId, load])

  // The message sweep is O(parts): redoing it on every stream token
  // would be wasted work. An anchor is only born when new media shows up — and
  // new media changes the LAST message (it is where the stream writes). The id goes
  // into the fingerprint because regenerating swaps the message for another one.
  const last = messages[messages.length - 1]
  const fingerprint = `${messages.length}:${last?.id ?? ""}:${last?.parts.length ?? 0}`
  const latest = useRef(messages)
  latest.current = messages
  useEffect(() => {
    if (!sessionId) return
    const byKey = bundles.length ? indexMotionBundles(bundles, {}).byKey : null
    setAnchors(sessionId, byKey ? motionBundleAnchors(latest.current, byKey) : {})
  }, [sessionId, fingerprint, bundles, setAnchors])
}
