import { useCallback, useEffect, useRef, useState } from "react"

/** Hover delays of the fullscreen bars — same convention as the app
 *  sidebar (App.tsx: SIDEBAR_SHOW_DELAY=100 / SIDEBAR_HIDE_DELAY=300). */
const EDGE_SHOW_DELAY = 100
const EDGE_HIDE_DELAY = 300

/** Hover with symmetric delay: it opens fast (100ms) when touching the edge and closes
 *  with slack (300ms) on leaving — it avoids expanding when crossing the edge in passing and
 *  collapsing when moving the mouse to the page. */
export function useEdgeHover() {
  const [hovered, setHovered] = useState(false)
  const showTimer = useRef<ReturnType<typeof setTimeout>>()
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()
  const handleEnter = useCallback(() => {
    clearTimeout(hideTimer.current)
    showTimer.current = setTimeout(() => setHovered(true), EDGE_SHOW_DELAY)
  }, [])
  const handleLeave = useCallback(() => {
    clearTimeout(showTimer.current)
    hideTimer.current = setTimeout(() => setHovered(false), EDGE_HIDE_DELAY)
  }, [])
  useEffect(
    () => () => {
      clearTimeout(showTimer.current)
      clearTimeout(hideTimer.current)
    },
    [],
  )
  return { hovered, handleEnter, handleLeave }
}
