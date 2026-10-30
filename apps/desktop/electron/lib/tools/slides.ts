import { tool, type ToolSet } from 'ai'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { withAssetLock, writeFileAtomic } from '../asset-lock'
import { buildDeckHtml } from '../slides/deck-template'
import { readDeckSummary } from '../slides/slides-deck'
import { getSlides, registerSlides, slidesPiecesDir } from '../slides/slides-store'
import { slidesSlug } from '../slides/slides-slug'
import { openSlidesAndReport } from '../slides/slides-open'
import {
  ASSET_SOURCE,
  EDIT_OP,
  applyTextEdits,
  deletePiece,
  importIntoPiece,
  journalPiece,
  type PieceToolScope,
} from './piece-common'

/**
 * Slides — the deck lives in Orbit's storage
 * (`orbit-data/slides/<session>/<name>/index.html`), in BOTH modes, created and
 * edited by NAME with the tools from here.
 *
 * Two write doors into the same deck: `slides` (the content of each slide in the
 * call itself, and main assembles the file with the house theme — the ergonomics of
 * create_artifact) and `html` (the whole document, for whoever wants their own CSS).
 * After that, slides_edit swaps exact excerpts without resending the deck. Every
 * write goes through the turn's journal: the message's revert undoes it.
 */

const SLIDE = z.object({
  title: z
    .string()
    .max(120)
    .optional()
    .describe('Short name of the slide, shown in the tab list and in the deck report (default: its first h1/h2/h3)'),
  html: z
    .string()
    .min(1)
    .describe(
      'The slide body as HTML — real content, no <section> wrapper (the tool adds it), no <script>. ' +
        'Use classes .cover (title slide), .section (divider), .kicker, .lead, .grid.cols-2/.cols-3, .card, .stat/.stat-value/.stat-label, .quote, .pill. ' +
        'Aim for one idea per slide: a headline and at most ~5 short points.',
    ),
  notes: z
    .string()
    .optional()
    .describe('Presenter notes for this slide (what to SAY), hidden on stage and shown in the Notes panel'),
})

const NAME = z
  .string()
  .min(1)
  .max(80)
  .describe('The deck in this conversation — its title or name (e.g. "Orbit em 12 slides"); the same name addresses it in every slides tool')

const ID = z
  .string()
  .min(1)
  .optional()
  .describe('Slides id (sld_…) of an existing deck — from a chat card or an attachment note. Use it to reach a deck from any conversation; omit when addressing by name in this one')

