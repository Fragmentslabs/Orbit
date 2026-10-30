import { tool } from 'ai'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { getDesign } from '../design/design-store'
import { getSlides } from '../slides/slides-store'
import { slidesSlug } from '../slides/slides-slug'
import { getMotion } from '../video/motion-store'
import { resolveSafePath, type ToolContext } from './context'
import { pieceSlug, piecesDir } from './piece-common'

/**
 * The only door from an Orbit piece to the user's repository (code
 * mode): it copies the whole folder — the composition, the canvas, the deck, with the
 * assets — to a path in the working folder. Only when they ASK for the piece
 * as a project file; the rest of the time it lives in Orbit, where its
 * tools edit it and the revert undoes it. The copy belongs to the project: it enters the turn's
 * snapshot like any other written file.
 */
export function createPieceExportTool(ctx: ToolContext, scope: { sessionId: string }) {
  return tool({
    description:
      'Copies an Orbit piece — a motion composition, a design canvas or a slide deck, with every file of its folder — into the working folder. ONLY when the user asks for the piece as files of the project ("salva o design no repo", "coloca os slides em docs/"). ' +
      'Pieces live in Orbit, not in the project: this is a one-way copy, and the piece keeps being edited with its own tools (the copy in the project does not follow). For a rendered video in the project, use motion_render with `output` instead.',
    inputSchema: z.object({
      kind: z.enum(['motion', 'design', 'slides']),
      name: z.string().min(1).max(80).optional().describe('The piece in this conversation, by name'),
      id: z.string().min(1).optional().describe('The piece id (mv_…, dsg_…, sld_…), for a piece of another conversation'),
      path: z.string().min(1).describe('Destination folder in the working folder (e.g. design/landing). It is created; existing files with the same names are overwritten'),
    }),
    execute: async ({ kind, name, id, path: destination }) => {
      let folder: string
      if (id) {
        const entry = kind === 'motion' ? await getMotion(id) : kind === 'design' ? await getDesign(id) : await getSlides(id)
        if (!entry) throw new Error(`no ${kind} piece with id "${id}"`)
        folder = entry.folder
      } else if (name) {
        const slug = kind === 'slides' ? slidesSlug(name) : pieceSlug(name, kind)
        folder = path.join(piecesDir(kind, scope.sessionId), slug)
      } else {
        throw new Error('pass either `name` (a piece of this conversation) or `id`')
      }
      if (!(await fsp.stat(folder).catch(() => null))?.isDirectory()) throw new Error(`the ${kind} piece "${name ?? id}" does not exist`)
      const target = resolveSafePath(ctx, destination)
      await fsp.mkdir(target, { recursive: true })
      await fsp.cp(folder, target, { recursive: true, force: true })
      const files = await fsp.readdir(target)
      return `Copied the ${kind} piece "${path.basename(folder)}" to ${path.relative(ctx.directory, target) || '.'} (${files.length} entr${files.length === 1 ? 'y' : 'ies'}). The piece itself stays in Orbit.`
    },
  })
}
