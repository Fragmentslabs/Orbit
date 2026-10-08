import { useCallback, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import {
  DragOverlay,
  PointerSensor,
  defaultDropAnimationSideEffects,
  pointerWithin,
  useDndContext,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DropAnimation,
} from "@dnd-kit/core"
import { MessageSquare } from "lucide-react"

import { cn } from "@/lib/utils"
import type { WorkspaceMode } from "@/lib/workspace-context"
import type { SessionInfo } from "@shared/chat"
import { usePanelStore } from "@/src/stores/panel-store"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Arrastar uma conversa da sidebar: o mesmo gesto serve para abrir no painel
 * lateral e para mudar a conversa de lugar (pasta, fixados, conversas,
 * arquivados). Tudo passa pelo DndContext do App, então a animação é uma só —
 * a linha original vira um espaço vazio e um "fantasma" dela segue o cursor.
 */

export const RIGHT_PANEL_DROP_ID = "right-panel-drop-zone"

/** Dados que cada linha arrastável da sidebar publica no dnd-kit. */
export interface SessionDragData {
  kind: "session"
  sessionId: string
  title: string
  icon?: React.ElementType
  /** Workers ficam presos ao orquestrador e os chats de rotina ao grupo
   *  "Rotinas": os dois ainda abrem no painel, mas não mudam de lugar. */
  movable: boolean
}

export type SidebarDropTarget =
  | { type: "pinned" }
  | { type: "chats" }
  /** `folderId` presente: agrupamento de arquivados de uma pasta viva. */
  | { type: "archived"; folderId?: string }
  | { type: "folder"; folderId: string; archived: boolean }

interface SidebarDropData {
  kind: "sidebar-target"
  target: SidebarDropTarget
}

function dropId(target: SidebarDropTarget) {
  switch (target.type) {
    case "folder":
      return `sidebar-folder:${target.folderId}`
    case "archived":
      return target.folderId ? `sidebar-archived:${target.folderId}` : "sidebar-archived"
    default:
      return `sidebar-${target.type}`
  }
}

/** O que muda na sessão ao soltá-la no alvo — null quando já está lá. */
function placementFor(session: SessionInfo, target: SidebarDropTarget) {
  let patch: { folderId?: string | null; pinned?: boolean; archived?: boolean }
  switch (target.type) {
    case "pinned":
      patch = { folderId: null, pinned: true, archived: false }
      break
    case "chats":
      patch = { folderId: null, pinned: false, archived: false }
      break
    case "archived":
      patch = target.folderId ? { folderId: target.folderId, archived: true } : { archived: true }
      break
    case "folder":
      patch = { folderId: target.folderId, archived: target.archived }
      break
  }
  const changed = (Object.keys(patch) as (keyof typeof patch)[]).some(
    (k) => (session[k] ?? (k === "folderId" ? null : false)) !== patch[k],
  )
  return changed ? patch : null
}

function draggedSession(data: unknown): SessionDragData | null {
  const d = data as SessionDragData | undefined
  return d?.kind === "session" ? d : null
}

/** Conversa móvel sendo arrastada agora (null fora de um arrasto). */
export function useDraggedMovableSession(): SessionDragData | null {
  const { active } = useDndContext()
  const data = draggedSession(active?.data.current)
  return data?.movable ? data : null
}

/**
 * Registra um alvo da sidebar. `highlighted` só acende quando soltar ali
 * muda alguma coisa — passar por cima do lugar onde a conversa já está não
 * pode parecer uma ação.
 */
export function useSidebarDropTarget(target: SidebarDropTarget) {
  const dragged = useDraggedMovableSession()
  const data: SidebarDropData = { kind: "sidebar-target", target }
  const { setNodeRef, isOver } = useDroppable({ id: dropId(target), data, disabled: !dragged })
  const session = useSessionStore((s) =>
    dragged ? s.sessions.find((x) => x.id === dragged.sessionId) : undefined,
  )
  const accepts = !!session && placementFor(session, target) !== null
  return { setNodeRef, dragging: !!dragged, highlighted: isOver && accepts }
}

/**
 * Alvos aninhados (pasta arquivada dentro de "Arquivados") disputam o mesmo
 * ponto: vale o menor que contém o cursor, que é o mais específico.
 */
const sessionCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  if (hits.length < 2) return hits
  const area = (id: string | number) => {
    const rect = args.droppableRects.get(id)
    return rect ? rect.width * rect.height : Infinity
  }
  return [...hits].sort((a, b) => area(a.id) - area(b.id))
}

