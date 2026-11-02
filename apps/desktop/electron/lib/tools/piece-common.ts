import path from 'node:path'
import { z } from 'zod'
import type { MediaKind } from '@shared/media'
import { deleteMedia, listMedia } from '../media'
import { panelPiecesRemoved } from '../panel-browser'
import { journalPath, type PieceKind } from '../session/media-journal'
import { deleteDesignCanvas, designIdFor } from '../design/design-store'
import { deleteSlidesDeck, slidesIdFor } from '../slides/slides-store'
import { deleteMotionComposition, motionIdFor } from '../video/motion-store'
import { importAttachmentInto, importFileInto, type ImportedAsset } from '../video/motion-asset'
import type { AttachmentKind } from '../attachment-ref'
import { resolveSafePath, type ToolContext } from './context'

/**
 * What Orbit's three pieces (motion, design, slides) have in common, in BOTH
 * modes. A piece is an app object: it lives in Orbit's storage
 * (`orbit-data/<type>/<session>/<name>/`), is created, read, shown, edited and
 * deleted by its tools, by NAME (this conversation) or by id (from any
 * conversation) — in the chat and in code, the same tools. The user's repository only
 * receives a piece when they ask (piece_export).
 *
 * Every write to a piece folder first goes through the turn's media journal
 * (journalPiece): that is what lets the message's revert undo it.
 */

export interface PieceToolScope {
  sessionId: string
  /**
   * Working folder (code mode). With it, the *_asset ones also copy a
   * project file (`path`) and piece_export writes the piece into it.
   */
  project?: ToolContext | null
  /** Main session: opens and focuses the tab. Worker: writes without opening a tab. */
  canShow?: boolean
  /** Plan mode: read and show only. */
  readOnly?: boolean
}

// Path and slug live in their own module (piece-paths): the project
// import uses both without dragging media, journal and the other pieces along.
export { piecesDir, piecesRoot, pieceSlug } from './piece-paths'

/**
 * Saves the piece folder in the turn's journal BEFORE the write — call it inside the
 * piece's lock. Outside a turn (the person editing in the panel) it does nothing.
 */
export async function journalPiece(
  kind: PieceKind,
  folder: string,
  meta: { entry?: string; root?: string; sessionId?: string } = {},
): Promise<void> {
  const id =
    kind === 'motion'
      ? motionIdFor(folder, meta.entry ?? path.join(folder, 'index.html'))
      : kind === 'slides'
        ? slidesIdFor(folder, meta.entry ?? path.join(folder, 'index.html'))
        : designIdFor(folder)
  await journalPath(folder, { kind, id, folder: path.resolve(folder), ...meta })
}

export interface TextEdit {
  oldText: string
  newText: string
  replaceAll?: boolean
}

export const EDIT_OP = z.object({
  oldText: z.string().describe('Exact current text (copy it, including indentation)'),
  newText: z.string(),
  replaceAll: z.boolean().optional(),
})

/** What one edit did: where, how many times, and the size of the text it swapped. */
export interface AppliedEdit {
  /** 1-based number of the edit in the call. */
  edit: number
  /** Line (1-based, in the text as it was when this edit ran) of the first replacement. */
  line: number
  replacements: number
  /** Lines of oldText → lines of newText (per replacement). */
  oldLines: number
  newLines: number
  /** The first line of what is there now, cut short — the "receipt" of the change. */
  now: string
}

const lineCount = (text: string): number => text.split('\n').length

/**
 * Applies EXACT replacements in order (the same contract as code mode's `edit`): the
 * excerpt has to exist and, without replaceAll, be unique — otherwise the replacement would land in the
 * wrong place silently. An edit that swaps a text for itself is refused too: it would report
 * "applied" and change nothing. Pure.
 */
export function applyTextEditsDetailed(source: string, edits: TextEdit[]): { text: string; applied: AppliedEdit[] } {
  let out = source
  const applied: AppliedEdit[] = []
  edits.forEach((edit, i) => {
    if (!edit.oldText) throw new Error(`edit ${i + 1}: oldText is empty`)
    if (edit.oldText === edit.newText) {
      throw new Error(`edit ${i + 1}: oldText and newText are identical — nothing would change`)
    }
    const count = out.split(edit.oldText).length - 1
    if (count === 0) throw new Error(`edit ${i + 1}: oldText not found — read the current text first and copy it exactly`)
    if (count > 1 && !edit.replaceAll) {
      throw new Error(`edit ${i + 1}: oldText appears ${count} times — add surrounding text to make it unique, or set replaceAll`)
    }
    const at = out.indexOf(edit.oldText)
    applied.push({
      edit: i + 1,
      line: out.slice(0, at).split('\n').length,
      replacements: edit.replaceAll ? count : 1,
      oldLines: lineCount(edit.oldText),
      newLines: lineCount(edit.newText),
      now: (edit.newText.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 100),
    })
    out = edit.replaceAll ? out.split(edit.oldText).join(edit.newText) : out.replace(edit.oldText, () => edit.newText)
  })
  return { text: out, applied }
}

export function applyTextEdits(source: string, edits: TextEdit[]): string {
  return applyTextEditsDetailed(source, edits).text
}

/** The two ways of bringing material into a piece. */
export const ASSET_SOURCE = {
  ref: z.string().optional().describe('Reference from the attachment note: img_…, vdo_… or aud_… (something the user ATTACHED)'),
  path: z
    .string()
    .optional()
    .describe('A file of the working folder (code mode only) — a project image, footage, a font, a local library such as node_modules/gsap/dist/gsap.min.js'),
  filename: z.string().optional().describe('Name for the copy (default: the original name, made safe)'),
}

/**
 * Copies an attachment (`ref`) or a file from the working folder (`path`) into the
 * piece folder. The caller has already registered the folder in the journal.
 */
export async function importIntoPiece(
  folder: string,
  input: { ref?: string; path?: string; filename?: string },
  project: ToolContext | null | undefined,
  usageNote?: (kind: AttachmentKind, name: string) => string,
): Promise<ImportedAsset> {
  if (Boolean(input.ref) === Boolean(input.path)) {
    throw new Error('pass exactly one source: `ref` (an attachment) or `path` (a file of the working folder)')
  }
  if (input.ref) return importAttachmentInto(folder, input.ref, input.filename, { usageNote })
  if (!project) throw new Error('`path` needs a working folder (code mode) — in chat, bring material in by its attachment `ref`')
  return importFileInto(folder, resolveSafePath(project, input.path!), input.filename, { usageNote })
}

const GALLERY_LINK: Record<PieceKind, 'motionId' | 'designId' | 'slidesId'> = {
  motion: 'motionId',
  design: 'designId',
  slides: 'slidesId',
}

/**
 * Really deletes a piece: the gallery item (whose hook deletes the folder and the
 * record), or only the folder and the record when it never entered the gallery. Its
 * tabs close. In the agent's turn everything goes through the journal — the message's
 * revert brings the piece back.
 */
export async function deletePiece(kind: PieceKind, id: string): Promise<{ removedFolder: boolean; keptBecause?: string }> {
  const link = GALLERY_LINK[kind]
  const items = await listMedia({ kind: kind as MediaKind })
  const item = items.find((entry) => entry[link] === id)
  let result: { removedFolder: boolean; keptBecause?: string }
  if (item) {
    await deleteMedia(item.id)
    result = { removedFolder: true }
  } else {
    result =
      kind === 'motion' ? await deleteMotionComposition(id) : kind === 'design' ? await deleteDesignCanvas(id) : await deleteSlidesDeck(id)
  }
  panelPiecesRemoved({ [kind]: [id] })
  return result
}
