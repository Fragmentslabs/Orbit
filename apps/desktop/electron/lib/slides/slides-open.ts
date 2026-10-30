import fsp from 'node:fs/promises'
import path from 'node:path'
import { listMedia } from '../media'
import { panelSlidesPreview } from '../panel-browser'
import { readDeckSummary } from './slides-deck'
import { registerSlidesCover } from './slides-gallery'
import { getSlides, registerSlides } from './slides-store'

/** Does the deck already have an item in the gallery? The `slidesId` is the link, not the folder. */
async function isInGallery(id: string): Promise<boolean> {
  try {
    const items = await listMedia({ kind: 'slides' })
    return items.some((item) => item.slidesId === id)
  } catch {
    return false
  }
}

/**
 * Opens a deck in the Slides tab of the panel and tells the agent how it turned out.
 *
 * Common step of `slides_preview` (code mode, deck in the project folder) and of
 * `slides_write` (chat mode, deck in the Orbit storage): registers the folder,
 * tells the panel to open (or focus) the tab and reads the deck from DISK —
 * without an offscreen window, unlike motion: the deck is static HTML, and how many
 * slides it has, with what title and what notes, is known by reading the file.
 *
 * The report closes the loop: the agent knows right away if it wrote a
 * `<section class="slide">` with the wrong name (zero slides) instead of finding
 * out from the user staring at an empty stage.
 */
export async function openSlidesAndReport(input: {
  /** Folder of the deck (or the entry HTML), already resolved and authorized. */
  target: string
  /** Explicit entry, when `target` is the folder. */
  entry?: string
  root?: string
  sessionId: string
  label: string
  nextStep: string
  /** Redoes the cover even if the deck is already in the gallery (rewritten deck). */
  refreshCover?: boolean
}): Promise<string> {
  const reg = await registerSlides(input.target, {
    entry: input.entry,
    root: input.root,
    sessionId: input.sessionId,
  })
  const name = path.basename(reg.folder)
  // The id makes the same deck come back to the SAME tab; `entry` is the path inside the
  // folder and `path` the absolute one, which the chat note returns to the agent.
  panelSlidesPreview({
    id: reg.id,
    entry: path.relative(reg.folder, reg.entry).split(path.sep).join('/'),
    title: name,
    path: reg.entry,
    sessionId: input.sessionId,
  })

  const html = await fsp.readFile(reg.entry, 'utf8').catch(() => null)
  if (html === null) {
    return `Slides "${name}" is registered but ${reg.entry} could not be read — the tab will show an empty stage. Write the deck again and call this tool.`
  }
  const deck = readDeckSummary(html)
  if (deck.slides.length === 0) {
    return (
      `Deck "${name}" is open in the Slides tab of the right panel (${input.label}), but it has NO slides: ` +
      'no <section class="slide"> was found in the file. The user is looking at an empty stage — ' +
      'write each slide as <section class="slide">…</section> (one per slide, in order) and call slides_preview again.'
    )
  }

  // Gallery: the cover is slide 1, and it is what makes the deck exist in the Media tab
  // (without this it would only come back through the chat card). Best-effort — a failed
  // capture leaves the item without a cover, it never takes down the opening.
  if (input.refreshCover || !(await isInGallery(reg.id))) {
    await registerSlidesCover(reg.id, { title: name, sessionId: input.sessionId }).catch(() => false)
  }

  const withNotes = deck.slides.filter((slide) => slide.notes).length
  const list = deck.slides
    .map((slide, index) => `${index + 1}. "${slide.title}"${slide.notes ? ' (has notes)' : ''}`)
    .join('; ')
  const count = deck.slides.length
  return [
    `Deck "${name}" is open in the Slides tab of the right panel (${input.label}) with ${count} slide${count === 1 ? '' : 's'}` +
      `${deck.title ? `, titled "${deck.title}"` : ''}: ${list}.` +
      (withNotes > 0 ? ` ${withNotes} of them have presenter notes.` : ''),
    'Navigation, scaling and notes are the app\'s: the deck file should stay content only (no JS of its own).',
    input.nextStep,
  ].join('\n')
}

/**
 * Reopens a deck that is ALREADY in the registry — the chat card, the gallery tile.
 * No `sessionId` on purpose: the renderer resolves the bucket from the ACTIVE chat
 * (see reopenMotion/reopenDesign, the same reasoning).
 */
export async function reopenSlides(id: string): Promise<boolean> {
  const entry = await getSlides(id)
  if (!entry) return false
  // After restarting the app the registry comes back from disk, but the watcher does not:
  // without registering again, the reopened deck would open without live reload. Idempotent.
  await registerSlides(entry.folder, { entry: entry.entry }).catch(() => {})
  panelSlidesPreview({
    id,
    entry: path.relative(entry.folder, entry.entry).split(path.sep).join('/'),
    title: path.basename(entry.folder),
    path: entry.entry,
  })
  return true
}
