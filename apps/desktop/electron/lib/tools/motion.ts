import { tool, type ToolSet } from 'ai'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { openMotionAndReport } from '../video/motion-open'
import { getMotion, motionIdFor, registerMotion } from '../video/motion-store'
import { pieceFileName, recordMotionFile } from '../video/motion-files'
import { MAX_FRAME_TIMES, captureMotionFrames, frameLabel, sheetFileName } from '../video/motion-frame'
import { renderMotion } from '../video/motion'
import { addVideoToGallery } from '../video/video-gallery'
import { VIDEO_GUIDES } from '../video/guide'
import { panelMotionPreview } from '../panel-browser'
import { withAssetLock, writeFileAtomic } from '../asset-lock'
import { resolveSafePath, resolveWritePath, type ToolContext } from './context'
import { resolveAttachmentRef } from '../attachment-ref'
import { createVideoTools } from './video'
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
 * Motion — a composição HTML que a aba Motion toca ao vivo (linha do tempo,
 * uma faixa por camada) e que o render transforma em vídeo.
 *
 * Nos DOIS modos é a mesma coisa: a composição mora no armazenamento do Orbit
 * (`orbit-data/motion/<sessão>/<nome>/index.html`), criada e editada por NOME
 * com as tools daqui. No modo código ela NÃO é uma pasta do projeto: o que vem
 * do projeto (uma filmagem, um gsap.min.js) entra pelo motion_asset({ path }),
 * e o vídeo só vai para o projeto quando o usuário pede (motion_render com
 * `output`, ou piece_export). Assim toda escrita passa pelo diário do turno e o
 * revert da mensagem a desfaz.
 */

/** Pasta das composições desta conversa. */
export function motionPiecesDir(sessionId: string): string {
  return piecesDir('motion', sessionId)
}

/** "Intro do Orbit!" → "intro-do-orbit". Puro. */
export function motionSlug(name: string): string {
  return pieceSlug(name, 'motion')
}

/**
 * HTML mínimo com o meta orbit-motion válido — o palco da aba carrega de
 * imediato (1920x1080 escuro, vazio) enquanto o modelo ainda está transmitindo
 * a composição de verdade. Não é "carga boa": o report() final mede a peça
 * real e a escrita progressiva dispara o watcher (motion:changed) que recarrega
 * a aba no mesmo instante em que o arquivo é gravado.
 */
