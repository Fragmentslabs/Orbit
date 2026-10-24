import { app } from 'electron'
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
 * O que as três peças do Orbit (motion, design, slides) têm em comum, nos DOIS
 * modos. Uma peça é um objeto do app: mora no armazenamento do Orbit
 * (`orbit-data/<tipo>/<sessão>/<nome>/`), é criada, lida, mostrada, editada e
 * excluída pelas tools dela, por NOME (desta conversa) ou por id (de qualquer
 * uma) — no chat e no código, as mesmas tools. O repositório do usuário só
 * recebe uma peça quando ele pede (piece_export).
 *
 * Toda escrita numa pasta de peça passa antes pelo diário de mídia do turno
 * (journalPiece): é o que deixa o revert da mensagem desfazê-la.
 */

export interface PieceToolScope {
  sessionId: string
  /**
   * Pasta de trabalho (modo código). Com ela, os *_asset também copiam um
   * arquivo do projeto (`path`) e piece_export grava a peça nela.
   */
  project?: ToolContext | null
  /** Sessão principal: abre e foca a aba. Worker: escreve sem abrir aba. */
  canShow?: boolean
  /** Modo plano: só ler e mostrar. */
  readOnly?: boolean
}

const SAFE_SESSION = /^[A-Za-z0-9_-]{1,80}$/

/** Pasta de todas as peças de um tipo — a raiz que a exclusão pode limpar. */
export function piecesRoot(kind: PieceKind): string {
  return path.join(app.getPath('userData'), 'orbit-data', kind)
}

/** Pasta das peças de um tipo nesta conversa. */
export function piecesDir(kind: PieceKind, sessionId: string): string {
  if (!SAFE_SESSION.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  return path.join(piecesRoot(kind), sessionId)
}

/** "Intro do Orbit!" → "intro-do-orbit". O nome vira pasta. Puro. */
export function pieceSlug(name: string, fallback: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || fallback
}

/**
 * Guarda a pasta da peça no diário do turno ANTES da escrita — chame dentro do
 * lock da peça. Fora de um turno (a pessoa editando no painel) não faz nada.
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

/**
 * Aplica trocas EXATAS em ordem (o mesmo contrato do `edit` do modo código): o
 * trecho tem que existir e, sem replaceAll, ser único — senão a troca cairia no
 * lugar errado em silêncio. Puro.
 */
export function applyTextEdits(source: string, edits: TextEdit[]): string {
  let out = source
  edits.forEach((edit, i) => {
    if (!edit.oldText) throw new Error(`edit ${i + 1}: oldText is empty`)
    const count = out.split(edit.oldText).length - 1
    if (count === 0) throw new Error(`edit ${i + 1}: oldText not found — read the current text first and copy it exactly`)
    if (count > 1 && !edit.replaceAll) {
      throw new Error(`edit ${i + 1}: oldText appears ${count} times — add surrounding text to make it unique, or set replaceAll`)
    }
    out = edit.replaceAll ? out.split(edit.oldText).join(edit.newText) : out.replace(edit.oldText, () => edit.newText)
  })
  return out
}

/** Os dois jeitos de trazer material para dentro de uma peça. */
export const ASSET_SOURCE = {
  ref: z.string().optional().describe('Reference from the attachment note: img_…, vdo_… or aud_… (something the user ATTACHED)'),
  path: z
    .string()
    .optional()
    .describe('A file of the working folder (code mode only) — a project image, footage, a font, a local library such as node_modules/gsap/dist/gsap.min.js'),
  filename: z.string().optional().describe('Name for the copy (default: the original name, made safe)'),
}

/**
 * Copia um anexo (`ref`) ou um arquivo da pasta de trabalho (`path`) para a
 * pasta da peça. Quem chama já registrou a pasta no diário.
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
 * Exclui uma peça de verdade: o item da galeria (cujo gancho apaga a pasta e o
 * registro), ou só a pasta e o registro quando ela nunca entrou na galeria. As
 * abas dela fecham. No turno do agente tudo passa pelo diário — o revert da
 * mensagem traz a peça de volta.
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
