import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { useTranslation } from "react-i18next"
import {
  AlertTriangle,
  Code2,
  Hand,
  Layers,
  LayoutGrid,
  Loader2,
  Maximize2,
  Minimize2,
  Minus,
  MousePointer2,
  PanelBottomClose,
  PanelBottomOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RotateCw,
  SlidersHorizontal,
  Square,
  Undo2,
  X,
  ExternalLink,
} from "lucide-react"
import { DESIGN_SCHEME } from "@shared/media"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/hint"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { IconAction } from "@/src/components/ai/artifact-part"
import { DesignCode } from "@/src/components/design/design-code"
import { DesignLayers } from "@/src/components/design/design-layers"
import { DesignPresenter } from "@/src/components/design/design-presenter"
import { planDesignReload } from "@/src/components/design/design-reload"
import { isBoardInView } from "@/src/components/design/design-view"
import { DesignProperties, type DesignBoardView, type DesignPropertiesTarget } from "@/src/components/design/design-properties"
import {
  DESIGN_SOURCE,
  applyWrap,
  boardForHref,
  editHtml,
  isTextPath,
  moveElements,
  parseRuntimeMessage,
  planLayerMove,
  planWrap,
  removeNodes,
  reorderChildren,
  samePath,
  setInlineStyle,
  setTextNode,
  type DesignElementInfo,
  type DesignRect,
  type DesignTreeNode,
  type DropMode,
  type ElementPath,
  type LayerMovePlan,
  type WrapPlan,
} from "@/src/components/design/design-protocol"
import { designApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"
import { cn } from "@/lib/utils"
import { FULLSCREEN_OVERLAY_CLASS } from "@/src/lib/fullscreen-overlay"
import { FloatingSidebar, FullscreenComposer } from "@/src/components/fullscreen-dock"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Design canvas editor in the right panel tab — navigable, selectable
 * and editable, in the mold of Claude's design editor (and Figma's).
 *
 * What is on screen is the HTML of the artboards itself, each one in a sandbox iframe
 * (without allow-same-origin). There is no parallel model: the bridge injected into each
 * artboard (electron/lib/design/design-runtime.ts) reads and touches the live DOM, and
 * every edit made here — property, text, delete, code — is applied to the
 * SOURCE of the file through the same address (child path from the <body>),
 * via DOMParser. The layers are the DOM read on the spot; the code is the file.
 *
 * Navigation: dragging the background (or holding Space / the Hand tool) moves the
 * canvas; the wheel moves, Ctrl+wheel (or pinch) zooms around the cursor —
 * including over an artboard, because the bridge forwards the wheel over here.
 */

interface DesignCanvasFile {
  v: number
  title?: string
  boards: Record<string, { title?: string; x: number; y: number; w: number; h: number }>
  order: string[]
}

type LoadState = { status: "loading" } | { status: "ready"; canvas: DesignCanvasFile } | { status: "error"; message: string }

interface Selection {
  file: string
  /** null = the whole artboard. */
  path: ElementPath | null
}

interface View {
  x: number
  y: number
  zoom: number
}

type Corner = "nw" | "ne" | "sw" | "se"

type Drag =
  | { kind: "pan"; startX: number; startY: number; origin: View; moved: boolean; clearOnClick: boolean }
  | { kind: "move"; file: string; startX: number; startY: number; origin: DesignBoardView; moved: boolean }
  | { kind: "resize-board"; file: string; corner: Corner; startX: number; startY: number; origin: DesignBoardView }
  | { kind: "resize-el"; file: string; path: ElementPath; corner: Corner; startX: number; startY: number; origin: DesignRect }

type InspectorTab = "properties" | "layers" | "code"

const MIN_ZOOM = 0.05
const MAX_ZOOM = 4
const FIT_PADDING = 56
const WIDE_LAYOUT_PX = 720
const UNDO_LIMIT = 50
/** How long the disk change notice is ignored after a write of
 *  OURS that is already applied live — reloading there would only blink the screen. */
const QUIET_MS = 1500
const STYLE_PERSIST_MS = 300
/** Margin (in SCREEN px) around the viewport in which the artboard still mounts:
 *  it is what prevents the iframe from appearing blank when the person pans fast. */
const VIRTUAL_MARGIN = 480

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
/**
 * Boundary between a fine delta (the trackpad pinch, which arrives in small and
 * continuous steps) and the coarse step of a wheel click (~100px at once).
 */
const COARSE_DELTA = 40
/**
 * Zoom gain per pixel of delta. A single gain for both gestures made the pinch
 * crawl on a notebook: the whole pinch adds up to ~200px of delta, against
 * ~100px in a single wheel click. Same split the memory graph uses.
 */
const ZOOM_SPEED_FINE = 0.0075
const ZOOM_SPEED_COARSE = 0.0022

/**
 * Order of two paths: the DOM one comes first. It is what orders the multiple
 * selection (the group comes out in the order in which the elements appear on screen).
 */
const pathOrder = (a: ElementPath, b: ElementPath) => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}
/** Spacing of the background dots, in SCREEN px. It follows the canvas
 *  (20 units × zoom), but with a floor: below it the step doubles (2×, like
 *  Figma's grid) — when zooming out the background scales along instead of turning into dust. */
const GRID_MIN_PX = 8
const gridStep = (zoom: number) => {
  let px = 20 * zoom
  while (px < GRID_MIN_PX) px *= 2
  return px
}
const pathKey = (file: string, path: ElementPath) => `${file}|${path.join(".")}`
const encodeFile = (file: string) => file.split("/").map(encodeURIComponent).join("/")