const MOTION_PLACEHOLDER = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="orbit-motion" content="width=1920,height=1080,fps=30,duration=1"></head>
<body style="margin:0;background:#111"></body>
</html>
`

/**
 * Abre a aba Motion ANTES da tool terminar: o chat-engine chama isto assim que
 * o nome da composição aparece no input streaming — enquanto o modelo ainda
 * está transmitindo o HTML. Registra a composição (religa o watcher) e manda o
 * painel abrir a aba; com `placeholder` (motion_write) grava um index.html
 * mínimo antes, para o palco ter o que carregar até o HTML de verdade chegar
 * (o watcher recarrega a aba no instante da gravação). `placeholder: false`
 * (motion_edit) não cria nada: a peça já existe, e se não existir é erro do
 * modelo — não há palco para abrir.
 */
export async function openMotionLive(
  sessionId: string,
  name: string,
  opts: { placeholder?: boolean } = {},
): Promise<void> {
  const root = motionPiecesDir(sessionId)
  const folder = path.join(root, motionSlug(name))
  const file = path.join(folder, 'index.html')
  try {
    await fs.promises.access(file)
  } catch {
    if (opts.placeholder === false) return
    await withAssetLock(`motion:${folder}`, async () => {
      // O placeholder já é uma escrita do turno: a pasta entra no diário antes.
      await journalPiece('motion', folder, { entry: file, root, sessionId })
      await fsp.mkdir(folder, { recursive: true })
      await writeFileAtomic(file, MOTION_PLACEHOLDER)
    })
  }
  const reg = await registerMotion(folder, file, { root, sessionId })
  panelMotionPreview({ id: reg.id, entry: 'index.html', title: motionSlug(name), path: file, sessionId })
}

const NAME = z
  .string()
  .min(1)
  .max(80)
  .describe('Name of the composition in this conversation (e.g. "orbit-intro") — the same name addresses it in every motion tool')

/**
 * Endereço GLOBAL por id (mv_…), o mesmo que aparece na nota de anexo. Dá para
 * ler/editar uma composição de qualquer conversa sem conhecer o nome dela. Todo
 * write carrega a leitura sob lock, então dois chats no mesmo id não se atropelam.
 */
const ID = z
  .string()
  .min(1)
  .optional()
  .describe('Motion id (mv_…) of an existing composition — the "motion id" from an attachment note or a chat card. Use it to reach a composition from any conversation; omit when addressing by name in this one')

/** Limite da imagem que vai ao modelo (o mesmo do panel_screenshot). */
const MAX_MODEL_IMAGE_BYTES = 300_000
const frameStash = new Map<string, { base64: string }>()

export function createMotionTools(
  scope: PieceToolScope & {
    modelVision?: boolean
    canRender: boolean
    /** Idioma da pessoa: o título do documento entregue pelo `transcribe` é para ela. */
    language?: string
    /** "Fala em texto" nas Preferências: desligado, a edição não ganha o `transcribe`. */
    sttEnabled?: boolean
  },
): ToolSet {
  const root = motionPiecesDir(scope.sessionId)
  const canShow = scope.canShow !== false
  const project = scope.project ?? null

  /**
   * Alvo por `name` (composição desta conversa) OU por `id` (global). Puro até o
   * `getMotion` — a autorização é só "existe"; não há checagem de dono.
   */
  const resolveTarget = async (input: { name?: string; id?: string }) => {
    if (input.id) {
      const entry = await getMotion(input.id)
      if (!entry) throw new Error(`no motion composition with id "${input.id}"`)
      return {
        folder: entry.folder,
        file: entry.entry,
        root: entry.root ?? path.dirname(entry.folder),
        name: path.basename(entry.folder),
      }
    }
    if (!input.name) throw new Error('pass either `name` (a composition of this conversation) or `id` (the mv_… from an attachment note)')
    const folder = path.join(root, motionSlug(input.name))
    return { folder, file: path.join(folder, 'index.html'), root, name: motionSlug(input.name) }
  }

  type Target = Awaited<ReturnType<typeof resolveTarget>>

  const mustExist = async (target: Target) => {
    try {
      await fsp.access(target.file)
    } catch {
      const list = await fsp.readdir(root).catch(() => [] as string[])
      throw new Error(`no composition named "${target.name}"${list.length ? ` — existing: ${list.filter((n) => !n.startsWith('.') && n !== 'renders').join(', ')}` : ' — create it with motion_write'}`)
    }
  }

  const report = async (target: Target, verb: string) => {
    const text = await openMotionAndReport({
      target: target.file,
      root: target.root,
      sessionId: scope.sessionId,
      label: `composition "${target.name}", ${verb}`,
      openTab: canShow,
      nextStep:
        'Keep refining with motion_edit (exact text replacements) — the tab reloads live at the same frame, so tell the user what you changed and let them watch. Check yourself with motion_frame. Render only if the user asks for the video file (they also have a Render button in the tab).',
      fixHint: 'fix it with motion_edit or motion_write (the tab reloads by itself) and read this result again.',
    })
    // Num worker não há aba: quem mostra a peça é a sessão principal, e ela só
    // a alcança pelo id (o nome é desta conversa).
    return canShow
      ? text
      : `${text}\nMotion id: ${motionIdFor(target.folder, target.file)} — report it, so the main session can show the piece with motion_preview({ id }).`
  }

  /** Toda escrita na composição: sob o lock da pasta e com a pasta no diário. */
  const writing = <T>(target: Target, fn: () => Promise<T>) =>
    withAssetLock(`motion:${target.folder}`, async () => {
      await journalPiece('motion', target.folder, { entry: target.file, root: target.root, sessionId: scope.sessionId })
      return fn()
    })

  const tools: ToolSet = {
    video_guide: tool({
      description:
        'Returns the craft guide for video work. Call it ONCE per conversation before your first edit plan (topic "editing"), before writing a motion composition ("motion"), or before setting up Remotion ("remotion").',
      inputSchema: z.object({ topic: z.enum(['editing', 'motion', 'remotion']) }),
      execute: async ({ topic }) => VIDEO_GUIDES[topic],
    }),

    motion_read: tool({
      description:
        'Returns the current HTML of a motion composition (of this conversation by name, or any one by id). The user may have asked for changes since you wrote it, and edits need the exact text.',
      inputSchema: z.object({ name: NAME.optional(), id: ID }),
      execute: async ({ name, id }) => {
        const target = await resolveTarget({ name, id })
        await mustExist(target)
        return fsp.readFile(target.file, 'utf8')
      },
    }),
  }

  if (canShow) {
    tools.motion_preview = tool({
      description:
        'Opens (or brings back to focus) an EXISTING motion composition in the Motion tab of the right panel and reports it: whether it loaded, format and duration, its layers with the frames where each enters and leaves, its audio tracks and the lint. Writes nothing. ' +
        'Use it when the user wants to see a piece again (the tab was closed, "abre o motion de novo"), or to read the report before editing. motion_write and motion_edit already open the tab — no need to call this after them.',
      inputSchema: z.object({ name: NAME.optional(), id: ID }),
      execute: async ({ name, id }) => {
        const target = await resolveTarget({ name, id })
        await mustExist(target)
        return report(target, 'opened')
      },
    })
  }

  if (!scope.readOnly) {
    tools.motion_write = tool({
      description:
        'Creates (or fully replaces) an HTML motion composition and opens it in the Motion tab of the right panel, where the user watches it live — play/pause, a frame slider and a track per layer showing when each element enters and leaves. The composition lives in Orbit (not in the project) and is addressed by its name. ' +
        'Use this — NOT create_artifact — whenever the user wants an animation as a video/motion piece: an intro, an animated title, kinetic text, a logo reveal, a lower third. ' +
        'Call video_guide("motion") once before writing your first composition. The page must declare its format (<meta name="orbit-motion" content="width=1920,height=1080,fps=30,duration=6">) and move only through seek: CSS animations, the Web Animations API, or window.orbitMotion.seek(frame) for script-driven motion. A library such as GSAP must be a local file next to index.html (motion_asset copies it from the working folder in code mode); with no local copy, use CSS/Web Animations or your own seek. Fonts: system fonts or a Google Fonts <link>. ' +
        'The result says whether it loaded and lists the layers with their enter/leave frames. After this, change it with motion_edit (small, exact replacements), not by rewriting everything.',
      inputSchema: z.object({
        name: NAME.optional(),
        id: ID,
        html: z.string().min(1).describe('The COMPLETE, self-contained HTML of the composition'),
      }),
      execute: async ({ name, id, html }) => {
        const target = await resolveTarget({ name, id })
        const existed = await writing(target, async () => {
          await fsp.mkdir(target.folder, { recursive: true })
          // O placeholder da abertura ao vivo (openMotionLive) não conta como
          // existente: "replaced" só quando o agente substitui uma peça escrita.
          let existed = false
          try {
            existed = (await fsp.readFile(target.file, 'utf8')) !== MOTION_PLACEHOLDER
          } catch {
            existed = false
          }
          await writeFileAtomic(target.file, html)
          return existed
        })
        return report(target, existed ? 'replaced' : 'created')
      },
    })

    tools.motion_edit = tool({
      description:
        'Edits a motion composition with EXACT text replacements, applied in order (oldText must exist and be unique unless replaceAll). The Motion tab reloads live at the same frame, so the user watches each change. ' +
        'This is how you iterate on timing, easing, colors and copy — small edits, not full rewrites. If you are unsure of the current text, motion_read first.',
      inputSchema: z.object({
        name: NAME.optional(),
        id: ID,
        edits: z.array(EDIT_OP).min(1),
      }),
      execute: async ({ name, id, edits }) => {
        const target = await resolveTarget({ name, id })
        // Leitura e escrita sob o mesmo lock: se outro chat gravou no meio, os
        // oldText não casam e o edit falha em vez de sobrescrever.
        await writing(target, async () => {
          let source: string
          try {
            source = await fsp.readFile(target.file, 'utf8')
          } catch {
            throw new Error(`no composition named "${target.name}" — create it with motion_write`)
          }
          await writeFileAtomic(target.file, applyTextEdits(source, edits))
        })
        return report(target, `${edits.length} edit${edits.length === 1 ? '' : 's'} applied`)
      },
    })

    tools.motion_asset = tool({
      description:
        'Copies material INTO a composition so the piece can use it by relative path: a file the user ATTACHED (`ref`: vdo_…, aud_…, img_…) or, in code mode, a file of the working folder (`path`: footage, a photo, a font, a local library like node_modules/gsap/dist/gsap.min.js). ' +
        'Call it only when you decide to USE the material in the piece; attaching does not copy it anywhere, and reading it (video_probe / transcribe / video_timeline) does not need it. ' +
        'name: the composition (created later by motion_write if it does not exist yet). The result gives the file name to put in the HTML (relative: src="clip.mp4") and how to use it — timing attributes, crop, sound. The same source twice gives the same file.',
      inputSchema: z.object({
        ...ASSET_SOURCE,
        name: NAME.optional(),
        id: ID,
      }),
      execute: async ({ ref, path: source, filename, name, id }) => {
        const target = await resolveTarget({ name, id })
        // A origem é resolvida ANTES de importar: o `id` que sai daqui
        // (`aud_x.wav`, `img_x.png`) é a mesma identidade que a mídia tem no
        // chat, e é ela — não o texto que o agente passou — que faz o player
        // solto virar uma linha do card da peça.
        const origin = ref ? await resolveAttachmentRef(ref).catch(() => null) : null
        const imported = await writing(target, () => importIntoPiece(target.folder, { ref, path: source, filename }, project))
        // A origem do arquivo fica registrada na peça: é o que faz o player
        // solto no chat virar uma linha do card da composição em vez de mais um
        // card na conversa. O id é derivado da pasta + entrada (`motionIdFor`),
        // então vale mesmo antes de a composição existir de verdade.
        await recordMotionFile(
          { id: motionIdFor(target.folder, target.file), folder: target.folder, sessionId: scope.sessionId },
          {
            name: pieceFileName(target.folder, imported.file) ?? imported.name,
            ...(origin ? { ref: origin.id } : ref ? { ref: ref.trim().replace(/^ref\s+/i, '') } : {}),
            ...(source && project ? { source: resolveSafePath(project, source) } : {}),
          },
        )
        return imported.report
      },
    })

    tools.motion_delete = tool({
      description:
        'Deletes a motion composition for good: its folder, its item in the Media gallery and its tab. Only when the user asks to delete/remove the piece. (Undoing the message brings it back.)',
      inputSchema: z.object({ name: NAME.optional(), id: ID }),
      execute: async ({ name, id }) => {
        const target = await resolveTarget({ name, id })
        await mustExist(target)
        const reg = await registerMotion(target.folder, target.file, { root: target.root, sessionId: scope.sessionId })
        const result = await deletePiece('motion', reg.id)
        return result.removedFolder
          ? `Composition "${target.name}" deleted (folder, gallery item and tab).`
          : `Composition "${target.name}" removed from the gallery, but its folder was kept: ${result.keptBecause}.`
      },
    })

    tools.motion_frame = tool({
      description:
        'Captures ONLY the instants you ask for in a composition as a contact sheet (time and frame number in each cell) — milliseconds, no video, no ffmpeg — and reports what loaded (fonts that failed, frame timing). times in SECONDS from the start, 1–8 instants inside the declared duration. ' +
        'The sheet is saved for the user; it enters YOUR context only with see: true. Load it only for a doubt that is genuinely visual (an overlap, a centring, an element that may be off-frame) — once, not after every edit, and never to show yourself that you are done. Use it BEFORE any render: the final render only runs once the user approved the composition.',
      inputSchema: z.object({
        name: NAME.optional(),
        id: ID,
        times: z.array(z.number().positive()).min(1).max(MAX_FRAME_TIMES),
        see: z.boolean().optional().describe('Load the contact sheet into your context (default false). Images are slow and costly: only for a visual doubt'),
      }),
      execute: async ({ name, id, times, see }, { toolCallId, abortSignal }) => {
        const target = await resolveTarget({ name, id })
        await mustExist(target)
        const result = await captureMotionFrames({
          target: target.file,
          times,
          root: target.root,
          sessionId: scope.sessionId,
          signal: abortSignal,
        })
        // A folha fica FORA da pasta da composição: aquela pasta é observada para
        // a recarga ao vivo, e um arquivo novo ali recarregaria a aba.
        const sheetFile = path.join(root, '.frames', sheetFileName(result.name))
        await fsp.mkdir(path.dirname(sheetFile), { recursive: true })
        await fsp.writeFile(sheetFile, result.image)
        const text = [
          `Frames of ${result.name} (${result.width}x${result.height} · ${result.fps} fps · ${result.durationInFrames} frames): ${result.cells
            .map((c) => frameLabel(c.timeMs, c.frame))
            .join(' · ')}.`,
          result.failedFonts.length
            ? `Fonts failed to load (the text fell back to another font): ${[...new Set(result.failedFonts)].join(', ')}.`
            : '',
          see
            ? 'Check the moments you will be judged on (entrance, payoff, hold) — motion_render only after the user approves.'
            : `Contact sheet saved for the user: ${sheetFile}. It was NOT loaded into your context — pass see: true only if a doubt is visual. Ask the user to look at the Motion tab — motion_render only after they approve.`,
        ]
          .filter(Boolean)
          .join('\n')
        if (see && scope.modelVision !== false) frameStash.set(toolCallId, { base64: result.image.toString('base64') })
        return text
      },
      toModelOutput: ({ toolCallId, output }) => {
        const stashed = frameStash.get(toolCallId)
        frameStash.delete(toolCallId)
        if (!stashed) return { type: 'text', value: String(output) }
        if (Buffer.byteLength(stashed.base64, 'base64') > MAX_MODEL_IMAGE_BYTES) {
          return { type: 'text', value: `${String(output)}\n[Image omitted: too large — ask for fewer instants.]` }
        }
        return {
          type: 'content',
          value: [
            { type: 'text', text: String(output) },
            { type: 'image-data', data: stashed.base64, mediaType: 'image/webp' },
          ],
        }
      },
    })
  }

  if (!scope.readOnly && scope.canRender) {
    tools.motion_render = tool({
      description:
        'Renders a composition to a video file inside the app (no network) by capturing every frame through window.orbitMotion.seek(frame) — deterministic — and puts it in the Media gallery. ONLY when the user explicitly asks for the video/file (or you need the clip as an overlay in an EDL): the live preview in the Motion tab is how they watch it, and the tab has its own Render button. Never render to check your work (motion_frame is the cheap look). ' +
        'format: mp4 (normal clip), mov (ProRes 4444) or webm; transparent: true with mov/webm gives an alpha overlay. ' +
        (project
          ? '`output` (code mode): ALSO copy the finished file into the working folder at this path — only when the user wants the video in the project or an EDL needs it there. `audio`: a one-off audio file of the working folder mixed from the start (normally declare tracks in audio.json inside the composition instead). '
          : '') +
        'Every frame must depend only on the frame number: setTimeout, Date.now() and requestAnimationFrame loops with their own clock freeze.',
      inputSchema: z.object({
        name: NAME.optional(),
        id: ID,
        format: z.enum(['mp4', 'mov', 'webm']).optional().describe('Default mp4'),
        transparent: z.boolean().optional(),
        duration: z.number().positive().max(180).optional(),
        width: z.number().int().positive().max(4096).optional(),
        height: z.number().int().positive().max(4096).optional(),
        fps: z.number().positive().max(60).optional(),
        output: z.string().optional().describe('Code mode only: a path in the working folder to ALSO copy the video to'),
        audio: z.string().optional().describe('Code mode only: an audio file of the working folder, mixed from the start of the piece'),
        show: z.boolean().optional().describe('Show it in your reply as a player (default true)'),
      }),
      execute: async ({ name, id, format, transparent, output, audio, show: showIt = true, ...spec }, { abortSignal }) => {
        const target = await resolveTarget({ name, id })
        await mustExist(target)
        if ((output || audio) && !project) throw new Error('`output` and `audio` need a working folder (code mode)')
        const exported = output ? resolveWritePath(project!, output) : null
        const ext = format ?? 'mp4'
        // A saída mora ao lado das composições da conversa, FORA da pasta da peça
        // (que é observada pela recarga ao vivo).
        const out = path.join(root, 'renders', `${target.name}.${ext}`)
        await fsp.mkdir(path.dirname(out), { recursive: true })
        const result = await renderMotion({
          file: target.file,
          output: out,
          signal: abortSignal,
          root: target.root,
          sessionId: scope.sessionId,
          transparent,
          audio: audio ? resolveSafePath(project!, audio) : undefined,
          ...spec,
        })
        if (exported) {
          await fsp.mkdir(path.dirname(exported), { recursive: true })
          await fsp.copyFile(out, exported)
        }
        const m = result.metrics
        const message = [
          `Rendered "${target.name}" — ${result.duration}s, ${result.width}x${result.height} @ ${result.fps} fps (${result.frames} frames)${transparent ? ', with alpha' : ''}.`,
          exported ? `Copied to ${path.relative(project!.directory, exported) || exported}.` : '',
          ...result.warnings.map((w) => `Warning: ${w}`),
          m ? `Render timing (ms, per frame): msPerFrame ${m.msPerFrame.toFixed(1)} · seekPaint ${m.seekPaint.toFixed(1)} · capture ${m.capture.toFixed(1)} · encodeWrite ${m.encodeWrite.toFixed(1)}.` : '',
        ]
          .filter(Boolean)
          .join('\n')
        // O vídeo é do app: entra na galeria, onde a pessoa vê e exclui.
        const { entry } = await addVideoToGallery({ file: out, name: path.basename(out), sessionId: scope.sessionId, source: 'chat' })
        if (!canShow || !showIt) return { message }
        return { message, videoUrl: entry.videoUrl, title: path.basename(out), durationMs: result.duration * 1000, path: out }
      },
    })
  }

  // Sem pasta de trabalho, a edição de vídeo (EDL) lê os ANEXOS pela referência
  // e grava no armazenamento da conversa — no código essas tools vêm da pasta
  // (createVideoTools com o ctx do projeto, em tools/index.ts).
  if (!project) {
    const chatCtx: ToolContext = {
      sessionId: scope.sessionId,
      directory: root,
      extraDirectories: [],
      abort: new AbortController().signal,
      modelVision: scope.modelVision,
    }
    const base = createVideoTools(chatCtx, {
      sessionId: scope.sessionId,
      canShow,
      readOnly: Boolean(scope.readOnly),
      language: scope.language,
      // O mesmo interruptor do modo código: sem "Fala em texto" não há motor.
      sttEnabled: scope.sttEnabled,
      chat: { outputDir: 'renders' },
    })
    for (const key of ['video_probe', 'transcribe', 'video_timeline'] as const) {
      if (base[key]) tools[key] = base[key]
    }
    if (scope.canRender && base.video_render) tools.video_render = base.video_render
  }

  return tools
}
