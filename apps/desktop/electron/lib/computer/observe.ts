import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { windowSpace, type ShotGeometry } from './geometry'
import { diffTrees, formatTree, SCREEN_CONTENT_CLOSE, SCREEN_CONTENT_OPEN } from './format'
import { newObservationId, type ObservationRecord, type Registry } from './registry'
import { assertTargetAllowed, CHROMIUM_BROWSERS } from './safety'
import { ComputerError, type AppInfo, type AppsSnapshot, type ComputerDriver, type Frame, type TreeSnapshot, type WindowInfo } from './types'

/**
 * Builds an observation: screenshot + tree + focus of ONE window, registered with new
 * indices. The text returned declares the geometry (which space the x/y are in) and
 * fences all content coming from the screen as untrusted data.
 */

export interface ObserveOptions {
  sessionId: string
  app: string
  windowId?: number
  includeTree: boolean
  includeScreenshot: boolean
  maxNodes: number
  maxScreenshotEdge: number
  /** Turns on the AX tree of Chromium/Electron apps */
  enhance: boolean
  /** Wait after turning on the flag — the caller knows whether the app was already on */
  enhanceWaitMs?: number
  /** Scale of the monitor of the window (2 on Retina) — defines the coordinate space */
  scaleFor?: (frame: Frame) => number
  /**
   * Observation against which the text can come out as a diff. Only the caller knows
   * whether the model still has that observation in context (one from another turn or
   * from the subagent it never saw), so it is the caller that decides to pass the base.
   */
  diffAgainst?: ObservationRecord | null
  signal?: AbortSignal
}

/** Consecutive diffs before a full tree: the chain does not grow forever, and the context cut discards what was left behind. */
export const MAX_DIFF_CHAIN = 8
/** Above this fraction of the tree changed, the diff is no longer smaller than the tree. */
const DIFF_MAX_FRACTION = 0.4
const DIFF_MIN_LINES = 12

export interface ObservationResult {
  record: ObservationRecord
  text: string
  /** Image already reduced and encoded for the model */
  image: { data: Buffer; mediaType: 'image/webp' } | null
  /** Why there is no image, when one was asked for */
  imageNote: string | null
  tree: TreeSnapshot | null
}

/** Finds the app by what the model sent: bundle id, exe (Windows), name (case-insensitive) or pid. */
export function resolveApp(snapshot: AppsSnapshot, query: string): AppInfo {
  const q = query.trim()
  const lower = q.toLowerCase()
  const byPid = /^\d+$/.test(q) ? snapshot.apps.find((a) => a.pid === Number(q)) : undefined
  const app =
    byPid ??
    snapshot.apps.find((a) => a.bundleId === q) ??
    snapshot.apps.find((a) => a.bundleId?.toLowerCase() === lower) ??
    // Windows: by the exe, with or without ".exe" ("notepad" finds Notepad.exe).
    snapshot.apps.find((a) => a.exe && [lower, `${lower}.exe`].includes(a.exe.toLowerCase())) ??
    snapshot.apps.find((a) => a.name.toLowerCase() === lower) ??
    snapshot.apps.find((a) => a.name.toLowerCase().includes(lower))
  if (!app) {
    throw new ComputerError('appNotFound', `No running app matches "${query}". Call cu_apps to list what is open, or use cu_computer with action "open_app".`)
  }
  return app
}

/** The requested window, or the app's front one (CGWindowList comes from the front to the back). */
export function resolveWindow(snapshot: AppsSnapshot, app: AppInfo, windowId?: number): WindowInfo {
  if (windowId !== undefined) {
    const win = snapshot.windows.find((w) => w.id === windowId && w.pid === app.pid)
    if (!win) throw new ComputerError('windowNotFound', `Window ${windowId} of ${app.name} is not visible anymore — call cu_apps again.`)
    return win
  }
  const win = snapshot.windows.find((w) => w.pid === app.pid)
  if (!win) {
    throw new ComputerError(
      'windowNotFound',
      `${app.name} has no visible window (minimized, hidden or on another Space). Ask the user to bring it up, or activate it first.`,
    )
  }
  return win
}

/** Resizes exactly to the window space: with and without an image, x/y are the same. */
async function encodeShot(png: Buffer, size: { width: number; height: number }): Promise<{ data: Buffer; width: number; height: number }> {
  const data = await sharp(png).resize(size.width, size.height, { fit: 'fill' }).webp({ quality: 72 }).toBuffer()
  return { data, ...size }
}

