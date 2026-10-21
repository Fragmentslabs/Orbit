import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
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

/**
 * Editor do canvas de design na aba do painel direito — navegável, selecionável
 * e editável, no molde do editor de design do Claude (e do Figma).
 *
 * O que está na tela é o próprio HTML dos artboards, cada um num iframe sandbox
 * (sem allow-same-origin). Não existe modelo paralelo: a ponte injetada em cada
 * artboard (electron/lib/design/design-runtime.ts) lê e mexe no DOM ao vivo, e
 * toda edição feita aqui — propriedade, texto, apagar, código — é aplicada no
 * FONTE do arquivo pelo mesmo endereço (caminho de filhos a partir do <body>),
 * via DOMParser. As camadas são o DOM lido na hora; o código é o arquivo.
 *
 * Navegação: arrastar o fundo (ou segurar Espaço / ferramenta Mão) move o
 * canvas; a roda move, Ctrl+roda (ou pinça) dá zoom em torno do cursor —
 * inclusive por cima de um artboard, porque a ponte repassa a roda para cá.
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
  /** null = o artboard inteiro. */
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
/** Quanto tempo o aviso de mudança no disco é ignorado depois de uma escrita
 *  NOSSA que já está aplicada ao vivo — recarregar ali só piscaria a tela. */
const QUIET_MS = 1500
const STYLE_PERSIST_MS = 300

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

/**
 * Ordem de dois caminhos: o do DOM vem antes. É o que ordena a seleção
 * múltipla (o grupo sai na ordem em que os elementos aparecem na tela).
 */
