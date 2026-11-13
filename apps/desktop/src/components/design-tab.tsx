import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { useTranslation } from "react-i18next"
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Code2,
  Copy,
  ClipboardPaste,
  Download,
  Eye,
  EyeOff,
  FileImage,
  Group,
  LayoutPanelLeft,
  Trash2,
  Hand,
  Layers,
  LayoutGrid,
  Loader2,
  Maximize2,
  Minimize2,
  Minus,
  MousePointer2,
  PanelBottomClose,
  MessagesSquare,
  PanelBottomOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Redo2,
  RotateCw,
  Scissors,
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
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { IconAction } from "@/src/components/ai/artifact-part"
import { DesignCode } from "@/src/components/design/design-code"
import { DesignContextMenu, type DesignMenuItem } from "@/src/components/design/design-context-menu"
import { DesignLayers } from "@/src/components/design/design-layers"
import { DesignPresenter } from "@/src/components/design/design-presenter"
import { planDesignReload } from "@/src/components/design/design-reload"
import { isBoardInView } from "@/src/components/design/design-view"
import { DesignProperties, type DesignBoardView, type DesignPropertiesTarget } from "@/src/components/design/design-properties"
import {
  DESIGN_SOURCE,
  applyWrap,
  buildClip,
  copyFileName,
  duplicateNodes,
  boardForHref,
  editHtml,
  hasContent,
  isTextPath,
  layoutFromRects,
  looseDocument,
  looseFileName,
  moveElements,
  parseRuntimeMessage,
  pasteClip,
  planLayerMove,
  planWrap,
  removeNodes,
  reorderChildren,
  rootPaths,
  samePath,
  setInlineStyle,
  setTextNode,
  stepOrder,
  type DesignClip,
  type DesignElementInfo,
  type DesignRect,
  type DesignTreeNode,
  type DropMode,
  type ElementPath,
  type LayerMovePlan,
  type PasteAt,
  type PasteContext,
  type WrapPlan,
} from "@/src/components/design/design-protocol"
import { designApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"
import { TabHeader } from "@/src/components/tab-header"
import { cn } from "@/lib/utils"
import { FULLSCREEN_OVERLAY_CLASS } from "@/src/lib/fullscreen-overlay"
import { ConversationBody } from "@/src/components/conversation-body"
import { FloatingSidebar, FullscreenComposer } from "@/src/components/fullscreen-dock"
import { ArtifactChatTools } from "@/src/components/artifact/artifact-chat-tools"
import { AGENT_META } from "@/src/components/agent-meta"
import { useArtifactChat } from "@/src/hooks/use-artifact-chat"
import { useArtifactView } from "@/src/hooks/use-artifact-view"
import { designViewState } from "@/src/components/design/design-view-state"
import { useSessionStatus } from "@/src/stores/session-store"
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
  boards: Record<string, { title?: string; x: number; y: number; w: number; h: number; free?: boolean }>
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

/** Where a board sits in canvas.json: the part of a history step that is about the INDEX. */
interface BoardMeta {
  board: { title?: string; x: number; y: number; w: number; h: number; free?: boolean }
  index: number
}

/**
 * One step of the history (undo/redo): the source of EVERY artboard it touched, before and after,
 * and — when it created or removed a board (a loose piece appearing, a frame emptied) — the place
 * that board had in canvas.json. One step can span several files, which is what lets a drag from
 * one artboard to another undo as one gesture.
 */
interface HistoryEntry {
  files: Record<string, { before: string | null; after: string | null }>
  boards?: Record<string, { before: BoardMeta | null; after: BoardMeta | null }>
}

/**
 * What Copy keeps, shared by every Design tab of the window: some nodes (with the styles they
 * need), or a whole artboard.
 */
type TabClip =
  | { kind: "nodes"; clip: DesignClip }
  | { kind: "board"; designId: string; file: string; html: string; board: { title?: string; w: number; h: number; free?: boolean } }
let sharedClip: TabClip | null = null

/** A drag in progress that left its artboard: the elements, the ghost and the place they would land. */
interface CrossDrag {
  file: string
  paths: ElementPath[]
  rects: DesignRect[]
  grab: { x: number; y: number }
  /** The pointer is outside the artboard the drag started in. */
  outside: boolean
  /** Pointer in CANVAS coordinates. */
  point: { x: number; y: number } | null
  /** The artboard under the pointer (a drop target), and the landing it reported. */
  over: string | null
  target: { file: string; parent: ElementPath; index: number } | null
}

/** The drag of a loose piece: the artboard itself follows the pointer. */
interface FreeDrag {
  file: string
  startSX: number
  startSY: number
  origin: { x: number; y: number }
  /** Pointer in canvas coordinates where the drag started. */
  anchor: { x: number; y: number }
  over: string | null
  target: { file: string; parent: ElementPath; index: number } | null
  last: { x: number; y: number }
}

const HISTORY_LIMIT = 100
/** How long the size a loose piece reports is held before it is written to canvas.json. */
const SIZE_PERSIST_MS = 250
/** Where a pasted loose piece lands relative to the one it was copied from. */
const PASTE_OFFSET = 24
const looseMeta = (b: { title?: string; x: number; y: number; w: number; h: number; free?: boolean }): BoardMeta["board"] => ({
  ...(b.title ? { title: b.title } : {}),
  x: b.x,
  y: b.y,
  w: b.w,
  h: b.h,
  ...(b.free ? { free: true } : {}),
})

const MIN_ZOOM = 0.05
const MAX_ZOOM = 4
const FIT_PADDING = 56
const WIDE_LAYOUT_PX = 720
/** Inspector card: the drag starts/stops here (px), and the CSS caps it at a share of the tab. */
const INSPECTOR_MIN_PX = 180
const INSPECTOR_MAX_PX = 640
const INSPECTOR_DEFAULT_PX = 288
const INSPECTOR_MAX_RATIO = 0.7
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

/** The tab remounts on every switch: the size the person chose is kept between them. */
const INSPECTOR_HEIGHT_KEY = "orbit.design.inspectorHeight"
const INSPECTOR_WIDTH_KEY = "orbit.design.inspectorWidth"
const readInspectorSize = (key: string) => {
  try {
    const value = Number(localStorage.getItem(key))
    if (Number.isFinite(value) && value >= INSPECTOR_MIN_PX && value <= INSPECTOR_MAX_PX) return value
  } catch {
    // no storage (or blocked): the default is enough
  }
  return INSPECTOR_DEFAULT_PX
}
const writeInspectorSize = (key: string, value: number) => {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // no storage: the size lives only as long as the tab
  }
}

/**
 * The two floating sidebars of fullscreen keep the state the person left them in — open
 * stays open, closed stays closed —, across the fullscreen leaving and the tab remounting
 * on every switch. The inspector of the SIDE tab is the opposite: it is born closed and is
 * never restored, because in the narrow panel the canvas is what matters.
 */
const LEFT_SIDE_KEY = "orbit.design.fullscreenLeftSide"
const RIGHT_SIDE_KEY = "orbit.design.fullscreenRightSide"
const readSideOpen = (key: string) => {
  try {
    const value = localStorage.getItem(key)
    if (value === "1") return true
    if (value === "0") return false
  } catch {
    // no storage (or blocked): the default is enough
  }
  return true
}
const writeSideOpen = (key: string, value: boolean) => {
  try {
    localStorage.setItem(key, value ? "1" : "0")
  } catch {
    // no storage: the state lives only as long as the tab
  }
}

