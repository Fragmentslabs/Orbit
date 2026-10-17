import { app } from 'electron'
import { tool, type ToolSet } from 'ai'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { importAttachmentInto } from '../video/motion-asset'
import { openMotionAndReport } from '../video/motion-open'
import type { ToolContext } from './context'
import { createVideoTools } from './video'

/**
 * Motion no MODO CHAT.
 *
 * No modo código a composição é uma pasta do projeto e o agente a escreve com
 * write/edit. O chat não tem pasta de trabalho nem essas tools — e, sem nada
 * melhor, o agente entregava a animação como artefato HTML: bonito, mas fora da
 * aba Motion (sem linha de tempo, sem camadas, sem render).
 *
 * Aqui a composição mora no armazenamento do Orbit, uma pasta por conversa
 * (`orbit-data/motion/<sessão>/<nome>/index.html`), como os artefatos moram na
 * galeria. O agente a cria e edita por NOME com tools próprias, e o resto é o
 * mesmo do modo código: a aba Motion abre e recarrega ao vivo, motion_frame
 * olha instantes, motion_render gera o arquivo quando pedido.
 */

const SAFE_SESSION = /^[A-Za-z0-9_-]{1,80}$/

/** Pasta das composições desta conversa. */
export function chatMotionDir(sessionId: string): string {
  if (!SAFE_SESSION.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  return path.join(app.getPath('userData'), 'orbit-data', 'motion', sessionId)
}

/** "Intro do Orbit!" → "intro-do-orbit". Puro. */
export function motionSlug(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'motion'
}

export interface TextEdit {
  oldText: string
  newText: string
  replaceAll?: boolean
}

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
    if (count === 0) throw new Error(`edit ${i + 1}: oldText not found — read the composition (motion_read) and copy the exact text`)
    if (count > 1 && !edit.replaceAll) {
      throw new Error(`edit ${i + 1}: oldText appears ${count} times — add surrounding text to make it unique, or set replaceAll`)
    }
    out = edit.replaceAll ? out.split(edit.oldText).join(edit.newText) : out.replace(edit.oldText, () => edit.newText)
  })
  return out
}

const NAME = z
  .string()
  .min(1)
  .max(80)
  .describe('Name of the composition in this conversation (e.g. "orbit-intro") — the same name addresses it in every motion tool')

