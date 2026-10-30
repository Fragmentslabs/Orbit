import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Memory, MemoryGraphJob, MemoryLayout } from '@orbit/shared'
import { createMemoryGraphJob } from '@orbit/shared'

/**
 * Graph layout served in slices, so the screen shows up right away.
 *
 * `layoutMemoryGraph` runs a force simulation and two separation passes —
 * seconds of work with a few hundred memories. Before it ran in a single
 * task: the JS thread got stuck, the "Building the graph…" did not even get to
 * paint and the app looked frozen.
 *
 * Here the same work comes from `createMemoryGraphJob`, which hands control back
 * every few milliseconds. The graph opens immediately with the real progress and
 * — while the pool is small enough for the preview to be cheap — with the
 * partial positions, so you can watch the drawing settle.
 *
 * The result stays in a small cache keyed by pool signature: switching the project
 * filter and coming back recalculates nothing.
 */

/**
 * Slice per frame with the graph screen in front. It goes up to 11 ms because, with the
 * building screen on screen, there is no competitor: slicing at 8 ms nearly doubled the
 * wall clock with nobody using the slack.
 */
const ACTIVE_BUDGET = 11
/** Slice when the layout is being warmed up with the LIST in front: here
 *  stealing frames shows up in the scroll, so the bite is smaller. */
const BACKGROUND_BUDGET = 4
/**
 * Minimum interval between two previews. Each one remounts the whole scene — the
 * partial layout is a new set of positions —, so they compete with the
 * layout slices themselves. At 250 ms the tax was too high; at 600 ms you can still
 * watch the graph settle without turning the build into a dispute.
 */
const PREVIEW_INTERVAL = 600
/** Above this the preview costs more than it informs: only the bar remains. */
const MAX_PREVIEW_NODES = 800
/** The project filter usually goes back and forth between two or three selections. */
const MAX_CACHE = 3

export interface GraphLayoutState {
  /** Partial while `building`; null until the first preview. */
  layout: MemoryLayout | null
  /** Moment when the layout was built — "recent"/"forgotten" are relative
   *  to it, and not to the current frame (otherwise the scene memo died on every frame). */
  now: number
  /** 0..1 — feeds the progress bar. */
  progress: number
  building: boolean
}

interface Entry {
  key: string
  layout: MemoryLayout
  now: number
}

interface Run {
  key: string
  pool: Memory[]
  job: MemoryGraphJob
  layout: MemoryLayout | null
  progress: number
  now: number
  budget: number
  frame: number | null
  lastPreview: number
  /** Last whole percentage already reported to React. */
  reportedPct: number
}

/** Tiny LRU: most recent at the end. */
const cache: Entry[] = []
let current: Run | null = null
const subscribers = new Set<() => void>()
/**
 * The state handed to React. `useSyncExternalStore` compares by identity on
 * every render, so it can only be rebuilt when something really changed
 * — otherwise it becomes an infinite render loop.
 */
let snapshot: { key: string; state: GraphLayoutState } | null = null

/**
 * Cheap pool signature: the layout only depends on who is in it and on the
 * declared links. It is a hash, not the concatenation of the ids — with thousands of
 * memories the string alone cost more than a whole slice.
 */
function signature(pool: Memory[]): string {
  let h = 2166136261
  for (const memory of pool) {
    const id = memory.id
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    h ^= memory.relatedIds.length + 1
    h = Math.imul(h, 16777619)
  }
  return `${pool.length}:${(h >>> 0).toString(36)}`
}

function fromCache(key: string): Entry | undefined {
  const i = cache.findIndex((e) => e.key === key)
  if (i < 0) return undefined
  const [entry] = cache.splice(i, 1)
  cache.push(entry)
  return entry
}

function store(entry: Entry): void {
  cache.push(entry)
  while (cache.length > MAX_CACHE) cache.shift()
}

