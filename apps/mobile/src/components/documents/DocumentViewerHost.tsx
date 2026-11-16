import { DocumentViewer } from './DocumentViewer'
import { useDocumentViewerStore } from '~/stores/document-viewer-store'

/** Mounted once in the layout: the card and the citations only point the store at a document. */
export function DocumentViewerHost() {
  const target = useDocumentViewerStore((s) => s.target)
  const close = useDocumentViewerStore((s) => s.close)
  if (!target) return null
  return <DocumentViewer key={JSON.stringify(target)} target={target} onClose={close} />
}