const pathOrder = (a: ElementPath, b: ElementPath) => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}
/** Espaçamento das bolinhas do fundo, em px de TELA. Acompanha o canvas
 *  (20 unidades × zoom), mas com um piso: abaixo dele o passo dobra (2×, como
 *  o grid do Figma) — no zoom out o fundo escala junto em vez de virar poeira. */
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
  // Artboard em apresentação (Play no canvas): ele roda como página — links e
  // botões funcionam —, e os demais seguem editáveis.
  const [playing, setPlaying] = useState<string | null>(null)
  const playingRef = useRef(playing)
  playingRef.current = playing
  /** Links relativos que cada artboard declara (a ponte avisa ao carregar): é o
   *  que decide quem ganha o botão Play. */
  const [links, setLinks] = useState<Record<string, string[]>>({})
  const [reloads, setReloads] = useState(0)
  const [selection, setSelection] = useState<Selection | null>(null)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const [info, setInfo] = useState<DesignElementInfo | null>(null)
  const [selRect, setSelRect] = useState<DesignRect | null>(null)
  /** Contornos dos DEMAIS membros da seleção múltipla (o primário usa selRect). */
  const [groupRects, setGroupRects] = useState<DesignRect[]>([])
  /** A seleção múltipla (caminhos de irmãos); o primário é `selection.path`. */
  const [groupPaths, setGroupPaths] = useState<ElementPath[]>([])
  const groupPathsRef = useRef(groupPaths)
  groupPathsRef.current = groupPaths
  const [hover, setHover] = useState<{ file: string; rect: DesignRect } | null>(null)
  const [trees, setTrees] = useState<Record<string, DesignTreeNode | undefined>>({})
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("properties")
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [codeFile, setCodeFile] = useState<string | null>(null)
  const [codeVersion, setCodeVersion] = useState(0)
  const [overrides, setOverrides] = useState<Record<string, Partial<DesignBoardView>>>({})
  const [fullscreen, setFullscreen] = useState(false)
  // Tela cheia: sidebars flutuantes (abertas por padrão) e o composer em hover
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
  /** Último tamanho do elemento no resize — fora do estado, para os re-renders
   *  do meio do arrasto (cada passo devolve `info`) não o perderem. */
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

  const bounds = useMemo(() => {
    if (boards.length === 0) return null
    const minX = Math.min(...boards.map((b) => b.x))
    const minY = Math.min(...boards.map((b) => b.y))
    const maxX = Math.max(...boards.map((b) => b.x + b.w))
    const maxY = Math.max(...boards.map((b) => b.y + b.h))
    return { minX, minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
  }, [boards])

  // ----------------------------------------------------------------- vista
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

  /** Zoom em torno de um ponto da viewport (o que estiver sob o cursor fica parado). */
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
        // Um passo de roda (~100) dá ~22%; a pinça do trackpad manda deltas
        // pequenos e contínuos. O teto por evento evita saltos de roda "rápida".
        const delta = Math.max(-80, Math.min(80, dy * scale))
        zoomAt(sx, sy, (z) => z * Math.exp(-delta * 0.002))
      } else {
        // Shift inverte os eixos: a roda vira pan horizontal (como nos
        // navegadores e no Figma).
        const hx = shift ? dy : dx
        const hy = shift ? dx : dy
        setView((v) => ({ ...v, x: v.x - hx * scale, y: v.y - hy * scale }))
      }
    },
    [zoomAt],
  )

  // A roda fora dos artboards (no fundo). `passive: false` porque o zoom precisa
  // cancelar o zoom da página.
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

  // Layout do inspetor: ao lado do canvas quando cabe, embaixo quando o painel
  // é estreito (o caso normal da aba lateral).
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const update = () => setWide(el.clientWidth >= WIDE_LAYOUT_PX)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // --------------------------------------------------------------- ponte
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
   * Seleção na LISTA DE CAMADAS: o clique troca, o Shift+clique alterna o
   * elemento no grupo — e só entre irmãos, como no canvas (um grupo é sempre
   * um conjunto de irmãos).
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
      // O Shift trabalha no MESMO NÍVEL da seleção: o alvo sobe até a
      // profundidade do selecionado, para o grupo não virar uma mistura de
      // níveis (e para não sugerir coisas fundas da árvore).
      if (additive && primary && target.length > primary.length) target = target.slice(0, primary.length)
      // Texto solto entra na seleção sozinho: ele não forma grupo.
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

  // Modo apresentação: o artboard em Play funciona como página (links, botões)
  // e a seleção sai de cena; os outros continuam editáveis.
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

  /** Enquadra um artboard na viewport (o Play entra "dentro" dele). */
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

  /** O artboard tem para onde ir? Ele aponta (`<a href>`) para outro do canvas. */
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

  // ------------------------------------------------------------- edição
  const pushUndo = useCallback((file: string, html: string) => {
    const stack = undoStacks.current.get(file) ?? []
    stack.push(html)
    if (stack.length > UNDO_LIMIT) stack.shift()
    undoStacks.current.set(file, stack)
    lastEdited.current = file
    setUndoCount((n) => n + 1)
  }, [])

  /** Escritas no MESMO artboard em fila: duas edições seguidas não podem ler o
   *  mesmo fonte e uma apagar a outra. */
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
   * Aplica a mudança no FONTE do artboard. `quiet`: a mudança já está na tela
   * (a ponte aplicou ao vivo), então o aviso do disco que vem a seguir não
   * recarrega nada; mudanças de estrutura (apagar, desfazer, código) recarregam.
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
   * Arrasto na LISTA DE CAMADAS: a camada solta sobre outra vira uma mudança
   * de estrutura. O plano sai do FONTE (o que manda nos índices) e vai para o
   * arquivo; a ponte aplica o MESMO plano no DOM ao vivo, para o canvas não
   * ficar para trás até o próximo reload.
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
          // Remoções antes das definições (o mesmo motivo do arraste ao vivo:
          // o shorthand expande para os longhands).
          const entries = Object.entries(entry.styles).sort(([, a], [, b]) => (a === "" ? -1 : b === "" ? 1 : 0))
          for (const [prop, value] of entries) setInlineStyle(el, prop, value)
        },
        true,
      )
    },
    [mutateSource],
  )

  /**
   * Os caminhos de TODOS os selecionados (o primário e o resto do grupo) —
   * é neles que uma alteração de propriedade vale: mexer num só é mexer em
   * todos. Texto solto não tem estilo: o que ele herda é do pai, e é no pai
   * que a mudança age.
   */
  const styleTargets = useCallback((): ElementPath[] => {
    const sel = selectionRef.current
    if (!sel?.path) return []
    const group = groupPathsRef.current.filter((p) => p.length > 0)
    const all = group.length ? group.slice() : []
    // O primário sempre entra: é ele que está selecionado.
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
      // As REMOÇÕES vão antes das definições: no CSSOM o shorthand expande
      // para os longhands, então apagar "padding-top" depois de pôr "padding"
      // desfaria o próprio valor (o campo voltava ao anterior).
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
    // Com grupo, apaga o grupo inteiro (a seleção múltipla é uma coisa só).
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

  // --------------------------------------------------- mensagens da ponte
  const blurInspector = useCallback(() => {
    const active = document.activeElement as HTMLElement | null
    if (active && active !== document.body && rootRef.current?.contains(active) && !active.closest(".cm-editor")) active.blur()
  }, [])

  const fileOf = useCallback((source: MessageEventSource | null) => {
    for (const [file, frame] of iframes.current) if (frame.contentWindow && frame.contentWindow === source) return file
    return null
  }, [])

  /**
   * "Envolver" a seleção: os elementos viram filhos de um div novo, que entra
   * no lugar do primeiro deles. `flex` vira uma linha ou uma coluna (conforme
   * onde eles estão); `block` vira um div de bloco.
   */
  const wrapSelected = useCallback(
    (mode: "flex" | "block") => {
      const sel = selectionRef.current
      if (!sel?.path) return
      const group = groupPathsRef.current.filter((p) => p.length > 0)
      const paths = group.length > 1 ? group.slice() : []
      // O primário sempre entra (é ele que está selecionado).
      if (paths.length && !paths.some((p) => samePath(p, sel.path!))) paths.push(sel.path!)
      if (paths.length < 2) return
      // A direção do flex: lado a lado (centros espalhados na horizontal) é
      // linha; empilhados (espalhados na vertical) é coluna.
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
        // A ponte aplica o MESMO plano no DOM ao vivo: o canvas muda na hora.
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
        // Agrupar: os selecionados viram filhos de um div de bloco.
        wrapSelected("block")
        return true
      }
      if (mod) return false
      if (key.shift && lower === "a") {
        // Alinhar: os selecionados viram filhos de um div flex (linha ou
        // coluna, conforme onde estão).
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
          setTrees((prev) => ({ ...prev, [file]: msg.tree }))
          setLinks((prev) => ({ ...prev, [file]: msg.links }))
          setGroupRects([])
          post(file, modeFor(file))
          // Recarga (o agente editou, desfazer, código): a seleção volta no MESMO
          // endereço, se ele ainda existir — e com o grupo, se houver.
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
          // Link clicado no artboard em Play: a apresentação segue para a tela
          // que ele aponta (se for uma do canvas).
          if (playingRef.current !== file) break
          const target = boardForHref(msg.href, boardsRef.current.map((b) => b.file))
          if (target) startPlay(target)
          break
        }
        case "hover":
          setHover((prev) => (msg.rect && msg.path ? { file, rect: msg.rect } : prev?.file === file ? null : prev))
          break
        case "select":
          // O clique no artboard não tira o foco do painel (a ponte cancela o
          // mousedown): um campo do inspetor no meio da edição seguiria focado e
          // a edição se perderia com a troca de seleção. O blur confirma o campo
          // AGORA, ainda contra a seleção anterior.
          blurInspector()
          // O runtime logo manda um `rects` com os contornos dos demais membros.
          setGroupRects([])
          if (msg.path && msg.path.length > 0) {
            setSelection({ file, path: msg.path })
            setInfo(msg.info)
            setSelRect(msg.info?.rect ?? null)
            // O grupo volta na ordem do DOM (é a ordem dos elementos na tela).
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
          // Fallback: normalmente o mousedown nativo do duplo clique já deu
          // foco ao iframe. Só intervimos se ele ainda estiver no painel —
          // focar de novo reiniciaria a seleção/cursor que o nativo colocou.
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
          // O arraste já aconteceu na tela (a ponte reordenou o DOM ao vivo);
          // aqui só o fonte passa a contar a mesma história. A lista de Camadas
          // veio da árvore antiga, então pede uma nova.
          void mutateSource(file, msg.parent, (el) => reorderChildren(el, msg.order), true).then(() => {
            post(file, { type: "tree" })
          })
          break
        case "move":
          // Mesma ideia do reorder, mas trocando de pai: a ponte já moveu o
          // elemento (ou o bloco da seleção múltipla) ao vivo; o fonte recebe
          // o mesmo movimento.
          void mutateSourceHtml(file, (html) => moveElements(html, msg.paths, msg.parent, msg.index), true).then(() => {
            post(file, { type: "tree" })
          })
          break
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [blurInspector, fileOf, handleKey, mutateSource, mutateSourceHtml, modeFor, post, startPlay, wheel])

  // Qualquer clique FORA dos artboards encerra a edição de texto em andamento
  // (eventos do iframe não chegam aqui, então um pointerdown no painel significa
  // que o clique foi fora). O `blur` da janela do artboard também cobre isso, mas
  // clicar num elemento não-focável do painel pode não tirar o foco do iframe.
  useEffect(() => {
    const onPointerDown = () => {
      for (const file of iframes.current.keys()) post(file, { type: "blur" })
    }
    window.addEventListener("pointerdown", onPointerDown, true)
    return () => window.removeEventListener("pointerdown", onPointerDown, true)
  }, [post])

  // Atalhos com o foco FORA dos artboards (dentro, a ponte os repassa).
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

  // O agente (ou outra janela) mudou a pasta: recarrega índice e artboards —
  // menos quando a mudança é nossa e já está na tela.
  useEffect(() => {
    if (!designId) return
    return designApi.onChanged((payload) => {
      if (payload.id !== designId) return
      setCodeVersion((n) => n + 1)
      if (Date.now() < quietUntil.current) return
      setReloads((n) => n + 1)
      load()
    })
  }, [designId, load])

  // --------------------------------------------------------------- arrastos
  const toCanvas = useCallback((dx: number, dy: number) => ({ dx: dx / viewRef.current.zoom, dy: dy / viewRef.current.zoom }), [])

  // Os listeners do arrasto são ligados NO pointerdown (ver beginDrag), não num
  // efeito: um arrasto rápido manda os primeiros pointermove antes de o efeito
  // rodar, e eles se perdiam. Os handlers leem o estado pelos refs.
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
            // Quantos elementos estão selecionados (o painel edita todos).
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
  /** A faixa de abas do inspetor: `tabs` decide quais aparecem (na tela cheia
   *  as camadas têm sidebar própria, então a da direita só tem as outras duas). */
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
  /** O arquivo que a aba de código mostra (o escolhido, ou o primeiro). */
  const codeShownFile = codeFile && boards.some((b) => b.file === codeFile) ? codeFile : (boards[0]?.file ?? null)
  /** A seleção do canvas só realça o código quando é do MESMO arquivo. */
  const codeSelectionPath = selection && selection.file === codeShownFile ? selection.path : null
  /** O conteúdo de uma aba do inspetor — o mesmo no painel lateral e nas
   *  sidebars flutuantes da tela cheia. */
  const renderInspectorBody = (tab: InspectorTab) => (
      <>
        {tab === "properties" && (
          <DesignProperties
            target={target}
            onStyles={(styles) => {
              if (!selection?.path) return
              // Vale para TODOS os selecionados: é o que faz a edição em
              // grupo valer.
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
              // Texto solto: muda o CONTEÚDO do nó. Elemento: o HTML de dentro.
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
                // A linha do ARTBOARD: o contorno é o quadro inteiro.
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

  // Tela cheia: camadas à esquerda; propriedades e código (abas) à direita.
  // Se a aba ativa era "camadas", a direita cai em "propriedades".
  const rightTab: InspectorTab = inspectorTab === "layers" ? "properties" : inspectorTab

  return (
    <div
      ref={rootRef}
      className={cn(
        // Em tela cheia o MESMO nó vira o overlay fixo (como o browser e o
        // motion): o iframe não é remontado e a ponte de seleção sobrevive.
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sidebar",
        fullscreen && FULLSCREEN_OVERLAY_CLASS,
      )}
    >
      {/* Cabeçalho: o canvas à esquerda; ferramentas, zoom e vista à direita. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 p-2">
        <div className="flex min-w-0 items-center gap-2">
          <LayoutGrid className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium text-muted-foreground">{title}</span>
          {wide && boards.length > 0 && (
            <Badge variant="outline" className="shrink-0">
              {t("design.boardsCount", { count: boards.length })}
            </Badge>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant={tool === "select" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-pressed={tool === "select"}
            title={t("design.tools.select")}
            aria-label={t("design.tools.select")}
            onClick={() => {
              setTool("select")
              setPlaying(null)
            }}
          >
            <MousePointer2 className="size-3.5" />
          </Button>
          <Button
            variant={tool === "hand" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-pressed={tool === "hand"}
            title={t("design.tools.hand")}
            aria-label={t("design.tools.hand")}
            onClick={() => setTool("hand")}
          >
            <Hand className="size-3.5" />
          </Button>
          <div className="mx-1 h-4 w-px bg-border" />
          {/* No painel estreito o −/+ sai: o zoom segue no Ctrl+roda, na pinça
              e nos atalhos, e o título do canvas precisa do espaço. */}
          {wide && <IconAction icon={Minus} label={t("design.zoomOut")} onClick={() => zoomCenter((z) => z / 1.25)} />}
          <button
            type="button"
            title={t("design.fit")}
            onClick={fit}
            className="w-10 shrink-0 rounded text-center text-[11px] tabular-nums text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          >
            {Math.round(zoom * 100)}%
          </button>
          {wide && <IconAction icon={Plus} label={t("design.zoomIn")} onClick={() => zoomCenter((z) => z * 1.25)} />}
          <div className="mx-1 h-4 w-px bg-border" />
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!canUndo}
            title={t("design.undo")}
            aria-label={t("design.undo")}
            onClick={undo}
          >
            <Undo2 className="size-3.5" />
          </Button>
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
          {/* Na tela cheia quem abre/fecha são os botões flutuantes das sidebars */}
          {!fullscreen && (
            <IconAction
              icon={inspectorOpen ? PanelRightClose : PanelRightOpen}
              label={t(inspectorOpen ? "design.hideInspector" : "design.showInspector")}
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
        {/* Canvas infinito: uma camada transformada (translate + scale) com os
            artboards nas coordenadas do canvas.json. */}
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
              const isBoardSelected = selection?.file === board.file && selection.path === null
              const isPlaying = playing === board.file
              const elementRect = selection?.file === board.file && selection.path ? selRect : null
              const groupRectList = selection?.file === board.file && selection.path ? groupRects : []
              const hoverRect = hover?.file === board.file && !dragging ? hover.rect : null
              return (
                <div key={board.file} className="absolute" style={{ left: board.x, top: board.y, width: board.w, height: board.h }}>
                  {/* Cabeçalho do artboard: o nome à esquerda (clicar seleciona o quadro,
                      arrastar o move) e, à direita, as ações de apresentação — só
                      onde há para onde navegar. Mesma escala do canvas. */}
                  <div
                    className="absolute left-0 flex items-center justify-between"
                    style={{ bottom: "100%", marginBottom: 4 / zoom, width: board.w, gap: 8 / zoom, fontSize: 11 / zoom, lineHeight: 1.3 }}
                  >
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
                    {canPlay(board.file) && (
                      <div className="flex shrink-0 items-center" style={{ gap: 4 / zoom }}>
                        {isPlaying ? (
                          <button
                            type="button"
                            title={t("design.present.stop")}
                            aria-label={t("design.present.stop")}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => setPlaying(null)}
                            className="flex items-center justify-center rounded-sm bg-primary text-primary-foreground"
                            style={{ width: 18 / zoom, height: 18 / zoom }}
                          >
                            <Square style={{ width: 9 / zoom, height: 9 / zoom }} fill="currentColor" />
                          </button>
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
                      key={`${board.file}:${reloads}`}
                      src={`${DESIGN_SCHEME}://${designId}/${encodeFile(board.file)}?r=${reloads}`}
                      title={board.title ?? board.file}
                      sandbox="allow-scripts"
                      allow=""
                      referrerPolicy="no-referrer"
                      className="absolute top-0 left-0 border-0"
                      style={{ width: board.w, height: board.h, pointerEvents: panning || dragging ? "none" : "auto" }}
                    />
                  </div>

                  {/* Contornos: desenhados AQUI, por cima do iframe — nada entra no
                      DOM do artboard (o caminho dos elementos não pode mudar). */}
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

          {/* Mão / Espaço / arrasto em curso: uma camada por cima dos iframes, que
              senão engoliriam o ponteiro. */}
          {(panning || dragging) && (
            <div className="absolute inset-0 z-20" onPointerDown={(e) => panning && startPan(e, false)} />
          )}
        </div>

        {!fullscreen && inspectorOpen && inspector}

        {/* Tela cheia: o canvas ocupa tudo e as sidebars flutuam por cima, com a
            aparência da sidebar padrão (redonda, flutuante, abre no hover da
            borda quando fechada). Esquerda: camadas. Direita: propriedades e
            código, em abas como no painel lateral. */}
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

/** O hover é o próprio selecionado? (então só um contorno aparece) */
function samePathRect(a: DesignRect, b: DesignRect): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5
}

/** Com `playFile` a aba APRESENTA o canvas (uma tela por vez); sem ele, edita. */
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
  /** A apresentação nasceu do editor em tela cheia — a aba já entra assim. */
  playFullscreen?: boolean
}) {
  if (designId && playFile)
    return <DesignPresenter designId={designId} title={title} startFile={playFile} initialFullscreen={playFullscreen} />
  return <DesignEditor designId={designId} title={title} path={path} />
}
