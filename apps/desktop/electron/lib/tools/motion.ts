import { tool, type ToolSet } from 'ai'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { openMotionAndReport } from '../video/motion-open'
import { getMotion, motionIdFor, registerMotion } from '../video/motion-store'
import { pieceFileName, recordMotionFile } from '../video/motion-files'
import { planPieceFiles, resolveEditFile, truncationReason, unflattenHtml } from '../video/motion-source'
import { MAX_FRAME_TIMES, MAX_EVAL_EXPRESSIONS, MAX_EVAL_LENGTH, MAX_PROBE_SELECTORS, captureMotionFrames, describeEvals, describeFrameContent, describeProbe, frameLabel, sheetFileName } from '../video/motion-frame'
import { motionAudioPlan } from '../video/motion-audio'
import { measureMotionAudio } from '../video/motion-audio-measure'
import { renderMotion } from '../video/motion'
import { MAX_VARIATIONS, checkOverrides, variationLabels } from '../video/motion-props'
import { copyPieceFolder } from '../video/motion-copy'
import { describeEditReceipt, fileHash, viewFile } from '../video/motion-view'
import { readWordsSidecar, writeWordsSidecar } from '../video/motion-words'
import { transcribeVideo } from '../video/transcript'
import { addVideoToGallery } from '../video/video-gallery'
import { VIDEO_GUIDES } from '../video/guide'
import { GUIDE_FIRST, hasReadGuide, markGuideRead } from '../video/guide-gate'
import { panelMotionPreview } from '../panel-browser'
import { withAssetLock, writeFileAtomic } from '../asset-lock'
import { resolveSafePath, resolveWritePath, type ToolContext } from './context'
import { resolveAttachmentRef } from '../attachment-ref'
import { createVideoTools } from './video'
import {
  ASSET_SOURCE,
  EDIT_OP,
  applyTextEditsDetailed,
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
        'Keep refining with motion_edit (exact text replacements) — the tab reloads live at the same frame, so tell the user what you changed and let them watch. Check yourself with motion_frame (probe: selectors as numbers, audio: true for the sound). Already built into window.orbitMotion, do not rewrite by hand: interpolate, spring, Easing, sequence, scenes, random(seed), fitText, audio.words/lines/find — detail in video_guide("motion"). Render only if the user asks for the video file (they also have a Render button in the tab).',
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
        'Returns the craft guide for video work. Call it before your first edit plan (topic "editing"), before writing a motion composition ("motion" for the contract, "motion-craft" for direction: shot list, easing, layers, sound), before any 3D / WebGL / three.js piece ("motion-3d"), before recreating the style of a reference video ("motion-style"), or before setting up Remotion ("remotion").',
      inputSchema: z.object({ topic: z.enum(['editing', 'motion', 'motion-3d', 'motion-craft', 'motion-style', 'remotion']) }),
      execute: async ({ topic }) => {
        markGuideRead(scope.sessionId, topic)
        return VIDEO_GUIDES[topic]
      },
    }),

    motion_read: tool({
      description:
        'Returns the current HTML of a motion composition (of this conversation by name, or any one by id), behind a one-line header with its line count and HASH. The user may have asked for changes since you wrote it, and edits need the exact text. ' +
        'A big file: do NOT re-read it all to copy one string — pass `symbol` (a function, class, const or CSS rule by name: returns the whole block), `from`/`to` (lines) or `find` (one text or several; returns the matching lines with `context` lines around, numbered). Line numbers are only for locating: never put them in oldText.',
      inputSchema: z.object({
        name: NAME.optional(),
        id: ID,
        file: z.string().optional().describe('Text file of the piece to read (e.g. scenes/intro.js). Default: the entry index.html'),
        from: z.number().int().positive().optional().describe('First line to return (1-based)'),
        to: z.number().int().positive().optional().describe('Last line to return'),
        find: z
          .union([z.string(), z.array(z.string()).max(8)])
          .optional()
          .describe('Return only the lines that contain this text (case-sensitive), with context — or ANY of several texts, in one call'),
        symbol: z
          .string()
          .optional()
          .describe('A function, class, const/let/var or CSS rule by name (buildK, .word, tick): returns the WHOLE block, closed for you — instead of guessing line ranges'),
        context: z.number().int().min(0).max(10).optional().describe('Lines around each match for `find` (default 2)'),
      }),
      execute: async ({ name, id, file, from, to, find, context, symbol }) => {
        const target = await resolveTarget({ name, id })
        await mustExist(target)
        const absolute = resolveEditFile(target.folder, target.file, file)
        const text = await fsp.readFile(absolute, 'utf8')
        return viewFile(file ?? 'index.html', text, { from, to, find, context, symbol })
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
        'Call video_guide("motion") once before writing your first composition (text that follows a voice or a song — karaoke, lyrics — reads its word times from orbitMotion.audio.words(): never type them; scenes are laid out from their durations with orbitMotion.scenes([{ name, dur }]) and duration=auto in the meta). The page must declare its format (<meta name="orbit-motion" content="width=1920,height=1080,fps=30,duration=6">) and move only through seek: CSS animations, the Web Animations API, or window.orbitMotion.seek(frame) for script-driven motion. A library such as GSAP must be a local file next to index.html (motion_asset copies it from the working folder in code mode); with no local copy, use CSS/Web Animations or your own seek. Fonts: system fonts or a Google Fonts <link>. ' +
        'A big piece goes in several files: a short index.html plus "files" (scenes/*.js as <script type="module" src>, theme.css, data.json) — one huge html is how a call comes out cut off, and such an html is refused. The result says whether it loaded and lists the layers with their enter/leave frames. After this, change it with motion_edit (small, exact replacements), not by rewriting everything. ' +
        'copyFrom clones an existing piece WITH its audio, images and audio.json (variations, A/B) — never recreate a piece by rewriting its html. ' +
        'Built in on window.orbitMotion (video_guide("motion") has the detail): interpolate(frame, [in…], [out…], { easing }), spring, Easing.easeOut/bezier, sequence, scenes, random(seed) instead of Math.random, fitText(text, { maxWidth, maxLines }) / measureText for text that must fit, audio.words/lines/find/level/bands.',
      inputSchema: z.object({
        name: NAME.optional(),
        id: ID,
        html: z
          .string()
          .min(1)
          .optional()
          .describe('The COMPLETE HTML of the entry (index.html), closed with </html>. Optional only with copyFrom (then the clone keeps the original html until you edit it)'),
        copyFrom: z
          .string()
          .min(1)
          .optional()
          .describe(
            'CLONE an existing composition first — its name in this conversation or its motion id (mv_…) — with EVERY file: audio, images, fonts, audio.json and the word times. For variations (A/B), a new version, a template. Without html the clone is the same piece; with html it replaces the entry. Never recreate a piece by rewriting its html: the clone would come out mute.',
          ),
        files: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Extra TEXT files of the piece, path → content (scenes/intro.js, theme.css, data.json). Reference them from the HTML by relative path (<script type="module" src="scenes/intro.js">). Use this to split a big piece: a single huge html is how a call comes out cut off.',
          ),
      }),
      execute: async ({ name, id, html: sent, copyFrom, files }) => {
        const target = await resolveTarget({ name, id })
        if (sent === undefined && !copyFrom) throw new Error('pass `html` (the whole composition) or `copyFrom` (a composition to clone)')
        const { html, fixed: unflattened } = sent === undefined ? { html: undefined, fixed: false } : unflattenHtml(sent)
        const cut = html === undefined ? null : truncationReason(html)
        if (cut) {
          throw new Error(
            `The html looks CUT OFF (${cut}) — nothing was written. Send it again in smaller pieces: keep index.html short and move the scripts/styles into "files" (e.g. scenes/01.js, theme.css), or write a skeleton now and fill the rest with motion_edit.`,
          )
        }
        // The first NEW piece of a conversation asks for the contract first: a clone, or
        // rewriting a piece that exists, already has one to go by.
        if (!copyFrom && !hasReadGuide(scope.sessionId, 'motion')) {
          const current = await fsp.readFile(target.file, 'utf8').catch(() => MOTION_PLACEHOLDER)
          if (current === MOTION_PLACEHOLDER) throw new Error(GUIDE_FIRST)
        }
        let origin: Target | null = null
        if (copyFrom) {
          origin = await resolveTarget(/^mv_/.test(copyFrom.trim()) ? { id: copyFrom.trim() } : { name: copyFrom })
          await mustExist(origin)
        }
        const extra = planPieceFiles(target.folder, target.file, files)
        let copied = 0
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
          if (origin) {
            if (existed) {
              throw new Error(`"${target.name}" already exists — a clone needs a name that is free (pick another, or delete it first)`)
            }
            copied = await copyPieceFolder(origin.folder, target.folder)
          }
          for (const file of extra) {
            await fsp.mkdir(path.dirname(file.absolute), { recursive: true })
            await writeFileAtomic(file.absolute, file.content)
          }
          if (html !== undefined) await writeFileAtomic(target.file, html)
          return existed
        })
        const result = await report(target, origin ? `cloned from "${origin.name}" (${copied} files)` : existed ? 'replaced' : 'created')
        return unflattened
          ? `[fixed] The html arrived as ONE line with literal \\n instead of line breaks (escaped twice); the breaks were restored. Send real line breaks next time.\n${result}`
          : result
      },
    })

    tools.motion_edit = tool({
      description:
        'Edits a motion composition with EXACT text replacements, applied in order (oldText must exist and be unique unless replaceAll; an edit that swaps a text for itself is refused). The Motion tab reloads live at the same frame, so the user watches each change. ' +
        'The answer starts with a RECEIPT: per edit the line where it landed and what is there now, and the file\'s hash before → after — if the receipt does not show your change, it did not land. Pass `baseHash` (from motion_read or the last receipt) to refuse the edit when the file is no longer the one you looked at. ' +
        'This is how you iterate on timing, easing, colors and copy — small edits, not full rewrites. If you are unsure of the current text, motion_read (with find or a line range) first.',
      inputSchema: z.object({
        name: NAME.optional(),
        id: ID,
        file: z
          .string()
          .optional()
          .describe('Text file of the piece to edit (e.g. scenes/intro.js). Default: the entry index.html'),
        edits: z.array(EDIT_OP).min(1),
        baseHash: z.string().optional().describe('Hash of the file you are editing, as motion_read / the last receipt gave it. A different current hash = nothing is applied'),
      }),
      execute: async ({ name, id, file, edits, baseHash }) => {
        const target = await resolveTarget({ name, id })
        const editing = resolveEditFile(target.folder, target.file, file)
        // Reading and writing under the same lock: if another chat wrote in the middle, the
        // oldText do not match and the edit fails instead of overwriting.
        const receipt = await writing(target, async () => {
          let source: string
          try {
            source = await fsp.readFile(editing, 'utf8')
          } catch {
            throw new Error(
              file ? `no file "${file}" in "${target.name}"` : `no composition named "${target.name}" — create it with motion_write`,
            )
          }
          if (baseHash && baseHash !== fileHash(source)) {
            throw new Error(
              `${file ?? 'index.html'} is not the file you looked at (hash ${fileHash(source)}, not ${baseHash}) — someone changed it since. Nothing was applied: motion_read it again.`,
            )
          }
          const { text, applied } = applyTextEditsDetailed(source, edits)
          if (text === source) throw new Error('the edits leave the file exactly as it was — nothing was applied')
          await writeFileAtomic(editing, text)
          return describeEditReceipt(file ?? 'index.html', source, text, applied)
        })
        return `${receipt}\n${await report(target, `${edits.length} edit${edits.length === 1 ? '' : 's'} applied`)}`
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
        words: z
          .boolean()
          .optional()
          .describe(
            'Audio only: ALSO measure the time of every word (a sung line, a narration that came without timings) and save it next to the file, so the piece reads it with orbitMotion.audio.words(). Needs Speech to text on; a narration made with audio_generate({ timings: true }) already has them',
          ),
      }),
      execute: async ({ ref, path: source, filename, name, id, words }) => {
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
        if (words && imported.kind === 'audio' && !(await readWordsSidecar(imported.file))) {
          if (!scope.sttEnabled) {
            return `${imported.report}\nWord times NOT measured: Speech to text is off (Settings → Voice). Ask the user to enable it, or keep the text to whole lines.`
          }
          try {
            const { transcript } = await transcribeVideo(imported.file)
            if (!transcript.words.length) return `${imported.report}\nWord times NOT measured: the engine recognized no words in ${imported.name}.`
            await writeWordsSidecar(imported.file, transcript.words)
            return `${imported.report}\nMeasured ${transcript.words.length} words → ${imported.name}.words.json: read them with orbitMotion.audio.words() once the track is in audio.json. Check them against the lyrics/script you know (music makes the engine less sure).`
          } catch (error) {
            return `${imported.report}\nWord times NOT measured: ${(error as Error).message}`
          }
        }
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
        'Captures ONLY the instants you ask for in a composition as a contact sheet (time and frame number in each cell) — milliseconds, no video, no ffmpeg — and reports what loaded (fonts that failed, frame timing) and, per instant, WHAT IS ON SCREEN read from the page: each visible text with its position, size and opacity, how many text blocks are invisible there, and visible images/media. times in SECONDS from the start, 1–8 instants inside the declared duration. ' +
          'Call it after writing a piece, on the key moments (each scene\'s entrance, a caption, the payoff): "NO visible text" where words should be is a bug to fix before showing the user. ' +
        'The image is saved for the user; it enters YOUR context only with see: true. Load it only for a doubt that is genuinely visual (an overlap, a centring, an element that may be off-frame) — once, not after every edit, and never to show yourself that you are done. Use it BEFORE any render: the final render only runs once the user approved the composition.',
      inputSchema: z.object({
        name: NAME.optional(),
        id: ID,
        times: z.array(z.number().positive()).min(1).max(MAX_FRAME_TIMES),
        probe: z
          .array(z.string().min(1))
          .max(MAX_PROBE_SELECTORS)
          .optional()
          .describe(
            'CSS selectors (e.g. ".w3", "[data-layer=title]") read as NUMBERS at each instant: effective opacity, scale/move/rotate, box, and whether it is inside the frame. The answer to "is the previous word still at 18% at 77.25 s?" — instead of looking at a picture.',
          ),
        evaluate: z
          .array(z.string().min(1).max(MAX_EVAL_LENGTH))
          .max(MAX_EVAL_EXPRESSIONS)
          .optional()
          .describe(
            'JavaScript EXPRESSIONS read from the running piece at each instant, after the seek — e.g. "p.on", "words.length", "document.querySelector(\'.w3\').style.opacity", "window.orbitMotion.scenes ? 1 : 0". The value you would have deduced from opacities, read directly. Only globals are visible (a variable inside a function or a type=module script is not: expose it as window.name); statements go in an IIFE. Read-only use — do not change the page.',
          ),
        audio: z
          .boolean()
          .optional()
          .describe(
            'ALSO measure the sound at those instants: RMS and peak (dBFS) of the mix exactly as the render builds it (gain, automation, fades, duck, master) and of each track alone. Checks a mix you reasoned about ("-22 dB under the voice") with a number.',
          ),
        props: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Look at the piece with these props (props.json) instead of the defaults — a variation, e.g. the one with the longest name or the biggest number. Checked like in motion_render.'),
        see: z.boolean().optional().describe('Load the contact sheet into your context (default false). Images are slow and costly: only for a visual doubt'),
      }),
      execute: async ({ name, id, times, probe, evaluate, audio, props, see }, { toolCallId, abortSignal }) => {
        const target = await resolveTarget({ name, id })
        await mustExist(target)
        if (props) {
          const problems = await checkOverrides(path.dirname(target.file), [{ label: 'props', props }])
          if (problems.length) throw new Error(`invalid props — ${problems.join('; ')}`)
        }
        const result = await captureMotionFrames({
          props,
          target: target.file,
          times,
          probe,
          evaluate,
          root: target.root,
          sessionId: scope.sessionId,
          signal: abortSignal,
        })
        // The sheet stays OUTSIDE the composition's folder: that folder is watched for
        // the live reload, and a new file there would reload the tab.
        const sheetFile = path.join(root, '.frames', sheetFileName(result.name))
        await fsp.mkdir(path.dirname(sheetFile), { recursive: true })
        await fsp.writeFile(sheetFile, result.image)
        // What each frame shows, as text: the check a model without vision can make
        // (and the cheap one for those with it) — "no visible text" at the moment the
        // lyrics should be up is a bug found without looking at an image.
        const content = result.cells
          .filter((c) => c.content)
          .map((c) => describeFrameContent(frameLabel(c.timeMs, c.frame), c.content!, { width: result.width, height: result.height }))
        const probed = result.cells
          .filter((c) => c.probe)
          .map((c) => describeProbe(frameLabel(c.timeMs, c.frame), c.probe!))
        const evaluated = result.cells.some((c) => c.evals)
          ? describeEvals(result.cells.filter((c) => c.evals).map((c) => ({ label: frameLabel(c.timeMs, c.frame), readings: c.evals! })))
          : ''
        let sound = ''
        if (audio) {
          try {
            const plan = await motionAudioPlan(target.folder)
            sound = await measureMotionAudio(plan, times, result.durationInFrames / result.fps, abortSignal)
          } catch (err) {
            sound = `Sound NOT measured: ${err instanceof Error ? err.message : String(err)}`
          }
        }
        const text = [
          `Frames of ${result.name} (${result.width}x${result.height} · ${result.fps} fps · ${result.durationInFrames} frames): ${result.cells
            .map((c) => frameLabel(c.timeMs, c.frame))
            .join(' · ')}.`,
          content.length ? `On screen (read from the page):\n${content.join('\n')}` : '',
          probed.length ? `Probe (numbers read from the page; the transform is the element's own):\n${probed.join('\n')}` : '',
          evaluated ? `Evaluate (read from the running page after each seek):\n${evaluated}` : '',
          sound,
          result.failedFonts.length
            ? `Fonts failed to load (the text fell back to another font): ${[...new Set(result.failedFonts)].join(', ')}.`
            : '',
          result.scriptErrors.length
            ? `[error] The composition's scripts threw: ${result.scriptErrors.join(' | ')}. The piece is BROKEN — fix this before anything else and do not tell the user it works.`
            : '',
          see
            ? 'Check the moments you will be judged on (entrance, payoff, hold) — motion_render only after the user approves.'
            : `Contact sheet saved for the user: ${sheetFile}. It was NOT loaded into your context — the "On screen" lines above are your check (text, position, opacity); pass see: true only if a doubt is purely visual. Ask the user to look at the Motion tab — motion_render only after they approve.`,
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
        'quality (high/balanced/small) is the FILE weight — the same choice as the tab\'s Render dialog — and it does NOT make the render faster: to make a render cheap, lower width/height and fps. ' +
        'bands: 1 forces a single sequential pass (the deterministic path for a composition that cannot be pure). ' +
        'PROPS: a composition that declares props.json (title, price, colour, logo…) is rendered with other values by `props` ({ title: "Oferta A" }) — the rest keep their defaults; an undeclared or ill-typed prop is refused with the list of what is declared. ' +
        `VIDEOS IN BULK: \`variations\` ([{ name: "oferta-a", props: {...} }, …], up to ${MAX_VARIATIONS}) renders the SAME piece once per item, one file each, named after the piece and the variation, all checked before the first frame; they go to the Media gallery and are listed in the result (not played one by one).` +
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
        quality: z
          .enum(['high', 'balanced', 'small'])
          .optional()
          .describe(
            "File weight (CRF/preset), the same choice as the tab's Render dialog. It changes the FILE, not the speed of the render — to make a render cheap, lower width/height and fps. Default balanced",
          ),
        bands: z
          .number()
          .int()
          .min(1)
          .max(16)
          .optional()
          .describe(
            'Parallel bands the frame range is split into (default: follows the cores). 1 = one sequential pass — the deterministic path for a composition that cannot be pure',
          ),
        output: z.string().optional().describe('Code mode only: a path in the working folder to ALSO copy the video to'),
        audio: z.string().optional().describe('Code mode only: an audio file of the working folder, mixed from the start of the piece'),
        show: z.boolean().optional().describe('Show it in your reply as a player (default true)'),
        props: z.record(z.string(), z.unknown()).optional().describe('Values for the props declared in props.json, for this render (the rest keep their defaults)'),
        variations: z
          .array(z.object({ name: z.string().optional().describe('Short label for the file name (default: its number)'), props: z.record(z.string(), z.unknown()) }))
          .min(1)
          .max(MAX_VARIATIONS)
          .optional()
          .describe(`One render per item, each with its own props — a batch of videos from one piece (max ${MAX_VARIATIONS}). In code mode \`output\` is then a FOLDER that receives them all.`),
      }),
      execute: async ({ name, id, format, transparent, output, audio, show: showIt = true, props, variations, ...spec }, { abortSignal }) => {
        const target = await resolveTarget({ name, id })
        await mustExist(target)
        if ((output || audio) && !project) throw new Error('`output` and `audio` need a working folder (code mode)')
        if (variations && props) throw new Error('pass `props` for one render or `variations` for several, not both')
        const ext = format ?? 'mp4'
        // The output lives next to the conversation's compositions, OUTSIDE the piece's folder
        // (which is watched for the live reload).
        await fsp.mkdir(path.join(root, 'renders'), { recursive: true })

        // BULK: every variation is checked against props.json before the first frame, so a typo in
        // the 37th does not come out after thirty-six renders.
        if (variations) {
          const labels = variationLabels(variations)
          const problems = await checkOverrides(
            path.dirname(target.file),
            variations.map((v, i) => ({ label: `variation ${i + 1}${v.name ? ` "${v.name}"` : ''}`, props: v.props })),
          )
          if (problems.length) throw new Error(`not rendered — ${problems.join('; ')}`)
          const folder = output ? resolveWritePath(project!, output) : null
          if (folder) await fsp.mkdir(folder, { recursive: true })
          const done: string[] = []
          const lines: string[] = []
          for (let i = 0; i < variations.length; i += 1) {
            if (abortSignal?.aborted) {
              lines.push(`Stopped by the user after ${done.length} of ${variations.length}.`)
              break
            }
            const file = path.join(root, 'renders', `${target.name}-${labels[i]}.${ext}`)
            const result = await renderMotion({
              file: target.file,
              output: file,
              signal: abortSignal,
              root: target.root,
              sessionId: scope.sessionId,
              transparent,
              audio: audio ? resolveSafePath(project!, audio) : undefined,
              props: variations[i].props,
              ...spec,
            })
            await addVideoToGallery({ file, name: path.basename(file), sessionId: scope.sessionId, source: 'chat' })
            if (folder) await fsp.copyFile(file, path.join(folder, path.basename(file)))
            done.push(path.basename(file))
            lines.push(`${i + 1}/${variations.length} ${path.basename(file)} — ${result.duration}s, ${result.width}x${result.height}${result.warnings.length ? ` · ${result.warnings.join('; ')}` : ''}`)
          }
          return {
            message: [
              `Rendered ${done.length} of ${variations.length} variations of "${target.name}" — all in the Media gallery${folder ? `, and copied to ${path.relative(project!.directory, folder) || folder}` : ''}.`,
              ...lines,
            ].join('\n'),
          }
        }

        const exported = output ? resolveWritePath(project!, output) : null
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
          props,
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
    for (const key of ['video_probe', 'audio_bpm', 'transcribe', 'video_timeline'] as const) {
      if (base[key]) tools[key] = base[key]
    }
    if (scope.canRender && base.video_render) tools.video_render = base.video_render
  }

  return tools
}
