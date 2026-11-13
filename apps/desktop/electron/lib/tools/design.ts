import { tool, type ToolSet } from 'ai'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  isSafeBoardFile,
  isSafeStyleFile,
  readDesignCanvas,
  writeDesignCanvas,
  type DesignCanvas,
} from '../design/design-canvas'
import { openDesignAndReport } from '../design/design-open'
import { getDesign, registerDesign } from '../design/design-store'
import { panelDesignPreview } from '../panel-browser'
import { withAssetLock, writeFileAtomic } from '../asset-lock'
import {
  ASSET_SOURCE,
  EDIT_OP,
  applyTextEdits,
  deletePiece,
  importIntoPiece,
  journalPiece,
  pieceSlug,
  piecesDir,
  type PieceToolScope,
} from './piece-common'

/**
 * Design — an artboard canvas (complete HTML screens/mockups, laid side by
 * side like a Figma board), in the same mold as motion (see motion.ts): in
 * BOTH modes the canvas lives in Orbit's storage
 * (`orbit-data/design/<session>/<name>/`), created and edited by NAME with the
 * tools from here — never with write/edit in the project. The Design tab opens and reloads
 * live on every write, and every write goes through the turn's journal (the message's
 * revert undoes it).
 *
 * Each artboard is a SELF-CONTAINED .html file (its own <html><head><style>) —
 * with no runtime and no template DSL: the agent writes real HTML/CSS, and the
 * browser resolves the layout. The ARRANGEMENT (position/size of each artboard on the
 * infinite canvas) is only that: a small JSON index (`canvas.json`), not a
 * tree parallel to the content — see design-canvas.ts.
 */

/** Folder of this conversation's canvases. */
export function designPiecesDir(sessionId: string): string {
  return piecesDir('design', sessionId)
}

/** "Landing page v2" → "landing-page-v2". Same algorithm as motionSlug. */
export function designSlug(name: string): string {
  return pieceSlug(name, 'design')
}

/**
 * Canvas name in a piece of the tool's JSON still STREAMING — chat-engine
 * accumulates the tool-input-delta and calls this on every piece. `name` is the first
 * field of the input, so it is enough to find the start of the value (partial parse by regex,
 * with the quote escaping resolved by the JSON.parse of the captured piece).
 */
export function designNameFromInputJson(json: string): string | null {
  const match = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(json)
  if (!match) return null
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return null
  }
}

/**
 * Opens the Design tab BEFORE the tool finishes: chat-engine calls this as soon as
 * the canvas name appears in the streaming input — while the model is still
 * transmitting the artboards' HTML. It registers the folder and guarantees a minimal canvas.json
 * (`placeholder`); design_write's progressive writing and the watcher
 * (design:changed) deliver each artboard as it is written, and the report()
 * at the end of the tool stays as it was (cover, validation, text for the model).
 * `placeholder: false` (design_edit) does not create an empty canvas: with no canvas the
 * edit has its own error ("create it with design_write") and there is nothing to
 * open.
 */
export async function openDesignLive(
  sessionId: string,
  name: string,
  opts: { placeholder?: boolean } = {},
): Promise<void> {
  const root = designPiecesDir(sessionId)
  const folder = path.join(root, designSlug(name))
  try {
    await fs.access(path.join(folder, 'canvas.json'))
  } catch {
    if (opts.placeholder === false) return
    await withAssetLock(`design:${folder}`, async () => {
      // The empty canvas is already a write of the turn: the folder goes into the journal first.
      await journalPiece('design', folder, { root, sessionId })
      await writeDesignCanvas(folder, { v: 1, boards: {}, order: [] })
    })
  }
  const reg = await registerDesign(folder, { root, sessionId })
  panelDesignPreview({ id: reg.id, title: designSlug(name), path: folder, sessionId })
}

const NAME = z
  .string()
  .min(1)
  .max(80)
  .describe('Name of the design canvas in this conversation (e.g. "landing-page") — the same name addresses it in every design tool')

/**
 * GLOBAL address by id (dsg_…), the same as the attachment note: it reads/edits a canvas
 * from any conversation without knowing its name. The writes read the canvas under
 * lock, so two chats on the same id do not silently overwrite each other.
 */
const ID = z
  .string()
  .min(1)
  .optional()
  .describe('Design id (dsg_…) of an existing canvas — the "design id" from an attachment note. Use it to read/edit a canvas from any conversation; omit when addressing by name in this one')

const BOARD_FILE = z
  .string()
  .min(1)
  .max(80)
  .describe('Artboard file name, plain (no slashes), ending in .html — e.g. "Main.html"')

