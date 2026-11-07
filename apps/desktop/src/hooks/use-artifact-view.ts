import { useEffect, useRef } from "react"
import { ARTIFACT_VIEW_CHANNEL, type ArtifactRef, type ArtifactViewValue } from "@shared/artifacts"

/** A burst of changes (a playhead moving) is sent once, after it settles. */
const SETTLE_MS = 400

/**
 * Tells the main process what the person is looking at in this artifact's tab, so the chat that
 * works on it knows what "this one" means. One line per tab, whatever the kind: the tab only
 * describes its own state, and the layer that turns it into text lives in main.
 *
 * `state` should be a stable-by-value object (the hook compares its JSON); it is cleared when the
 * tab unmounts.
 */
export function useArtifactView(ref: ArtifactRef | null, state: Record<string, ArtifactViewValue | null | undefined> | null): void {
  const kind = ref?.kind
  const id = ref?.id
  const json = JSON.stringify(state ?? null)
  const last = useRef("")

  useEffect(() => {
    if (!kind || !id || json === last.current) return
    const timer = setTimeout(() => {
      last.current = json
      window.ipcRenderer.send(ARTIFACT_VIEW_CHANNEL, { ref: { kind, id }, state: JSON.parse(json) })
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [kind, id, json])

  useEffect(() => {
    if (!kind || !id) return
    return () => {
      last.current = ""
      window.ipcRenderer.send(ARTIFACT_VIEW_CHANNEL, { ref: { kind, id }, state: null })
    }
  }, [kind, id])
}
