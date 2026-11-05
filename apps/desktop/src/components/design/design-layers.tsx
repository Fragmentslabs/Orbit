import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Box, ChevronRight, Eye, EyeOff, ImageIcon, LayoutGrid, Loader2, MousePointerClick, Shapes, Type, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { samePath, type DesignNodeKind, type DesignTreeNode, type DropMode, type ElementPath } from "./design-protocol"
import type { DesignBoardView } from "./design-properties"

import { Hint } from "@/components/ui/hint"
/**
 * Layers of the canvas: the artboards and, inside each one, the DOM tree — read
 * live by the bridge, and not kept anywhere. The HTML IS the model; this
 * list is only a view of it (which is why it never goes out of sync with what is on screen).
 *
 * The list is also where the structure changes: dragging a layer over another
 * reorders the siblings or moves the element inside another one — the panel writes
 * to the source and the bridge applies the same change to the live DOM, so the canvas does not
 * lag behind.
 */

const KIND_ICON: Record<DesignNodeKind, LucideIcon> = {
  text: Type,
  image: ImageIcon,
  svg: Shapes,
  input: MousePointerClick,
  box: Box,
}

/** The payload of the drag between rows: only the identity of the dragged layer. */
const LAYER_DND_MIME = "application/x-orbit-design-layer"

const keyOf = (file: string, path: ElementPath) => `${file}:${path.join(".")}`

/** Is `a` an ancestor of `b`? (the path is the chain of child indexes) */
const isAncestor = (a: ElementPath, b: ElementPath) =>
  a.length < b.length && a.every((n, i) => b[i] === n)

interface Props {
  boards: DesignBoardView[]
  trees: Record<string, DesignTreeNode | undefined>
  selection: { file: string; path: ElementPath | null } | null
  /** The OTHER members of the multiple selection (the primary one is `selection.path`). */
  group: ElementPath[]
  /** `additive` = Shift+click: toggles the element in the group. */
  onSelect: (file: string, path: ElementPath | null, additive: boolean) => void
  /** `file` null = the pointer left the list (removes the outline). */
  onHover: (file: string | null, path: ElementPath | null) => void
  /** Layer drag: `fromPath` was dropped over `targetPath`. */
  onMove: (file: string, fromPath: ElementPath, targetPath: ElementPath, mode: DropMode) => void
  /** Artboards hidden on the canvas (the element ones come in the tree as `hidden`). */
  hiddenBoards: Set<string>
  /** The eye: `path` null = the whole artboard. */
  onToggleHidden: (file: string, path: ElementPath | null) => void
  /** Right click on a row (`path` null = the artboard), at the pointer's screen position. */
  onContextMenu: (file: string, path: ElementPath | null, x: number, y: number) => void
}