export function createChatMotionTools(scope: { sessionId: string; modelVision?: boolean; canRender: boolean }): ToolSet {
  const root = chatMotionDir(scope.sessionId)
  const entryOf = (name: string) => path.join(root, motionSlug(name), 'index.html')
  const ctx: ToolContext = {
    sessionId: scope.sessionId,
    directory: root,
    extraDirectories: [],
    abort: new AbortController().signal,
    modelVision: scope.modelVision,
  }

  const report = (name: string, verb: string) =>
    openMotionAndReport({
      target: entryOf(name),
      root,
      sessionId: scope.sessionId,
      label: `composition "${motionSlug(name)}", ${verb}`,
      nextStep:
        'Keep refining with motion_edit (exact text replacements) — the tab reloads live at the same frame, so tell the user what you changed and let them watch. Check yourself with motion_frame. Render only if the user asks for the video file (they also have a Render button in the tab).',
      fixHint: 'fix it with motion_edit or motion_write (the tab reloads by itself) and read this result again.',
    })

  // Olhar e renderizar são os MESMOS do modo código, só endereçados por nome.
  const base = createVideoTools(ctx, { sessionId: scope.sessionId, canShow: true, readOnly: false })

  const tools: ToolSet = {
    video_guide: base.video_guide,

    motion_write: tool({
      description:
        'Creates (or fully replaces) an HTML motion composition and opens it in the Motion tab of the right panel, where the user watches it live — play/pause, a frame slider and a track per layer showing when each element enters and leaves. ' +
        'Use this — NOT create_artifact — whenever the user wants an animation as a video/motion piece: an intro, an animated title, kinetic text, a logo reveal, a lower third. ' +
        'Call video_guide("motion") once before writing your first composition. The page must declare its format (<meta name="orbit-motion" content="width=1920,height=1080,fps=30,duration=6">) and move only through seek: CSS animations, the Web Animations API, or window.orbitMotion.seek(frame) for script-driven motion. There is NO local gsap here — no folder to copy it into — so prefer CSS/Web Animations or your own seek. Fonts: system fonts or a Google Fonts <link>. ' +
        'The result says whether it loaded and lists the layers with their enter/leave frames. After this, change it with motion_edit (small, exact replacements), not by rewriting everything.',
      inputSchema: z.object({
        name: NAME,
        html: z.string().min(1).describe('The COMPLETE, self-contained HTML of the composition'),
      }),
      execute: async ({ name, html }) => {
        const file = entryOf(name)
        await fs.mkdir(path.dirname(file), { recursive: true })
        let existed = true
        try {
          await fs.access(file)
        } catch {
          existed = false
        }
        await fs.writeFile(file, html, 'utf8')
        return report(name, existed ? 'replaced' : 'created')
      },
    }),

    motion_edit: tool({
      description:
        'Edits a motion composition of this conversation with EXACT text replacements, applied in order (oldText must exist and be unique unless replaceAll). The Motion tab reloads live at the same frame, so the user watches each change. ' +
        'This is how you iterate on timing, easing, colors and copy — small edits, not full rewrites. If you are unsure of the current text, motion_read first.',
      inputSchema: z.object({
        name: NAME,
        edits: z
          .array(
            z.object({
              oldText: z.string().describe('Exact current text (copy it, including indentation)'),
              newText: z.string(),
              replaceAll: z.boolean().optional(),
            }),
          )
          .min(1),
      }),
      execute: async ({ name, edits }) => {
        const file = entryOf(name)
        let source: string
        try {
          source = await fs.readFile(file, 'utf8')
        } catch {
          throw new Error(`no composition named "${motionSlug(name)}" in this conversation — create it with motion_write`)
        }
        await fs.writeFile(file, applyTextEdits(source, edits), 'utf8')
        return report(name, `${edits.length} edit${edits.length === 1 ? '' : 's'} applied`)
      },
    }),

    motion_read: tool({
      description: 'Returns the current HTML of a motion composition of this conversation (the user may have asked for changes since you wrote it, and edits need the exact text).',
      inputSchema: z.object({ name: NAME }),
      execute: async ({ name }) => {
        try {
          return await fs.readFile(entryOf(name), 'utf8')
        } catch {
          const list = await fs.readdir(root).catch(() => [] as string[])
          throw new Error(
            `no composition named "${motionSlug(name)}" in this conversation${list.length ? ` — existing: ${list.join(', ')}` : ''}`,
          )
        }
      },
    }),
  }

  // Ler o material anexado: as mesmas tools do modo código, que aqui só recebem a
  // REFERÊNCIA do anexo (vdo_…) — o chat não tem pasta de trabalho de onde ler.
  for (const name of ['video_probe', 'video_transcribe', 'video_timeline'] as const) {
    if (base[name]) tools[name] = base[name]
  }

  tools.motion_asset = tool({
    description:
      'Copies an ATTACHED file (a video, photo, GIF or audio the user sent in this chat) into a composition, so the piece can use it. ' +
      'Call it only when you decide to USE the material in the piece; attaching does not copy it anywhere, and reading it (video_probe / video_transcribe / video_timeline, or audio_transcribe) does not need it. ' +
      'ref: the vdo_… / aud_… / img_… reference from the attachment note. name: the composition (created later by motion_write if it does not exist yet). ' +
      'The result gives the file name to put in the HTML (relative: src="clip.mp4") and how to use it — timing attributes, crop, sound. The same ref twice gives the same file.',
    inputSchema: z.object({
      ref: z.string().describe('Reference from the attachment note: vdo_…, aud_… or img_…'),
      name: NAME,
      filename: z.string().optional().describe('Name for the copy (default: the original name, made safe)'),
    }),
    execute: async ({ ref, name, filename }) => {
      const imported = await importAttachmentInto(path.dirname(entryOf(name)), ref, filename)
      return imported.report
    },
  })

  if (base.motion_frame) {
    tools.motion_frame = tool({
      description:
        'Looks at ONLY the instants you ask for in a composition of this conversation and returns a contact sheet (time and frame number in each cell) — milliseconds, no video. ' +
        'This is how you check your work: the entrance, the payoff, the hold at the end. times in SECONDS, 1–8 instants.',
      inputSchema: z.object({
        name: NAME,
        times: z.array(z.number().positive()).min(1).max(8),
      }),
      execute: (input, options) =>
        base.motion_frame.execute!({ path: path.relative(root, entryOf(input.name)), times: input.times }, options),
      toModelOutput: base.motion_frame.toModelOutput,
    })
  }

  if (scope.canRender && base.motion_render) {
    tools.motion_render = tool({
      description:
        'Renders a composition of this conversation to a video file and shows it in your reply as a player. ONLY when the user explicitly asks for the video/file — the live preview in the Motion tab is how they watch it, and the tab has its own Render button. ' +
        'format by extension: .mp4 (normal clip), .mov (ProRes 4444) or .webm with transparent: true for an overlay with alpha.',
      inputSchema: z.object({
        name: NAME,
        format: z.enum(['mp4', 'mov', 'webm']).optional().describe('Default mp4'),
        transparent: z.boolean().optional(),
      }),
      execute: (input, options) =>
        base.motion_render.execute!(
          {
            path: path.relative(root, entryOf(input.name)),
            output: path.join('renders', `${motionSlug(input.name)}.${input.format ?? 'mp4'}`),
            transparent: input.transparent,
            show: true,
          },
          options,
        ),
    })
  }

  return tools
}
