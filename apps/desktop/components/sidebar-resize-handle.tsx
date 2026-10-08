import { useCallback, useLayoutEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { SIDEBAR_DEFAULT_WIDTH, clampSidebarWidth } from "@shared/app-settings"
import { useAppSettings } from "@/src/stores/app-settings"

/**
 * Alça de arrasto da borda direita da sidebar.
 *
 * A largura é uma configuração (`AppSettings.sidebarWidth`) e quem a aplica é
 * este componente: escreve direto na variável CSS `--sidebar-width` do wrapper
 * do sidebar, que é o que dimensiona o vão (o espaço reservado no layout) e o
 * painel fixo. Durante o arrasto isso evita um render por quadro — o valor
 * final só então vai para as configurações.
 *
 * O componente fica MONTADO mesmo quando não é arrastável: é ele que aplica a
 * largura salva, e a sidebar precisa abrir já no tamanho escolhido.
 */

/** O wrapper do sidebar é o dono da variável CSS (data-slot do ui/sidebar). */
function findWrapper(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>('[data-slot="sidebar-wrapper"]')
}

interface SidebarResizeHandleProps {
  /**
   * Arrastável só com a sidebar fixada. Em modo hover ela se fecha ao tirar o
   * mouse e o arrasto se perderia no meio.
   */
  active?: boolean
}

export function SidebarResizeHandle({ active = true }: SidebarResizeHandleProps) {
  const { t } = useTranslation()
  const width = useAppSettings((s) => s.settings.sidebarWidth)
  const handleRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  // A largura salva vale já na primeira pintura — com um efeito comum a sidebar
  // apareceria no padrão e só depois encolheria para o tamanho escolhido.
  useLayoutEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    findWrapper(handle)?.style.setProperty("--sidebar-width", `${width}px`)
  }, [width])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!active || e.button !== 0) return
      const handle = e.currentTarget
      const wrapper = findWrapper(handle)
      if (!wrapper) return
      e.preventDefault()
      handle.setPointerCapture(e.pointerId)
      dragging.current = true

      // O vão e o painel animam a largura em 200ms (abrir/fechar): durante o
      // arrasto cada quadro viraria uma animação atrasada, então a transição
      // sai de cena e volta no fim.
      const animated = [
        wrapper.querySelector<HTMLElement>('[data-slot="sidebar-gap"]'),
        wrapper.querySelector<HTMLElement>('[data-slot="sidebar-container"]'),
      ].filter((node): node is HTMLElement => node !== null)
      for (const node of animated) node.style.transitionProperty = "none"
      const previousCursor = document.body.style.cursor
      document.body.style.cursor = "col-resize"

      const startX = e.clientX
      const startWidth = wrapper.getBoundingClientRect().width
      const widthAt = (clientX: number) => clampSidebarWidth(startWidth + (clientX - startX))

      const onMove = (ev: PointerEvent) => {
        if (!dragging.current) return
        wrapper.style.setProperty("--sidebar-width", `${widthAt(ev.clientX)}px`)
      }

      const onEnd = (ev: PointerEvent) => {
        if (!dragging.current) return
        dragging.current = false
        handle.removeEventListener("pointermove", onMove)
        handle.removeEventListener("pointerup", onEnd)
        handle.removeEventListener("pointercancel", onEnd)
        if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId)
        for (const node of animated) node.style.transitionProperty = ""
        document.body.style.cursor = previousCursor
        // O React volta a mandar na variável (efeito acima) e o valor final
        // passa a ser a fonte da verdade — igual na próxima abertura.
        useAppSettings.getState().update({ sidebarWidth: widthAt(ev.clientX) })
      }

      handle.addEventListener("pointermove", onMove)
      handle.addEventListener("pointerup", onEnd)
      handle.addEventListener("pointercancel", onEnd)
    },
    [active],
  )

  // Duplo clique volta ao tamanho de sempre: sem isso não haveria como desfazer.
  const onDoubleClick = useCallback(() => {
    useAppSettings.getState().update({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH })
  }, [])

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={active ? t("sidebar.resize") : undefined}
      title={active ? t("sidebar.resize") : undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={active ? onDoubleClick : undefined}
      className={
        active
          ? "group/handle absolute inset-y-0 right-0 z-20 flex w-2 cursor-col-resize touch-none items-center justify-center"
          : "pointer-events-none absolute inset-y-0 right-0 opacity-0"
      }
    >
      <div className="pointer-events-none h-8 w-0.5 rounded-full bg-transparent transition-colors group-hover/handle:bg-border" />
    </div>
  )
}
