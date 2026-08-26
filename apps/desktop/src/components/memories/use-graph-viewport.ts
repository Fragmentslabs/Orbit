/**
 * Viewport do canvas de memórias — pan e zoom.
 *
 * O transform vive num ref e é escrito direto no <g> da cena: durante um
 * arraste ou uma pinça o React não re-renderiza nada, então a cena inteira
 * (centenas de nós, com ícone em foreignObject cada um) não é reconciliada a
 * cada frame. Quem precisa do valor — o rótulo de % e o retângulo do minimapa
 * — assina via `subscribe`, e só esses pedacinhos redesenham.
 *
 * A roda é ouvida num listener nativo não-passivo: o onWheel do React é
 * passivo, o preventDefault não pegava e a janela dava o próprio zoom por
 * cima do nosso — daí o travamento e os saltos.
 *
 * Mapa dos gestos:
 *   roda / dois dedos      → anda nos dois eixos, 1:1 com o gesto
 *   shift + roda           → anda de lado
 *   ctrl (ou cmd) + roda   → zoom no ponteiro; a pinça do trackpad no macOS
 *                            chega exatamente assim, só que em deltas finos
 *   arrastar               → anda nos dois eixos, 1:1 com o cursor
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"

export interface Transform {
  x: number
  y: number
  k: number
}

/** Deltas em "linhas" (Firefox e algumas rodas) — passo padrão do Chromium. */
const LINE_PX = 16
/**
 * Fronteira entre delta fino (pinça de trackpad, que chega em passos pequenos
 * e contínuos) e o degrau grosso de um clique de roda (~100px de uma vez).
 */
const COARSE_DELTA = 40
/**
 * Ganho do zoom por pixel de delta. A pinça soma uns ~200px ao longo do gesto
 * inteiro, então precisa de um ganho bem maior que a roda para um movimento
 * confortável dar um zoom perceptível (~4,5x aqui).
 */
const ZOOM_SPEED_FINE = 0.0075
const ZOOM_SPEED_COARSE = 0.0022
/** Folga em px antes de um pointerdown virar arraste em vez de clique. */
const DRAG_SLOP = 3
/** Duração das transições discretas (botões de zoom, centralizar). */
const ANIM_MS = 220

interface DragState {
  id: number
  /** Ponteiro no início e na última amostra (esta reancora o zoom no meio). */
  startX: number
  startY: number
  lastX: number
  lastY: number
  /** Transform no instante em que o arraste começou. */
  originX: number
  originY: number
  moved: boolean
}

export interface CanvasViewport {
  /** Elemento que recebe roda e ponteiro. */
  surfaceRef: React.MutableRefObject<SVGSVGElement | null>
  /** Grupo que carrega o transform. */
  sceneRef: React.MutableRefObject<SVGGElement | null>
  subscribe: (fn: () => void) => () => void
  getTransform: () => Transform
  setViewport: (next: Transform, animate?: boolean) => void
  zoomBy: (factor: number) => void
  /** Verdadeiro quando o clique que está chegando é só o fim de um arraste. */
  wasDragged: () => boolean
  onPointerDown: (e: React.PointerEvent) => void
}