const STYLE_FILE = z
  .string()
  .min(1)
  .max(80)
  .describe('Shared stylesheet file name, plain (no slashes), ending in .css — e.g. "base.css"')

/** Cap of artboards in one call: see the comment in the design_write schema. */
const MAX_BOARDS_PER_WRITE = 4

export function createDesignTools(scope: PieceToolScope): ToolSet {
  const root = designPiecesDir(scope.sessionId)

  /** Target by `name` (this conversation) OR by `id` (global). */
  const resolveFolder = async (input: { name?: string; id?: string }) => {
    if (input.id) {
      const reg = await getDesign(input.id)
      if (!reg) throw new Error(`no design canvas with id "${input.id}"`)
      return { folder: reg.folder, name: path.basename(reg.folder), root: reg.root }
    }
    if (!input.name) throw new Error('pass either `name` (a canvas of this conversation) or `id` (the dsg_… from an attachment note)')
    return { folder: path.join(root, designSlug(input.name)), name: designSlug(input.name), root }
  }

  /** Every write to the canvas: under the folder's lock and with the folder in the journal. */
  const writing = <T>(target: { folder: string; root?: string }, fn: () => Promise<T>) =>
    withAssetLock(`design:${target.folder}`, async () => {
      await journalPiece('design', target.folder, { root: target.root, sessionId: scope.sessionId })
      return fn()
    })

  const report = (target: { folder: string; name: string; root?: string }, verb: string) =>
    openDesignAndReport({
      target: target.folder,
      root: target.root ?? root,
      sessionId: scope.sessionId,
      label: `canvas "${target.name}", ${verb}`,
      nextStep:
        'Keep going with design_edit: exact `edits` for a small change (never resend a whole document for one line), `html` only for a full rewrite, `style` for the shared stylesheet, and the layout fields to move/resize/reorder. Add the remaining screens ONE AT A TIME so each shows up as you write it. The tab reloads live. Use design_read when unsure of the current HTML, the layout or the stylesheets.',
    })

  const tools: ToolSet = {
    design_write: tool({
      description:
        'Creates (or fully replaces) a design canvas — one or more HTML "artboards" laid out on an infinite canvas, like a Figma board — and opens it in the Design tab of the right panel, where the user sees it live and can reopen it later from the Media gallery. ' +
        'Use this — NOT create_artifact, and NOT an image — whenever the user wants a visual design to look at: a logo or brand mark, a UI mockup, a wireframe, a landing page, a poster, a social post, an app/web screen, or "design mode"/"modo design". The canvas holds exactly the artboards the request asks for: one screen is one artboard, and variants/options only when the user asked for them — never add one on your own, since every extra artboard is another whole document written. ' +
        'BUILD IN STAGES: when the request has more than one screen, the first call carries ONE artboard (the main screen) and the others arrive with design_edit, one at a time. The canvas opens on the first one and the rest appear as you write them — a batch of four stays empty until the whole input finishes streaming. ' +
        'Each artboard is a real HTML document (its own <!doctype>, <head>, <style> — no template syntax, no shared runtime/JS: write real HTML/CSS). For more than one artboard, put the shared foundation in `styles` (e.g. base.css: reset, design tokens, type scale, shared components) and link it from every artboard (<link rel="stylesheet" href="base.css">) instead of repeating the same CSS in each document — the Design tab serves every file of the canvas folder. Work LOW-FI FIRST: structure, hierarchy and the primary action before visual polish. ' +
        'Lay artboards side by side with x/y in canvas pixels so none overlap (80px gap between them is typical); w/h are the artboard\'s own pixel size. ' +
        'To make a CLICKABLE prototype, link the artboards with plain relative anchors (<a href="Pricing.html">): the artboard that links to another gets a Play button, and the user can present it on the canvas or in its own tab. ' +
        'After this, iterate with design_edit — small changes, not full rewrites. To USE a photo, GIF or video the user attached, copy it into the canvas first with design_asset and reference it with a relative src.',
      inputSchema: z.object({
        name: NAME.optional(),
        id: ID,
        title: z.string().optional().describe('Canvas title shown in the tab (default: the name)'),
        boards: z
          .array(
            z.object({
              file: BOARD_FILE,
              title: z.string().optional().describe('Artboard label shown above it on the canvas'),
              x: z.number(),
              y: z.number(),
              w: z.number().min(40).max(8000),
              h: z.number().min(40).max(8000),
              html: z
                .string()
                .min(1)
                .describe('The COMPLETE HTML document for this artboard (link the shared stylesheet from it when the canvas has one)'),
            }),
          )
          .min(1)
          // Cap of ONE call. The tool only executes when the input finishes
          // streaming: four screens in one call = an empty canvas until the end. One per
          // call (the main one here, the rest in design_edit) shows the first
          // while the model is still writing the others — see prompts.ts.
          .max(
            MAX_BOARDS_PER_WRITE,
            'at most 4 artboards per call — write the main one first and add the rest with design_edit',
          ),
        styles: z
          .array(
            z.object({
              file: STYLE_FILE,
              css: z
                .string()
                .min(1)
                .describe('The whole stylesheet: reset, design tokens, type scale, shared components'),
            }),
          )
          .max(3)
          .optional()
          .describe(
            'Shared stylesheets written into the canvas folder. Link them from the artboards (<link rel="stylesheet" href="base.css">) instead of repeating the same CSS in every document — it is the biggest token waste in this flow',
          ),
      }),
      execute: async ({ name, id, title, boards, styles }) => {
        // The schema already limits it; here the message is what the model needs to see if the
        // validation is bypassed (execute is also called directly).
        if (boards.length > MAX_BOARDS_PER_WRITE) {
          throw new Error(
            `design_write takes at most ${MAX_BOARDS_PER_WRITE} artboards — write the main one here and add the rest with design_edit, one at a time, so each appears while you write the next`,
          )
        }
        for (const b of boards) {
          if (!isSafeBoardFile(b.file)) {
            throw new Error(`invalid artboard file name: "${b.file}" — use a plain name ending in .html, e.g. "Main.html"`)
          }
        }
        for (const s of styles ?? []) {
          if (!isSafeStyleFile(s.file)) {
            throw new Error(`invalid stylesheet file name: "${s.file}" — use a plain name ending in .css, e.g. "base.css"`)
          }
        }
        const target = await resolveFolder({ name, id })
        // A whole canvas (canvas.json + several artboards) stays under a single lock:
        // two design_write on the same id do not interleave and do not leave the index
        // pointing at a half-written artboard.
        const existed = await writing(target, async () => {
          // The empty canvas from openDesignLive (live opening) does not count as
          // existing: "replaced" only when there is already an artboard in the canvas.
          let existed = false
          try {
            existed = (await readDesignCanvas(target.folder)).order.length > 0
          } catch {
            existed = false
          }
          await fs.mkdir(target.folder, { recursive: true })
          // The shared base comes in BEFORE the artboards: they already reference it
          // (<link href="base.css">) and that way there is no instant with the screen without
          // style (the watcher reloads the tab on every file).
          for (const s of styles ?? []) await writeFileAtomic(path.join(target.folder, s.file), s.css)
          // Progressive writing: each artboard enters canvas.json as soon as the
          // file is written — with the tab already open since the input's streaming
          // (openDesignLive), the user sees the board assembling piece by piece instead
          // of waiting for the whole batch. The canvas is a replacement: the new index
          // is born empty and grows.
          const canvas: DesignCanvas = { v: 1, title: title ?? target.name, boards: {}, order: [] }
          for (const b of boards) {
            await writeFileAtomic(path.join(target.folder, b.file), b.html)
            canvas.boards[b.file] = { title: b.title, x: b.x, y: b.y, w: b.w, h: b.h }
            canvas.order.push(b.file)
            await writeDesignCanvas(target.folder, canvas)
          }
          return existed
        })
        return report(target, existed ? 'replaced' : 'created')
      },
    }),

    design_edit: tool({
      description:
        'Edits an existing design canvas of this conversation: apply EXACT text replacements to one artboard (preferred — like the edit tool, oldText must exist and be unique unless replaceAll) or replace its whole HTML (full rewrite); edit the SHARED STYLESHEET (pass `style`); move/resize/retitle an artboard; add a brand-new artboard (pass html); remove one; or reorder the whole stack. ' +
        'Never resend a whole document for a one-line change — design_read first when unsure of the exact text. The Design tab reloads live.',
      inputSchema: z.object({
        name: NAME.optional(),
        id: ID,
        file: BOARD_FILE.optional().describe('The artboard to change — omit only when `order` alone is reordering the stack'),
        html: z.string().optional().describe('Full replacement HTML for `file` (creating a new artboard: required)'),
        edits: z
          .array(EDIT_OP)
          .optional()
          .describe('Exact text replacements applied to the CURRENT content of `file`, as an alternative to `html`'),
        style: z
          .object({
            file: STYLE_FILE,
            css: z.string().optional().describe('Full replacement of the stylesheet'),
            edits: z.array(EDIT_OP).optional().describe('Exact text replacements applied to the current stylesheet'),
          })
          .optional()
          .describe('Edit a shared stylesheet of the canvas (exact `edits`, or the whole `css`) instead of an artboard'),
        title: z.string().optional().describe('New artboard label (or, with no `file`, the canvas title)'),
        x: z.number().optional(),
        y: z.number().optional(),
        w: z.number().min(40).max(8000).optional(),
        h: z.number().min(40).max(8000).optional(),
        remove: z.boolean().optional().describe('Remove this artboard from the canvas and delete its file'),
        order: z.array(z.string()).optional().describe('New full back-to-front order of artboard file names'),
      }),
      execute: async ({ name, id, file, html, edits, style, title, x, y, w, h, remove, order }) => {
        const target = await resolveFolder({ name, id })
        if (file && !isSafeBoardFile(file)) {
          throw new Error(`invalid artboard file name: "${file}" — use a plain name ending in .html`)
        }
        if (style && !isSafeStyleFile(style.file)) {
          throw new Error(`invalid stylesheet file name: "${style.file}" — use a plain name ending in .css, e.g. "base.css"`)
        }
        // Read the canvas, touch the artboard and rewrite the index under the same lock:
        // an edit that read a stale canvas (another chat wrote in the middle)
        // fails on the oldText instead of overwriting.
        await writing(target, async () => {
          let canvas: DesignCanvas
          try {
            canvas = await readDesignCanvas(target.folder)
          } catch {
            throw new Error(`no design canvas named "${target.name}" — create it with design_write`)
          }
          if (style) {
            // The shared sheet is a file of the folder like the artboard: the same
            // pair "replace everything / exact swap", so a small edit does not cost
            // the whole CSS back.
            const stylePath = path.join(target.folder, style.file)
            if (style.css !== undefined) {
              await writeFileAtomic(stylePath, style.css)
            } else if (style.edits && style.edits.length > 0) {
              let current: string
              try {
                current = await fs.readFile(stylePath, 'utf8')
              } catch {
                throw new Error(`stylesheet "${style.file}" does not exist yet — pass css to create it`)
              }
              await writeFileAtomic(stylePath, applyTextEdits(current, style.edits))
            } else if (!(await fs.stat(stylePath).catch(() => null))) {
              throw new Error(`stylesheet "${style.file}" is new — pass css with its content`)
            }
          }
          if (file && remove) {
            await fs.rm(path.join(target.folder, file), { force: true })
            delete canvas.boards[file]
            canvas.order = canvas.order.filter((f) => f !== file)
          } else if (file) {
            const existingBoard = canvas.boards[file]
            if (html !== undefined) {
              await writeFileAtomic(path.join(target.folder, file), html)
            } else if (edits && edits.length > 0) {
              let current: string
              try {
                current = await fs.readFile(path.join(target.folder, file), 'utf8')
              } catch {
                throw new Error(`artboard "${file}" does not exist yet — pass html to create it`)
              }
              await writeFileAtomic(path.join(target.folder, file), applyTextEdits(current, edits))
            } else if (!existingBoard) {
              throw new Error(`artboard "${file}" is new — pass html with its full content`)
            }
            canvas.boards[file] = {
              // A loose piece the person made stays loose when the agent touches it.
              ...(existingBoard?.free ? { free: true as const } : {}),
              title: title ?? existingBoard?.title,
              x: x ?? existingBoard?.x ?? 0,
              y: y ?? existingBoard?.y ?? 0,
              w: w ?? existingBoard?.w ?? 800,
              h: h ?? existingBoard?.h ?? 600,
            }
            if (!canvas.order.includes(file)) canvas.order.push(file)
          } else if (title !== undefined) {
            canvas.title = title
          }
          if (order) canvas.order = order
          await writeDesignCanvas(target.folder, canvas)
        })
        return report(
          target,
          style ? `updated "${style.file}"` : remove ? `removed "${file}"` : file ? `updated "${file}"` : 'layout updated',
        )
      },
    }),

    design_read: tool({
      description:
        'Returns the layout (canvas.json: artboards, position, size, plus the shared stylesheets) of a design canvas (of this conversation by name, or any one by id), or — with `file` — one file\'s current content (an artboard .html or a stylesheet .css). The user may have asked for changes since you wrote it, and edits need the exact text. An artboard marked `free: true` is a LOOSE piece the user left on the canvas outside any frame (an element or some text): it is still an HTML file you can edit, but it is not a screen — never link to it or count it as one.',
      inputSchema: z.object({
        name: NAME.optional(),
        id: ID,
        file: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe('One file of the canvas to return as-is: an artboard (.html) or a shared stylesheet (.css)'),
      }),
      execute: async ({ name, id, file }) => {
        const target = await resolveFolder({ name, id })
        if (file) {
          if (!isSafeBoardFile(file) && !isSafeStyleFile(file)) {
            throw new Error(`invalid file name: "${file}" — use a plain name ending in .html or .css`)
          }
          try {
            return await fs.readFile(path.join(target.folder, file), 'utf8')
          } catch {
            throw new Error(`file "${file}" not found in canvas "${target.name}"`)
          }
        }
        try {
          const canvas = await readDesignCanvas(target.folder)
          // canvas.json is only the ARRANGEMENT: the shared sheets are not in it.
          // Without this list the agent forgets that base.css exists — it repeats the CSS in
          // each document or rewrites an artboard without the <link>.
          const styles = (await fs.readdir(target.folder).catch(() => [] as string[]))
            .filter((entry) => entry.toLowerCase().endsWith('.css'))
            .sort()
          return JSON.stringify({ ...canvas, styles }, null, 2)
        } catch {
          throw new Error(`no design canvas named "${target.name}"`)
        }
      },
    }),

    design_asset: tool({
      description:
        'Copies material INTO a design canvas so an artboard can use it by relative src: a photo, GIF or video the user ATTACHED (`ref`: img_…, vdo_…) or, in code mode, a file of the working folder (`path`: a logo, a screenshot, a font of the project). ' +
        'Call it only when you decide to USE the material in a design; attaching does not copy it anywhere, and reading it does not need it. name: the canvas (created later by design_write if it does not exist yet). ' +
        'The result gives the file name to put in the artboard HTML as a RELATIVE src (e.g. <img src="photo.png">) — the Design tab serves every file of the canvas folder, so the image appears live.',
      inputSchema: z.object({
        ...ASSET_SOURCE,
        name: NAME.optional(),
        id: ID,
      }),
      execute: async ({ ref, path: source, filename, name, id }) => {
        const target = await resolveFolder({ name, id })
        const imported = await writing(target, () =>
          importIntoPiece(target.folder, { ref, path: source, filename }, scope.project, (kind, file) =>
            kind === 'video'
              ? `Use it in an artboard as <video src="${file}"></video>.`
              : kind === 'audio'
                ? `Use it in an artboard as <audio src="${file}"></audio>.`
                : `Use it in an artboard as <img src="${file}"> — style it with CSS. It is a RELATIVE url: the Design tab serves every file of the canvas folder, so the image appears live.`,
          ),
        )
        return imported.report
      },
    }),

    design_preview: tool({
      description:
        'Opens (or brings back to focus) an EXISTING design canvas in the Design tab of the right panel and reports its layout (artboards, sizes, positions) and shared stylesheets. Writes nothing. ' +
        'Use it when the user wants to see a canvas again (the tab was closed, "abre o design de novo"). design_write and design_edit already open the tab — no need to call this after them.',
      inputSchema: z.object({ name: NAME.optional(), id: ID }),
      execute: async ({ name, id }) => {
        const target = await resolveFolder({ name, id })
        try {
          await fs.access(path.join(target.folder, 'canvas.json'))
        } catch {
          throw new Error(`no design canvas named "${target.name}" — create it with design_write`)
        }
        return report(target, 'opened')
      },
    }),

    design_delete: tool({
      description:
        'Deletes a design canvas for good: its folder (every artboard and stylesheet), its item in the Media gallery and its tab. Only when the user asks to delete/remove the design. (Undoing the message brings it back.) To drop ONE artboard, use design_edit with remove.',
      inputSchema: z.object({ name: NAME.optional(), id: ID }),
      execute: async ({ name, id }) => {
        const target = await resolveFolder({ name, id })
        try {
          await fs.access(path.join(target.folder, 'canvas.json'))
        } catch {
          throw new Error(`no design canvas named "${target.name}"`)
        }
        const reg = await registerDesign(target.folder, { root: target.root, sessionId: scope.sessionId })
        const result = await deletePiece('design', reg.id)
        return result.removedFolder
          ? `Design "${target.name}" deleted (folder, gallery item and tab).`
          : `Design "${target.name}" removed from the gallery, but its folder was kept: ${result.keptBecause}.`
      },
    }),
  }

  // Plan mode: read and show, without writing.
  if (scope.readOnly) {
    delete tools.design_write
    delete tools.design_edit
    delete tools.design_asset
    delete tools.design_delete
  }
  return tools
}
