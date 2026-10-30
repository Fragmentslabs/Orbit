import { documentOpensAsFile } from "@shared/media"
import { documentApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"

/**
 * Opens an agent document in the panel — and decides in WHICH tab.
 *
 * There are two objects with the same origin and different destinations: the live document
 * in Markdown opens in the canvas, where one reads and edits it; the one ASKED for as a
 * file ("make a PDF of this") opens in the document viewer, with a table of contents,
 * find, zoom and print, which is what one expects from a finished file.
 *
 * The decision lives here, and not in each button, because the two entry points —
 * the conversation card and the gallery — have to agree: the same document cannot
 * open one way in the chat and another in the gallery.
 *
 * And it consults the REGISTRY, instead of reading the part of the message: the part is a
 * snapshot of the turn in which it was created, and a document that became a PDF later
 * would keep opening as Markdown through the old card.
 */
export async function openDocumentInPanel(
  sessionId: string,
  documentId: string,
  title: string,
): Promise<void> {
  const info = await documentApi.info(documentId)
  const store = usePanelStore.getState()
  // Without a registry the document is gone: the viewer is the one that knows how to tell
  // the user that, naming the id it did not find.
  if (!info || documentOpensAsFile(info)) {
    store.openSourceTab(sessionId, { docId: documentId, page: 1, title })
    return
  }
  store.openDocumentTab(sessionId, { documentId, title })
}
