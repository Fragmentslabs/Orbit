import { mediaKind, type MediaEntry } from "@shared/media"
import { designApi, motionApi, slidesApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"
import { openDocumentInPanel } from "@/src/lib/open-document"

/**
 * Opens a piece of the gallery in its own tab and says whether it did. The pieces that have a
 * tab (motion, design, slides, HTML artifact, document) open here; an image or a video needs
 * the viewer, which belongs to whoever shows the lightbox, so they answer false.
 *
 * Motion, design and slides are reopened by the main process through their own id: the cover
 * is only the cover, and the folder stays valid outside the conversation that created it.
 * `bucketKey` is the panel the tab is born in (the one on screen, not the origin chat's).
 */
export function openMediaEntryInPanel(entry: MediaEntry, bucketKey: string): boolean {
  const kind = mediaKind(entry)
  if (kind === "motion") {
    if (entry.motionId) void motionApi.open({ id: entry.motionId })
    return true
  }
  if (kind === "design") {
    if (entry.designId) void designApi.open({ id: entry.designId })
    return true
  }
  if (kind === "slides") {
    if (entry.slidesId) void slidesApi.open({ id: entry.slidesId })
    return true
  }
  // A living document opens in the Markdown canvas, a requested file in the viewer: what
  // decides is openDocumentInPanel, so the gallery and the conversation card agree.
  if (kind === "document") {
    void openDocumentInPanel(bucketKey, entry.id, entry.name || entry.id)
    return true
  }
  if (kind === "artifact") {
    usePanelStore.getState().openArtifactTab(bucketKey, entry.id, entry.name || entry.id)
    return true
  }
  return false
}
