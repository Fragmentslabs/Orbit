import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Box, ChevronRight, ImageIcon, LayoutGrid, Loader2, MousePointerClick, Shapes, Type, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { samePath, type DesignNodeKind, type DesignTreeNode, type DropMode, type ElementPath } from "./design-protocol"
import type { DesignBoardView } from "./design-properties"

/**
 * Camadas do canvas: os artboards e, dentro de cada um, a árvore do DOM — lida
 * ao vivo pela ponte, e não guardada em lugar nenhum. O HTML É o modelo; esta
 * lista é só uma vista dele (por isso nunca dessincroniza do que está na tela).
 *
 * A lista também é onde a estrutura muda: arrastar uma camada sobre outra
 * reordena os irmãos ou move o elemento para dentro de outro — o painel escreve
 * no fonte e a ponte aplica a mesma mudança no DOM ao vivo, para o canvas não
 * ficar para trás.
 */

const KIND_ICON: Record<DesignNodeKind, LucideIcon> = {
  text: Type,
  image: ImageIcon,
  svg: Shapes,
  input: MousePointerClick,
  box: Box,
}

/** O payload do arrasto entre linhas: só a identidade da camada arrastada. */
const LAYER_DND_MIME = "application/x-orbit-design-layer"

const keyOf = (file: string, path: ElementPath) => `${file}:${path.join(".")}`

/** `a` é ancestral de `b`? (o caminho é a cadeia de índices de filhos) */
const isAncestor = (a: ElementPath, b: ElementPath) =>
  a.length < b.length && a.every((n, i) => b[i] === n)

interface Props {
  boards: DesignBoardView[]
  trees: Record<string, DesignTreeNode | undefined>
  selection: { file: string; path: ElementPath | null } | null
  /** Os OUTROS membros da seleção múltipla (o primário é `selection.path`). */
  group: ElementPath[]
  /** `additive` = Shift+clique: alterna o elemento no grupo. */
  onSelect: (file: string, path: ElementPath | null, additive: boolean) => void
  /** `file` null = o ponteiro saiu da lista (tira o contorno). */
  onHover: (file: string | null, path: ElementPath | null) => void
  /** Arrasto de camada: `fromPath` foi solta sobre `targetPath`. */
  onMove: (file: string, fromPath: ElementPath, targetPath: ElementPath, mode: DropMode) => void
}

export function DesignLayers({ boards, trees, selection, group, onSelect, onHover, onMove }: Props) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  /** Onde a linha solta vai cair (linha + modo) — a guia do arrasto. */
  const [drop, setDrop] = useState<{ key: string; mode: DropMode } | null>(null)
  const dragging = useRef<{ file: string; path: ElementPath } | null>(null)
  const selectedRef = useRef<HTMLButtonElement | null>(null)

  // A seleção feita no canvas abre os ancestrais dela na lista e rola até lá —
  // senão clicar num botão lá no fundo não teria resposta visível aqui.
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
    const out: { file: string; node: DesignTreeNode | null; board?: DesignBoardView; depth: number; key: string; hasChildren: boolean }[] = []
    for (const board of boards) {
      const tree = trees[board.file]
      const boardKey = keyOf(board.file, [])
      out.push({ file: board.file, node: null, board, depth: 0, key: boardKey, hasChildren: Boolean(tree?.children.length) })
      if (!tree || collapsed.has(boardKey)) continue
      const walk = (node: DesignTreeNode, depth: number) => {
        const key = keyOf(board.file, node.path)
        out.push({ file: board.file, node, depth, key, hasChildren: node.children.length > 0 })
        if (collapsed.has(key)) return
        for (const child of node.children) walk(child, depth + 1)
      }
      for (const child of tree.children) walk(child, 1)
    }
    return out
  }, [boards, trees, collapsed])

  if (boards.length === 0) {
    return <p className="px-3 py-3 text-[11px] text-muted-foreground">{t("design.empty")}</p>
  }

  /**
   * Onde a linha cai: acima, abaixo ou dentro dela. Uma linha sem filhos não
   * tem "dentro" — e o artboard (a raiz) é sempre "dentro", porque o corpo é
   * o container de tudo.
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
        const isDropTarget = drop?.key === row.key
        const hint = isDropTarget ? drop.mode : null
        return (
          <div
            key={row.key}
            className={cn(
              "group/layer relative flex h-6 items-center pr-2 text-[11px]",
              isSelected ? "bg-primary/15 text-foreground" : inGroup ? "bg-primary/10 text-foreground" : "text-foreground/85 hover:bg-accent/50",
              hint === "inside" && "bg-primary/15",
            )}
            style={{ paddingLeft: 6 + row.depth * 12 }}
            onMouseEnter={() => onHover(row.file, path)}
            onDragOver={(e) => {
              const payload = dragging.current
              if (!payload || payload.file !== row.file) return
              // Não se solta dentro de si mesmo nem dentro de um descendente.
              const target = row.node?.path ?? []
              if (samePath(payload.path, target) || isAncestor(payload.path, target)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = "move"
              const mode = modeAt(e, row)
              setDrop((prev) => (prev && prev.key === row.key && prev.mode === mode ? prev : { key: row.key, mode }))
            }}
            onDragLeave={(e) => {
              // Sair para um FILHO da linha não é sair da linha.
              const to = e.relatedTarget as Node | null
              if (to && e.currentTarget.contains(to)) return
              setDrop((prev) => (prev?.key === row.key ? null : prev))
            }}
            onDrop={(e) => {
              e.preventDefault()
              const payload = dragging.current
              // O modo é recalculado aqui (e não lido do estado): o drop
              // acontece logo depois do último dragover, e o estado pode ainda
              // ser o de antes.
              const mode = modeAt(e, row)
              setDrop(null)
              dragging.current = null
              if (!payload || payload.file !== row.file) return
              const target = row.node?.path ?? []
              if (samePath(payload.path, target) || isAncestor(payload.path, target)) return
              onMove(row.file, payload.path, target, mode)
            }}
          >
            {/* A guia do arrasto: a linha onde o elemento vai cair. */}
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
              title={row.node ? `<${row.node.tag}> ${name}` : name}
            >
              <Icon className={cn("size-3 shrink-0", row.node ? "opacity-70" : "text-primary")} />
              <span className={cn("truncate", !row.node && "font-medium")}>{name}</span>
              {row.node && row.node.label && row.node.text && (
                <span className="truncate text-muted-foreground">{row.node.text}</span>
              )}
            </button>
            {!row.node && !trees[row.file] && <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />}
          </div>
        )
      })}
    </div>
  )
}
