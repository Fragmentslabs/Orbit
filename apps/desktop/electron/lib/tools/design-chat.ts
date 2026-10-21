import { app } from 'electron'
import { tool, type ToolSet } from 'ai'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { isSafeBoardFile, readDesignCanvas, writeDesignCanvas, type DesignCanvas } from '../design/design-canvas'
import { importAttachmentInto } from '../video/motion-asset'
import { openDesignAndReport } from '../design/design-open'
import { getDesign, registerDesign } from '../design/design-store'
import { panelDesignPreview } from '../panel-browser'
import { withAssetLock, writeFileAtomic } from '../asset-lock'
import { applyTextEdits } from './motion-chat'

/**
 * Design no MODO CHAT — um canvas de artboards (telas/mockups HTML completos,
 * dispostos lado a lado como um board do Figma), no mesmo molde do motion no
 * chat (ver motion-chat.ts): sem pasta de trabalho, o canvas mora no
 * armazenamento do Orbit (`orbit-data/design/<sessão>/<nome>/`), criado e
 * editado por NOME. A aba Design abre e recarrega ao vivo a cada escrita.
 *
 * Cada artboard é um arquivo .html AUTOCONTIDO (próprio <html><head><style>) —
 * sem runtime nem DSL de template: o agente escreve HTML/CSS de verdade, e o
 * navegador resolve o layout. O ARRANJO (posição/tamanho de cada artboard no
 * canvas infinito) é só isso: um índice JSON pequeno (`canvas.json`), não uma
 * árvore paralela ao conteúdo — ver design-canvas.ts.
 */

const SAFE_SESSION = /^[A-Za-z0-9_-]{1,80}$/