function compute(key: string): GraphLayoutState {
  const cached = cache.find((e) => e.key === key)
  if (cached) return { layout: cached.layout, now: cached.now, progress: 1, building: false }
  if (current?.key === key) {
    return { layout: current.layout, now: current.now, progress: current.progress, building: true }
  }
  return { layout: null, now: 0, progress: 0, building: true }
}

function read(key: string): GraphLayoutState {
  if (snapshot?.key === key) return snapshot.state
  snapshot = { key, state: compute(key) }
  return snapshot.state
}

function notify(): void {
  snapshot = null
  for (const fn of subscribers) fn()
}

function schedule(exec: Run, first = false): void {
  if (exec.frame != null) return
  // On the first scheduling it is TWO frames: the first rAF still runs before
  // React has painted the loading state, and starting the grind there would hold
  // exactly the frame that needs to show up.
  const tick = () => {
    exec.frame = null
    work(exec)
  }
  exec.frame = requestAnimationFrame(first ? () => {
    exec.frame = requestAnimationFrame(tick)
  } : tick)
}

function work(exec: Run): void {
  if (current !== exec) return
  const finished = exec.job.step(exec.budget)
  exec.progress = exec.job.progress

  if (finished) {
    const layout = exec.job.snapshot()
    const builtAt = Date.now()
    exec.layout = layout
    exec.now = builtAt
    store({ key: exec.key, layout, now: builtAt })
    current = null
    notify()
    return
  }

  const nowMs = Date.now()
  let changed = false
  if (exec.pool.length <= MAX_PREVIEW_NODES && nowMs - exec.lastPreview >= PREVIEW_INTERVAL) {
    exec.lastPreview = nowMs
    exec.layout = exec.job.snapshot()
    if (!exec.now) exec.now = nowMs
    changed = true
  }
  // Apart from the previews, the only visible thing is the percentage: telling React on every
  // slice would be one render per frame to redraw the same number.
  const pct = Math.round(exec.progress * 100)
  if (pct !== exec.reportedPct) {
    exec.reportedPct = pct
    changed = true
  }
  if (changed) notify()
  schedule(exec)
}

function cancel(): void {
  if (!current) return
  if (current.frame != null) cancelAnimationFrame(current.frame)
  current = null
  snapshot = null
}

function start(key: string, pool: Memory[], budget: number): void {
  if (fromCache(key)) return
  if (current?.key === key) {
    // Already running: whoever arrived in a hurry (the graph screen open) decides
    // the slice size.
    if (budget > current.budget) current.budget = budget
    return
  }
  cancel()
  const exec: Run = {
    key,
    pool,
    job: createMemoryGraphJob(pool, { inferEdges: true }),
    layout: null,
    progress: 0,
    now: 0,
    budget,
    frame: null,
    lastPreview: Date.now(),
    reportedPct: -1,
  }
  current = exec
  snapshot = null
  schedule(exec, true)
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  return () => {
    subscribers.delete(fn)
  }
}

/**
 * Warms up the layout while the user is still in the list. In practice this is what
 * makes the List→Graph toggle open ready most of the time.
 */
export function prewarmGraphLayout(pool: Memory[]): void {
  if (pool.length === 0) return
  start(signature(pool), pool, BACKGROUND_BUDGET)
}

/** Stops whatever is running — the memories screen left the scene. */
export function stopGraphLayout(): void {
  cancel()
}

export function useGraphLayout(pool: Memory[]): GraphLayoutState {
  // Memoized: without it the signature would be redone on every render of the graph —
  // including on the gesture frames, which is exactly where there cannot be
  // work proportional to the number of memories.
  const key = useMemo(() => signature(pool), [pool])

  useEffect(() => {
    start(key, pool, ACTIVE_BUDGET)
    return () => {
      // Without the graph screen in front the work continues, only slowly:
      // going back to it resumes from where it stopped instead of starting over.
      if (current) current.budget = BACKGROUND_BUDGET
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key summarizes the pool
  }, [key])

  return useSyncExternalStore(
    subscribe,
    useCallback(() => read(key), [key]),
  )
}
