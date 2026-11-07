import { BROWSER_SELECTION_MIME, type FilePart } from "@shared/chat"
import type { BrowserSelection } from "@/src/stores/panel-store"

/**
 * Elements picked on a page (the panel browser, or a fragment in inspect mode) → message
 * attachments. Both composers need this at send time and the format has to be identical:
 * the engine reads it back in ONE place (preprocessAttachment), so serializing it twice
 * would be the easiest way for the two to drift apart.
 *
 * The detail (selector/html/text) travels in the data URL of the marker MIME; the bubble
 * shows only the chip.
 */
export function selectionsToFileParts(selections: BrowserSelection[]): FilePart[] {
  return selections.map<FilePart>((sel) => {
    const payload = encodeURIComponent(
      JSON.stringify({ tag: sel.tag, url: sel.url, selector: sel.selector, text: sel.text, html: sel.html, where: sel.where }),
    )
    const label = sel.text ? `"${sel.text.slice(0, 40)}${sel.text.length > 40 ? "…" : ""}"` : ""
    return {
      id: sel.id,
      type: "file",
      mime: BROWSER_SELECTION_MIME,
      filename: `<${sel.tag}>${label ? ` ${label}` : ""}`,
      url: `data:${BROWSER_SELECTION_MIME},${payload}`,
    }
  })
}
