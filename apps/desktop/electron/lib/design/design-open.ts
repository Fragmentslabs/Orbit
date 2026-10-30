import fsp from 'node:fs/promises'
import path from 'node:path'
import { panelDesignPreview } from '../panel-browser'
import { readDesignCanvas } from './design-canvas'
import { refreshDesignCover } from './design-gallery'
import { getDesign, registerDesign } from './design-store'

/**
 * Reopens a canvas that is ALREADY in the registry — the chat card, the Media tile.
 * No sessionId on purpose: the renderer resolves the bucket from the ACTIVE chat
 * (see reopenMotion, same reasoning).
 */
export async function reopenDesign(id: string): Promise<boolean> {
  const entry = await getDesign(id)
  if (!entry) return false
  await registerDesign(entry.folder, {}).catch(() => {})
  panelDesignPreview({ id, title: path.basename(entry.folder), path: entry.folder })
  return true
}

/**
 * Opens a canvas in the Design tab and tells the agent how it turned out — the
 * common step of design_write/design_edit. Registers the folder, tells the panel to
 * open (or focus) the tab, and validates canvas.json (without rendering anything:
 * unlike motion, the artboard is static HTML — the sandboxed iframe validates the
 * rest).
 */
export async function openDesignAndReport(input: {
  /** Folder of the canvas, already resolved and authorized. */
  target: string
  root?: string
  sessionId: string
  label: string
  nextStep: string
}): Promise<string> {
  const reg = await registerDesign(input.target, { root: input.root, sessionId: input.sessionId })
  const name = path.basename(input.target)
  panelDesignPreview({ id: reg.id, title: name, path: input.target, sessionId: input.sessionId })
  try {
    const canvas = await readDesignCanvas(input.target)
    if (canvas.order.length === 0) throw new Error('canvas.json has no artboards in "order"')
    // The cover goes out in BACKGROUND: the canvas is already open in the panel, and the
    // tool result has no reason to wait for the offscreen window to load,
    // take the shot and sharp to resize (see design-gallery.ts).
    refreshDesignCover(reg.id, { sessionId: input.sessionId })
    const boards = canvas.order.map((file) => {
      const b = canvas.boards[file]
      if (!b) return `"${file}" (missing from boards!)`
      return `"${b.title ?? file}" (${file}, ${Math.round(b.w)}×${Math.round(b.h)} at ${Math.round(b.x)},${Math.round(b.y)})`
    })
    // The shared style sheets are not in canvas.json (the index is only
    // the LAYOUT): without this line the agent forgets that base.css exists and goes back
    // to repeating the CSS inside every document.
    const styles = (await fsp.readdir(input.target).catch(() => [] as string[]))
      .filter((file) => file.toLowerCase().endsWith('.css'))
      .sort()
    const stylesNote = styles.length > 0 ? ` Shared stylesheets: ${styles.join(', ')}.` : ''
    return [
      `Design "${name}" is open in the Design tab of the right panel (${input.label}) with ${boards.length} artboard${boards.length === 1 ? '' : 's'}: ${boards.join('; ')}.${stylesNote}`,
      input.nextStep,
    ].join('\n')
  } catch (err) {
    return `Design "${name}" is open in the Design tab, but canvas.json could not be read: ${err instanceof Error ? err.message : String(err)}. Fix it with design_edit or design_write and read this result again.`
  }
}