function DesignEditor({
  designId,
  title,
  path,
  sessionId,
}: {
  designId?: string
  title: string
  path?: string
  /** Conversation that owns the tab — the fullscreen composer talks to it (chat or code mode). */
  sessionId?: string
}) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  /** The inspector card, measured by the drag: its size is what the canvas gives away. */
  const inspectorRef = useRef<HTMLDivElement | null>(null)
  /** Canvas + inspector: it is the room the drag of the card can use. */
  const layoutRef = useRef<HTMLDivElement | null>(null)
  /** The iframe that is ON SCREEN for each artboard (rebuilt after every render). */
  const iframes = useRef(new Map<string, HTMLIFrameElement>())
  /**
   * Every iframe that exists, by frame key. An artboard that reloads is mounted TWICE for a moment:
   * the old document stays on screen while the new one loads hidden beside it, and only when it has
   * loaded do they swap — so a reload (undo, redo, the agent writing) never shows a blank frame.
   */
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>())
  const frameFiles = useRef(new Map<string, string>())
  /** The frame key each artboard is showing right now. */
  const shownKeys = useRef<Record<string, string>>({})
  const [, setFrameTick] = useState(0)

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
  /** The card is born CLOSED: the canvas is what the tab is for, and whoever wants
   *  properties/layers/code opens it with the header button. */
  const [inspectorOpen, setInspectorOpen] = useState(false)
  /** Size of the card in each orientation: height of the strip below, width of the column. */
  const [inspectorHeight, setInspectorHeight] = useState(() => readInspectorSize(INSPECTOR_HEIGHT_KEY))
  const [inspectorWidth, setInspectorWidth] = useState(() => readInspectorSize(INSPECTOR_WIDTH_KEY))
  const [codeFile, setCodeFile] = useState<string | null>(null)
  const [codeVersion, setCodeVersion] = useState(0)
  const [overrides, setOverrides] = useState<Record<string, Partial<DesignBoardView>>>({})
  const [fullscreen, setFullscreen] = useState(false)
  // Fullscreen: floating sidebars (open by default, and kept as the person left them) and the
  // composer on hover
  const [leftSideOpen, setLeftSideOpen] = useState(() => readSideOpen(LEFT_SIDE_KEY))
  /** The left sidebar has two tabs: the layers and the conversation with the agent. */
  const [leftTab, setLeftTab] = useState<"layers" | "conversation">("layers")
  // The conversation of the fullscreen: the chat the person picked for this canvas, else the
  // one that owns the tab (see use-artifact-chat).
  const chat = useArtifactChat(designId ? { kind: "design", id: designId } : null, { fallback: sessionId })
  const chatSessionId = chat.sessionId ?? sessionId
  const agentStatus = useSessionStatus(chatSessionId)
  const agentBusy = agentStatus === "submitted" || agentStatus === "streaming"
  const [rightSideOpen, setRightSideOpen] = useState(() => readSideOpen(RIGHT_SIDE_KEY))
  // Closing one of the fullscreen sidebars is a decision that outlives the tab: it is written
  // where the next opening reads it (the size of the inspector does the same).
  useEffect(() => {
    writeSideOpen(LEFT_SIDE_KEY, leftSideOpen)
  }, [leftSideOpen])
  useEffect(() => {
    writeSideOpen(RIGHT_SIDE_KEY, rightSideOpen)
  }, [rightSideOpen])
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
  /** History: the steps that can be undone, and the ones undone that can be redone. */
  const undoStack = useRef<HistoryEntry[]>([])
  const redoStack = useRef<HistoryEntry[]>([])
  const [, setHistoryVersion] = useState(0)
  /** The drag that left its artboard (ghost + drop target) and the drag of a loose piece. */
  const crossRef = useRef<CrossDrag | null>(null)
  const freeDragRef = useRef<FreeDrag | null>(null)
  const [ghost, setGhost] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  /** The frame a drag is about to drop into (outlined on the canvas). */
  const [dropOver, setDropOver] = useState<string | null>(null)
  /** A loose piece is being dragged: the iframes stand aside so the panel sees the pointer. */
  const [freeDragging, setFreeDragging] = useState(false)
  const sizeTimers = useRef(new Map<string, number>())

  const quietUntil = useRef(0)
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

  /** Export in progress (hidden Chromium windows) and its failure. */
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  /** Artboards hidden by the eye (view state; never written to the files). */
  const [hiddenBoards, setHiddenBoards] = useState<Set<string>>(() => new Set())
  /** Right-click menu: where it is and what it acts on. */
  const [menu, setMenu] = useState<{ x: number; y: number; scope: "element" | "frame" | "canvas"; file: string; at?: { x: number; y: number } } | null>(null)
  const exportDesign = useCallback(
    async (format: "pdf" | "png", files?: string[]) => {
      if (!designId || exporting) return
      setExporting(true)
      setExportError(null)
      try {
        const result = await designApi.export(
          designId,
          format,
          title,
          files,
        )
        if (!result.ok && !result.canceled) setExportError(result.error ?? t("design.exportFailed"))
      } catch {
        setExportError(t("design.exportFailed"))
      } finally {
        setExporting(false)
      }
    },
    [designId, exporting, title, t],
  )

  const boards = useMemo<DesignBoardView[]>(() => {
    if (state.status !== "ready") return []
    const { canvas } = state
    return canvas.order
      .filter((file) => canvas.boards[file])
      .map((file) => ({ file, ...canvas.boards[file], ...overrides[file] }))
  }, [state, overrides])
  const boardsRef = useRef(boards)
  boardsRef.current = boards
  // The active artboard and the selection reach the chat at its next turn.
  useArtifactView(
    designId ? { kind: "design", id: designId } : null,
    designViewState({ title, boards, selection, extraSelected: groupPaths.length, element: info }),
  )

  /** Are the Layers in view? It is the only thing that needs the DOM tree. */
  const layersVisible = fullscreen ? leftSideOpen && leftTab === "layers" : inspectorOpen && inspectorTab === "layers"
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

  // The inspector's size lives in the DOM, not in a style prop: during the drag it is
  // written straight into the element (a render in the middle — the canvas measuring
  // itself — would undo it). This is what applies the value committed at the end and what
  // restores it when the card is opened again.
  useLayoutEffect(() => {
    const card = inspectorRef.current
    if (!card) return
    card.style.width = wide ? `${inspectorWidth}px` : ""
    card.style.height = wide ? "" : `${inspectorHeight}px`
  }, [wide, inspectorWidth, inspectorHeight, inspectorOpen])

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
  /** A new step: whatever was undone can no longer be redone. */
  const pushHistory = useCallback((entry: HistoryEntry) => {
    undoStack.current.push(entry)
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift()
    redoStack.current = []
    setHistoryVersion((n) => n + 1)
  }, [])

  const pushUndo = useCallback(
    (file: string, before: string, after: string) => pushHistory({ files: { [file]: { before, after } } }),
    [pushHistory],
  )

  /** Writes to the artboards in a queue: two edits in a row cannot read the same source and one
   *  erase the other. A step that touches several files waits for all of them. */
  const chainAll = useCallback((files: string[], task: () => Promise<void>) => {
    const previous = Promise.all(files.map((file) => (writeChains.current.get(file) ?? Promise.resolve()).catch(() => {})))
    const next = previous.then(task).catch((err: unknown) => setSaveError(err instanceof Error ? err.message : String(err)))
    for (const file of files) writeChains.current.set(file, next)
    return next
  }, [])
  const chain = useCallback((file: string, task: () => Promise<void>) => chainAll([file], task), [chainAll])

  /** Keeps the local copy of canvas.json in step with a board created or removed by the panel. */
  const putBoardLocal = useCallback((file: string, meta: BoardMeta | null) => {
    setState((prev) => {
      if (prev.status !== "ready") return prev
      const boards = { ...prev.canvas.boards }
      let order = prev.canvas.order.filter((f) => f !== file)
      if (meta) {
        boards[file] = meta.board
        order.splice(Math.min(order.length, Math.max(0, meta.index)), 0, file)
      } else {
        delete boards[file]
        order = order.filter((f) => f !== file)
      }
      return { status: "ready", canvas: { ...prev.canvas, boards, order } }
    })
    setOverrides((prev) => {
      if (!(file in prev)) return prev
      const next = { ...prev }
      delete next[file]
      return next
    })
    if (!meta && selectionRef.current?.file === file) {
      setSelection(null)
      setInfo(null)
      setSelRect(null)
      setGroupRects([])
      setGroupPaths([])
    }
  }, [])

  /** Removes a board (a loose piece that was emptied or deleted) as ONE step of the history. */
  const dropBoard = useCallback(
    (file: string) => {
      if (!designId) return Promise.resolve()
      const board = boardsRef.current.find((b) => b.file === file)
      if (!board) return Promise.resolve()
      const meta: BoardMeta = { board: looseMeta(board), index: boardsRef.current.indexOf(board) }
      return chain(file, async () => {
        const before = await designApi.readBoard(designId, file)
        pushHistory({ files: { [file]: { before, after: null } }, boards: { [file]: { before: meta, after: null } } })
        quietUntil.current = Date.now() + QUIET_MS
        await designApi.removeBoard(designId, file)
        putBoardLocal(file, null)
        setCodeVersion((n) => n + 1)
      })
    },
    [chain, designId, pushHistory, putBoardLocal],
  )

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
        const board = boardsRef.current.find((b) => b.file === file)
        if (board?.free && !hasContent(after)) {
          // A loose piece is its content: when the last element goes, the piece goes with it.
          const meta: BoardMeta = { board: looseMeta(board), index: boardsRef.current.indexOf(board) }
          pushHistory({ files: { [file]: { before, after: null } }, boards: { [file]: { before: meta, after: null } } })
          quietUntil.current = Date.now() + QUIET_MS
          await designApi.removeBoard(designId, file)
          putBoardLocal(file, null)
          setCodeVersion((n) => n + 1)
          return
        }
        pushUndo(file, before, after)
        if (quiet) quietUntil.current = Date.now() + QUIET_MS
        await designApi.writeBoard(designId, file, after)
        setSaveError(null)
        setCodeVersion((n) => n + 1)
      })
    },
    [chain, designId, pushHistory, pushUndo, putBoardLocal],
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
          // Only what was written stops being an override: a drag in progress keeps its own.
          setOverrides((prev) => {
            const current = prev[file]
            if (!current) return prev
            const rest = { ...current }
            for (const key of Object.keys(patch)) delete rest[key as keyof typeof rest]
            const next = { ...prev }
            if (Object.keys(rest).length > 0) next[file] = rest
            else delete next[file]
            return next
          })
        })
        .catch((err: unknown) => setSaveError(err instanceof Error ? err.message : String(err)))
    },
    [designId],
  )

  const deleteSelected = useCallback(() => {
    const sel = selectionRef.current
    if (!sel) return
    if (!sel.path || sel.path.length === 0) {
      // The whole artboard: only a loose piece can be deleted this way (a frame is the agent's).
      if (boardsRef.current.find((b) => b.file === sel.file)?.free) {
        select(null)
        void dropBoard(sel.file)
      }
      return
    }
    const { file, path: target } = sel
    // With a group, it deletes the whole group (the multiple selection is a single thing).
    const group = groupPathsRef.current.filter((p) => p.length > 0)
    const paths = group.length > 1 ? group : [target]
    select(null)
    void mutateSourceHtml(file, (html) => removeNodes(html, paths), true).then(() => {
      post(file, { type: "remove", paths })
    })
  }, [dropBoard, mutateSourceHtml, post, select])

  /** Applies one history step in one direction: rewrites each file, and re-creates or removes the
   *  boards the step created or removed. */
  const applyEntry = useCallback(
    async (entry: HistoryEntry, direction: "undo" | "redo") => {
      if (!designId) return
      for (const [file, change] of Object.entries(entry.files)) {
        const html = direction === "undo" ? change.before : change.after
        const meta = entry.boards?.[file]
        const board = meta ? (direction === "undo" ? meta.before : meta.after) : undefined
        if (board === null) {
          await designApi.removeBoard(designId, file)
          putBoardLocal(file, null)
        } else if (board) {
          await designApi.addBoard(designId, file, html ?? "", board.board, board.index)
          putBoardLocal(file, board)
        } else if (html !== null) {
          await designApi.writeBoard(designId, file, html)
        }
      }
      setSaveError(null)
      setCodeVersion((n) => n + 1)
    },
    [designId, putBoardLocal],
  )

  const stepHistory = useCallback(
    (direction: "undo" | "redo") => {
      if (!designId) return
      const from = direction === "undo" ? undoStack.current : redoStack.current
      const to = direction === "undo" ? redoStack.current : undoStack.current
      const entry = from.pop()
      if (!entry) return
      to.push(entry)
      setHistoryVersion((n) => n + 1)
      // The quiet window exists for edits that are ALREADY on screen. An undo is the opposite — the
      // screen has to catch up to the file — so a recent edit must not swallow its reload.
      quietUntil.current = 0
      void chainAll(Object.keys(entry.files), () => applyEntry(entry, direction))
    },
    [applyEntry, chainAll, designId],
  )
  const undo = useCallback(() => stepHistory("undo"), [stepHistory])
  const redo = useCallback(() => stepHistory("redo"), [stepHistory])

  const saveCode = useCallback(
    async (file: string, html: string) => {
      if (!designId) return
      const before = await designApi.readBoard(designId, file)
      if (before === html) return
      pushUndo(file, before, html)
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

  /** The frame (and its artboard) a message came from — shown or still loading in the background. */
  const frameOf = useCallback((source: MessageEventSource | null) => {
    for (const [key, frame] of frameRefs.current) {
      const file = frameFiles.current.get(key)
      if (file && frame.contentWindow && frame.contentWindow === source) return { key, file }
    }
    return null
  }, [])

  /** The key of the frame an artboard SHOULD be showing now (it changes on every reload). */
  const wantedKey = (file: string) => `${file}:${reloads}:${fileVersions[file] ?? 0}`

  /**
   * The new document of a reloaded artboard has loaded: it takes the place of the old one in the
   * same frame of the screen, and the old one is unmounted. What the panel knew about the old
   * document (outlines, info) is asked again of the new one.
   */
  const promote = useCallback(
    (file: string, key: string) => {
      if (shownKeys.current[file] === key) return
      shownKeys.current = { ...shownKeys.current, [file]: key }
      const frame = frameRefs.current.get(key)
      if (frame) iframes.current.set(file, frame)
      const sel = selectionRef.current
      if (sel?.file === file && sel.path && sel.path.length > 0) {
        const group = groupPathsRef.current.filter((p) => p.length > 0)
        post(file, { type: "select", path: sel.path, group: group.length ? group : [sel.path] })
      }
      setFrameTick((n) => n + 1)
    },
    [post],
  )

  // After every render the shown frame of each mounted artboard is recorded (a first mount shows
  // what it wants) and the artboard → iframe map is rebuilt from what is really on screen.
  useLayoutEffect(() => {
    const next: Record<string, string> = {}
    const map = new Map<string, HTMLIFrameElement>()
    for (const board of boards) {
      if (!mounted.has(board.file)) continue
      const key = shownKeys.current[board.file] ?? wantedKey(board.file)
      next[board.file] = key
      const frame = frameRefs.current.get(key)
      if (frame) map.set(board.file, frame)
    }
    shownKeys.current = next
    iframes.current = map
  })

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

  /** Duplicates the selection (or the whole group): each clone enters right after its original. */
  const duplicateSelected = useCallback(() => {
    const sel = selectionRef.current
    if (!sel?.path || sel.path.length === 0) return
    const group = groupPathsRef.current.filter((p) => p.length > 0)
    const paths = group.length > 1 ? group : [sel.path]
    // Not quiet: the structure changed, so the disk notice reloads the artboard.
    void mutateSourceHtml(sel.file, (html) => duplicateNodes(html, paths), false)
  }, [mutateSourceHtml])

  /** Moves the selected element one step up/down among its siblings (in the Layers order). */
  const stepSelected = useCallback(
    (direction: "up" | "down") => {
      const sel = selectionRef.current
      if (!sel?.path || sel.path.length === 0) return
      const index = sel.path[sel.path.length - 1]
      if (index < 0) return
      const parent = sel.path.slice(0, -1)
      const planRef = { current: null as number[] | null }
      void mutateSourceHtml(
        sel.file,
        (html) =>
          editHtml(html, parent, (el) => {
            const order = stepOrder(el.children.length, index, direction)
            planRef.current = order
            if (order) reorderChildren(el, order)
          }),
        true,
      ).then(() => {
        if (!planRef.current) return
        post(sel.file, { type: "reorder", parent, order: planRef.current })
        select({ file: sel.file, path: [...parent, direction === "up" ? index - 1 : index + 1] })
      })
    },
    [mutateSourceHtml, post, select],
  )

  /** The eye: hides/shows an element (bridge, live DOM) or a whole artboard. */
  const toggleHidden = useCallback(
    (file: string, path: ElementPath | null) => {
      if (path && path.length > 0) {
        post(file, { type: "hide", path })
        return
      }
      setHiddenBoards((prev) => {
        const next = new Set(prev)
        if (next.has(file)) next.delete(file)
        else next.add(file)
        return next
      })
    },
    [post],
  )

  const toggleHiddenSelected = useCallback(() => {
    const sel = selectionRef.current
    if (!sel) return
    const group = groupPathsRef.current.filter((p) => p.length > 0)
    if (sel.path && sel.path.length > 0) for (const p of group.length > 1 ? group : [sel.path]) toggleHidden(sel.file, p)
    else toggleHidden(sel.file, null)
  }, [toggleHidden])

  // ------------------------------------------- clipboard, loose pieces and drops
  const selRectRef = useRef(selRect)
  selRectRef.current = selRect
  const groupRectsRef = useRef(groupRects)
  groupRectsRef.current = groupRects

  /** A point of the screen, in canvas coordinates. */
  const canvasPoint = useCallback((clientX: number, clientY: number) => {
    const el = viewportRef.current
    const v = viewRef.current
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom }
  }, [])

  const viewportCenter = useCallback(() => {
    const el = viewportRef.current
    const v = viewRef.current
    if (!el) return { x: 0, y: 0 }
    return { x: (el.clientWidth / 2 - v.x) / v.zoom, y: (el.clientHeight / 2 - v.y) / v.zoom }
  }, [])

  /** Is a canvas point under the canvas itself (and not under the inspector or the header)? */
  const pointInViewport = useCallback((point: { x: number; y: number }) => {
    const el = viewportRef.current
    const v = viewRef.current
    if (!el) return false
    const sx = point.x * v.zoom + v.x
    const sy = point.y * v.zoom + v.y
    return sx >= 0 && sy >= 0 && sx <= el.clientWidth && sy <= el.clientHeight
  }, [])

  /** What the styles of a clip need to travel to where it is going. */
  const pasteContextFor = useCallback(
    async (clip: DesignClip, file: string | null): Promise<PasteContext> => {
      const sameDesign = clip.designId === designId
      const ctx: PasteContext = { sameFile: sameDesign && clip.file === file, sameDesign }
      if (!sameDesign && clip.designId && clip.links.length > 0) {
        // Another canvas: its `<link href="base.css">` means nothing here, so the sheet is read
        // from there and goes in as a block of CSS.
        const inlineCss: Record<string, string> = {}
        for (const href of clip.links) {
          try {
            const res = await fetch(`${DESIGN_SCHEME}://${clip.designId}/${encodeFile(href)}`)
            if (res.ok) inlineCss[href] = await res.text()
          } catch {
            // that sheet is not reachable: the markup still comes, only less styled
          }
        }
        ctx.inlineCss = inlineCss
      }
      return ctx
    },
    [designId],
  )

  /** The document, the index entry and the place of a new loose piece. */
  const planLoose = useCallback((clip: DesignClip, origin: { x: number; y: number }, ctx: PasteContext) => {
    const file = looseFileName(boardsRef.current.map((b) => b.file))
    const w = Math.max(1, Math.round(clip.size.w) || 200)
    const h = Math.max(1, Math.round(clip.size.h) || 80)
    const html = looseDocument(clip, w, ctx)
    const meta: BoardMeta = {
      board: { title: clip.label, x: Math.round(origin.x), y: Math.round(origin.y), w, h, free: true },
      index: boardsRef.current.length,
    }
    return { file, html, meta }
  }, [])

  /**
   * Moves nodes from one artboard to another artboard, or out onto the empty canvas as a loose
   * piece — as ONE step of the history. The source loses the nodes (and a loose piece that is
   * left empty goes away), the destination gets them with the styles they need.
   */
  const transfer = useCallback(
    async (args: {
      from: string
      paths: ElementPath[]
      rects: DesignRect[]
      to: { kind: "frame"; file: string; parent: ElementPath; index: number } | { kind: "canvas"; origin: { x: number; y: number } }
    }) => {
      if (!designId) return
      const { from, paths, rects, to } = args
      if (to.kind === "frame" && to.file === from) return
      const files = to.kind === "frame" ? [from, to.file] : [from]
      let selectAfter: Selection | null = null
      let groupAfter: ElementPath[] = []
      await chainAll(files, async () => {
        const htmlFrom = await designApi.readBoard(designId, from)
        const clip = buildClip(htmlFrom, paths, { designId, file: from, rects })
        if (!clip) return
        const afterFrom = removeNodes(htmlFrom, paths)
        const entry: HistoryEntry = { files: {}, boards: {} }
        if (to.kind === "frame") {
          const htmlTo = await designApi.readBoard(designId, to.file)
          const pasted = pasteClip(htmlTo, clip, { kind: "inside", parent: to.parent, index: to.index }, await pasteContextFor(clip, to.file))
          entry.files[to.file] = { before: htmlTo, after: pasted.html }
          selectAfter = { file: to.file, path: pasted.paths[0] ?? null }
          groupAfter = pasted.paths
        } else {
          const plan = planLoose(clip, to.origin, await pasteContextFor(clip, null))
          entry.files[plan.file] = { before: null, after: plan.html }
          entry.boards![plan.file] = { before: null, after: plan.meta }
          const single = clip.items.length === 1
          selectAfter = { file: plan.file, path: single ? [0] : null }
          groupAfter = single ? [[0]] : []
        }
        const source = boardsRef.current.find((b) => b.file === from)
        if (source?.free && !hasContent(afterFrom)) {
          entry.files[from] = { before: htmlFrom, after: null }
          entry.boards![from] = { before: { board: looseMeta(source), index: boardsRef.current.indexOf(source) }, after: null }
        } else {
          entry.files[from] = { before: htmlFrom, after: afterFrom }
        }
        quietUntil.current = 0
        await applyEntry(entry, "redo")
        pushHistory(entry)
      })
      if (selectAfter) {
        setSelection(selectAfter)
        setGroupPaths(groupAfter)
        setInfo(null)
        setSelRect(null)
        setGroupRects([])
      }
    },
    [applyEntry, chainAll, designId, pasteContextFor, planLoose, pushHistory],
  )

  /** Copies the selection: some nodes (with their styles), or the whole artboard when it is the one selected. */
  const copySelected = useCallback(async (): Promise<boolean> => {
    const sel = selectionRef.current
    if (!sel || !designId) return false
    const board = boardsRef.current.find((b) => b.file === sel.file)
    if (!board) return false
    const html = await designApi.readBoard(designId, sel.file)
    if (!sel.path || sel.path.length === 0) {
      sharedClip = {
        kind: "board",
        designId,
        file: sel.file,
        html,
        board: { ...(board.title ? { title: board.title } : {}), w: board.w, h: board.h, ...(board.free ? { free: true } : {}) },
      }
      return true
    }
    const group = groupPathsRef.current.filter((p) => p.length > 0)
    const paths = group.some((p) => samePath(p, sel.path!)) ? group : [...group, sel.path]
    const rects = [selRectRef.current, ...groupRectsRef.current].filter((r): r is DesignRect => Boolean(r))
    const clip = buildClip(html, paths, { designId, file: sel.file, rects })
    if (!clip) return false
    sharedClip = { kind: "nodes", clip }
    return true
  }, [designId])

  const cutSelected = useCallback(async () => {
    if (await copySelected()) deleteSelected()
  }, [copySelected, deleteSelected])

  /**
   * Pastes what was copied. With a frame (or an element in it) selected it goes INTO that frame —
   * after the element, or at the end. With a loose piece selected, or nothing, it lands on the
   * canvas as a loose piece of its own. `where` (a right click on the canvas) overrides both.
   */
  const paste = useCallback(
    async (where?: { x: number; y: number }) => {
      const entry = sharedClip
      if (!entry || !designId) return
      const sel = selectionRef.current
      const selBoard = sel ? boardsRef.current.find((b) => b.file === sel.file) : undefined
      if (entry.kind === "board") {
        const taken = boardsRef.current.map((b) => b.file)
        const file = entry.board.free ? looseFileName(taken) : copyFileName(entry.file, taken)
        const original = entry.designId === designId ? boardsRef.current.find((b) => b.file === entry.file) : undefined
        const at = where
          ? { x: where.x, y: where.y }
          : original
            ? entry.board.free
              ? { x: original.x + PASTE_OFFSET, y: original.y + PASTE_OFFSET }
              : { x: original.x + original.w + 80, y: original.y }
            : (() => {
                const c = viewportCenter()
                return { x: c.x - entry.board.w / 2, y: c.y - entry.board.h / 2 }
              })()
        const meta: BoardMeta = {
          board: {
            ...(entry.board.title ? { title: entry.board.title } : {}),
            x: Math.round(at.x),
            y: Math.round(at.y),
            w: entry.board.w,
            h: entry.board.h,
            ...(entry.board.free ? { free: true } : {}),
          },
          index: boardsRef.current.length,
        }
        const step: HistoryEntry = { files: { [file]: { before: null, after: entry.html } }, boards: { [file]: { before: null, after: meta } } }
        await chainAll([file], async () => {
          quietUntil.current = 0
          await applyEntry(step, "redo")
          pushHistory(step)
        })
        setSelection({ file, path: null })
        setGroupPaths([])
        return
      }
      const clip = entry.clip
      if (!where && sel && selBoard && !selBoard.free) {
        const file = sel.file
        let at: PasteAt = { kind: "end" }
        if (sel.path && sel.path.length > 0) {
          const members = [...groupPathsRef.current.filter((p) => p.length > 0), sel.path]
          const last = members.reduce((a, b) => (pathOrder(a, b) >= 0 ? a : b))
          at = { kind: "after", path: isTextPath(last) ? last.slice(0, -1) : last }
          if (at.path.length === 0) at = { kind: "end" }
        }
        const ctx = await pasteContextFor(clip, file)
        let pasted: ElementPath[] = []
        // Not quiet: the structure changed, so the artboard reloads (without a blank frame).
        await mutateSourceHtml(
          file,
          (html) => {
            const result = pasteClip(html, clip, at, ctx)
            pasted = result.paths
            return result.html
          },
          false,
        )
        if (pasted.length > 0) {
          setSelection({ file, path: pasted[0] })
          setGroupPaths(pasted)
          setInfo(null)
          setSelRect(null)
          setGroupRects([])
        }
        return
      }
      const w = clip.size.w || 200
      const h = clip.size.h || 80
      const origin = where
        ? where
        : selBoard?.free
          ? { x: selBoard.x + PASTE_OFFSET, y: selBoard.y + PASTE_OFFSET }
          : (() => {
              const c = viewportCenter()
              return { x: c.x - w / 2, y: c.y - h / 2 }
            })()
      const ctx = await pasteContextFor(clip, null)
      const plan = planLoose(clip, origin, ctx)
      const step: HistoryEntry = {
        files: { [plan.file]: { before: null, after: plan.html } },
        boards: { [plan.file]: { before: null, after: plan.meta } },
      }
      await chainAll([plan.file], async () => {
        quietUntil.current = 0
        await applyEntry(step, "redo")
        pushHistory(step)
      })
      const single = clip.items.length === 1
      setSelection({ file: plan.file, path: single ? [0] : null })
      setGroupPaths(single ? [[0]] : [])
    },
    [applyEntry, chainAll, designId, mutateSourceHtml, pasteContextFor, planLoose, pushHistory, viewportCenter],
  )

  // ---- drag between artboards and of loose pieces ----
  /** The frame (not a loose piece) under a canvas point that can take a drop. */
  const frameAt = useCallback((x: number, y: number, skip: string): DesignBoardView | null => {
    const list = boardsRef.current
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const b = list[i]
      if (b.free || b.file === skip || !iframes.current.has(b.file)) continue
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b
    }
    return null
  }, [])

  /** Points a drag at the frame under `point` (outlines it, asks it where the drop would land). */
  const aimAt = useCallback(
    (state: { over: string | null; target: { file: string; parent: ElementPath; index: number } | null }, point: { x: number; y: number }, skip: string, enabled: boolean) => {
      const frame = enabled ? frameAt(point.x, point.y, skip) : null
      if (state.over && state.over !== frame?.file) {
        post(state.over, { type: "dropAt", active: false })
        state.target = null
      }
      state.over = frame?.file ?? null
      if (frame) post(frame.file, { type: "dropAt", active: true, x: point.x - frame.x, y: point.y - frame.y })
      setDropOver(frame?.file ?? null)
    },
    [frameAt, post],
  )

  /**
   * While a drag is outside its artboard the iframe may or may not keep the pointer (it does in
   * Chromium, but nothing here depends on it): the panel listens to the pointer too, and whichever
   * hears the release first closes the drag. Every handler below is idempotent.
   */
  useEffect(() => {
    const timers = sizeTimers.current
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const trackers = useRef<Partial<Record<"cross" | "free", () => void>>>({})
  const track = useCallback((key: "cross" | "free", onMove: (e: PointerEvent) => void, onUp: (e: PointerEvent, canceled: boolean) => void) => {
    trackers.current[key]?.()
    const up = (e: PointerEvent) => onUp(e, false)
    const cancel = (e: PointerEvent) => onUp(e, true)
    window.addEventListener("pointermove", onMove, true)
    window.addEventListener("pointerup", up, true)
    window.addEventListener("pointercancel", cancel, true)
    trackers.current[key] = () => {
      window.removeEventListener("pointermove", onMove, true)
      window.removeEventListener("pointerup", up, true)
      window.removeEventListener("pointercancel", cancel, true)
      delete trackers.current[key]
    }
  }, [])
  useEffect(() => {
    const current = trackers.current
    return () => {
      current.cross?.()
      current.free?.()
    }
  }, [])

  const crossMove = useCallback(
    (point: { x: number; y: number }, mod: boolean) => {
      const c = crossRef.current
      if (!c) return
      c.outside = true
      c.point = point
      const size = layoutFromRects(c.rects).size
      setGhost({ x: point.x - c.grab.x, y: point.y - c.grab.y, w: size.w, h: size.h })
      // Ctrl/⌘ keeps the piece loose: it is not aimed at the frame under it.
      aimAt(c, point, c.file, !mod)
    },
    [aimAt],
  )

  const crossBack = useCallback(() => {
    const c = crossRef.current
    if (!c) return
    c.outside = false
    c.point = null
    c.target = null
    if (c.over) post(c.over, { type: "dropAt", active: false })
    c.over = null
    setGhost(null)
    setDropOver(null)
  }, [post])

  const crossFinish = useCallback(
    async (commit: boolean, point: { x: number; y: number } | null, mod: boolean) => {
      const c = crossRef.current
      if (!c) return
      crossRef.current = null
      trackers.current.cross?.()
      setGhost(null)
      setDropOver(null)
      if (c.over) post(c.over, { type: "dropAt", active: false })
      // If the artboard never heard the release (it lost the pointer), it drops its own drag now.
      post(c.file, { type: "dragAbort" })
      const p = point ?? c.point
      if (!commit || !c.outside || !p || c.paths.length === 0) return
      // Released over the inspector or the header: nothing is dropped there.
      if (!pointInViewport(p)) return
      const origin = boardsRef.current.find((b) => b.file === c.file)
      if (origin && p.x >= origin.x && p.x <= origin.x + origin.w && p.y >= origin.y && p.y <= origin.y + origin.h) return
      const frame = mod ? null : frameAt(p.x, p.y, c.file)
      if (frame) {
        const target = c.target && c.target.file === frame.file ? c.target : { file: frame.file, parent: [] as ElementPath, index: 99_999 }
        await transfer({ from: c.file, paths: c.paths, rects: c.rects, to: { kind: "frame", file: target.file, parent: target.parent, index: target.index } })
      } else {
        await transfer({ from: c.file, paths: c.paths, rects: c.rects, to: { kind: "canvas", origin: { x: p.x - c.grab.x, y: p.y - c.grab.y } } })
      }
    },
    [frameAt, pointInViewport, post, transfer],
  )

  const beginCross = useCallback(
    (file: string, paths: ElementPath[], rects: DesignRect[], grab: { x: number; y: number }) => {
      crossRef.current = { file, paths, rects, grab, outside: false, point: null, over: null, target: null }
      track(
        "cross",
        (e) => crossMove(canvasPoint(e.clientX, e.clientY), e.metaKey || e.ctrlKey),
        (e, canceled) => void crossFinish(!canceled, canvasPoint(e.clientX, e.clientY), e.metaKey || e.ctrlKey),
      )
    },
    [canvasPoint, crossFinish, crossMove, track],
  )

  const freeMove = useCallback(
    (sx: number, sy: number, mod: boolean) => {
      const d = freeDragRef.current
      if (!d) return
      const { zoom: z } = viewRef.current
      const dx = (sx - d.startSX) / z
      const dy = (sy - d.startSY) / z
      const x = Math.round(d.origin.x + dx)
      const y = Math.round(d.origin.y + dy)
      d.last = { x, y }
      setOverrides((prev) => ({ ...prev, [d.file]: { ...prev[d.file], x, y } }))
      aimAt(d, { x: d.anchor.x + dx, y: d.anchor.y + dy }, d.file, !mod)
    },
    [aimAt],
  )

  const freeFinish = useCallback(
    async (mod: boolean) => {
      const d = freeDragRef.current
      if (!d || !designId) return
      freeDragRef.current = null
      trackers.current.free?.()
      setFreeDragging(false)
      setDropOver(null)
      if (d.over) post(d.over, { type: "dropAt", active: false })
      post(d.file, { type: "dragAbort" })
      const moved = d.last.x !== d.origin.x || d.last.y !== d.origin.y
      if (!mod && d.over) {
        // Dropped on a frame: the piece becomes part of it (the piece itself goes away).
        const target = d.target && d.target.file === d.over ? d.target : { file: d.over, parent: [] as ElementPath, index: 99_999 }
        const html = await designApi.readBoard(designId, d.file)
        await transfer({ from: d.file, paths: rootPaths(html), rects: [], to: { kind: "frame", file: target.file, parent: target.parent, index: target.index } })
        // The piece keeps showing where it was dropped until its content is in the frame; if it
        // was not removed (the move failed) it goes back to where canvas.json has it.
        setOverrides((prev) => {
          if (!(d.file in prev)) return prev
          const next = { ...prev }
          delete next[d.file]
          return next
        })
        return
      }
      if (moved) updateBoard(d.file, { x: d.last.x, y: d.last.y })
    },
    [designId, post, transfer, updateBoard],
  )

  const beginFreeDrag = useCallback(
    (file: string, msg: { sx: number; sy: number; x: number; y: number }) => {
      const board = boardsRef.current.find((b) => b.file === file)
      if (!board) return
      freeDragRef.current = {
        file,
        startSX: msg.sx,
        startSY: msg.sy,
        origin: { x: board.x, y: board.y },
        anchor: { x: board.x + msg.x, y: board.y + msg.y },
        over: null,
        target: null,
        last: { x: board.x, y: board.y },
      }
      setFreeDragging(true)
      track(
        "free",
        (e) => freeMove(e.screenX, e.screenY, e.metaKey || e.ctrlKey),
        (e) => void freeFinish(e.metaKey || e.ctrlKey),
      )
    },
    [freeFinish, freeMove, track],
  )

  const handleKey = useCallback(
    (key: { key: string; code: string; ctrl: boolean; meta: boolean; shift: boolean; alt?: boolean; phase: "down" | "up" }): boolean => {
      if (key.key === " ") {
        setSpaceHeld(key.phase === "down")
        return true
      }
      if (key.phase === "up") return false
      const mod = key.ctrl || key.meta
      const lower = key.key.toLowerCase()
      if (mod && lower === "z") {
        if (key.shift) redo()
        else undo()
        return true
      }
      if (mod && lower === "y") {
        redo()
        return true
      }
      // Copy/cut only when something of the canvas is selected, paste only when there is something
      // to paste: otherwise the shortcut belongs to whatever else has the selection (the chat).
      if (mod && lower === "c" && selectionRef.current) {
        void copySelected()
        return true
      }
      if (mod && lower === "x" && selectionRef.current) {
        void cutSelected()
        return true
      }
      if (mod && lower === "v" && sharedClip) {
        void paste()
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
      if (mod && lower === "d") {
        duplicateSelected()
        return true
      }
      if (mod && key.shift && lower === "h") {
        toggleHiddenSelected()
        return true
      }
      if (key.alt && (key.key === "ArrowUp" || key.key === "ArrowDown")) {
        stepSelected(key.key === "ArrowUp" ? "up" : "down")
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
    [copySelected, cutSelected, deleteSelected, duplicateSelected, fit, paste, redo, select, stepSelected, toggleHiddenSelected, undo, wrapSelected, zoomCenter],
  )

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameOf(event.source)
      if (!frame) return
      const { file, key } = frame
      const msg = parseRuntimeMessage(event.data)
      if (!msg) return
      // A document still loading in the background (a reload in progress) only gets to say `ready`:
      // everything else is the old document's business until the new one takes its place.
      const shown = (shownKeys.current[file] ?? key) === key
      if (!shown && msg.type !== "ready") return
      const sel = selectionRef.current
      switch (msg.type) {
        case "ready": {
          // New document (first load or reload): the tree that was
          // kept belongs to the previous HTML. If the Layers are in view it is requested
          // right away; otherwise, only when the panel opens (effect right below).
          // The answers go to THIS document (it may not be the one on screen yet).
          const reply = (message: Record<string, unknown>) =>
            (event.source as Window | null)?.postMessage({ source: DESIGN_SOURCE, ...message }, "*")
          treeRequests.current.delete(file)
          // The old tree stays until the new document sends its own (right below, when the Layers are
          // in view): clearing it here made the Layers list collapse and refill on every reload.
          setTrees((prev) => {
            if (!msg.tree) return prev
            return prev[file] === msg.tree ? prev : { ...prev, [file]: msg.tree }
          })
          setLinks((prev) => ({ ...prev, [file]: msg.links }))
          if (!msg.tree && layersVisibleRef.current) {
            treeRequests.current.add(file)
            reply({ type: "tree" })
          }
          if (shown) setGroupRects([])
          reply(modeFor(file))
          // Reload (the agent edited, undo, code): the selection comes back at the SAME
          // address, if it still exists — and with the group, if there is one.
          if (sel?.file === file && sel.path && sel.path.length > 0) {
            const group = groupPathsRef.current.filter((p) => p.length > 0)
            reply({ type: "select", path: sel.path, group: group.length ? group : [sel.path] })
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
        case "context": {
          // The bridge reports the pointer inside the iframe (artboard pixels); the canvas is
          // scaled, so the screen position comes from the iframe's real rectangle.
          const frame = iframes.current.get(file)
          const board = boardsRef.current.find((b) => b.file === file)
          if (!frame || !board) break
          const rect = frame.getBoundingClientRect()
          const scale = rect.width / Math.max(1, board.w)
          setMenu({ x: rect.left + msg.x * scale, y: rect.top + msg.y * scale, scope: "element", file })
          break
        }
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
        case "crossDrag": {
          const board = boardsRef.current.find((b) => b.file === file)
          if (!board) break
          if (msg.phase === "start") {
            beginCross(file, msg.paths, msg.rects, msg.grab)
            break
          }
          const c = crossRef.current
          if (!c || c.file !== file) break
          const point = { x: board.x + msg.x, y: board.y + msg.y }
          if (msg.phase === "move") crossMove(point, msg.mod)
          else if (msg.phase === "back") crossBack()
          else {
            if (msg.paths.length > 0) c.paths = msg.paths
            void crossFinish(msg.phase === "end", point, msg.mod)
          }
          break
        }
        case "boardDrag":
          if (msg.phase === "start") beginFreeDrag(file, msg)
          else if (msg.phase === "move") freeMove(msg.sx, msg.sy, msg.mod)
          else void freeFinish(msg.mod)
          break
        case "dropTarget": {
          const aim = crossRef.current?.over === file ? crossRef.current : freeDragRef.current?.over === file ? freeDragRef.current : null
          if (aim) aim.target = msg.parent ? { file, parent: msg.parent, index: msg.index } : null
          break
        }
        case "size": {
          // A loose piece is as big as its content: the artboard follows what the page reports.
          const board = boardsRef.current.find((b) => b.file === file)
          if (!board?.free) break
          const w = Math.max(1, Math.round(msg.w))
          const h = Math.max(1, Math.round(msg.h))
          if (Math.abs(board.w - w) < 1 && Math.abs(board.h - h) < 1) break
          setOverrides((prev) => ({ ...prev, [file]: { ...prev[file], w, h } }))
          window.clearTimeout(sizeTimers.current.get(file))
          sizeTimers.current.set(
            file,
            window.setTimeout(() => {
              sizeTimers.current.delete(file)
              updateBoard(file, { w, h })
            }, SIZE_PERSIST_MS),
          )
          break
        }
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
  }, [beginCross, beginFreeDrag, blurInspector, crossBack, crossFinish, crossMove, frameOf, freeFinish, freeMove, handleKey, mutateSource, mutateSourceHtml, modeFor, post, startPlay, updateBoard, wheel])

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

  /**
   * Divider of the inspector card: what moves is the EDGE of the card. Dragging it up
   * grows the strip below; dragging it left grows the column on the right — in both cases
   * the canvas gives the room. Double click goes back to the default size.
   */
  const startInspectorResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const card = inspectorRef.current
    const layout = layoutRef.current
    if (!card || !layout || e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const below = !wide
    const start = below ? e.clientY : e.clientX
    const startSize = below ? card.getBoundingClientRect().height : card.getBoundingClientRect().width
    const room = below ? layout.clientHeight : layout.clientWidth
    // The card never takes the canvas' last third — the same ceiling the CSS applies.
    const max = Math.max(INSPECTOR_MIN_PX, Math.min(INSPECTOR_MAX_PX, room * INSPECTOR_MAX_RATIO))
    const sizeAt = (clientX: number, clientY: number) =>
      Math.round(Math.min(max, Math.max(INSPECTOR_MIN_PX, startSize + (start - (below ? clientY : clientX)))))
    // The size is written straight into the element while the drag lasts: a render in the
    // middle (the canvas measuring itself) would put the previous size back.
    const fit = (clientX: number, clientY: number) => {
      const size = sizeAt(clientX, clientY)
      if (below) card.style.height = `${size}px`
      else card.style.width = `${size}px`
    }
    const onMove = (ev: PointerEvent) => fit(ev.clientX, ev.clientY)
    const onEnd = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", onMove)
      handle.removeEventListener("pointerup", onEnd)
      handle.removeEventListener("pointercancel", onEnd)
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId)
      document.body.style.cursor = ""
      const size = sizeAt(ev.clientX, ev.clientY)
      if (below) {
        setInspectorHeight(size)
        writeInspectorSize(INSPECTOR_HEIGHT_KEY, size)
      } else {
        setInspectorWidth(size)
        writeInspectorSize(INSPECTOR_WIDTH_KEY, size)
      }
    }
    handle.addEventListener("pointermove", onMove)
    handle.addEventListener("pointerup", onEnd)
    handle.addEventListener("pointercancel", onEnd)
    document.body.style.cursor = below ? "row-resize" : "col-resize"
  }
  const resetInspectorSize = () => {
    setInspectorHeight(INSPECTOR_DEFAULT_PX)
    setInspectorWidth(INSPECTOR_DEFAULT_PX)
    writeInspectorSize(INSPECTOR_HEIGHT_KEY, INSPECTOR_DEFAULT_PX)
    writeInspectorSize(INSPECTOR_WIDTH_KEY, INSPECTOR_DEFAULT_PX)
  }

  const panning = tool === "hand" || spaceHeld
  const dragging = drag !== null
  /** A drag of elements has left its artboard: the panel has the pointer now. */
  const crossOutside = ghost !== null

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
  const canUndo = undoStack.current.length > 0
  const canRedo = redoStack.current.length > 0

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
  const renderStrip = <T extends string,>(
    items: readonly { value: T; Icon: typeof Layers; label: string; busy?: boolean }[],
    active: T,
    onSelect: (value: T) => void,
    trailing?: React.ReactNode,
  ) => (
    <div className="flex shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5 py-1">
      {items.map(({ value, Icon, label, busy }) => (
        <button
          key={value}
          type="button"
          onClick={() => onSelect(value)}
          className={cn(
            "flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors",
            active === value ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <span className="relative flex items-center">
            <Icon className="size-3" />
            {busy && <span className="absolute -right-1 -top-1 size-1.5 animate-pulse rounded-full bg-emerald-500" />}
          </span>
          {label}
        </button>
      ))}
      {trailing && <span className="ml-auto flex items-center pr-0.5">{trailing}</span>}
    </div>
  )
  const renderTabStrip = (tabs: readonly InspectorTab[], active: InspectorTab) =>
    renderStrip(
      tabs.map((value) => ({ value, Icon: inspectorTabMeta[value][0], label: inspectorTabMeta[value][1] })),
      active,
      setInspectorTab,
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
            hiddenBoards={hiddenBoards}
            onToggleHidden={toggleHidden}
            onContextMenu={(file, p, x, y) => {
              const target = p && p.length > 0 ? p : null
              const current = selectionRef.current
              const inSelection =
                target &&
                current?.file === file &&
                (samePath(current.path, target) || groupPathsRef.current.some((g) => samePath(g, target)))
              if (!inSelection) selectLayer(file, target, false)
              setMenu({ x, y, scope: target ? "element" : "frame", file })
            }}
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
      ref={inspectorRef}
      className={cn(
        "flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden bg-sidebar",
        wide ? "max-w-[70%] border-l border-border/60" : "max-h-[70%] border-t border-border/60",
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

  // The card is a column on the right when the tab is wide and a strip at the bottom when
  // it is not. ONE variable decides the layout and the icon, so the button can never point
  // at a side the card is not on.
  const mod = /mac|iphone|ipad/i.test(navigator.platform) ? "⌘" : "Ctrl+"
  const contextItems = (m: { scope: "element" | "frame" | "canvas"; file: string; at?: { x: number; y: number } }): DesignMenuItem[] => {
    const canPaste = sharedClip !== null
    if (m.scope === "canvas") {
      return [{ label: t("design.ctx.pasteHere"), icon: ClipboardPaste, shortcut: `${mod}V`, disabled: !canPaste, onSelect: () => void paste(m.at) }]
    }
    if (m.scope === "frame") {
      const frameHidden = hiddenBoards.has(m.file)
      return [
        { label: t("design.ctx.copyFrame"), icon: Copy, shortcut: `${mod}C`, onSelect: () => void copySelected() },
        { label: t("design.ctx.paste"), icon: ClipboardPaste, shortcut: `${mod}V`, disabled: !canPaste, onSelect: () => void paste() },
        { separator: true },
        { label: t("design.present.playHere"), icon: Play, disabled: !canPlay(m.file), onSelect: () => startPlay(m.file) },
        {
          label: t("design.present.playTab"),
          icon: ExternalLink,
          disabled: !canPlay(m.file) || !designId,
          onSelect: () => designId && usePanelStore.getState().openDesignPlayTab(designId, m.file, fullscreen),
        },
        { separator: true },
        { label: t("design.exportPdf"), icon: Download, disabled: exporting, onSelect: () => void exportDesign("pdf", [m.file]) },
        { label: t("design.exportPng"), icon: FileImage, disabled: exporting, onSelect: () => void exportDesign("png", [m.file]) },
        { separator: true },
        {
          label: t(frameHidden ? "design.layersShow" : "design.layersHide"),
          icon: frameHidden ? Eye : EyeOff,
          onSelect: () => toggleHidden(m.file, null),
        },
      ]
    }
    const sel = selectionRef.current
    const members = groupPaths.filter((p) => p.length > 0)
    const multi = members.length >= 2
    const selTree = sel?.path && sel.path.length > 0 ? trees[sel.file] : undefined
    const nodeAt = (node: DesignTreeNode | undefined, p: ElementPath): DesignTreeNode | undefined =>
      p.reduce<DesignTreeNode | undefined>((acc, i) => (i >= 0 ? acc?.children.find((c) => c.path[c.path.length - 1] === i) : undefined), node)
    const isHidden = Boolean(sel?.path && nodeAt(selTree, sel.path)?.hidden)
    const hasEl = Boolean(sel?.path && sel.path.length > 0)
    return [
      { label: t("design.ctx.copy"), icon: Copy, shortcut: `${mod}C`, disabled: !hasEl, onSelect: () => void copySelected() },
      { label: t("design.ctx.cut"), icon: Scissors, shortcut: `${mod}X`, disabled: !hasEl, onSelect: () => void cutSelected() },
      { label: t("design.ctx.paste"), icon: ClipboardPaste, shortcut: `${mod}V`, disabled: !canPaste, onSelect: () => void paste() },
      { separator: true },
      { label: t("design.ctx.duplicate"), icon: Copy, shortcut: `${mod}D`, disabled: !hasEl, onSelect: duplicateSelected },
      { label: t("design.ctx.delete"), icon: Trash2, shortcut: "⌫", disabled: !hasEl, destructive: true, onSelect: deleteSelected },
      { separator: true },
      { label: t("design.ctx.group"), icon: Group, shortcut: `${mod}G`, disabled: !multi, onSelect: () => wrapSelected("block") },
      { label: t("design.ctx.autoLayout"), icon: LayoutPanelLeft, shortcut: "⇧A", disabled: !multi, onSelect: () => wrapSelected("flex") },
      { separator: true },
      { label: t("design.ctx.moveUp"), icon: ArrowUp, shortcut: "⌥↑", disabled: !hasEl || multi, onSelect: () => stepSelected("up") },
      { label: t("design.ctx.moveDown"), icon: ArrowDown, shortcut: "⌥↓", disabled: !hasEl || multi, onSelect: () => stepSelected("down") },
      {
        label: t(isHidden ? "design.layersShow" : "design.layersHide"),
        icon: isHidden ? Eye : EyeOff,
        shortcut: `${mod}⇧H`,
        disabled: !hasEl,
        onSelect: toggleHiddenSelected,
      },
    ]
  }

  const inspectorBelow = !wide
  const InspectorIcon = inspectorOpen
    ? inspectorBelow
      ? PanelBottomClose
      : PanelRightClose
    : inspectorBelow
      ? PanelBottomOpen
      : PanelRightOpen

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
      <TabHeader
        icon={LayoutGrid}
        iconClassName="text-violet-400"
        title={title}
        tag={wide && boards.length > 0 ? <Badge variant="outline" className="shrink-0">{t("design.boardsCount", { count: boards.length })}</Badge> : undefined}
      >
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
          <Hint label={t("design.redo")}>
            <Button variant="ghost" size="icon-sm" disabled={!canRedo} aria-label={t("design.redo")} onClick={redo}>
              <Redo2 className="size-3.5" />
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
          <DropdownMenu>
            <Hint label={exporting ? t("design.exporting") : t("design.export")}>
              <DropdownMenuTrigger
                disabled={exporting || !designId || boards.length === 0}
                aria-label={t("design.export")}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("design.exportAll")}</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => exportDesign("pdf")}>{t("design.exportPdf")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportDesign("png")}>{t("design.exportPng")}</DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("design.exportSelection")}</DropdownMenuLabel>
                <DropdownMenuItem disabled={!selection} onClick={() => exportDesign("pdf", selection ? [selection.file] : undefined)}>
                  {t("design.exportPdf")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!selection} onClick={() => exportDesign("png", selection ? [selection.file] : undefined)}>
                  {t("design.exportPng")}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* The panels button comes first and the fullscreen one sits right next to it.
              In fullscreen the floating buttons of the sidebars are what open/close them */}
          {!fullscreen && (
            <IconAction
              icon={InspectorIcon}
              label={t(inspectorOpen ? "design.hideInspector" : "design.showInspector")}
              active={inspectorOpen}
              onClick={() => setInspectorOpen((v) => !v)}
            />
          )}
          <IconAction
            icon={fullscreen ? Minimize2 : Maximize2}
            label={t(fullscreen ? "design.exitFullscreen" : "design.fullscreen")}
            onClick={() => setFullscreen((v) => !v)}
          />
        </TabHeader>

      {state.status === "error" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="break-words">{state.message}</span>
        </div>
      )}
      {menu && (
        <DesignContextMenu x={menu.x} y={menu.y} items={contextItems(menu)} onClose={() => setMenu(null)} />
      )}
      {exportError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{exportError}</span>
          <button type="button" aria-label={t("common.close")} onClick={() => setExportError(null)}>
            <X className="size-3" />
          </button>
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

      <div ref={layoutRef} className={cn("relative flex min-h-0 flex-1", wide ? "flex-row" : "flex-col")}>
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
          onContextMenu={(e) => {
            // The empty canvas: the place to paste a loose piece (the artboards have their own menus).
            if (e.target !== e.currentTarget && (e.target as HTMLElement).dataset.canvasLayer === undefined) return
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, scope: "canvas", file: "", at: canvasPoint(e.clientX, e.clientY) })
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
              // A reload keeps the old document on screen until the new one has loaded (see `promote`).
              const wantKey = wantedKey(board.file)
              const shownKey = shownKeys.current[board.file] ?? wantKey
              const frameKeys = shownKey === wantKey ? [wantKey] : [shownKey, wantKey]
              return (
                <div key={board.file} className="absolute" style={{ left: board.x, top: board.y, width: board.w, height: board.h }}>
                  {/* Artboard header: the name on the left (clicking selects the frame,
                      dragging moves it) and, on the right, the presentation actions — only
                      where there is somewhere to navigate. Same scale as the canvas. */}
                  {!board.free && (
                  <div
                    className="absolute left-0 flex items-center justify-between"
                    style={{ bottom: "100%", marginBottom: 4 / zoom, width: board.w, gap: 8 / zoom, fontSize: 11 / zoom, lineHeight: 1.3 }}
                  >
                    <Truncate text={board.title ?? board.file}>
                      <div
                        className={cn(
                          "min-w-0 cursor-default truncate font-medium whitespace-nowrap",
                          hiddenBoards.has(board.file) && "opacity-50",
                          isBoardSelected || isPlaying ? "text-primary" : "text-muted-foreground hover:text-foreground",
                        )}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          select({ file: board.file, path: null })
                          setMenu({ x: e.clientX, y: e.clientY, scope: "frame", file: board.file })
                        }}
                        onPointerDown={(e) => {
                          if (e.button === 2) return
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
                  )}
                  <div
                    // A loose piece has no frame: no background, no shadow, no outline — only its content.
                    className={cn("relative", !board.free && "overflow-hidden bg-white shadow-sm")}
                    style={{
                      width: board.w,
                      height: board.h,
                      visibility: hiddenBoards.has(board.file) ? "hidden" : undefined,
                      outline: board.free
                        ? undefined
                        : isPlaying
                          ? `${2 / zoom}px solid var(--primary)`
                          : `${1 / zoom}px solid color-mix(in oklab, var(--border) 80%, transparent)`,
                    }}
                  >
                    {frameKeys.map((frameKey) => (
                      <iframe
                        ref={(el) => {
                          if (el) {
                            frameRefs.current.set(frameKey, el)
                            frameFiles.current.set(frameKey, board.file)
                          } else {
                            frameRefs.current.delete(frameKey)
                            frameFiles.current.delete(frameKey)
                          }
                        }}
                        // The key carries the FILE version: an artboard that has not changed stays
                        // mounted (with its scroll and selection). A new version mounts BESIDE the
                        // old one and takes its place once loaded.
                        key={frameKey}
                        onLoad={() => {
                          if (frameKey === wantedKey(board.file)) promote(board.file, frameKey)
                        }}
                        // The file version enters through the key, not through the URL: that way
                        // the address stays stable and the scheme's ETag can return 304.
                        src={`${DESIGN_SCHEME}://${designId}/${encodeFile(board.file)}?v=${reloads}`}
                        title={board.title ?? board.file}
                        sandbox="allow-scripts"
                        allow=""
                        referrerPolicy="no-referrer"
                        className="absolute top-0 left-0 border-0"
                        style={{
                          width: board.w,
                          height: board.h,
                          pointerEvents: frameKey !== shownKey || panning || dragging || crossOutside || freeDragging ? "none" : "auto",
                          // The document that is still loading is there, but not seen.
                          opacity: frameKey !== shownKey ? 0 : undefined,
                          // A transparent page over a dark app: without this the browser paints the frame opaque.
                          colorScheme: board.free ? "light" : undefined,
                        }}
                      />
                    ))}
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
                  {dropOver === board.file && (
                    <div
                      className="pointer-events-none absolute inset-0"
                      style={{ outline: `${2 / zoom}px solid var(--primary)`, background: "color-mix(in oklab, var(--primary) 6%, transparent)" }}
                    />
                  )}
                  {isBoardSelected && (
                    <div className="pointer-events-none absolute inset-0" style={{ outline: `${line}px solid var(--primary)` }}>
                      {/* A loose piece is as big as its content: there is nothing to resize. */}
                      {!board.free && corners.map((corner) => (
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
            {/* The elements being dragged out of an artboard: a placeholder of their size under
                the pointer, until they are dropped into an artboard or onto the empty canvas. */}
            {ghost && (
              <div
                className="pointer-events-none absolute z-30 rounded-[2px]"
                style={{
                  left: ghost.x,
                  top: ghost.y,
                  width: ghost.w,
                  height: ghost.h,
                  border: `${1.5 / zoom}px dashed var(--primary)`,
                  background: "color-mix(in oklab, var(--primary) 14%, transparent)",
                }}
              />
            )}
          </div>

          {/* Hand / Space / drag in progress: a layer over the iframes, which
              would otherwise swallow the pointer. */}
          {(panning || dragging || crossOutside || freeDragging) && (
            <div className="absolute inset-0 z-20" onPointerDown={(e) => panning && startPan(e, false)} />
          )}
        </div>

        {/* The card's edge: dragging it resizes the inspector (height below, width on the
            right) — the same gesture as the app's panels. Double click resets it. */}
        {!fullscreen && inspectorOpen && (
          <>
            <div
              role="separator"
              aria-orientation={wide ? "vertical" : "horizontal"}
              aria-label={t("design.resizeInspector")}
              title={t("design.resizeInspector")}
              onPointerDown={startInspectorResize}
              onDoubleClick={resetInspectorSize}
              className={cn(
                "group/card flex shrink-0 touch-none items-center justify-center",
                wide ? "h-full w-1.5 cursor-col-resize" : "h-1.5 w-full cursor-row-resize",
              )}
            >
              <div
                className={cn(
                  "rounded-full bg-transparent transition-colors group-hover/card:bg-primary/60",
                  wide ? "h-8 w-0.5" : "h-0.5 w-8",
                )}
              />
            </div>
            {inspector}
          </>
        )}

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
              {renderStrip(
                [
                  { value: "layers" as const, Icon: Layers, label: t("design.inspector.layers") },
                  { value: "conversation" as const, Icon: chat.kind ? AGENT_META[chat.kind].icon : MessagesSquare, label: t("design.inspector.conversation"), busy: agentBusy },
                ],
                leftTab,
                setLeftTab,
                leftTab === "conversation" ? (
                  <ArtifactChatTools
                    kind={chat.kind}
                    chats={chat.chats}
                    sessionId={chatSessionId}
                    onSelect={chat.select}
                    onNew={() => void chat.createEmbedded()}
                  />
                ) : undefined,
              )}
              {leftTab === "layers" ? (
                <div className="min-h-0 flex-1 overflow-y-auto">{renderInspectorBody("layers")}</div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <ConversationBody
                    sessionId={chatSessionId}
                    active={leftSideOpen && leftTab === "conversation"}
                    onAsk={() => {
                      setLeftSideOpen(true)
                      setLeftTab("conversation")
                    }}
                  />
                </div>
              )}
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
            <FullscreenComposer
              sessionId={chatSessionId}
              pinned={composerPinned}
              onTogglePin={() => setComposerPinned((v) => !v)}
            />
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
  sessionId,
}: {
  designId?: string
  title: string
  path?: string
  playFile?: string
  /** The presentation was born from the fullscreen editor — the tab already enters like this. */
  playFullscreen?: boolean
  /** Conversation that owns the tab — the fullscreen composer talks to it (chat or code mode). */
  sessionId?: string
}) {
  if (designId && playFile)
    return <DesignPresenter designId={designId} title={title} startFile={playFile} initialFullscreen={playFullscreen} />
  return <DesignEditor designId={designId} title={title} path={path} sessionId={sessionId} />
}
