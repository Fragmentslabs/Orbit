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
 * Motion — the HTML composition the Motion tab plays live (timeline,
 * one track per layer) and that the render turns into video.
 *
 * In BOTH modes it is the same thing: the composition lives in Orbit's storage
 * (`orbit-data/motion/<session>/<name>/index.html`), created and edited by NAME
 * with the tools from here. In code mode it is NOT a project folder: what comes
 * from the project (footage, a gsap.min.js) comes in through motion_asset({ path }),
 * and the video only goes to the project when the user asks (motion_render with
 * `output`, or piece_export). That way every write goes through the turn's journal and the
 * message's revert undoes it.
 */

/** Folder of this conversation's compositions. */
export function motionPiecesDir(sessionId: string): string {
  return piecesDir('motion', sessionId)
}

/** "Orbit intro!" → "orbit-intro". Pure. */
export function motionSlug(name: string): string {
  return pieceSlug(name, 'motion')
}

/**
 * Minimal HTML with a valid orbit-motion meta — the tab's stage loads
 * immediately (1920x1080 dark, empty) while the model is still transmitting
 * the real composition. It is not a "good load": the final report() measures the real
 * piece and the progressive writing fires the watcher (motion:changed) that reloads
 * the tab at the very instant the file is written.
 */
const MOTION_PLACEHOLDER = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="orbit-motion" content="width=1920,height=1080,fps=30,duration=1"></head>
<body style="margin:0;background:#111"></body>
</html>
`

/**
 * Opens the Motion tab BEFORE the tool finishes: chat-engine calls this as soon as
 * the composition name appears in the streaming input — while the model is still
 * transmitting the HTML. It registers the composition (re-attaches the watcher) and tells the
 * panel to open the tab; with `placeholder` (motion_write) it writes a minimal
 * index.html first, so the stage has something to load until the real HTML arrives
 * (the watcher reloads the tab at the instant of the write). `placeholder: false`
 * (motion_edit) creates nothing: the piece already exists, and if it does not it is the
 * model's error — there is no stage to open.
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
      // The placeholder is already a write of the turn: the folder goes into the journal first.
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
 * GLOBAL address by id (mv_…), the same one that appears in the attachment note. It allows
 * reading/editing a composition from any conversation without knowing its name. Every
 * write carries the read under lock, so two chats on the same id do not run over each other.
 */
const ID = z
  .string()
  .min(1)
  .optional()
  .describe('Motion id (mv_…) of an existing composition — the "motion id" from an attachment note or a chat card. Use it to reach a composition from any conversation; omit when addressing by name in this one')

/** Limit of the image that goes to the model (the same as panel_screenshot's). */
const MAX_MODEL_IMAGE_BYTES = 300_000
const frameStash = new Map<string, { base64: string }>()

export function createMotionTools(
  scope: PieceToolScope & {
    modelVision?: boolean
    canRender: boolean
    /** The person's language: the title of the document delivered by `transcribe` is for them. */
    language?: string
    /** "Speech to text" in Preferences: off, the edit does not get `transcribe`. */
    sttEnabled?: boolean
  },
): ToolSet {
  const root = motionPiecesDir(scope.sessionId)
  const canShow = scope.canShow !== false
  const project = scope.project ?? null

  /**
   * Target by `name` (this conversation's composition) OR by `id` (global). Pure up to
   * `getMotion` — the authorization is only "it exists"; there is no owner check.
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
    // In a worker there is no tab: what shows the piece is the main session, and it only
    // reaches it by id (the name belongs to this conversation).
    return canShow
      ? text
      : `${text}\nMotion id: ${motionIdFor(target.folder, target.file)} — report it, so the main session can show the piece with motion_preview({ id }).`
  }

  /** Every write to the composition: under the folder's lock and with the folder in the journal. */
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
          // The placeholder from the live opening (openMotionLive) does not count as
          // existing: "replaced" only when the agent replaces a written piece.
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
        // Reading and writing under the same lock: if another chat wrote in the middle, the
        // oldText do not match and the edit fails instead of overwriting.
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
        // The source is resolved BEFORE importing: the `id` that comes out of here
        // (`aud_x.wav`, `img_x.png`) is the same identity the media has in the
        // chat, and it is what — not the text the agent passed — turns the loose
        // player into a line of the piece's card.
        const origin = ref ? await resolveAttachmentRef(ref).catch(() => null) : null
        const imported = await writing(target, () => importIntoPiece(target.folder, { ref, path: source, filename }, project))
        // The file's source stays recorded in the piece: it is what turns the loose
        // player in the chat into a line of the composition's card instead of one more
        // card in the conversation. The id is derived from the folder + input (`motionIdFor`),
        // so it holds even before the composition really exists.
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
        // The sheet stays OUTSIDE the composition's folder: that folder is watched for
        // the live reload, and a new file there would reload the tab.
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
        // The output lives next to the conversation's compositions, OUTSIDE the piece's folder
        // (which is watched for the live reload).
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
        // The video belongs to the app: it enters the gallery, where the person sees and deletes it.
        const { entry } = await addVideoToGallery({ file: out, name: path.basename(out), sessionId: scope.sessionId, source: 'chat' })
        if (!canShow || !showIt) return { message }
        return { message, videoUrl: entry.videoUrl, title: path.basename(out), durationMs: result.duration * 1000, path: out }
      },
    })
  }

  // With no working folder, video editing (EDL) reads the ATTACHMENTS by reference
  // and writes to the conversation's storage — in code those tools come from the folder
  // (createVideoTools with the project's ctx, in tools/index.ts).
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
      // The same switch as code mode: without "Speech to text" there is no engine.
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