/** Pasta dos canvas desta conversa. */
export function chatDesignDir(sessionId: string): string {
  if (!SAFE_SESSION.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  return path.join(app.getPath('userData'), 'orbit-data', 'design', sessionId)
}

/** "Landing page v2" → "landing-page-v2". Mesmo algoritmo do motionSlug. */
export function designSlug(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'design'
}

/**
 * Nome do canvas num pedaço de JSON da tool ainda EM STREAMING — o chat-engine
 * acumula os tool-input-delta e chama isto a cada pedaço. `name` é o primeiro
 * campo do input, então basta achar o começo do valor (parse parcial por regex,
 * com o escape de aspas resolvido pelo JSON.parse do pedaço capturado).
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
 * Abre a aba Design ANTES da tool terminar: o chat-engine chama isto assim que
 * o nome do canvas aparece no input streaming — enquanto o modelo ainda está
 * transmitindo o HTML dos artboards. Registra a pasta e garante um canvas.json
 * mínimo (`placeholder`); a escrita progressiva do design_write e o watcher
 * (design:changed) entregam cada artboard conforme ele é gravado, e o report()
 * do fim da tool segue como estava (capa, validação, texto para o modelo).
 * `placeholder: false` (design_edit) não cria canvas vazio: sem canvas a
 * edição tem o próprio erro ("create it with design_write") e não há o que
 * abrir.
 */
export async function openDesignLive(
  sessionId: string,
  name: string,
  opts: { placeholder?: boolean } = {},
): Promise<void> {
  const root = chatDesignDir(sessionId)
  const folder = path.join(root, designSlug(name))
  try {
    await fs.access(path.join(folder, 'canvas.json'))
  } catch {
    if (opts.placeholder === false) return
    await writeDesignCanvas(folder, { v: 1, boards: {}, order: [] })
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
 * Endereço GLOBAL por id (dsg_…), o mesmo da nota de anexo: lê/edita um canvas
 * de qualquer conversa sem conhecer o nome dele. Os writes leem o canvas sob
 * lock, então dois chats no mesmo id não se sobrescrevem em silêncio.
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

export function createChatDesignTools(scope: { sessionId: string }): ToolSet {
  const root = chatDesignDir(scope.sessionId)

  /** Alvo por `name` (desta conversa) OU por `id` (global). */
  const resolveFolder = async (input: { name?: string; id?: string }) => {
    if (input.id) {
      const reg = await getDesign(input.id)
      if (!reg) throw new Error(`no design canvas with id "${input.id}"`)
      return { folder: reg.folder, name: path.basename(reg.folder) }
    }
    if (!input.name) throw new Error('pass either `name` (a canvas of this conversation) or `id` (the dsg_… from an attachment note)')
    return { folder: path.join(root, designSlug(input.name)), name: designSlug(input.name) }
  }

  const report = (target: { folder: string; name: string }, verb: string) =>
    openDesignAndReport({
      target: target.folder,
      root,
      sessionId: scope.sessionId,
      label: `canvas "${target.name}", ${verb}`,
      nextStep:
        'Keep refining with design_edit — replace one artboard\'s whole HTML (or apply exact text edits), move/resize/reorder it on the canvas, add a new one, or remove one. The tab reloads live. Use design_read when unsure of the current HTML or layout.',
    })

  return {
    design_write: tool({
      description:
        'Creates (or fully replaces) a design canvas — one or more self-contained HTML "artboards" laid out on an infinite canvas, like a Figma board — and opens it in the Design tab of the right panel, where the user sees it live and can reopen it later from the Media gallery. ' +
        'Use this — NOT create_artifact, and NOT an image — whenever the user wants a visual design to look at: a logo or brand mark, a UI mockup, a wireframe, a landing page, a poster, a social post, an app/web screen, or "design mode"/"modo design". Especially good for exploring more than one direction or variant at once (e.g. 2-4 logo concepts side by side) — the canvas is built for comparing options. ' +
        'Each artboard is a COMPLETE, self-contained HTML document (its own <!doctype>, <head>, <style> — no shared runtime, no template syntax: write real HTML/CSS). Lay artboards side by side with x/y in canvas pixels so none overlap (80px gap between them is typical); w/h are the artboard\'s own pixel size. ' +
        'To make a CLICKABLE prototype, link the artboards with plain relative anchors (<a href="Pricing.html">): the artboard that links to another gets a Play button, and the user can present it on the canvas or in its own tab. ' +
        'After this, iterate with design_edit— small changes, not full rewrites. To USE a photo, GIF or video the user attached, copy it into the canvas first with design_asset and reference it with a relative src.',
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
              html: z.string().min(1).describe('The COMPLETE, self-contained HTML document for this artboard'),
            }),
          )
          .min(1)
          .max(40),
      }),
      execute: async ({ name, id, title, boards }) => {
        for (const b of boards) {
          if (!isSafeBoardFile(b.file)) {
            throw new Error(`invalid artboard file name: "${b.file}" — use a plain name ending in .html, e.g. "Main.html"`)
          }
        }
        const target = await resolveFolder({ name, id })
        // Um canvas inteiro (canvas.json + vários artboards) fica sob um lock só:
        // dois design_write no mesmo id não intercalam e não deixam o índice
        // apontando para um artboard pela metade.
        const existed = await withAssetLock(`design:${target.folder}`, async () => {
          // O canvas vazio do openDesignLive (abertura ao vivo) não conta como
          // existente: "replaced" só quando já há artboard no canvas.
          let existed = false
          try {
            existed = (await readDesignCanvas(target.folder)).order.length > 0
          } catch {
            existed = false
          }
          await fs.mkdir(target.folder, { recursive: true })
          // Escrita progressiva: cada artboard entra no canvas.json assim que o
          // arquivo é gravado — com a aba já aberta desde o streaming da entrada
          // (openDesignLive), o usuário vê o board montando peça por peça em vez
          // de esperar o lote inteiro. O canvas é uma substituição: o índice novo
          // nasce vazio e cresce.
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
        'Edits an existing design canvas of this conversation: replace one artboard\'s whole HTML (full rewrite), or apply EXACT text replacements to it (like the edit tool — oldText must exist and be unique unless replaceAll); move/resize/retitle it; add a brand-new artboard (pass html); remove one; or reorder the whole stack. ' +
        'The Design tab reloads live. If unsure of the current HTML or layout, design_read first.',
      inputSchema: z.object({
        name: NAME.optional(),
        id: ID,
        file: BOARD_FILE.optional().describe('The artboard to change — omit only when `order` alone is reordering the stack'),
        html: z.string().optional().describe('Full replacement HTML for `file` (creating a new artboard: required)'),
        edits: z
          .array(
            z.object({
              oldText: z.string().describe('Exact current text (copy it, including indentation)'),
              newText: z.string(),
              replaceAll: z.boolean().optional(),
            }),
          )
          .optional()
          .describe('Exact text replacements applied to the CURRENT content of `file`, as an alternative to `html`'),
        title: z.string().optional().describe('New artboard label (or, with no `file`, the canvas title)'),
        x: z.number().optional(),
        y: z.number().optional(),
        w: z.number().min(40).max(8000).optional(),
        h: z.number().min(40).max(8000).optional(),
        remove: z.boolean().optional().describe('Remove this artboard from the canvas and delete its file'),
        order: z.array(z.string()).optional().describe('New full back-to-front order of artboard file names'),
      }),
      execute: async ({ name, id, file, html, edits, title, x, y, w, h, remove, order }) => {
        const target = await resolveFolder({ name, id })
        if (file && !isSafeBoardFile(file)) {
          throw new Error(`invalid artboard file name: "${file}" — use a plain name ending in .html`)
        }
        // Ler o canvas, mexer no artboard e regravar o índice sob o mesmo lock:
        // um edit que leu um canvas desatualizado (outro chat gravou no meio)
        // falha nos oldText em vez de reescrever por cima.
        await withAssetLock(`design:${target.folder}`, async () => {
          let canvas: DesignCanvas
          try {
            canvas = await readDesignCanvas(target.folder)
          } catch {
            throw new Error(`no design canvas named "${target.name}" — create it with design_write`)
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
        return report(target, remove ? `removed "${file}"` : file ? `updated "${file}"` : 'layout updated')
      },
    }),

    design_read: tool({
      description:
        'Returns the layout (canvas.json: artboards, position, size) of a design canvas (of this conversation by name, or any one by id), or — with `file` — one artboard\'s current HTML. The user may have asked for changes since you wrote it, and edits need the exact text.',
      inputSchema: z.object({ name: NAME.optional(), id: ID, file: BOARD_FILE.optional() }),
      execute: async ({ name, id, file }) => {
        const target = await resolveFolder({ name, id })
        if (file) {
          try {
            return await fs.readFile(path.join(target.folder, file), 'utf8')
          } catch {
            throw new Error(`artboard "${file}" not found in canvas "${target.name}"`)
          }
        }
        try {
          const canvas = await readDesignCanvas(target.folder)
          return JSON.stringify(canvas, null, 2)
        } catch {
          throw new Error(`no design canvas named "${target.name}"`)
        }
      },
    }),

    design_asset: tool({
      description:
        'Copies an ATTACHED file (a photo, GIF or video the user sent in this chat) into a design canvas of this conversation, so an artboard can use it. ' +
        'Call it only when you decide to USE the material in a design; attaching does not copy it anywhere, and reading it does not need it. ' +
        'ref: the img_… / vdo_… reference from the attachment note. name: the canvas (created later by design_write if it does not exist yet). ' +
        'The result gives the file name to put in the artboard HTML as a RELATIVE src (e.g. <img src="photo.png">) — the Design tab serves every file of the canvas folder, so the image appears live.',
      inputSchema: z.object({
        ref: z.string().describe('Reference from the attachment note: img_… or vdo_…'),
        name: NAME.optional(),
        id: ID,
        filename: z.string().optional().describe('Name for the copy (default: the original name, made safe)'),
      }),
      execute: async ({ ref, name, id, filename }) => {
        const target = await resolveFolder({ name, id })
        const imported = await importAttachmentInto(target.folder, ref, filename, {
          usageNote: (kind, file) =>
            kind === 'video'
              ? `Use it in an artboard as <video src="${file}"></video>.`
              : kind === 'audio'
                ? `Use it in an artboard as <audio src="${file}"></audio>.`
                : `Use it in an artboard as <img src="${file}"> — style it with CSS. It is a RELATIVE url: the Design tab serves every file of the canvas folder, so the image appears live.`,
        })
        return imported.report
      },
    }),
  }
}