export async function observe(
  driver: ComputerDriver,
  registry: Registry,
  options: ObserveOptions,
): Promise<ObservationResult> {
  const snapshot = await driver.apps(options.signal)
  const app = resolveApp(snapshot, options.app)
  assertTargetAllowed(app)
  const win = resolveWindow(snapshot, app, options.windowId)
  const geometry = windowSpace(win.frame, options.scaleFor?.(win.frame) ?? 1, options.maxScreenshotEdge)

  // Capture and tree in parallel: they are different processes, and the sum of the two
  // is the time the turn waits.
  const [shot, tree] = await Promise.all([
    options.includeScreenshot
      ? driver
          .capture(win.id, options.signal)
          .then((png) => encodeShot(png, geometry))
          .catch((err: unknown) => {
            if (err instanceof ComputerError && err.code === 'aborted') throw err
            return err instanceof ComputerError ? err : new ComputerError('bridgeError', String(err))
          })
      : Promise.resolve(null),
    options.includeTree
      ? driver.tree(
          {
            pid: app.pid,
            window: { id: win.id, frame: win.frame, title: win.title },
            maxNodes: options.maxNodes,
            enhance: options.enhance,
            enhanceFull: options.enhance && Boolean(app.bundleId && CHROMIUM_BROWSERS.has(app.bundleId)),
            enhanceWaitMs: options.enhanceWaitMs ?? 0,
          },
          options.signal,
        )
      : Promise.resolve(null),
  ])

  const image = shot && !(shot instanceof ComputerError) ? shot : null
  const imageNote = shot instanceof ComputerError ? shot.message : null
  if (!image && !tree) {
    throw shot instanceof ComputerError ? shot : new ComputerError('badRequest', 'Nothing to observe: include_tree and include_screenshot are both false.')
  }

  // Same window: the indices of whatever stays on screen do not change.
  const previous = registry.peek(options.sessionId, app.pid)
  const sameWindow = previous && previous.window.id === win.id ? previous : null
  const formatted = tree ? formatTree(tree, geometry, sameWindow?.keys) : null
  const title = win.title ?? (tree?.nodes[0]?.title || null)

  const base = options.diffAgainst
  const diff =
    formatted && base?.bodies && base.window.id === win.id && (base.diffChain ?? 0) < MAX_DIFF_CHAIN
      ? diffTrees(base.bodies, formatted.bodies)
      : null
  const diffSize = diff ? diff.added.length + diff.changed.length + diff.removed.length : 0
  const useDiff =
    diff !== null && formatted !== null && diffSize <= Math.max(DIFF_MIN_LINES, Math.round(formatted.bodies.size * DIFF_MAX_FRACTION))

  const record: ObservationRecord = {
    id: newObservationId(),
    sessionId: options.sessionId,
    createdAt: Date.now(),
    app,
    window: { ...win, title },
    geometry,
    hasScreenshot: Boolean(image),
    url: formatted?.url ?? null,
    elements: formatted?.handles ?? new Map(),
    digest: formatted ? createHash('sha1').update(formatted.lines.join('\n')).digest('hex') : null,
    keys: formatted?.keys,
    bodies: formatted?.bodies,
    diffChain: useDiff ? (base?.diffChain ?? 0) + 1 : 0,
  }
  registry.record(record)

  const lines: string[] = []
  lines.push(`App: ${app.name} (${app.bundleId ?? 'no bundle id'}, pid ${app.pid})${app.active ? '' : ' — in the background'}`)
  lines.push(
    `Window ${win.id}: ${title ? `"${title}"` : '(untitled)'} — ${Math.round(win.frame[2])}×${Math.round(win.frame[3])} ${driver.platform === 'win32' ? 'px' : 'pt'} at (${Math.round(win.frame[0])}, ${Math.round(win.frame[1])})`,
  )
  lines.push(
    image
      ? `Observation ${record.id} — screenshot ${geometry.width}×${geometry.height} px. x/y in cu_computer are pixels of THIS screenshot; element frames below (@x,y wxh) use the same space.`
      : `Observation ${record.id} — no screenshot${imageNote ? ` (${imageNote})` : ''}. x/y in cu_computer and the frames below (@x,y wxh) still use this window's screenshot space (${geometry.width}×${geometry.height} px) — the same numbers as an observation with the image.`,
  )
  if (record.url) lines.push(`URL: ${record.url}`)
  if (formatted && tree && useDiff && diff && base) {
    const focused = formatted.focusedIndex
    if (focused !== null) lines.push(`Focused: element ${focused}`)
    const unchanged = formatted.bodies.size - diff.added.length - diff.changed.length
    if (diffSize === 0) {
      lines.push(`Tree: no change since ${base.id} — every element keeps its index.`)
    } else {
      lines.push(
        `Tree: changes since ${base.id} (${unchanged} other elements unchanged, same indices; "+" new, "~" changed). Call cu_observe for the whole tree.`,
      )
      lines.push(SCREEN_CONTENT_OPEN)
      const shown = new Set([...diff.added, ...diff.changed])
      const added = new Set(diff.added)
      formatted.indices.forEach((index) => {
        if (shown.has(index)) lines.push(`${added.has(index) ? '+' : '~'} ${index} ${formatted.bodies.get(index)}`)
      })
      if (diff.removed.length) lines.push(`- gone: ${diff.removed.join(', ')}`)
      lines.push(SCREEN_CONTENT_CLOSE)
    }
  } else if (formatted && tree) {
    const focused = formatted.focusedIndex
    if (focused !== null) lines.push(`Focused: element ${focused}`)
    const notes: string[] = []
    if (tree.truncated === 'maxNodes') notes.push(`truncated at ${options.maxNodes} nodes, ${tree.omitted} not shown — use cu_query to search the rest`)
    else if (tree.truncated === 'deadline') notes.push(`stopped by the time budget, ${tree.omitted} not shown — use cu_query or a smaller max_nodes`)
    else if (tree.truncated === 'axTimeout') notes.push(`${tree.timeouts} elements did not answer (app busy) — the tree is partial`)
    lines.push(`Tree (${formatted.handles.size} elements${notes.length ? `; ${notes.join('; ')}` : ''}):`)
    lines.push(SCREEN_CONTENT_OPEN)
    lines.push(...formatted.lines)
    lines.push(SCREEN_CONTENT_CLOSE)
    if (formatted.handles.size <= 2 && !options.enhance) {
      lines.push('The accessibility tree is almost empty. For browsers and Electron apps, observe again with enhance_accessibility: true; otherwise rely on the screenshot and x/y.')
    }
  } else if (options.includeTree === false) {
    lines.push('Tree not requested — act by x/y on the screenshot, or observe with include_tree to get element indices.')
  }
  return { record, text: lines.join('\n'), image: image ? { data: image.data, mediaType: 'image/webp' } : null, imageNote, tree }
}

