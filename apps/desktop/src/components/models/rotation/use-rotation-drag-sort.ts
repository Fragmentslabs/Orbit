import { useMemo, useState } from "react"
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"

/**
 * Hook de reordenação da lista de modelos da rotação.
 *
 * IDs dnd-kit usados:
 *   draggable:  `slot-<index>`
 *   droppable:  `alvo-<index>`
 *
 * Validações no drop:
 *   - origem e destino precisam ser índices válidos da lista
 *   - origem ≠ destino
 *
 * Devolve um `contextProps` pronto para o `<DndContext>` e dois helpers para
 * que o componente (que conhece o índice da linha) monte o par
 * draggable+droppable com IDs consistentes.
 */
export function useRotationDragSort(count: number, onReorder: (from: number, to: number) => void) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  const onDragStart = (event: { active: { id: unknown } }) => {
    setActiveId(String(event.active.id))
  }

  const onDragOver = (event: { over: { id: unknown } | null }) => {
    setOverId(event.over ? String(event.over.id) : null)
  }

  const onDragEnd = (event: DragEndEvent) => {
    const from = parseIndex(String(event.active.id), "slot-")
    const to = parseIndex(String(event.over?.id ?? ""), "alvo-")
    setActiveId(null)
    setOverId(null)
    if (from === null || to === null || from === to) return
    if (from < 0 || to < 0 || from >= count || to >= count) return
    onReorder(from, to)
  }

  const contextProps = useMemo(
    () => ({ sensors, onDragStart, onDragOver, onDragEnd }),
    // sensors/handlers são estáveis para o ciclo de vida do hook
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  return {
    DndContext,
    contextProps,
    activeId,
    overId,
  }
}

export function dragId(index: number): string {
  return `slot-${index}`
}

export function dropId(index: number): string {
  return `alvo-${index}`
}

function parseIndex(raw: string, prefix: string): number | null {
  if (!raw.startsWith(prefix)) return null
  const n = Number(raw.slice(prefix.length))
  return Number.isInteger(n) ? n : null
}