export function useCanvasViewport({ minZoom, maxZoom }: {
  minZoom: number
  maxZoom: number
}): CanvasViewport {
  const surfaceRef = useRef<SVGSVGElement | null>(null)
  const sceneRef = useRef<SVGGElement | null>(null)
  const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 })
  const listeners = useRef(new Set<() => void>())
  const commitRaf = useRef(0)
  const animRaf = useRef(0)
  const drag = useRef<DragState | null>(null)
  /** Sobrevive ao pointerup para o click seguinte poder consultá-lo. */
  const dragged = useRef(false)

  const subscribe = useCallback((fn: () => void) => {
    listeners.current.add(fn)
    return () => {
      listeners.current.delete(fn)
    }
  }, [])
  const getTransform = useCallback(() => transformRef.current, [])

  const clampK = useCallback(
    (k: number) => Math.min(maxZoom, Math.max(minZoom, k)),
    [minZoom, maxZoom],
  )

  /** Escreve o transform no DOM. É o caminho quente: nada de React aqui. */
  const paint = useCallback(() => {
    const g = sceneRef.current
    if (!g) return
    const { x, y, k } = transformRef.current
    g.setAttribute("transform", `translate(${x}, ${y}) scale(${k})`)
  }, [])

  /** Avisa os assinantes no máximo uma vez por frame. */
  const notify = useCallback(() => {
    if (commitRaf.current) return
    commitRaf.current = requestAnimationFrame(() => {
      commitRaf.current = 0
      for (const fn of listeners.current) fn()
    })
  }, [])

  const apply = useCallback((next: Transform) => {
    transformRef.current = next
    paint()
    notify()
  }, [paint, notify])

  const stopAnimation = useCallback(() => {
    if (!animRaf.current) return
    cancelAnimationFrame(animRaf.current)
    animRaf.current = 0
  }, [])

  const animateTo = useCallback((target: Transform, duration = ANIM_MS) => {
    stopAnimation()
    const from = transformRef.current
    const to = { ...target, k: clampK(target.k) }
    const start = performance.now()
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration)
      const e = 1 - Math.pow(1 - p, 3)
      apply({
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        k: from.k + (to.k - from.k) * e,
      })
      animRaf.current = p < 1 ? requestAnimationFrame(step) : 0
    }
    animRaf.current = requestAnimationFrame(step)
  }, [apply, clampK, stopAnimation])

  const setViewport = useCallback((next: Transform, animate = false) => {
    if (animate) {
      animateTo(next)
      return
    }
    stopAnimation()
    apply({ ...next, k: clampK(next.k) })
  }, [animateTo, apply, clampK, stopAnimation])

  /** Zoom mantendo fixo o ponto (cx, cy), em coordenadas do container. */
  const zoomAround = useCallback((k: number, cx: number, cy: number, animate = false) => {
    const t = transformRef.current
    const next = clampK(k)
    const target = {
      k: next,
      x: cx - ((cx - t.x) / t.k) * next,
      y: cy - ((cy - t.y) / t.k) * next,
    }
    // Zoom no meio de um arraste: reancora no ponteiro, senão o próximo
    // pointermove devolveria o conteúdo para onde ele estava antes.
    const d = drag.current
    if (d) {
      d.originX = target.x
      d.originY = target.y
      d.startX = d.lastX
      d.startY = d.lastY
    }
    if (animate) {
      animateTo(target)
    } else {
      stopAnimation()
      apply(target)
    }
  }, [animateTo, apply, clampK, stopAnimation])

  const zoomBy = useCallback((factor: number) => {
    const el = surfaceRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    zoomAround(transformRef.current.k * factor, rect.width / 2, rect.height / 2, true)
  }, [zoomAround])

  useEffect(() => {
    const el = surfaceRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      // Segura o zoom/scroll da própria janela — sem isto o gesto era
      // disputado entre o canvas e o Chromium, e daí vinham os saltos.
      e.preventDefault()
      stopAnimation()
      const rect = el.getBoundingClientRect()
      let dx = e.deltaX
      let dy = e.deltaY
      if (e.deltaMode === 1) {
        dx *= LINE_PX
        dy *= LINE_PX
      } else if (e.deltaMode === 2) {
        dx *= rect.width
        dy *= rect.height
      }

      if (e.ctrlKey || e.metaKey) {
        const speed = Math.abs(dy) < COARSE_DELTA ? ZOOM_SPEED_FINE : ZOOM_SPEED_COARSE
        zoomAround(
          transformRef.current.k * Math.exp(-dy * speed),
          e.clientX - rect.left,
          e.clientY - rect.top,
        )
        return
      }

      const t = transformRef.current
      if (e.shiftKey && dx === 0) {
        // Alguns navegadores já trocam os eixos sozinhos com shift (aí dx vem
        // preenchido e cai no caso geral); nos outros a troca é aqui.
        apply({ ...t, x: t.x - dy })
        return
      }
      apply({ ...t, x: t.x - dx, y: t.y - dy })
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [apply, zoomAround, stopAnimation])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Botão esquerdo ou do meio; o direito fica para o menu de contexto.
    if (e.button !== 0 && e.button !== 1) return
    if (e.button === 1) e.preventDefault()
    stopAnimation()
    dragged.current = false
    const t = transformRef.current
    const state: DragState = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      originX: t.x,
      originY: t.y,
      moved: false,
    }
    drag.current = state

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== state.id) return
      state.lastX = ev.clientX
      state.lastY = ev.clientY
      const dx = ev.clientX - state.startX
      const dy = ev.clientY - state.startY
      if (!state.moved && Math.abs(dx) + Math.abs(dy) <= DRAG_SLOP) return
      state.moved = true
      dragged.current = true
      // 1:1 com o cursor, nos dois eixos, desde o primeiro pixel.
      apply({ ...transformRef.current, x: state.originX + dx, y: state.originY + dy })
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== state.id) return
      drag.current = null
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
    }
    // Escutar na window em vez de capturar o ponteiro: a captura reencaminha
    // também o click para o elemento capturado, e aí clicar num nó deixaria
    // de selecioná-lo.
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
  }, [apply, stopAnimation])

  const wasDragged = useCallback(() => dragged.current, [])

  // Sem lista de dependências de propósito: reafirma o transform depois de
  // qualquer render, para o React nunca devolver o <g> à identidade.
  useLayoutEffect(paint)

  useEffect(() => () => {
    if (commitRaf.current) cancelAnimationFrame(commitRaf.current)
    if (animRaf.current) cancelAnimationFrame(animRaf.current)
  }, [])

  // Identidade estável: o objeto entra nas dependências de quem consome.
  return useMemo(
    () => ({ surfaceRef, sceneRef, subscribe, getTransform, setViewport, zoomBy, wasDragged, onPointerDown }),
    [subscribe, getTransform, setViewport, zoomBy, wasDragged, onPointerDown],
  )
}