/** Target by description instead of index: line text (title, value, description) and/or role. */
export interface ElementQuery {
  text?: string
  role?: string
}

const roleWord = (role: string) => role.toLowerCase().replace(/^ax/, '').replace(/\s+/g, '')

/** The part of the line that describes the element — without actions or position, where "press" or "12" would match everything. */
const searchable = (body: string) => body.replace(/ (actions: |@\d+,\d+ |offscreen\b).*$/, '').toLowerCase()

/** Does any element of the observation show this text? (the `expect` of the actions) */
export function treeMentions(record: ObservationRecord, text: string): boolean {
  const needle = text.toLowerCase()
  if (record.window.title?.toLowerCase().includes(needle)) return true
  for (const body of record.bodies?.values() ?? []) if (searchable(body).includes(needle)) return true
  return false
}

/**
 * Resolves a described target against an observation. Ambiguous is an error with the
 * candidates — never the first in the list, which is how a click ends up on the wrong
 * button. With several candidates, the title exactly equal to the text wins.
 */
export function findElement(record: ObservationRecord, target: ElementQuery): number {
  if (!target.text && !target.role) throw new ComputerError('badRequest', 'find needs "text" and/or "role".')
  if (!record.bodies) throw new ComputerError('staleIndex', 'The latest observation of this app has no tree — call cu_observe first.')
  const needle = target.text?.toLowerCase() ?? null
  const role = target.role ? roleWord(target.role) : null
  const hits = [...record.bodies].filter(([index, body]) => {
    const handle = record.elements.get(index)
    if (!handle) return false
    if (role && !roleWord(handle.role).includes(role)) return false
    return !needle || searchable(body).includes(needle)
  })
  const what = [target.role, target.text && `"${target.text}"`].filter(Boolean).join(' ')
  if (hits.length === 0) {
    throw new ComputerError('staleIndex', `No element matches ${what} in observation ${record.id}. Call cu_query or cu_observe to see what is there.`)
  }
  if (hits.length > 1 && needle) {
    const exact = hits.filter(([index]) => record.elements.get(index)?.title?.toLowerCase() === needle)
    if (exact.length === 1) return exact[0][0]
  }
  if (hits.length > 1) {
    const list = hits.slice(0, 6).map(([index, body]) => `${index} ${body}`)
    throw new ComputerError(
      'ambiguous',
      `${hits.length} elements match ${what} — be more specific (add role, or more of the text) or use the index:\n${list.join('\n')}`,
    )
  }
  return hits[0][0]
}

