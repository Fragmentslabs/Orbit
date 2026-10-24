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
 * Design — um canvas de artboards (telas/mockups HTML completos, dispostos lado
 * a lado como um board do Figma), no mesmo molde do motion (ver motion.ts): nos
 * DOIS modos o canvas mora no armazenamento do Orbit
 * (`orbit-data/design/<sessão>/<nome>/`), criado e editado por NOME com as
 * tools daqui — nunca com write/edit no projeto. A aba Design abre e recarrega
 * ao vivo a cada escrita, e toda escrita passa pelo diário do turno (o revert
 * da mensagem a desfaz).
 *
 * Cada artboard é um arquivo .html AUTOCONTIDO (próprio <html><head><style>) —
 * sem runtime nem DSL de template: o agente escreve HTML/CSS de verdade, e o
 * navegador resolve o layout. O ARRANJO (posição/tamanho de cada artboard no
 * canvas infinito) é só isso: um índice JSON pequeno (`canvas.json`), não uma
 * árvore paralela ao conteúdo — ver design-canvas.ts.
 */

/** Pasta dos canvas desta conversa. */
export function designPiecesDir(sessionId: string): string {
  return piecesDir('design', sessionId)
}

/** "Landing page v2" → "landing-page-v2". Mesmo algoritmo do motionSlug. */
export function designSlug(name: string): string {
  return pieceSlug(name, 'design')
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
  const root = designPiecesDir(sessionId)
  const folder = path.join(root, designSlug(name))
  try {
    await fs.access(path.join(folder, 'canvas.json'))
  } catch {
    if (opts.placeholder === false) return
    await withAssetLock(`design:${folder}`, async () => {
      // O canvas vazio já é uma escrita do turno: a pasta entra no diário antes.
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

const STYLE_FILE = z
  .string()
  .min(1)
  .max(80)
  .describe('Shared stylesheet file name, plain (no slashes), ending in .css — e.g. "base.css"')

/** Teto de artboards numa chamada: ver o comentário no schema do design_write. */
const MAX_BOARDS_PER_WRITE = 4

export function createDesignTools(scope: PieceToolScope): ToolSet {
  const root = designPiecesDir(scope.sessionId)

  /** Alvo por `name` (desta conversa) OU por `id` (global). */
  const resolveFolder = async (input: { name?: string; id?: string }) => {
    if (input.id) {
      const reg = await getDesign(input.id)
      if (!reg) throw new Error(`no design canvas with id "${input.id}"`)
      return { folder: reg.folder, name: path.basename(reg.folder), root: reg.root }
    }
    if (!input.name) throw new Error('pass either `name` (a canvas of this conversation) or `id` (the dsg_… from an attachment note)')
    return { folder: path.join(root, designSlug(input.name)), name: designSlug(input.name), root }
  }

  /** Toda escrita no canvas: sob o lock da pasta e com a pasta no diário. */
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
          // Teto de UMA chamada. A tool só executa quando o input termina de
          // streamar: quatro telas num call = canvas vazio até o fim. Uma por
          // chamada (a principal aqui, o resto no design_edit) mostra a primeira
          // enquanto o modelo ainda escreve as outras — ver prompts.ts.
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
        // O schema já limita; aqui a mensagem é a que o modelo precisa ver se a
        // validação for contornada (o execute também é chamado direto).
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
        // Um canvas inteiro (canvas.json + vários artboards) fica sob um lock só:
        // dois design_write no mesmo id não intercalam e não deixam o índice
        // apontando para um artboard pela metade.
        const existed = await writing(target, async () => {
          // O canvas vazio do openDesignLive (abertura ao vivo) não conta como
          // existente: "replaced" só quando já há artboard no canvas.
          let existed = false
          try {
            existed = (await readDesignCanvas(target.folder)).order.length > 0
          } catch {
            existed = false
          }
          await fs.mkdir(target.folder, { recursive: true })
          // A base compartilhada entra ANTES dos artboards: eles já a referenciam
          // (<link href="base.css">) e assim não há um instante com a tela sem
          // estilo (o watcher recarrega a aba a cada arquivo).
          for (const s of styles ?? []) await writeFileAtomic(path.join(target.folder, s.file), s.css)
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
        // Ler o canvas, mexer no artboard e regravar o índice sob o mesmo lock:
        // um edit que leu um canvas desatualizado (outro chat gravou no meio)
        // falha nos oldText em vez de reescrever por cima.
        await writing(target, async () => {
          let canvas: DesignCanvas
          try {
            canvas = await readDesignCanvas(target.folder)
          } catch {
            throw new Error(`no design canvas named "${target.name}" — create it with design_write`)
          }
          if (style) {
            // A folha compartilhada é um arquivo da pasta como o artboard: mesmo
            // par "substitui tudo / troca exata", para a edição pequena não custar
            // o CSS inteiro de volta.
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
        'Returns the layout (canvas.json: artboards, position, size, plus the shared stylesheets) of a design canvas (of this conversation by name, or any one by id), or — with `file` — one file\'s current content (an artboard .html or a stylesheet .css). The user may have asked for changes since you wrote it, and edits need the exact text.',
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
          // O canvas.json é só o ARRANJO: as folhas compartilhadas não estão nele.
          // Sem esta lista o agente esquece que base.css existe — repete o CSS em
          // cada documento ou reescreve um artboard sem o <link>.
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

  // Modo plano: ler e mostrar, sem escrever.
  if (scope.readOnly) {
    delete tools.design_write
    delete tools.design_edit
    delete tools.design_asset
    delete tools.design_delete
  }
  return tools
}