function DesignEditor({ designId, title, path }: { designId?: string; title: string; path?: string }) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const iframes = useRef(new Map<string, HTMLIFrameElement>())

  const [state, setState] = useState<LoadState>({ status: "loading" })
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const [tool, setTool] = useState<"select" | "hand">("select")
  const [spaceHeld, setSpaceHeld] = useState(false)
  // Artboard in presentation (Play on the canvas): it runs as a page — links and
  // buttons work —, and the others stay editable.
  const [playing, setPlaying] = useState<string | null>(null)
  const playingRef = useRef(playing)
  playingRef.current = playing
  /** Relative links each artboard declares (the bridge warns on load): it is
   *  what decides who gets the Play button. */
  const [links, setLinks] = useState<Record<string, string[]>>({})
  const [reloads, setReloads] = useState(0)
  /** Version of each artboard: when the agent writes a file, only IT remounts
   *  (the global `reloads` is left for the manual reload and for changes that may
   *  affect all the screens — CSS, image, folder font). */
  const [fileVersions, setFileVersions] = useState<Record<string, number>>({})
  const [selection, setSelection] = useState<Selection | null>(null)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const [info, setInfo] = useState<DesignElementInfo | null>(null)
  const [selRect, setSelRect] = useState<DesignRect | null>(null)
  /** Outlines of the OTHER members of the multiple selection (the primary one uses selRect). */
  const [groupRects, setGroupRects] = useState<DesignRect[]>([])
  /** The multiple selection (sibling paths); the primary one is `selection.path`. */
  const [groupPaths, setGroupPaths] = useState<ElementPath[]>([])
  const groupPathsRef = useRef(groupPaths)
  groupPathsRef.current = groupPaths
  const [hover, setHover] = useState<{ file: string; rect: DesignRect } | null>(null)
  const [trees, setTrees] = useState<Record<string, DesignTreeNode | undefined>>({})
  /** Trees already requested and still unanswered (the Layers ask for one per artboard). */
  const treeRequests = useRef<Set<string>>(new Set())
  /** Size of the canvas viewport: it is what decides which artboards mount. */
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 })
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("properties")
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [codeFile, setCodeFile] = useState<string | null>(null)
  const [codeVersion, setCodeVersion] = useState(0)
  const [overrides, setOverrides] = useState<Record<string, Partial<DesignBoardView>>>({})
  const [fullscreen, setFullscreen] = useState(false)
  // Fullscreen: floating sidebars (open by default) and the composer on hover
  const [leftSideOpen, setLeftSideOpen] = useState(true)
  const [rightSideOpen, setRightSideOpen] = useState(true)
  const [composerPinned, setComposerPinned] = useState(false)
  useEffect(() => {
    if (!fullscreen) setComposerPinned(false)
  }, [fullscreen])
  const [wide, setWide] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef(drag)
  dragRef.current = drag
  /** Last size of the element on resize — outside the state, so the re-renders
   *  in the middle of the drag (every step returns `info`) do not lose it. */
  const resizeLast = useRef<{ w: number; h: number } | null>(null)
  const [undoCount, setUndoCount] = useState(0)

  const quietUntil = useRef(0)
  const undoStacks = useRef(new Map<string, string[]>())
  const lastEdited = useRef<string | null>(null)
  const writeChains = useRef(new Map<string, Promise<void>>())
  const pendingStyles = useRef(new Map<string, { file: string; path: ElementPath; styles: Record<string, string>; timer: number }>())
  const autoFit = useRef(true)
  const addQuote = usePanelStore((s) => s.addQuote)

  // ------------------------------------------------------------- canvas.json
  const load = useCallback(() => {
    if (!designId) return
    fetch(`${DESIGN_SCHEME}://${designId}/canvas.json?r=${Date.now()}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<DesignCanvasFile>
      })
      .then((canvas) => {
        setState({ status: "ready", canvas })
        setOverrides({})
      })
      .catch((err: unknown) => setState({ status: "error", message: err instanceof Error ? err.message : String(err) }))
  }, [designId])

  useEffect(() => {
    autoFit.current = true
    setState({ status: "loading" })
    setSelection(null)
    setTrees({})
    treeRequests.current.clear()
    setFileVersions({})
    load()
  }, [load])

  const boards = useMemo<DesignBoardView[]>(() => {
    if (state.status !== "ready") return []
    const { canvas } = state
    return canvas.order
      .filter((file) => canvas.boards[file])
      .map((file) => ({ file, ...canvas.boards[file], ...overrides[file] }))
  }, [state, overrides])
  const boardsRef = useRef(boards)
  boardsRef.current = boards

  /** Are the Layers in view? It is the only thing that needs the DOM tree. */
  const layersVisible = fullscreen ? leftSideOpen : inspectorOpen && inspectorTab === "layers"
  const layersVisibleRef = useRef(layersVisible)
  layersVisibleRef.current = layersVisible

  /**
   * Which artboards have an iframe mounted now. Each one is a whole DOCUMENT with
   * the bridge injected; with ten screens on the canvas, mounting all of them on opening costs
   * a lot and changes nothing for whoever is looking at one. Outside the view the board
   * becomes a rectangle — and the iframe mounts when it enters the screen.
   */
  const mounted = useMemo(() => {
    const files = new Set<string>()
    const { w: vw, h: vh } = viewportSize
    // Before the first measurement there is no way to know what is in view — and until the
    // first `fit` the view is still the origin one: mount everything, otherwise the opening
    // would show empty rectangles for a frame.
    const everything = vw === 0 || vh === 0 || autoFit.current
    for (const board of boards) {
      // Play and selection need the iframe even outside the view; with the Layers
      // open as well — the panel lists the structure of ALL of them and clicking a
      // row has to really select.
      if (everything || layersVisible || board.file === playing || board.file === selection?.file) {
        files.add(board.file)
        continue
      }
      if (isBoardInView(board, view, viewportSize, VIRTUAL_MARGIN)) files.add(board.file)
    }
    return files
  }, [boards, layersVisible, playing, selection?.file, view, viewportSize])

  const bounds = useMemo(() => {
    if (boards.length === 0) return null
    const minX = Math.min(...boards.map((b) => b.x))
    const minY = Math.min(...boards.map((b) => b.y))
    const maxX = Math.max(...boards.map((b) => b.x + b.w))
    const maxY = Math.max(...boards.map((b) => b.y + b.h))
    return { minX, minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
  }, [boards])

  // ------------------------------------------------------------------- view
  const fit = useCallback(() => {
    const el = viewportRef.current
    if (!el || !bounds) return
    const vw = el.clientWidth
    const vh = el.clientHeight
    if (vw <= 0 || vh <= 0) return
    const zoom = clampZoom(Math.min((vw - FIT_PADDING * 2) / bounds.w, (vh - FIT_PADDING * 2) / bounds.h, 1))
    setView({
      zoom,
      x: (vw - bounds.w * zoom) / 2 - bounds.minX * zoom,
      y: (vh - bounds.h * zoom) / 2 - bounds.minY * zoom,
    })
  }, [bounds])

  useEffect(() => {
    if (state.status !== "ready" || !autoFit.current || !bounds) return
    autoFit.current = false
    requestAnimationFrame(fit)
  }, [state, bounds, fit])

  /** Zoom around a point of the viewport (whatever is under the cursor stays put). */
  const zoomAt = useCallback((sx: number, sy: number, next: (z: number) => number) => {
    setView((v) => {
      const zoom = clampZoom(next(v.zoom))
      const cx = (sx - v.x) / v.zoom
      const cy = (sy - v.y) / v.zoom
      return { zoom, x: sx - cx * zoom, y: sy - cy * zoom }
    })
  }, [])

  const zoomCenter = useCallback(
    (next: (z: number) => number) => {
      const el = viewportRef.current
      if (!el) return
      zoomAt(el.clientWidth / 2, el.clientHeight / 2, next)
    },
    [zoomAt],
  )

  const wheel = useCallback(
    (sx: number, sy: number, dx: number, dy: number, ctrl: boolean, shift: boolean, mode: number) => {
      const scale = mode === 1 ? 16 : mode === 2 ? 400 : 1
      if (ctrl) {
        // The trackpad pinch sends small and continuous deltas; a wheel click
        // arrives as one ~100px jump. `zoomAt` already clamps the result.
        const delta = dy * scale
        const speed = Math.abs(delta) < COARSE_DELTA ? ZOOM_SPEED_FINE : ZOOM_SPEED_COARSE
        zoomAt(sx, sy, (z) => z * Math.exp(-delta * speed))
      } else {
        // Shift inverts the axes: the wheel becomes a horizontal pan (as in
        // browsers and in Figma).
        const hx = shift ? dy : dx
        const hy = shift ? dx : dy
        setView((v) => ({ ...v, x: v.x - hx * scale, y: v.y - hy * scale }))
      }
    },
    [zoomAt],
  )

  // The wheel outside the artboards (on the background). `passive: false` because the zoom needs
  // to cancel the page zoom.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      wheel(e.clientX - rect.left, e.clientY - rect.top, e.deltaX, e.deltaY, e.ctrlKey || e.metaKey, e.shiftKey, e.deltaMode)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [wheel, state.status])

  // Inspector layout: next to the canvas when it fits, below when the panel
  // is narrow (the normal case of the side tab).
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const update = () => setWide(el.clientWidth >= WIDE_LAYOUT_PX)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // The canvas is a transformed layer: to know what is in view one needs
  // the viewport size (the pan and the zoom come from `view`). `useLayoutEffect`
  // because the first measurement has to count already on the first paint — otherwise the
  // opening would mount all the artboards and unmount half of them on the next frame.
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const update = () => setViewportSize({ w: el.clientWidth, h: el.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // ----------------------------------------------------------------- bridge
  const post = useCallback((file: string, message: Record<string, unknown>) => {
    iframes.current.get(file)?.contentWindow?.postMessage({ source: DESIGN_SOURCE, ...message }, "*")
  }, [])

  const select = useCallback(
    (next: Selection | null) => {
      setSelection(next)
      setInfo(null)
      setSelRect(null)
      setGroupRects([])
      setGroupPaths([])
      if (next) {
        post(next.file, { type: "select", path: next.path ?? [] })
        setCodeFile(next.file)
      }
      for (const file of iframes.current.keys()) {
        if (!next || file !== next.file || next.path === null) post(file, { type: "select", path: null })
      }
    },
    [post],
  )

  /**
   * Selection in the LAYERS LIST: the click swaps, Shift+click toggles the
   * element in the group — and only among siblings, as on the canvas (a group is always
   * a set of siblings).
   */
  const selectLayer = useCallback(
    (file: string, path: ElementPath | null, additive: boolean) => {
      let target = path && path.length > 0 ? path : null
      if (!target) {
        select({ file, path: null })
        return
      }
      const current = selectionRef.current
      const primary = current && current.file === file ? current.path : null
      const group = groupPathsRef.current
      // Shift works at the SAME LEVEL as the selection: the target goes up to the
      // depth of the selected one, so the group does not become a mixture of
      // levels (and so as not to suggest deep things from the tree).
      if (additive && primary && target.length > primary.length) target = target.slice(0, primary.length)
      // Loose text enters the selection alone: it does not form a group.
      const groupable = !isTextPath(target)
      const siblings = primary && primary.length === target.length && primary.slice(0, -1).every((n, i) => n === target.slice(0, -1)[i])
      let next: ElementPath[]
      if (additive && primary && siblings && groupable) {
        const inside = group.some((p) => samePath(p, target))
        next = inside ? group.filter((p) => !samePath(p, target)) : group.concat([target])
      } else {
        next = [target]
      }
      next = next.slice().sort(pathOrder)
      const primaryPath = next.some((p) => samePath(p, target)) ? target : next.length ? next[next.length - 1] : null
      setGroupPaths(next)
      setGroupRects([])
      setSelection({ file, path: primaryPath })
      post(file, { type: "select", path: primaryPath ?? [], group: next })
      for (const other of iframes.current.keys()) {
        if (other !== file) post(other, { type: "select", path: null, group: [] })
      }
    },
    [post, select],
  )

  const modeFor = useCallback(
    (file: string) => ({ type: "mode", select: playingRef.current !== file, play: playingRef.current === file }),
    [],
  )

  // Presentation mode: the artboard in Play works as a page (links, buttons)
  // and the selection leaves the scene; the others stay editable.
  useEffect(() => {
    for (const file of iframes.current.keys()) post(file, modeFor(file))
    if (playing) {
      setSelection(null)
      setSelRect(null)
      setGroupRects([])
      setInfo(null)
      setHover(null)
    }
  }, [playing, post, modeFor])

  /** Frames an artboard in the viewport (Play goes "inside" it). */
  const focusBoard = useCallback((file: string) => {
    const b = boardsRef.current.find((item) => item.file === file)
    const el = viewportRef.current
    if (!b || !el) return
    const zoom = clampZoom(Math.min((el.clientWidth - FIT_PADDING * 2) / b.w, (el.clientHeight - FIT_PADDING * 2) / b.h, 1))
    setView({ zoom, x: (el.clientWidth - b.w * zoom) / 2 - b.x * zoom, y: (el.clientHeight - b.h * zoom) / 2 - b.y * zoom })
  }, [])

  const startPlay = useCallback(
    (file: string) => {
      setPlaying(file)
      focusBoard(file)
    },
    [focusBoard],
  )

  /** Does the artboard have somewhere to go? It points (`<a href>`) to another one of the canvas. */
  const canPlay = useCallback(
    (file: string) => {
      const files = boardsRef.current.map((b) => b.file)
      return (links[file] ?? []).some((href) => {
        const target = boardForHref(href, files)
        return target !== null && target !== file
      })
    },
    [links],
  )

  // ---------------------------------------------------------------- editing
  const pushUndo = useCallback((file: string, html: string) => {
    const stack = undoStacks.current.get(file) ?? []
    stack.push(html)
    if (stack.length > UNDO_LIMIT) stack.shift()
    undoStacks.current.set(file, stack)
    lastEdited.current = file
    setUndoCount((n) => n + 1)
  }, [])

  /** Writes to the SAME artboard in a queue: two edits in a row cannot read the
   *  same source and one erase the other. */
  const chain = useCallback((file: string, task: () => Promise<void>) => {
    const previous = writeChains.current.get(file) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(task)
      .catch((err: unknown) => setSaveError(err instanceof Error ? err.message : String(err)))
    writeChains.current.set(file, next)
    return next
  }, [])

  /**
   * Applies the change to the SOURCE of the artboard. `quiet`: the change is already on screen
   * (the bridge applied it live), so the disk notice that comes next
   * reloads nothing; structure changes (delete, undo, code) reload.
   */
  const mutateSourceHtml = useCallback(
    (file: string, mutate: (html: string) => string, quiet: boolean) => {
      if (!designId) return Promise.resolve()
      return chain(file, async () => {
        const before = await designApi.readBoard(designId, file)
        const after = mutate(before)
        if (after === before) return
        pushUndo(file, before)
        if (quiet) quietUntil.current = Date.now() + QUIET_MS
        await designApi.writeBoard(designId, file, after)
        setSaveError(null)
        setCodeVersion((n) => n + 1)
      })
    },
    [chain, designId, pushUndo],
  )

  const mutateSource = useCallback(
    (file: string, path: ElementPath, mutate: (el: Element) => void, quiet: boolean) =>
      mutateSourceHtml(file, (html) => editHtml(html, path, mutate), quiet),
    [mutateSourceHtml],
  )

  /**
   * Drag in the LAYERS LIST: the layer dropped over another becomes a structure
   * change. The plan comes from the SOURCE (which rules the indexes) and goes to the
   * file; the bridge applies the SAME plan to the live DOM, so the canvas does not
   * lag behind until the next reload.
   */
  const moveLayer = useCallback(
    (file: string, fromPath: ElementPath, targetPath: ElementPath, mode: DropMode) => {
      const planRef = { current: null as LayerMovePlan | null }
      void mutateSourceHtml(
        file,
        (html) => {
          const plan = planLayerMove(html, fromPath, targetPath, mode)
          planRef.current = plan
          if (!plan) return html
          if (plan.order) return editHtml(html, plan.parent, (el) => reorderChildren(el, plan.order ?? []))
          return moveElements(html, [fromPath], plan.parent, plan.index)
        },
        true,
      ).then(() => {
        const plan = planRef.current
        if (!plan) return
        if (plan.order) post(file, { type: "reorder", parent: plan.parent, order: plan.order })
        else post(file, { type: "move", path: fromPath, parent: plan.parent, index: plan.index })
      })
    },
    [mutateSourceHtml, post],
  )

  const flushStyles = useCallback(
    (key: string) => {
      const entry = pendingStyles.current.get(key)
      if (!entry) return
      window.clearTimeout(entry.timer)
      pendingStyles.current.delete(key)
      void mutateSource(
        entry.file,
        entry.path,
        (el) => {
          // Removals before the definitions (the same reason as the live drag:
          // the shorthand expands into the longhands).
          const entries = Object.entries(entry.styles).sort(([, a], [, b]) => (a === "" ? -1 : b === "" ? 1 : 0))
          for (const [prop, value] of entries) setInlineStyle(el, prop, value)
        },
        true,
      )
    },
    [mutateSource],
  )

  /**
   * The paths of ALL the selected ones (the primary one and the rest of the group) —
   * it is on them that a property change applies: touching one is touching
   * all. Loose text has no style: what it inherits is the parent's, and it is on the parent
   * that the change acts.
   */
  const styleTargets = useCallback((): ElementPath[] => {
    const sel = selectionRef.current
    if (!sel?.path) return []
    const group = groupPathsRef.current.filter((p) => p.length > 0)
    const all = group.length ? group.slice() : []
    // The primary one always enters: it is the one that is selected.
    if (!all.some((p) => samePath(p, sel.path!))) all.push(sel.path!)
    const out: ElementPath[] = []
    for (const path of all) {
      const target = isTextPath(path) ? path.slice(0, -1) : path
      if (!out.some((p) => samePath(p, target))) out.push(target)
    }
    return out
  }, [])

  const applyStyles = useCallback(
    (file: string, path: ElementPath, styles: Record<string, string>, persistNow = false) => {
      // The REMOVALS go before the definitions: in the CSSOM the shorthand expands
      // into the longhands, so deleting "padding-top" after setting "padding"
      // would undo the value itself (the field went back to the previous one).
      const entries = Object.entries(styles).sort(([, a], [, b]) => (a === "" ? -1 : b === "" ? 1 : 0))
      for (const [prop, value] of entries) post(file, { type: "style", path, prop, value })
      const key = pathKey(file, path)
      const current = pendingStyles.current.get(key)
      if (current) window.clearTimeout(current.timer)
      const entry = { file, path, styles: { ...(current?.styles ?? {}), ...styles }, timer: 0 }
      pendingStyles.current.set(key, entry)
      if (persistNow) flushStyles(key)
      else entry.timer = window.setTimeout(() => flushStyles(key), STYLE_PERSIST_MS)
    },
    [flushStyles, post],
  )

  const updateBoard = useCallback(
    (file: string, patch: Partial<Pick<DesignBoardView, "title" | "x" | "y" | "w" | "h">>) => {
      if (!designId) return
      setOverrides((prev) => ({ ...prev, [file]: { ...prev[file], ...patch } }))
      quietUntil.current = Date.now() + QUIET_MS
      designApi
        .updateBoard(designId, file, patch)
        .then(() => {
          setSaveError(null)
          setState((prev) => {
            if (prev.status !== "ready") return prev
            const board = prev.canvas.boards[file]
            if (!board) return prev
            const merged = { ...board, ...patch, title: patch.title === "" ? undefined : (patch.title ?? board.title) }
            return { status: "ready", canvas: { ...prev.canvas, boards: { ...prev.canvas.boards, [file]: merged } } }
          })
          setOverrides((prev) => {
            const next = { ...prev }
            delete next[file]
            return next
          })
        })
        .catch((err: unknown) => setSaveError(err instanceof Error ? err.message : String(err)))
    },
    [designId],
  )

  const deleteSelected = useCallback(() => {
    const sel = selectionRef.current
    if (!sel || !sel.path || sel.path.length === 0) return
    const { file, path: target } = sel
    // With a group, it deletes the whole group (the multiple selection is a single thing).
    const group = groupPathsRef.current.filter((p) => p.length > 0)
    const paths = group.length > 1 ? group : [target]
    select(null)
    void mutateSourceHtml(file, (html) => removeNodes(html, paths), true).then(() => {
      post(file, { type: "remove", paths })
    })
  }, [mutateSourceHtml, post, select])

  const undo = useCallback(() => {
    if (!designId) return
    const file = selectionRef.current?.file && undoStacks.current.get(selectionRef.current.file)?.length
      ? selectionRef.current.file
      : lastEdited.current
    if (!file) return
    const stack = undoStacks.current.get(file)
    const previous = stack?.pop()
    if (previous === undefined) return
    setUndoCount((n) => n + 1)
    void chain(file, async () => {
      await designApi.writeBoard(designId, file, previous)
      setCodeVersion((n) => n + 1)
    })
  }, [chain, designId])

  const saveCode = useCallback(
    async (file: string, html: string) => {
      if (!designId) return
      const before = await designApi.readBoard(designId, file)
      if (before === html) return
      pushUndo(file, before)
      await designApi.writeBoard(designId, file, html)
    },
    [designId, pushUndo],
  )

  const comment = useCallback(() => {
    const sel = selectionRef.current
    if (!sel) return
    const board = boardsRef.current.find((b) => b.file === sel.file)
    addQuote({
      kind: "design",
      name: title,
      ...(path ? { path } : {}),
      file: sel.file,
      ...(board?.title ? { boardTitle: board.title } : {}),
      ...(sel.path && sel.path.length > 0 && info
        ? {
            elementPath: sel.path,
            tag: info.tag,
            ...(info.label ? { label: info.label } : {}),
            ...(info.text ? { text: info.text.slice(0, 400) } : {}),
            html: info.html,
          }
        : {}),
    })
  }, [addQuote, info, path, title])

  // --------------------------------------------- messages from the bridge
  const blurInspector = useCallback(() => {
    const active = document.activeElement as HTMLElement | null
    if (active && active !== document.body && rootRef.current?.contains(active) && !active.closest(".cm-editor")) active.blur()
  }, [])

  const fileOf = useCallback((source: MessageEventSource | null) => {
    for (const [file, frame] of iframes.current) if (frame.contentWindow && frame.contentWindow === source) return file
    return null
  }, [])

  /**
   * "Wrap" the selection: the elements become children of a new div, which enters
   * in the place of the first of them. `flex` becomes a row or a column (according
   * to where they are); `block` becomes a block div.
   */
  const wrapSelected = useCallback(
    (mode: "flex" | "block") => {
      const sel = selectionRef.current
      if (!sel?.path) return
      const group = groupPathsRef.current.filter((p) => p.length > 0)
      const paths = group.length > 1 ? group.slice() : []
      // The primary one always enters (it is the one that is selected).
      if (paths.length && !paths.some((p) => samePath(p, sel.path!))) paths.push(sel.path!)
      if (paths.length < 2) return
      // The flex direction: side by side (centers spread horizontally) is
      // a row; stacked (spread vertically) is a column.
      const rects = [selRect, ...groupRects].filter((r): r is DesignRect => Boolean(r))
      let direction = "row"
      if (rects.length >= 2) {
        const centersX = rects.map((r) => r.x + r.w / 2)
        const centersY = rects.map((r) => r.y + r.h / 2)
        const spreadX = Math.max(...centersX) - Math.min(...centersX)
        const spreadY = Math.max(...centersY) - Math.min(...centersY)
        direction = spreadX >= spreadY ? "row" : "column"
      }
      const style = mode === "block" ? "display: block" : `display: flex; flex-direction: ${direction}`
      const planRef = { current: null as WrapPlan | null }
      void mutateSourceHtml(
        sel.file,
        (html) => {
          const plan = planWrap(html, paths)
          planRef.current = plan
          if (!plan) return html
          return applyWrap(html, plan, style)
        },
        true,
      ).then(() => {
        const plan = planRef.current
        if (!plan) return
        // The bridge applies the SAME plan to the live DOM: the canvas changes on the spot.
        post(sel.file, { type: "wrap", parent: plan.parent, index: plan.index, children: plan.children, style })
      })
    },
    [groupRects, mutateSourceHtml, post, selRect],
  )

  const handleKey = useCallback(
    (key: { key: string; code: string; ctrl: boolean; meta: boolean; shift: boolean; phase: "down" | "up" }): boolean => {
      if (key.key === " ") {
        setSpaceHeld(key.phase === "down")
        return true
      }
      if (key.phase === "up") return false
      const mod = key.ctrl || key.meta
      const lower = key.key.toLowerCase()
      if (mod && lower === "z") {
        undo()
        return true
      }
      if (mod && (key.key === "=" || key.key === "+")) {
        zoomCenter((z) => z * 1.25)
        return true
      }
      if (mod && key.key === "-") {
        zoomCenter((z) => z / 1.25)
        return true
      }
      if (mod && key.key === "0") {
        zoomCenter(() => 1)
        return true
      }
      if (mod && lower === "g") {
        // Group: the selected ones become children of a block div.
        wrapSelected("block")
        return true
      }
      if (mod) return false
      if (key.shift && lower === "a") {
        // Align: the selected ones become children of a flex div (row or
        // column, according to where they are).
        wrapSelected("flex")
        return true
      }
      if (key.shift && key.code === "Digit1") {
        fit()
        return true
      }
      if (lower === "v") {
        setTool("select")
        setPlaying(null)
        return true
      }
      if (lower === "h") {
        setTool("hand")
        return true
      }
      if (key.key === "Escape") {
        if (playingRef.current) {
          setPlaying(null)
          return true
        }
        const sel = selectionRef.current
        if (sel?.path && sel.path.length > 0) select({ file: sel.file, path: sel.path.length > 1 ? sel.path.slice(0, -1) : null })
        else if (sel) select(null)
        return true
      }
      if (key.key === "Delete" || key.key === "Backspace") {
        deleteSelected()
        return true
      }
      return false
    },
    [deleteSelected, fit, select, undo, wrapSelected, zoomCenter],
  )

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const file = fileOf(event.source)
      if (!file) return
      const msg = parseRuntimeMessage(event.data)
      if (!msg) return
      const sel = selectionRef.current
      switch (msg.type) {
        case "ready": {
          // New document (first load or reload): the tree that was
          // kept belongs to the previous HTML. If the Layers are in view it is requested
          // right away; otherwise, only when the panel opens (effect right below).
          treeRequests.current.delete(file)
          setTrees((prev) => {
            const next = msg.tree ?? undefined
            return prev[file] === next ? prev : { ...prev, [file]: next }
          })
          setLinks((prev) => ({ ...prev, [file]: msg.links }))
          if (!msg.tree && layersVisibleRef.current) {
            treeRequests.current.add(file)
            post(file, { type: "tree" })
          }
          setGroupRects([])
          post(file, modeFor(file))
          // Reload (the agent edited, undo, code): the selection comes back at the SAME
          // address, if it still exists — and with the group, if there is one.
          if (sel?.file === file && sel.path && sel.path.length > 0) {
            const group = groupPathsRef.current.filter((p) => p.length > 0)
            post(file, { type: "select", path: sel.path, group: group.length ? group : [sel.path] })
          }
          break
        }
        case "tree":
          setTrees((prev) => ({ ...prev, [file]: msg.tree }))
          break
        case "navigate": {
          // Link clicked in the artboard in Play: the presentation goes on to the screen
          // it points to (if it is one of the canvas).
          if (playingRef.current !== file) break
          const target = boardForHref(msg.href, boardsRef.current.map((b) => b.file))
          if (target) startPlay(target)
          break
        }
        case "hover":
          setHover((prev) => (msg.rect && msg.path ? { file, rect: msg.rect } : prev?.file === file ? null : prev))
          break
        case "select":
          // The click on the artboard does not take the focus from the panel (the bridge cancels the
          // mousedown): an inspector field in the middle of an edit would stay focused and
          // the edit would be lost with the selection switch. The blur confirms the field
          // NOW, still against the previous selection.
          blurInspector()
          // The runtime soon sends a `rects` with the outlines of the other members.
          setGroupRects([])
          if (msg.path && msg.path.length > 0) {
            setSelection({ file, path: msg.path })
            setInfo(msg.info)
            setSelRect(msg.info?.rect ?? null)
            // The group comes back in DOM order (it is the order of the elements on screen).
            setGroupPaths(msg.group.length ? msg.group.slice().sort(pathOrder) : [msg.path])
          } else {
            setSelection({ file, path: null })
            setInfo(null)
            setSelRect(null)
            setGroupPaths([])
          }
          setCodeFile(file)
          for (const other of iframes.current.keys()) if (other !== file) post(other, { type: "select", path: null })
          break
        case "info":
          if (sel?.file === file && samePath(sel.path, msg.path)) {
            setInfo(msg.info)
            setSelRect(msg.info?.rect ?? null)
          }
          break
        case "rects":
          if (sel?.file === file && sel.path) {
            setSelRect(msg.selected)
            setGroupRects(msg.selected ? msg.group : [])
          }
          setHover((prev) => (msg.hover ? { file, rect: msg.hover } : prev?.file === file ? null : prev))
          break
        case "wheel": {
          const frame = iframes.current.get(file)
          const viewport = viewportRef.current
          if (!frame || !viewport) break
          const fr = frame.getBoundingClientRect()
          const vr = viewport.getBoundingClientRect()
          const zoom = viewRef.current.zoom
          wheel(fr.left + msg.x * zoom - vr.left, fr.top + msg.y * zoom - vr.top, msg.dx, msg.dy, msg.ctrl, msg.shift, msg.mode)
          break
        }
        case "key":
          handleKey(msg)
          break
        case "focus": {
          // Fallback: usually the native mousedown of the double click has already given
          // focus to the iframe. We only intervene if it is still in the panel —
          // focusing again would restart the selection/cursor the native one placed.
          const frame = iframes.current.get(file)
          if (frame && document.activeElement !== frame) frame.focus()
          break
        }
        case "textEdited":
          void mutateSource(
            file,
            msg.path,
            (el) => {
              el.innerHTML = msg.html
            },
            true,
          )
          break
        case "reorder":
          // The drag already happened on screen (the bridge reordered the live DOM);
          // here only the source starts telling the same story. The Layers list
          // came from the old tree, so it asks for a new one.
          void mutateSource(file, msg.parent, (el) => reorderChildren(el, msg.order), true).then(() => {
            post(file, { type: "tree" })
          })
          break
        case "move":
          // Same idea as the reorder, but swapping parents: the bridge has already moved the
          // element (or the block of the multiple selection) live; the source receives
          // the same move.
          void mutateSourceHtml(file, (html) => moveElements(html, msg.paths, msg.parent, msg.index), true).then(() => {
            post(file, { type: "tree" })
          })
          break
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [blurInspector, fileOf, handleKey, mutateSource, mutateSourceHtml, modeFor, post, startPlay, wheel])

  // The DOM tree only serves the Layers — it is requested the moment the panel
  // comes into view (and again on every reload, in `ready`). With the panel closed
  // no artboard pays for mounting it.
  useEffect(() => {
    const files = [...iframes.current.keys()]
    if (!layersVisible) {
      // Panel closed: the bridge stops mounting trees nobody is going to see.
      treeRequests.current.clear()
      for (const file of files) post(file, { type: "tree", want: false })
      return
    }
    for (const file of files) {
      if (treeRequests.current.has(file)) continue
      treeRequests.current.add(file)
      post(file, { type: "tree" })
    }
  }, [layersVisible, post])

  // Any click OUTSIDE the artboards ends the text edit in progress
  // (iframe events do not reach here, so a pointerdown in the panel means
  // that the click was outside). The `blur` of the artboard window also covers that, but
  // clicking a non-focusable element of the panel may not take the focus from the iframe.
  useEffect(() => {
    const onPointerDown = () => {
      for (const file of iframes.current.keys()) post(file, { type: "blur" })
    }
    window.addEventListener("pointerdown", onPointerDown, true)
    return () => window.removeEventListener("pointerdown", onPointerDown, true)
  }, [post])

  // Shortcuts with the focus OUTSIDE the artboards (inside, the bridge forwards them).
  useEffect(() => {
    const visible = () => Boolean(rootRef.current && rootRef.current.getClientRects().length > 0)
    const typing = (target: EventTarget | null) => {
      const el = target as HTMLElement | null
      return Boolean(el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName) || el.closest?.(".cm-editor")))
    }
    const onKey = (phase: "down" | "up") => (e: KeyboardEvent) => {
      if (!visible() || typing(e.target)) return
      if (phase === "down" && e.key === "Escape" && fullscreen && !selectionRef.current) {
        setFullscreen(false)
        return
      }
      const handled = handleKey({ key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, phase })
      if (handled) e.preventDefault()
    }
    const down = onKey("down")
    const up = onKey("up")
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    return () => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
    }
  }, [fullscreen, handleKey])

  // The agent (or another window) changed the folder: it reloads the index and ONLY the
  // artboards that changed — except when the change is ours and is already on screen.
  // The watcher sends the names (see design-store.ts); before, any write
  // remounted all the iframes, and generating 4 screens remounted the canvas 4 times.
  useEffect(() => {
    if (!designId) return
    return designApi.onChanged((payload) => {
      if (payload.id !== designId) return
      setCodeVersion((n) => n + 1)
      if (Date.now() < quietUntil.current) return
      const plan = planDesignReload(payload.files)
      if (plan.index) load()
      if (plan.boards.length > 0) {
        setFileVersions((prev) => {
          const next = { ...prev }
          for (const file of plan.boards) next[file] = (next[file] ?? 0) + 1
          return next
        })
      }
      // CSS, image or folder font (or an event with no name): all of them reload.
      if (plan.all) setReloads((n) => n + 1)
    })
  }, [designId, load])

  // ------------------------------------------------------------------ drags
  const toCanvas = useCallback((dx: number, dy: number) => ({ dx: dx / viewRef.current.zoom, dy: dy / viewRef.current.zoom }), [])

  // The drag listeners are attached ON pointerdown (see beginDrag), not in an
  // effect: a fast drag sends the first pointermove before the effect
  // runs, and they were lost. The handlers read the state through the refs.
  const markMoved = (current: Drag) => {
    if ((current.kind === "pan" || current.kind === "move") && !current.moved) {
      const next = { ...current, moved: true }
      dragRef.current = next
      setDrag(next)
    }
  }

  const onDragMove = useRef<(e: PointerEvent) => void>(() => {})
  const onDragEnd = useRef<() => void>(() => {})

  onDragMove.current = (e: PointerEvent) => {
    const current = dragRef.current
    if (!current) return
    const sx = e.clientX - current.startX
    const sy = e.clientY - current.startY
    if (current.kind === "pan") {
      if (Math.abs(sx) + Math.abs(sy) > 3) markMoved(current)
      setView({ ...current.origin, x: current.origin.x + sx, y: current.origin.y + sy })
    } else if (current.kind === "move") {
      const { dx, dy } = toCanvas(sx, sy)
      if (Math.abs(sx) + Math.abs(sy) > 3) markMoved(current)
      setOverrides((prev) => ({
        ...prev,
        [current.file]: { ...prev[current.file], x: Math.round(current.origin.x + dx), y: Math.round(current.origin.y + dy) },
      }))
    } else if (current.kind === "resize-board") {
      const { dx, dy } = toCanvas(sx, sy)
      const o = current.origin
      const west = current.corner.includes("w")
      const north = current.corner.includes("n")
      const w = Math.max(40, Math.round(west ? o.w - dx : o.w + dx))
      const h = Math.max(40, Math.round(north ? o.h - dy : o.h + dy))
      setOverrides((prev) => ({
        ...prev,
        [current.file]: { ...prev[current.file], w, h, x: west ? o.x + o.w - w : o.x, y: north ? o.y + o.h - h : o.y },
      }))
    } else {
      const { dx, dy } = toCanvas(sx, sy)
      const o = current.origin
      const w = Math.max(1, Math.round(current.corner.includes("w") ? o.w - dx : o.w + dx))
      const h = Math.max(1, Math.round(current.corner.includes("n") ? o.h - dy : o.h + dy))
      post(current.file, { type: "style", path: current.path, prop: "width", value: `${w}px` })
      post(current.file, { type: "style", path: current.path, prop: "height", value: `${h}px` })
      resizeLast.current = { w, h }
    }
  }

  onDragEnd.current = () => {
    const current = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (!current) return
    if (current.kind === "pan") {
      if (!current.moved && current.clearOnClick) select(null)
    } else if (current.kind === "move") {
      const board = boardsRef.current.find((b) => b.file === current.file)
      if (current.moved && board) updateBoard(current.file, { x: board.x, y: board.y })
    } else if (current.kind === "resize-board") {
      const board = boardsRef.current.find((b) => b.file === current.file)
      if (board) updateBoard(current.file, { x: board.x, y: board.y, w: board.w, h: board.h })
    } else if (resizeLast.current) {
      const last = resizeLast.current
      resizeLast.current = null
      applyStyles(current.file, current.path, { width: `${last.w}px`, height: `${last.h}px` }, true)
    }
  }

  const beginDrag = useCallback((next: Drag) => {
    dragRef.current = next
    setDrag(next)
    const move = (e: PointerEvent) => onDragMove.current(e)
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
      onDragEnd.current()
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
  }, [])

  const startPan = (e: ReactPointerEvent, clearOnClick: boolean) => {
    if (e.button !== 0 && e.button !== 1) return
    e.preventDefault()
    blurInspector()
    beginDrag({ kind: "pan", startX: e.clientX, startY: e.clientY, origin: viewRef.current, moved: false, clearOnClick })
  }

  const panning = tool === "hand" || spaceHeld
  const dragging = drag !== null

  // ----------------------------------------------------------------- render
  if (!designId) {
    return <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">{t("design.unavailable")}</div>
  }

  const selectedBoard = selection ? (boards.find((b) => b.file === selection.file) ?? null) : null
  const target: DesignPropertiesTarget =
    selection && selectedBoard
      ? selection.path && info
        ? {
            kind: "element",
            board: selectedBoard,
            info,
            depth: selection.path.length,
            key: `${selection.file}|${selection.path.join(".")}`,
            // How many elements are selected (the panel edits all of them).
            count: Math.max(1, groupPaths.length),
          }
        : { kind: "board", board: selectedBoard }
      : { kind: "none", canvasTitle: state.status === "ready" ? (state.canvas.title ?? title) : title, boards: boards.length }
  const zoom = view.zoom
  const grid = gridStep(zoom)
  const handle = 8 / zoom
  const line = 1.5 / zoom
  const canUndo = undoCount >= 0 && Array.from(undoStacks.current.values()).some((s) => s.length > 0)

  const corners: Corner[] = ["nw", "ne", "sw", "se"]
  const cornerStyle = (corner: Corner, w: number, h: number) => ({
    width: handle,
    height: handle,
    left: (corner.includes("w") ? 0 : w) - handle / 2,
    top: (corner.includes("n") ? 0 : h) - handle / 2,
    borderWidth: line,
    cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
  })

  const inspectorTabMeta = {
    properties: [SlidersHorizontal, t("design.inspector.properties")],
    layers: [Layers, t("design.inspector.layers")],
    code: [Code2, t("design.inspector.code")],
  } as const
  /** The inspector tab strip: `tabs` decides which ones appear (in fullscreen
   *  the layers have their own sidebar, so the right one only has the other two). */
  const renderTabStrip = (tabs: readonly InspectorTab[], active: InspectorTab) => (
    <div className="flex shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5 py-1">
      {tabs.map((value) => {
        const [Icon, label] = inspectorTabMeta[value]
        return (
          <button
            key={value}
            type="button"
            onClick={() => setInspectorTab(value)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors",
              active === value ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <Icon className="size-3" />
            {label}
          </button>
        )
      })}
    </div>
  )
  /** The file the code tab shows (the chosen one, or the first). */
  const codeShownFile = codeFile && boards.some((b) => b.file === codeFile) ? codeFile : (boards[0]?.file ?? null)
  /** The canvas selection only highlights the code when it is from the SAME file. */
  const codeSelectionPath = selection && selection.file === codeShownFile ? selection.path : null
  /** The content of an inspector tab — the same in the side panel and in the
   *  floating sidebars of fullscreen. */
  const renderInspectorBody = (tab: InspectorTab) => (
      <>
        {tab === "properties" && (
          <DesignProperties
            target={target}
            onStyles={(styles) => {
              if (!selection?.path) return
              // It applies to ALL the selected ones: it is what makes the group
              // edit count.
              for (const path of styleTargets()) applyStyles(selection.file, path, styles)
            }}
            onAttr={(name, value) => {
              if (!selection?.path) return
              for (const path of styleTargets()) {
                post(selection.file, { type: "attr", path, name, value })
                void mutateSource(
                  selection.file,
                  path,
                  (el) => (value ? el.setAttribute(name, value) : el.removeAttribute(name)),
                  true,
                )
              }
            }}
            onText={(value) => {
              if (!selection?.path) return
              // Loose text: changes the CONTENT of the node. Element: the HTML inside.
              const paths = groupPathsRef.current.filter((p) => p.length > 0)
              const all = paths.length ? paths : [selection.path]
              for (const path of all) {
                if (isTextPath(path)) {
                  post(selection.file, { type: "text", path, value })
                  void mutateSourceHtml(selection.file, (html) => setTextNode(html, path, value), true)
                  continue
                }
                post(selection.file, { type: "text", path, value })
                void mutateSource(
                  selection.file,
                  path,
                  (el) => {
                    el.textContent = value
                  },
                  true,
                )
              }
            }}
            onBoard={(patch) => selection && updateBoard(selection.file, patch)}
            onSelectParent={() =>
              selection?.path && select({ file: selection.file, path: selection.path.length > 1 ? selection.path.slice(0, -1) : null })
            }
            onComment={comment}
            onDelete={deleteSelected}
          />
        )}
        {tab === "layers" && (
          <DesignLayers
            boards={boards}
            trees={trees}
            selection={selection}
            group={groupPaths}
            onSelect={selectLayer}
            onMove={moveLayer}
            onHover={(file, p) => {
              if (!file) {
                for (const each of iframes.current.keys()) post(each, { type: "hover", path: null })
                setHover(null)
              } else if (p && p.length > 0) {
                post(file, { type: "hover", path: p })
              } else {
                // The ARTBOARD row: the outline is the whole frame.
                post(file, { type: "hover", path: null })
                const board = boardsRef.current.find((b) => b.file === file)
                setHover(board ? { file, rect: { x: 0, y: 0, w: board.w, h: board.h } } : null)
              }
            }}
          />
        )}
        {tab === "code" && (
          <DesignCode
            designId={designId}
            boards={boards}
            file={codeShownFile}
            selectionPath={codeSelectionPath}
            version={codeVersion}
            onFileChange={setCodeFile}
            onSave={saveCode}
          />
        )}
      </>
  )

  const inspector = (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-sidebar",
        wide ? "w-72 shrink-0 border-l border-border/60" : "h-[45%] min-h-48 shrink-0 border-t border-border/60",
      )}
    >
      {renderTabStrip(["properties", "layers", "code"], inspectorTab)}
      <div className={cn("min-h-0 flex-1", inspectorTab === "code" ? "overflow-hidden" : "overflow-y-auto")}>
        {renderInspectorBody(inspectorTab)}
      </div>
    </div>
  )

  // Fullscreen: layers on the left; properties and code (tabs) on the right.
  // If the active tab was "layers", the right one falls back to "properties".
  const rightTab: InspectorTab = inspectorTab === "layers" ? "properties" : inspectorTab

  // The inspector is a column on the right when the tab is wide and a strip at the
  // bottom when it is not: the icon follows the place the panel actually takes.
  const InspectorIcon = inspectorOpen ? (wide ? PanelRightClose : PanelBottomClose) : (wide ? PanelRightOpen : PanelBottomOpen)

  return (
    <div
      ref={rootRef}
      className={cn(
        // In fullscreen the SAME node becomes the fixed overlay (like the browser and the
        // motion): the iframe is not remounted and the selection bridge survives.
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sidebar",
        fullscreen && FULLSCREEN_OVERLAY_CLASS,
      )}
    >
      {/* Header: the canvas on the left; tools, zoom and view on the right. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 p-2">
        <div className="flex min-w-0 items-center gap-2">
          <LayoutGrid className="size-3.5 shrink-0 text-muted-foreground" />
          <Truncate text={title}>
            <span className="truncate text-xs font-medium text-muted-foreground">{title}</span>
          </Truncate>
          {wide && boards.length > 0 && (
            <Badge variant="outline" className="shrink-0">
              {t("design.boardsCount", { count: boards.length })}
            </Badge>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Hint label={t("design.tools.select")}>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(tool === "select" && "bg-primary/15 text-primary hover:bg-primary/20")}
              aria-pressed={tool === "select"}

              aria-label={t("design.tools.select")}
              onClick={() => {
                setTool("select")
                setPlaying(null)
              }}
            >
              <MousePointer2 className="size-3.5" />
            </Button>
          </Hint>
          <Hint label={t("design.tools.hand")}>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(tool === "hand" && "bg-primary/15 text-primary hover:bg-primary/20")}
              aria-pressed={tool === "hand"}

              aria-label={t("design.tools.hand")}
              onClick={() => setTool("hand")}
            >
              <Hand className="size-3.5" />
            </Button>
          </Hint>
          <div className="mx-1 h-4 w-px bg-border" />
          {/* In the narrow panel the −/+ goes away: the zoom stays on Ctrl+wheel, on pinch
              and on the shortcuts, and the canvas title needs the room. */}
          {wide && <IconAction icon={Minus} label={t("design.zoomOut")} onClick={() => zoomCenter((z) => z / 1.25)} />}
          <button
            type="button"
            onClick={fit}
            className="w-10 shrink-0 rounded text-center text-[11px] tabular-nums text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          >
            {Math.round(zoom * 100)}%
          </button>
          {wide && <IconAction icon={Plus} label={t("design.zoomIn")} onClick={() => zoomCenter((z) => z * 1.25)} />}
          <div className="mx-1 h-4 w-px bg-border" />
          <Hint label={t("design.undo")}>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!canUndo}

              aria-label={t("design.undo")}
              onClick={undo}
            >
              <Undo2 className="size-3.5" />
            </Button>
          </Hint>
          <IconAction
            icon={RotateCw}
            label={t("design.reload")}
            onClick={() => {
              setReloads((n) => n + 1)
              load()
            }}
          />
          <IconAction
            icon={fullscreen ? Minimize2 : Maximize2}
            label={t(fullscreen ? "design.exitFullscreen" : "design.fullscreen")}
            onClick={() => setFullscreen((v) => !v)}
          />
          {/* In fullscreen the floating buttons of the sidebars are what open/close them */}
          {!fullscreen && (
            <IconAction
              icon={InspectorIcon}
              label={t(inspectorOpen ? "design.hideInspector" : "design.showInspector")}
              active={inspectorOpen}
              onClick={() => setInspectorOpen((v) => !v)}
            />
          )}
        </div>
      </div>

      {state.status === "error" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="break-words">{state.message}</span>
        </div>
      )}
      {saveError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{t("design.saveFailed", { error: saveError })}</span>
          <button type="button" aria-label={t("common.close")} onClick={() => setSaveError(null)}>
            <X className="size-3" />
          </button>
        </div>
      )}

      <div className={cn("relative flex min-h-0 flex-1", wide ? "flex-row" : "flex-col")}>
        {/* Infinite canvas: a transformed layer (translate + scale) with the
            artboards at the coordinates of canvas.json. */}
        <div
          ref={viewportRef}
          className={cn(
            "relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden select-none",
            panning ? (drag?.kind === "pan" ? "cursor-grabbing" : "cursor-grab") : "cursor-default",
          )}
          style={{
            backgroundImage: "radial-gradient(circle, color-mix(in oklab, var(--foreground) 14%, transparent) 1px, transparent 1px)",
            backgroundSize: `${grid}px ${grid}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.canvasLayer !== undefined) startPan(e, !panning)
            else if (e.button === 1) startPan(e, false)
          }}
        >
          {state.status === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("design.loading")}
            </div>
          )}
          {state.status === "ready" && boards.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">{t("design.empty")}</div>
          )}

          <div
            data-canvas-layer=""
            className="absolute top-0 left-0 origin-top-left"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${zoom})` }}
          >
            {boards.map((board) => {
              // Outside the view: only the rectangle (the iframe mounts when the board
              // enters the screen — see `mounted`). `data-canvas-layer` keeps the pan
              // working if the pointer falls here.
              if (!mounted.has(board.file)) {
                return (
                  <div
                    key={board.file}
                    data-canvas-layer=""
                    className="absolute rounded-sm border border-border/50 bg-card/30"
                    style={{ left: board.x, top: board.y, width: board.w, height: board.h }}
                  />
                )
              }
              const isBoardSelected = selection?.file === board.file && selection.path === null
              const isPlaying = playing === board.file
              const elementRect = selection?.file === board.file && selection.path ? selRect : null
              const groupRectList = selection?.file === board.file && selection.path ? groupRects : []
              const hoverRect = hover?.file === board.file && !dragging ? hover.rect : null
              return (
                <div key={board.file} className="absolute" style={{ left: board.x, top: board.y, width: board.w, height: board.h }}>
                  {/* Artboard header: the name on the left (clicking selects the frame,
                      dragging moves it) and, on the right, the presentation actions — only
                      where there is somewhere to navigate. Same scale as the canvas. */}
                  <div
                    className="absolute left-0 flex items-center justify-between"
                    style={{ bottom: "100%", marginBottom: 4 / zoom, width: board.w, gap: 8 / zoom, fontSize: 11 / zoom, lineHeight: 1.3 }}
                  >
                    <Truncate text={board.title ?? board.file}>
                      <div
                        className={cn(
                          "min-w-0 cursor-default truncate font-medium whitespace-nowrap",
                          isBoardSelected || isPlaying ? "text-primary" : "text-muted-foreground hover:text-foreground",
                        )}
                        onPointerDown={(e) => {
                          if (panning || e.button !== 0) return startPan(e, false)
                          e.preventDefault()
                          e.stopPropagation()
                          blurInspector()
                          select({ file: board.file, path: null })
                          beginDrag({ kind: "move", file: board.file, startX: e.clientX, startY: e.clientY, origin: board, moved: false })
                        }}
                      >
                        {board.title ?? board.file}
                      </div>
                    </Truncate>
                    {canPlay(board.file) && (
                      <div className="flex shrink-0 items-center" style={{ gap: 4 / zoom }}>
                        {isPlaying ? (
                          <Hint label={t("design.present.stop")}>
                            <button
                              type="button"
                              aria-label={t("design.present.stop")}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={() => setPlaying(null)}
                              className="flex items-center justify-center rounded-sm bg-primary text-primary-foreground cursor-pointer"
                              style={{ width: 18 / zoom, height: 18 / zoom }}
                            >
                              <Square style={{ width: 9 / zoom, height: 9 / zoom }} fill="currentColor" />
                            </button>
                          </Hint>
                        ) : (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              title={t("design.present.play")}
                              aria-label={t("design.present.play")}
                              onPointerDown={(e) => e.stopPropagation()}
                              className="flex items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                              style={{ width: 18 / zoom, height: 18 / zoom }}
                            >
                              <Play style={{ width: 11 / zoom, height: 11 / zoom }} fill="currentColor" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-52">
                              <DropdownMenuItem onClick={() => startPlay(board.file)}>
                                <Play className="size-3.5" />
                                {t("design.present.playHere")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  designId && usePanelStore.getState().openDesignPlayTab(designId, board.file, fullscreen)
                                }
                              >
                                <ExternalLink className="size-3.5" />
                                {t("design.present.playTab")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    )}
                  </div>
                  <div
                    className="relative overflow-hidden bg-white shadow-sm"
                    style={{
                      width: board.w,
                      height: board.h,
                      outline: isPlaying
                        ? `${2 / zoom}px solid var(--primary)`
                        : `${1 / zoom}px solid color-mix(in oklab, var(--border) 80%, transparent)`,
                    }}
                  >
                    <iframe
                      ref={(el) => {
                        if (el) iframes.current.set(board.file, el)
                        else iframes.current.delete(board.file)
                      }}
                      // The key carries the FILE version: an artboard that has not
                      // changed stays mounted (with its scroll and selection).
                      key={`${board.file}:${reloads}:${fileVersions[board.file] ?? 0}`}
                      // The file version enters through the key, not through the URL: that way
                      // the address stays stable and the scheme's ETag can return 304.
                      src={`${DESIGN_SCHEME}://${designId}/${encodeFile(board.file)}?v=${reloads}`}
                      title={board.title ?? board.file}
                      sandbox="allow-scripts"
                      allow=""
                      referrerPolicy="no-referrer"
                      className="absolute top-0 left-0 border-0"
                      style={{ width: board.w, height: board.h, pointerEvents: panning || dragging ? "none" : "auto" }}
                    />
                  </div>

                  {/* Outlines: drawn HERE, over the iframe — nothing enters the
                      DOM of the artboard (the path of the elements cannot change). */}
                  {groupRectList.map((rect, index) => (
                    <div
                      key={`group-${index}`}
                      className="pointer-events-none absolute"
                      style={{
                        left: rect.x,
                        top: rect.y,
                        width: rect.w,
                        height: rect.h,
                        outline: `${line}px solid color-mix(in oklab, var(--primary) 55%, transparent)`,
                      }}
                    />
                  ))}
                  {hoverRect && !(elementRect && samePathRect(hoverRect, elementRect)) && (
                    <div
                      className="pointer-events-none absolute"
                      style={{
                        left: hoverRect.x,
                        top: hoverRect.y,
                        width: hoverRect.w,
                        height: hoverRect.h,
                        outline: `${line}px solid color-mix(in oklab, var(--primary) 60%, transparent)`,
                      }}
                    />
                  )}
                  {elementRect && (
                    <div
                      className="pointer-events-none absolute"
                      style={{ left: elementRect.x, top: elementRect.y, width: elementRect.w, height: elementRect.h, outline: `${line}px solid var(--primary)` }}
                    >
                      {corners.map((corner) => (
                        <div
                          key={corner}
                          className="pointer-events-auto absolute rounded-[1px] border-primary bg-background"
                          style={cornerStyle(corner, elementRect.w, elementRect.h)}
                          onPointerDown={(e) => {
                            if (!selection?.path) return
                            e.preventDefault()
                            e.stopPropagation()
                            resizeLast.current = null
                            beginDrag({
                              kind: "resize-el",
                              file: board.file,
                              path: selection.path,
                              corner,
                              startX: e.clientX,
                              startY: e.clientY,
                              origin: elementRect,
                            })
                          }}
                        />
                      ))}
                      <div
                        className="absolute left-1/2 -translate-x-1/2 rounded bg-primary px-1 font-mono whitespace-nowrap text-primary-foreground"
                        style={{ top: "100%", marginTop: 4 / zoom, fontSize: 10 / zoom, lineHeight: 1.4 }}
                      >
                        {Math.round(elementRect.w)} × {Math.round(elementRect.h)}
                      </div>
                    </div>
                  )}
                  {isBoardSelected && (
                    <div className="pointer-events-none absolute inset-0" style={{ outline: `${line}px solid var(--primary)` }}>
                      {corners.map((corner) => (
                        <div
                          key={corner}
                          className="pointer-events-auto absolute rounded-[1px] border-primary bg-background"
                          style={cornerStyle(corner, board.w, board.h)}
                          onPointerDown={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            beginDrag({ kind: "resize-board", file: board.file, corner, startX: e.clientX, startY: e.clientY, origin: board })
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Hand / Space / drag in progress: a layer over the iframes, which
              would otherwise swallow the pointer. */}
          {(panning || dragging) && (
            <div className="absolute inset-0 z-20" onPointerDown={(e) => panning && startPan(e, false)} />
          )}
        </div>

        {!fullscreen && inspectorOpen && inspector}

        {/* Fullscreen: the canvas takes everything and the sidebars float over it, with the
            look of the standard sidebar (round, floating, opens on the edge hover
            when closed). Left: layers. Right: properties and
            code, in tabs as in the side panel. */}
        {fullscreen && (
          <>
            <FloatingSidebar
              side="left"
              open={leftSideOpen}
              onToggle={() => setLeftSideOpen((v) => !v)}
              openLabel={t("design.showLayers")}
              closeLabel={t("design.hideLayers")}
            >
              <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 px-3 text-[11px] font-medium">
                <Layers className="size-3" />
                {t("design.inspector.layers")}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">{renderInspectorBody("layers")}</div>
            </FloatingSidebar>
            <FloatingSidebar
              side="right"
              open={rightSideOpen}
              onToggle={() => setRightSideOpen((v) => !v)}
              openLabel={t("design.showInspector")}
              closeLabel={t("design.hideInspector")}
            >
              {renderTabStrip(["properties", "code"], rightTab)}
              <div className={cn("min-h-0 flex-1", rightTab === "code" ? "overflow-hidden" : "overflow-y-auto")}>
                {renderInspectorBody(rightTab)}
              </div>
            </FloatingSidebar>
            <FullscreenComposer pinned={composerPinned} onTogglePin={() => setComposerPinned((v) => !v)} />
          </>
        )}
      </div>
    </div>
  )
}

/** Is the hover the selected one itself? (then only one outline appears) */
function samePathRect(a: DesignRect, b: DesignRect): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5
}

/** With `playFile` the tab PRESENTS the canvas (one screen at a time); without it, it edits. */
export function DesignTab({
  designId,
  title,
  path,
  playFile,
  playFullscreen,
}: {
  designId?: string
  title: string
  path?: string
  playFile?: string
  /** The presentation was born from the fullscreen editor — the tab already enters like this. */
  playFullscreen?: boolean
}) {
  if (designId && playFile)
    return <DesignPresenter designId={designId} title={title} startFile={playFile} initialFullscreen={playFullscreen} />
  return <DesignEditor designId={designId} title={title} path={path} />
}