export function DesignLayers({
  boards,
  trees,
  selection,
  group,
  onSelect,
  onHover,
  onMove,
  hiddenBoards,
  onToggleHidden,
  onContextMenu,
}: Props) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  /** Where the dropped row is going to land (row + mode) — the drag guide. */
  const [drop, setDrop] = useState<{ key: string; mode: DropMode } | null>(null)
  const dragging = useRef<{ file: string; path: ElementPath } | null>(null)
  const selectedRef = useRef<HTMLButtonElement | null>(null)

  // The selection made on the canvas opens its ancestors in the list and scrolls there —
  // otherwise clicking a button deep down would have no visible response here.
  const selectionKey = selection ? keyOf(selection.file, selection.path ?? []) : null
  useEffect(() => {
    if (!selection) return
    setCollapsed((prev) => {
      const next = new Set(prev)
      let changed = false
      const path = selection.path ?? []
      for (let i = 0; i <= path.length; i++) {
        const key = keyOf(selection.file, path.slice(0, i))
        if (next.delete(key)) changed = true
      }
      return changed ? next : prev
    })
    window.setTimeout(() => selectedRef.current?.scrollIntoView({ block: "nearest" }), 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey])

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const rows = useMemo(() => {
    const out: { file: string; node: DesignTreeNode | null; board?: DesignBoardView; depth: number; key: string; hasChildren: boolean; inheritedHidden: boolean }[] = []
    for (const board of boards) {
      const tree = trees[board.file]
      const boardKey = keyOf(board.file, [])
      out.push({ file: board.file, node: null, board, depth: 0, key: boardKey, hasChildren: Boolean(tree?.children.length), inheritedHidden: false })
      if (!tree || collapsed.has(boardKey)) continue
      const boardHidden = hiddenBoards.has(board.file)
      const walk = (node: DesignTreeNode, depth: number, ancestorHidden: boolean) => {
        const key = keyOf(board.file, node.path)
        out.push({ file: board.file, node, depth, key, hasChildren: node.children.length > 0, inheritedHidden: ancestorHidden })
        if (collapsed.has(key)) return
        for (const child of node.children) walk(child, depth + 1, ancestorHidden || Boolean(node.hidden))
      }
      for (const child of tree.children) walk(child, 1, boardHidden)
    }
    return out
  }, [boards, trees, collapsed, hiddenBoards])

  if (boards.length === 0) {
    return <p className="px-3 py-3 text-[11px] text-muted-foreground">{t("design.empty")}</p>
  }

  /**
   * Where the row lands: above, below or inside it. A row without children has no
   * "inside" — and the artboard (the root) is always "inside", because the body is
   * the container of everything.
   */
  const modeAt = (e: React.DragEvent, row: (typeof rows)[number]): DropMode => {
    if (!row.node) return "inside"
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientY - rect.top) / Math.max(1, rect.height)
    if (!row.hasChildren) return ratio < 0.5 ? "before" : "after"
    if (ratio < 0.25) return "before"
    if (ratio > 0.75) return "after"
    return "inside"
  }

  return (
    <div
      className="flex flex-col py-1"
      onMouseLeave={() => onHover(null, null)}
      onDragEnd={() => {
        dragging.current = null
        setDrop(null)
      }}
    >
      {rows.map((row) => {
        const path = row.node?.path ?? null
        const isSelected = Boolean(
          selection && selection.file === row.file && (row.node ? samePath(selection.path, path) : selection.path === null),
        )
        const inGroup =
          Boolean(row.node) && Boolean(selection && selection.file === row.file && group.some((p) => samePath(p, path)))
        const Icon = row.node ? KIND_ICON[row.node.kind] : LayoutGrid
        const name = row.node
          ? row.node.label || row.node.text || row.node.tag
          : (row.board?.title ?? row.file)
        const ownHidden = row.node ? Boolean(row.node.hidden) : hiddenBoards.has(row.file)
        const dimmed = ownHidden || row.inheritedHidden
        const isDropTarget = drop?.key === row.key
        const hint = isDropTarget ? drop.mode : null
        return (
          <div
            key={row.key}
            className={cn(
              "group/layer relative flex h-6 items-center pr-2 text-[11px]",
              isSelected ? "bg-primary/15 text-foreground" : inGroup ? "bg-primary/10 text-foreground" : "text-foreground/85 hover:bg-accent/50",
              hint === "inside" && "bg-primary/15",
              dimmed && "opacity-50",
            )}
            onContextMenu={(e) => {
              e.preventDefault()
              onContextMenu(row.file, path, e.clientX, e.clientY)
            }}
            style={{ paddingLeft: 6 + row.depth * 12 }}
            onMouseEnter={() => onHover(row.file, path)}
            onDragOver={(e) => {
              const payload = dragging.current
              if (!payload || payload.file !== row.file) return
              // One does not drop inside itself nor inside a descendant.
              const target = row.node?.path ?? []
              if (samePath(payload.path, target) || isAncestor(payload.path, target)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = "move"
              const mode = modeAt(e, row)
              setDrop((prev) => (prev && prev.key === row.key && prev.mode === mode ? prev : { key: row.key, mode }))
            }}
            onDragLeave={(e) => {
              // Leaving to a CHILD of the row is not leaving the row.
              const to = e.relatedTarget as Node | null
              if (to && e.currentTarget.contains(to)) return
              setDrop((prev) => (prev?.key === row.key ? null : prev))
            }}
            onDrop={(e) => {
              e.preventDefault()
              const payload = dragging.current
              // The mode is recalculated here (and not read from the state): the drop
              // happens right after the last dragover, and the state may still
              // be the previous one.
              const mode = modeAt(e, row)
              setDrop(null)
              dragging.current = null
              if (!payload || payload.file !== row.file) return
              const target = row.node?.path ?? []
              if (samePath(payload.path, target) || isAncestor(payload.path, target)) return
              onMove(row.file, payload.path, target, mode)
            }}
          >
            {/* The drag guide: the row where the element is going to land. */}
            {hint === "before" && <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-primary" />}
            {hint === "after" && <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-primary" />}
            <button
              type="button"
              aria-label={collapsed.has(row.key) ? t("design.layersExpand") : t("design.layersCollapse")}
              onClick={() => toggle(row.key)}
              className={cn("flex size-4 shrink-0 items-center justify-center text-muted-foreground", !row.hasChildren && "invisible")}
            >
              <ChevronRight className={cn("size-3 transition-transform", !collapsed.has(row.key) && "rotate-90")} />
            </button>
            <Hint label={row.node ? `<${row.node.tag}> ${name}` : name}>
              <button
                ref={isSelected ? selectedRef : undefined}
                type="button"
                draggable={Boolean(row.node)}
                onDragStart={(e) => {
                  if (!row.node) return
                  const payload = { file: row.file, path: row.node.path }
                  dragging.current = payload
                  e.dataTransfer.setData(LAYER_DND_MIME, JSON.stringify(payload))
                  e.dataTransfer.effectAllowed = "move"
                }}
                onClick={(e) => onSelect(row.file, path, e.shiftKey)}
                className="flex min-w-0 flex-1 select-none items-center gap-1.5 text-left"
              >
       
                   <Icon className={cn("size-3 shrink-0", row.node ? "opacity-70" : "text-primary")} />
              <span className={cn("truncate", !row.node && "font-medium")}>{name}</span>
              {row.node && row.node.label && row.node.text && (
                <span className="truncate text-muted-foreground">{row.node.text}</span>
              )}
            </button>
            </Hint>
            {/* The eye: grows in from the right on hover (same motion as the app sidebar
                actions) and stays visible while the layer is hidden. */}
            <button
              type="button"
              aria-label={t(ownHidden ? "design.layersShow" : "design.layersHide")}
              onClick={(e) => {
                e.stopPropagation()
                onToggleHidden(row.file, path)
              }}
              className={cn(
                "ml-auto flex h-5 shrink-0 items-center justify-center overflow-hidden rounded-sm p-0 text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground focus-visible:w-5 focus-visible:opacity-100 [&>svg]:size-3.5 [&>svg]:shrink-0",
                ownHidden ? "w-5 opacity-100" : "w-0 opacity-0 group-hover/layer:w-5 group-hover/layer:opacity-100",
              )}
            >
              {ownHidden ? <EyeOff /> : <Eye />}
            </button>
            {!row.node && !trees[row.file] && <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />}
          </div>
        )
      })}
    </div>
  )
}
