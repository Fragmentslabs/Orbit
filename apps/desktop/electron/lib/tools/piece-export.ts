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
 * A única porta de uma peça do Orbit para o repositório do usuário (modo
 * código): copia a pasta inteira — a composição, o canvas, o deck, com os
 * assets — para um caminho da pasta de trabalho. Só quando ele PEDE a peça
 * como arquivo do projeto; o resto do tempo ela vive no Orbit, onde as tools
 * dela a editam e o revert a desfaz. A cópia é do projeto: entra no snapshot
 * do turno como qualquer outro arquivo escrito.
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