export function createSlidesTools(scope: PieceToolScope): ToolSet {
  const root = slidesPiecesDir(scope.sessionId)

  /** Target by `name` (this conversation's deck) OR by `id` (global). */
  const resolveDeck = async (input: { name?: string; id?: string }) => {
    if (input.id) {
      const reg = await getSlides(input.id)
      if (!reg) throw new Error(`no slide deck with id "${input.id}"`)
      return { folder: reg.folder, entry: reg.entry, root: reg.root ?? root, name: path.basename(reg.folder) }
    }
    if (!input.name) throw new Error('pass either `name` (a deck of this conversation) or `id` (the sld_… of a deck)')
    const folder = path.join(root, slidesSlug(input.name))
    return { folder, entry: path.join(folder, 'index.html'), root, name: slidesSlug(input.name) }
  }

  type Deck = Awaited<ReturnType<typeof resolveDeck>>

  const mustExist = async (deck: Deck) => {
    try {
      await fsp.access(deck.entry)
    } catch {
      const list = await fsp.readdir(root).catch(() => [] as string[])
      throw new Error(`no deck named "${deck.name}"${list.length ? ` — existing: ${list.join(', ')}` : ' — create it with slides_write'}`)
    }
  }

  /** Every write to the deck: under the folder's lock and with the folder in the journal. */
  const writing = <T>(deck: Deck, fn: () => Promise<T>) =>
    withAssetLock(`slides:${deck.folder}`, async () => {
      await journalPiece('slides', deck.folder, { entry: deck.entry, root: deck.root, sessionId: scope.sessionId })
      return fn()
    })

  const report = (deck: Deck, verb: string, refreshCover: boolean) =>
    openSlidesAndReport({
      target: deck.folder,
      entry: deck.entry,
      root: deck.root,
      sessionId: scope.sessionId,
      label: `deck "${deck.name}", ${verb}`,
      // Rewritten or edited: the old cover would show a slide that may not even
      // exist anymore.
      refreshCover,
      nextStep:
        'To change it, use slides_edit with exact replacements (slides_read first when unsure of the text) — never resend the whole deck for a small change. The tab reloads live, at the same slide.',
    })

  const tools: ToolSet = {
    slides_read: tool({
      description:
        'Returns the current HTML of a slide deck (of this conversation by name, or any one by id) — the whole file, with every <section class="slide">. The user may have asked for changes since you wrote it, and slides_edit needs the exact text.',
      inputSchema: z.object({ name: NAME.optional(), id: ID }),
      execute: async ({ name, id }) => {
        const deck = await resolveDeck({ name, id })
        await mustExist(deck)
        return fsp.readFile(deck.entry, 'utf8')
      },
    }),

    slides_preview: tool({
      description:
        'Opens (or brings back to focus) an EXISTING slide deck in the Slides tab of the right panel and reports its slides by title. Writes nothing. ' +
        'Use it when the user wants to see or present a deck again (the tab was closed, "abre os slides de novo"). slides_write and slides_edit already open the tab — no need to call this after them.',
      inputSchema: z.object({ name: NAME.optional(), id: ID }),
      execute: async ({ name, id }) => {
        const deck = await resolveDeck({ name, id })
        await mustExist(deck)
        return report(deck, 'opened', false)
      },
    }),
  }

  if (scope.readOnly) return tools

  tools.slides_write = tool({
    description:
      'Creates (or fully replaces) a slide deck and opens it in the Slides tab of the right panel, where the user presents it in fullscreen. The deck lives in Orbit (not in the project) and is addressed by its title. ' +
      'Two ways to write it — pass exactly one: ' +
      '`slides` (the usual one): an array of slides; the app supplies the house theme (dark, gold accent, large type), the 16:9 stage, navigation, the slide list, presenter notes and fullscreen — write content, not CSS. Use the helper classes: .cover (opening), .section (divider), .kicker (small uppercase label), .lead (large intro line), .grid.cols-2 / .cols-3 / .cols-4 with .card, .stat + .stat-value + .stat-label (a number worth reading), .quote. ' +
      '`html`: the WHOLE deck document, for a custom look — <style> in the head and nothing but <section class="slide">…</section> blocks in the body (optional data-title on a section, presenter notes in <aside class="notes"> inside it, <meta name="orbit-slides" content="width=1280,height=720"> for another stage size); no script, no navigation of your own. ' +
      'One idea per slide, a headline and at most ~5 short points. After this, change it with slides_edit (exact replacements), not by sending the deck again.',
    inputSchema: z.object({
      title: z.string().min(1).max(80).describe('Deck title — also its address in this conversation'),
      id: ID,
      slides: z.array(SLIDE).min(1).max(60).optional().describe('The slides, in presentation order (house theme)'),
      html: z.string().min(1).optional().describe('The complete deck document (custom theme), instead of `slides`'),
      lang: z
        .string()
        .length(2)
        .optional()
        .describe('Language of the deck html element (default: pt-BR) — only with `slides`. The slide TEXT is not translated by this'),
    }),
    execute: async ({ title, id, slides, html, lang }) => {
      if (Boolean(slides) === Boolean(html)) throw new Error('pass exactly one of `slides` (house theme) or `html` (the whole deck document)')
      const document = slides ? buildDeckHtml({ title, slides, lang }) : html!
      if (readDeckSummary(document).slides.length === 0) {
        throw new Error('the deck has no <section class="slide"> — write one section per slide')
      }
      const deck = await resolveDeck({ name: title, id })
      const existed = await writing(deck, async () => {
        const existed = await fsp.access(deck.entry).then(() => true, () => false)
        await fsp.mkdir(deck.folder, { recursive: true })
        await writeFileAtomic(deck.entry, document)
        return existed
      })
      return report(deck, existed ? 'replaced' : 'created', true)
    },
  })

  tools.slides_edit = tool({
    description:
      'Edits a slide deck with EXACT text replacements on its HTML, applied in order (oldText must exist and be unique unless replaceAll): fix a line, change a number, rewrite one slide, add a slide (replace the closing </section> of the slide before it with itself plus the new section), remove one, adjust the CSS of a custom deck. ' +
      'The Slides tab reloads live at the same slide. slides_read first when unsure of the exact text.',
    inputSchema: z.object({
      name: NAME.optional(),
      id: ID,
      edits: z.array(EDIT_OP).min(1),
    }),
    execute: async ({ name, id, edits }) => {
      const deck = await resolveDeck({ name, id })
      await writing(deck, async () => {
        let source: string
        try {
          source = await fsp.readFile(deck.entry, 'utf8')
        } catch {
          throw new Error(`no deck named "${deck.name}" — create it with slides_write`)
        }
        const next = applyTextEdits(source, edits)
        if (readDeckSummary(next).slides.length === 0) {
          throw new Error('after these edits the deck would have no <section class="slide"> — nothing was written')
        }
        await writeFileAtomic(deck.entry, next)
      })
      return report(deck, `${edits.length} edit${edits.length === 1 ? '' : 's'} applied`, true)
    },
  })

  tools.slides_asset = tool({
    description:
      'Copies material INTO a deck so a slide can use it by relative src: a photo, GIF or video the user ATTACHED (`ref`: img_…, vdo_…) or, in code mode, a file of the working folder (`path`: a screenshot, a logo, a chart image). ' +
      'Call it only when you decide to USE the material on a slide. name: the deck (created later by slides_write if it does not exist yet). The result gives the file name to put in the slide HTML (e.g. <img src="chart.png">).',
    inputSchema: z.object({
      ...ASSET_SOURCE,
      name: NAME.optional(),
      id: ID,
    }),
    execute: async ({ ref, path: source, filename, name, id }) => {
      const deck = await resolveDeck({ name, id })
      const imported = await writing(deck, () =>
        importIntoPiece(deck.folder, { ref, path: source, filename }, scope.project, (kind, file) =>
          kind === 'video'
            ? `Use it on a slide as <video src="${file}" controls></video>.`
            : kind === 'audio'
              ? `Use it on a slide as <audio src="${file}" controls></audio>.`
              : `Use it on a slide as <img src="${file}"> — a RELATIVE url: the Slides tab serves every file of the deck folder.`,
        ),
      )
      return imported.report
    },
  })

  tools.slides_delete = tool({
    description:
      'Deletes a slide deck for good: its folder, its item in the Media gallery and its tab. Only when the user asks to delete/remove the deck. (Undoing the message brings it back.) To drop ONE slide, use slides_edit.',
    inputSchema: z.object({ name: NAME.optional(), id: ID }),
    execute: async ({ name, id }) => {
      const deck = await resolveDeck({ name, id })
      await mustExist(deck)
      const reg = await registerSlides(deck.folder, { entry: deck.entry, root: deck.root, sessionId: scope.sessionId })
      const result = await deletePiece('slides', reg.id)
      return result.removedFolder
        ? `Deck "${deck.name}" deleted (folder, gallery item and tab).`
        : `Deck "${deck.name}" removed from the gallery, but its folder was kept: ${result.keptBecause}.`
    },
  })

  return tools
}