export interface QueryOptions {
  sessionId: string
  app: string
  windowId?: number
  text?: string
  role?: string
  maxNodes: number
  limit: number
  enhance: boolean
  enhanceWaitMs?: number
  maxScreenshotEdge: number
  scaleFor?: (frame: Frame) => number
  signal?: AbortSignal
}

/**
 * Search in the tree without a screenshot — the cheap path when the app is big. It
 * reads with a bigger budget and returns only the lines that match, with indices
 * valid for cu_computer: it becomes the most recent observation of the app. If the
 * window has not changed since the last screenshot, it keeps its coordinate space.
 */
export async function query(driver: ComputerDriver, registry: Registry, options: QueryOptions): Promise<string> {
  if (!options.text && !options.role) throw new ComputerError('badRequest', 'cu_query needs "text" and/or "role".')
  const snapshot = await driver.apps(options.signal)
  const app = resolveApp(snapshot, options.app)
  assertTargetAllowed(app)
  const win = resolveWindow(snapshot, app, options.windowId)
  const tree = await driver.tree(
    {
      pid: app.pid,
      window: { id: win.id, frame: win.frame, title: win.title },
      maxNodes: options.maxNodes,
      deadlineMs: 8000,
      enhance: options.enhance,
      enhanceFull: options.enhance && Boolean(app.bundleId && CHROMIUM_BROWSERS.has(app.bundleId)),
      enhanceWaitMs: options.enhanceWaitMs ?? 0,
    },
    options.signal,
  )
  const previous = registry.peek(options.sessionId, app.pid)
  const sameFrame = previous && previous.window.id === win.id && previous.window.frame.every((v, i) => Math.abs(v - win.frame[i]) < 1)
  const geometry: ShotGeometry = windowSpace(win.frame, options.scaleFor?.(win.frame) ?? 1, options.maxScreenshotEdge)
  const formatted = formatTree(tree, geometry, previous && previous.window.id === win.id ? previous.keys : undefined)
  // It never becomes a diff base (diffChain at the ceiling): the search reads with another
  // budget, and a diff against it would point out as gone everything the next
  // observation does not reach. The lines stay for the search by target.
  const record: ObservationRecord = {
    id: newObservationId(),
    sessionId: options.sessionId,
    createdAt: Date.now(),
    app,
    window: win,
    geometry,
    hasScreenshot: Boolean(previous && sameFrame && previous.hasScreenshot),
    url: formatted.url,
    elements: formatted.handles,
    digest: null,
    keys: formatted.keys,
    bodies: formatted.bodies,
    diffChain: MAX_DIFF_CHAIN,
  }
  registry.record(record)

  const needle = options.text?.toLowerCase() ?? null
  const role = options.role?.toLowerCase().replace(/^ax/, '') ?? null
  const matches: string[] = []
  formatted.lines.forEach((line, i) => {
    const handle = formatted.handles.get(formatted.indices[i])
    if (!handle) return
    const body = line.trimStart()
    if (needle && !body.toLowerCase().includes(needle)) return
    if (role && !handle.role.toLowerCase().replace(/^ax/, '').includes(role.replace(/\s+/g, ''))) return
    matches.push(body)
  })
  const shown = matches.slice(0, options.limit)
  const space = `frames and x/y use this window's screenshot space (${geometry.width}×${geometry.height} px), with or without an image`
  const header = [
    `App: ${app.name} (${app.bundleId ?? 'no bundle id'}, pid ${app.pid}) — window ${win.id}`,
    `Observation ${record.id} (replaces the previous one of this app; ${space}). Searched ${tree.nodes.length} nodes${tree.truncated ? ` (stopped: ${tree.truncated})` : ''}.`,
    shown.length
      ? `${matches.length} match(es)${matches.length > shown.length ? `, showing ${shown.length}` : ''}:`
      : 'No element matches. Try another word, a role (button, text field, link…), or cu_observe to see the screen.',
  ]
  return [...header, ...(shown.length ? [SCREEN_CONTENT_OPEN, ...shown, SCREEN_CONTENT_CLOSE] : [])].join('\n')
}