type DropKind = "panel" | "move" | "cancel"

/** Soltou no painel: o fantasma some ali mesmo, encolhendo no cursor. */
const panelDropAnimation: DropAnimation = {
  duration: 180,
  easing: "ease-out",
  keyframes: ({ transform: { initial } }) => {
    const at = `translate3d(${initial.x}px, ${initial.y}px, 0)`
    return [
      { opacity: 1, transform: `${at} scale(1)` },
      { opacity: 0, transform: `${at} scale(0.92)` },
    ]
  },
  sideEffects: null,
}

/** Mudou de lugar ou desistiu: o fantasma desliza até onde a linha está
 *  agora (o novo lugar, ou o espaço vazio de origem). */
const settleDropAnimation: DropAnimation = {
  duration: 220,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } } }),
}

export function useSessionDragAndDrop(workspaceMode: WorkspaceMode) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const [dropKind, setDropKind] = useState<DropKind>("cancel")

  const onDragStart = useCallback(() => {
    document.body.style.cursor = "grabbing"
  }, [])

  const onDragCancel = useCallback(() => {
    document.body.style.cursor = ""
    setDropKind("cancel")
  }, [])

  const onDragEnd = useCallback((event: DragEndEvent) => {
    document.body.style.cursor = ""
    const data = draggedSession(event.active.data.current)
    const over = event.over
    if (!data || !over) {
      setDropKind("cancel")
      return
    }

    if (over.id === RIGHT_PANEL_DROP_ID) {
      const sessionStore = useSessionStore.getState()
      if (sessionStore.activeIds[workspaceMode] === data.sessionId) {
        sessionStore.createSession(workspaceMode, { setActive: true })
      }
      usePanelStore.getState().openChatTab(data.sessionId, data.title)
      setDropKind("panel")
      return
    }

    const target = (over.data.current as SidebarDropData | undefined)?.target
    const store = useSessionStore.getState()
    const session = store.sessions.find((s) => s.id === data.sessionId)
    const patch = data.movable && target && session ? placementFor(session, target) : null
    if (patch) store.placeSession(data.sessionId, patch)
    setDropKind(patch ? "move" : "cancel")
  }, [workspaceMode])

  return {
    contextProps: { sensors, collisionDetection: sessionCollision, onDragStart, onDragEnd, onDragCancel },
    overlay: <SessionDragOverlay dropAnimation={dropKind === "panel" ? panelDropAnimation : settleDropAnimation} />,
  }
}

function SessionDragOverlay({ dropAnimation }: { dropAnimation: DropAnimation }) {
  const { active } = useDndContext()
  const data = draggedSession(active?.data.current)
  const Icon = data?.icon ?? MessageSquare

  // Portal: a sidebar flutuante usa transform, que prenderia o `fixed` do
  // overlay dentro dela.
  const ghost = useMemo(
    () =>
      data ? (
        <div
          className={cn(
            "session-drag-ghost flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs",
            "border border-foreground/10 bg-sidebar-accent text-sidebar-accent-foreground",
          )}
        >
          <Icon className="size-4 shrink-0" />
          <span className="truncate">{data.title}</span>
        </div>
      ) : null,
    [data, Icon],
  )

  return createPortal(
    <DragOverlay dropAnimation={dropAnimation} zIndex={1000} className="cursor-grabbing">
      {ghost}
    </DragOverlay>,
    document.body,
  )
}
