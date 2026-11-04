import { tool, type ToolSet } from 'ai'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { getMediaEntry, mediaIdFromUrl, saveMedia } from '../media'
import { captureUrl } from '../browser-script'
import {
  PanelCaptureError,
  panelClick,
  panelConsole,
  panelCurrentUrl,
  panelDrag,
  panelEval,
  panelHover,
  panelLastViewport,
  panelNavigate,
  panelRead,
  panelResize,
  panelRunScript,
  panelScreenshot,
  panelType,
} from '../panel-browser'
import {
  DEFAULT_COLS,
  DEFAULT_PER_SHEET,
  DEFAULT_TILE,
  composeSheet,
  dataUrlsToBuffers,
  describeSheet,
  planSheets,
  sampleTimes,
  seekScript,
  timeLabel,
  videoCaptureScript,
  videoProbeScript,
} from '../panel-sheet'
import { resolveSafePath, resolveWritePath, type ToolContext } from './context'
import { describeImage } from '../vision'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
/** Size limit for an image sent to the model via toModelOutput (300KB). */
const MAX_MODEL_IMAGE_BYTES = 300_000
/** Total timeout of the tool (capture + vision description + save): the tool can never
 *  hang the turn — without `see`, there is no LLM call at all. */
const SCREENSHOT_TIMEOUT_MS = 45_000

/** Viewport presets for responsiveness testing. */
/** panel_screenshot input. Declared here (and not inline) so that
 *  `execute` keeps typed parameters even when the `see` field is
 *  removed from the schema announced to the model — see the comment at the usage. */
const SCREENSHOT_SCHEMA = z.object({
  savePath: z
    .string()
    .optional()
    .describe('Path relative to the working folder to save the image (optional)'),
  fullscreen: z
    .boolean()
    .optional()
    .describe('Captures full screen (bigger shot) and returns to the side view'),
  fullPage: z
    .boolean()
    .optional()
    .describe('Captures the whole page (scroll included) in a hidden window'),
  format: z.enum(['webp', 'png']).optional().describe('Default webp; png for documentation'),
  maxWidth: z
    .number()
    .int()
    .min(320)
    .max(3840)
    .optional()
    .describe('Maximum width in px (default 1024 — raise it only for documentation)'),
  see: z
    .boolean()
    .optional()
    .describe(
      'Loads the image into your context so you can SEE it — natively if you have vision, or via the configured vision model description when the Vision mode is ON (the raw image never enters your context in that case). Default false — returns only the media URL (no image tokens). Use true when you actually need to see the screen.',
    ),
})

/** panel_sheet input. Like SCREENSHOT_SCHEMA, `see` is removed from what the model is told when no vision exists. */
const SHEET_SCHEMA = z.object({
  mode: z
    .enum(['video', 'seek'])
    .optional()
    .describe(
      '"video" reads the <video> of the page (default when there is no seekCode); "seek" runs your seekCode to put ANY page at time t and screenshots the panel.',
    ),
  from: z.number().min(0).optional().describe('First instant in seconds (default 0)'),
  to: z.number().positive().optional().describe('Last instant in seconds (default: the end of the video; REQUIRED in seek mode)'),
  step: z.number().positive().optional().describe('Seconds between frames (default: about 24 frames from..to). 0.2 reads motion; 0.05–0.1 reads an easing curve'),
  count: z.number().int().min(1).max(120).optional().describe('Number of frames, evenly spaced from..to. Wins over step'),
  perSheet: z.number().int().min(4).max(40).optional().describe(`Frames per sheet (default ${DEFAULT_PER_SHEET}); more frames make more sheets`),
  cols: z.number().int().min(1).max(8).optional().describe(`Columns of the grid (default ${DEFAULT_COLS})`),
  tile: z.number().int().min(120).max(480).optional().describe(`Width of each frame in px (default ${DEFAULT_TILE}); raise it to read small type`),
  selector: z.string().optional().describe('CSS selector of the <video> (or a container of it) when the page has several'),
  seekCode: z
    .string()
    .optional()
    .describe(
      'Seek mode: the body of an async function with `t` (seconds) and `i` (frame index) in scope that puts the page at that time, e.g. `await window.orbitMotion.seek(Math.round(t * 30))` or `anim.goToAndStop(t * 1000)` or `document.getAnimations().forEach(a => { a.pause(); a.currentTime = t * 1000 })`.',
    ),
  settleMs: z.number().int().min(0).max(2000).optional().describe('Seek mode: wait after each seek before the screenshot (default 150)'),
  see: z
    .boolean()
    .optional()
    .describe('Loads the sheets (up to 3) into your context so you can SEE them — natively with vision, or described by the vision model. Default false: only the media URLs come back.'),
})

/** Mouse target: a panel_read ref, a CSS selector or viewport coordinates. */
const TARGET_SCHEMA = z.object({
  ref: z.number().int().optional().describe('Numeric ref from panel_read'),
  selector: z.string().optional().describe('CSS selector (alternative to ref)'),
  x: z.number().optional().describe('Viewport X in CSS px (with y, alternative to ref/selector)'),
  y: z.number().optional().describe('Viewport Y in CSS px'),
})

const VIEWPORT_PRESETS: Record<string, { width: number | null; height: number | null; label: string }> = {
  mobile: { width: 390, height: 844, label: 'mobile (390×844)' },
  tablet: { width: 834, height: 1112, label: 'tablet (834×1112)' },
  desktop: { width: 1440, height: 900, label: 'desktop (1440×900)' },
  fit: { width: null, height: null, label: 'fit to panel' },
}

/**
 * Right panel browser tools (code mode). The browser runs in the session's
 * webview — visible in the Browser tab or IN THE HIDDEN HOST when the panel
 * is closed (the UI never opens on its own; the user clicks the "testing…"
 * indicator to see it). The screenshot by default comes back only as a URL
 * (orbit-media://) — the image is only loaded into the model via toModelOutput
 * (content file) when the agent asks for `see: true` on a model with vision; the
 * base64 stays in a stash per toolCallId so as not to inflate the persisted history.
 */

/** The sheets of panel_sheet that should enter the context (see: true), per toolCallId. */
const sheetStash = new Map<string, { images: Array<{ base64: string; format: 'webp' | 'jpeg' }> } | { text: string }>()
/** A sheet is sent to the model at most this many times per call. */
const MAX_SEEN_SHEETS = 3
/** The whole panel_sheet call: capture, composition and storage. */
const SHEET_TIMEOUT_MS = 240_000

const screenshotStash = new Map<
  string,
  | { base64: string; format: 'webp' | 'png' }
  | { text: string }
>()

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createPanelBrowserTools(ctx: ToolContext): ToolSet {
  return {
    panel_navigate: tool({
      description:
        'Opens a URL in the agent\'s browser (it runs in the background — the side panel does NOT open on its own; the user can click the "testing…" indicator to watch). Use it to test web apps — local servers (http://localhost:...) included.',
      inputSchema: z.object({
        url: z.string().describe('Full URL (http/https)'),
      }),
      execute: async ({ url }) => {
        const result = await panelNavigate(ctx.sessionId, url)
        return `Loaded: ${result.title || '(untitled)'} — ${result.url}. Use panel_read to see the content or panel_screenshot to see the screen.`
      },
    }),
    panel_read: tool({
      description:
        'Reads the page open in the panel browser: title, URL, visible text, and interactive elements with numbered refs for panel_click/panel_type.',
      inputSchema: z.object({}),
      execute: async () => panelRead(ctx.sessionId),
    }),
    panel_click: tool({
      description:
        'Clicks an element on the panel page, by ref (from panel_read) or CSS selector. Refs change after navigation — run panel_read again.',
      inputSchema: z.object({
        ref: z.number().int().optional().describe('Numeric ref from panel_read'),
        selector: z.string().optional().describe('CSS selector (alternative to ref)'),
      }),
      execute: async ({ ref, selector }) => {
        if (ref == null && !selector) return 'Provide ref or selector.'
        return panelClick(ctx.sessionId, ref, selector)
      },
    }),
    panel_type: tool({
      description:
        'Types text into a field on the panel page (by ref or CSS selector), with the option to submit the form.',
      inputSchema: z.object({
        text: z.string().describe('Text to type'),
        ref: z.number().int().optional().describe('Numeric ref from panel_read'),
        selector: z.string().optional().describe('CSS selector (alternative to ref)'),
        pressEnter: z.boolean().optional().describe('Submits the form after typing'),
      }),
      execute: async ({ text, ref, selector, pressEnter }) => {
        if (ref == null && !selector) return 'Provide ref or selector.'
        return panelType(ctx.sessionId, text, ref, selector, pressEnter)
      },
    }),
    panel_console: tool({
      description:
        'Reads the console of the page open in the panel browser: errors (uncaught exceptions and rejected promises included), warnings, logs, failed loads and crashes, with source:line. Check it whenever a page renders blank or broken, or after an interaction that should have done something.',
      inputSchema: z.object({
        level: z
          .enum(['all', 'warning', 'error'])
          .optional()
          .describe("'error' = only errors, 'warning' = warnings and errors, 'all' (default)"),
        pattern: z.string().optional().describe('Only messages containing this text (case-insensitive)'),
        limit: z.number().int().min(1).max(500).optional().describe('Most recent N messages (default 50)'),
        clear: z.boolean().optional().describe('Clears the console after reading (to see only what comes next)'),
      }),
      execute: async (options) => panelConsole(ctx.sessionId, options),
    }),
    panel_eval: tool({
      description:
        'Runs JavaScript in the page open in the panel browser — the same page the user sees, with its current state — and returns the result as JSON. A single expression returns its value (e.g. `document.title`, `[...document.querySelectorAll("li")].length`); for several statements use `return`. Top-level await works. Use it to inspect state (stores, DOM, localStorage) or to set up a scenario before a screenshot. For mouse interaction prefer panel_click/panel_hover/panel_drag, which send real input events.',
      inputSchema: z.object({
        code: z.string().describe('JavaScript to run in the page'),
      }),
      execute: async ({ code }) => panelEval(ctx.sessionId, code),
    }),
    panel_hover: tool({
      description:
        'Moves the mouse over an element (real mouse event) to reveal hover menus, tooltips and :hover styles. Then use panel_screenshot.',
      inputSchema: TARGET_SCHEMA,
      execute: async (target) => panelHover(ctx.sessionId, target),
    }),
    panel_drag: tool({
      description:
        'Drags with the left mouse button using real mouse events (down → several moves → up) — works with pointer-based drag and drop (dnd-kit, sortable lists, sliders, resize handles, canvases). Each end is a ref, CSS selector or x/y. With release: false the button stays pressed at `to`: take a panel_screenshot of the mid-drag state (drag ghost, drop highlight), then call panel_drag again WITHOUT from to keep moving and/or drop (release defaults to true). Native HTML5 draggable elements are best-effort.',
      inputSchema: z.object({
        from: TARGET_SCHEMA.optional().describe('Where to press the button. Omit to continue a held drag'),
        to: TARGET_SCHEMA.describe('Where to move the pointer'),
        steps: z.number().int().min(1).max(100).optional().describe('Intermediate moves (default 12)'),
        release: z.boolean().optional().describe('Release the button at the end (default true)'),
      }),
      execute: async (options) => panelDrag(ctx.sessionId, options),
    }),
    panel_resize: tool({
      description:
        'Resizes the panel browser\'s viewport to test responsiveness. Use a preset (mobile/tablet/desktop/fit) or custom width/height. Then use panel_screenshot to see the result.',
      inputSchema: z.object({
        preset: z.enum(['mobile', 'tablet', 'desktop', 'fit']).optional(),
        width: z.number().int().min(280).max(3840).optional().describe('Custom width in px'),
        height: z.number().int().min(400).max(2160).optional().describe('Custom height in px'),
      }),
      execute: async ({ preset, width, height }) => {
        if (width && height) return panelResize(ctx.sessionId, width, height, `${width}×${height}`)
        const chosen = VIEWPORT_PRESETS[preset ?? 'fit']
        return panelResize(ctx.sessionId, chosen.width, chosen.height, chosen.label)
      },
    }),
    panel_screenshot: tool({
      description:
        'Takes a screenshot of the panel page. By default it returns only the media URL (orbit-media://...) — the image is NOT loaded into your context (saves image tokens). Pass see: true to load the image so you can actually SEE it — natively if you have vision, or via the configured vision model when the Vision mode is ON (in that case the vision model DESCRIBES the image and only the description enters your context, even if you have native vision). With savePath, also saves it to the working folder (e.g.: docs/login/screen.webp) — use in documentation mode. With fullscreen, expands to full screen, captures, and returns to the side view. With fullPage, captures the WHOLE page (beyond the viewport) in a hidden window, without touching the panel; format: png gives a high-resolution image for documentation.',
      // The schema is built at runtime because `see` can only EXIST when there is
      // vision available — announcing the field without it would make the model ask for an
      // image nobody can read. The `omit` preserves the static type of the
      // complete form (with optional `see`), which is exactly what the execute
      // below consumes; without that its parameters would come as `any`.
      inputSchema: (ctx.modelVision || ctx.visionModel
        ? SCREENSHOT_SCHEMA
        : SCREENSHOT_SCHEMA.omit({ see: true })) as typeof SCREENSHOT_SCHEMA,
      execute: async ({ savePath, fullscreen, fullPage, format, maxWidth, see }, { toolCallId }) => {
        const outFormat: 'webp' | 'png' = format === 'png' ? 'png' : 'webp'
        const run = async (): Promise<string> => {
          let image: Buffer
          let fallbackNote = ''
          if (fullPage) {
            // Full page: we never resize the visible webview (it would blink the
            // UI). We capture in a hidden window with the SAME URL and session — and in
            // the same viewport as panel_resize (responsiveness counts here too).
            const url = panelCurrentUrl(ctx.sessionId)
            if (!url) return 'The panel browser has no page open — use panel_navigate first.'
            image = await captureUrl({
              url,
              sessionId: ctx.sessionId,
              fullPage: true,
              format: outFormat,
              maxWidth,
              viewport: panelLastViewport() ?? undefined,
            })
          } else {
            try {
              image = await panelScreenshot(ctx.sessionId, fullscreen === true, {
                format: outFormat,
                maxWidth,
              })
            } catch (err) {
              if (!(err instanceof PanelCaptureError)) throw err
              // Panel webview without paint (hidden/0×0) or stuck: instead of
              // failing the tool, it captures the SAME URL in the hidden window (which paints
              // even when hidden) — the shot comes out the same way, in the same viewport.
              const url = panelCurrentUrl(ctx.sessionId)
              if (!url || url.startsWith('about:')) throw err
              image = await captureUrl({
                url,
                sessionId: ctx.sessionId,
                format: outFormat,
                maxWidth,
                viewport: panelLastViewport() ?? undefined,
              })
              fallbackNote =
                ' (the panel webview was not painting — captured in the hidden window with the same URL; the state may differ slightly)'
            }
          }
          const mediaUrl = await saveMedia(image, outFormat, {
            source: 'screenshot',
            sessionId: ctx.sessionId,
            name: savePath ?? (fullPage ? 'fullPage' : 'panel'),
          })
          let loaded = ''
          if (see === true) {
            if (ctx.visionModel) {
              // Vision mode on: always delegates (even for a model with native
              // vision) — only the description enters the context, the image never
              // (token savings in the history; the agent does not behave differently).
              const desc = await describeImage({
                model: ctx.visionModel,
                imageDataUrl: `data:image/${outFormat};base64,${image.toString('base64')}`,
              })
              if (desc) {
                screenshotStash.set(toolCallId, { text: desc })
                loaded = ` Description generated by the vision model (${ctx.visionModel.modelId}) loaded into your context (see: true).`
              } else {
                loaded = ' (see: true — the configured vision model could not describe the image; no description was loaded.)'
              }
            } else if (ctx.modelVision) {
              // Native vision, Vision mode off: image in the context.
              screenshotStash.set(toolCallId, { base64: image.toString('base64'), format: outFormat })
              loaded = ' Image loaded into your context (see: true).'
            } else {
              loaded = ' (see: true ignored — this model has no vision; the image was NOT loaded into the context.)'
            }
          }
          let saved = ''
          if (savePath) {
            const saveName = savePath.replace(/\.[^/.]+$/, '') + `.${outFormat}`
            const target = resolveWritePath(ctx, saveName)
            await fsp.mkdir(path.dirname(target), { recursive: true })
            await fsp.writeFile(target, image)
            saved = ` Saved to ${saveName}.`
          }
          return `Screenshot captured (${Math.round(image.length / 1024)}KB${fullPage ? ', full page' : ''}). Media: ${mediaUrl}${saved}${loaded}${fallbackNote}`
        }
        const SCREENSHOT_TIMED_OUT = Symbol('screenshotTimedOut')
        const outcome = await Promise.race([
          run(),
          delay(SCREENSHOT_TIMEOUT_MS).then(() => SCREENSHOT_TIMED_OUT),
        ])
        if (outcome === SCREENSHOT_TIMED_OUT) {
          return `The capture exceeded ${Math.round(SCREENSHOT_TIMEOUT_MS / 1000)}s and was abandoned (the browser may be stuck). Try again; if it persists, use run_browser_script/capture_batch, which run in a separate hidden window.`
        }
        return outcome
      },
      toModelOutput: ({ toolCallId, output }) => {
        const stashed = screenshotStash.get(toolCallId)
        screenshotStash.delete(toolCallId)
        if (!stashed) return { type: 'text', value: String(output) }
        if ('text' in stashed) {
          // Vision delegation: the description enters as text, without an image
          return { type: 'text', value: `${String(output)}\n\n[Image description (vision model)]: ${stashed.text}` }
        }
        const { base64, format } = stashed
        const raw = Buffer.from(base64, 'base64')
        const parts: ({ type: 'text'; text: string } | { type: 'image-data'; data: string; mediaType: string })[] = [
          { type: 'text', text: String(output) },
        ]
        if (raw.length <= MAX_MODEL_IMAGE_BYTES) {
          parts.push({ type: 'image-data', data: base64, mediaType: `image/${format}` })
        } else {
          parts.push({
            type: 'text',
            text: `[Screenshot omitted: ${Math.round(raw.length / 1024)}KB — exceeds the ${Math.round(MAX_MODEL_IMAGE_BYTES / 1024)}KB limit. The image is saved in the media gallery (and on disk, if savePath was given).]`,
          })
        }
        return { type: 'content', value: parts }
      },
    }),
    panel_sheet: tool({
      description:
        'Reads ANYTHING that plays in the panel browser as a CONTACT SHEET: a grid of frames with the time written on each, images only (no audio, no words). ' +
        'Use it to analyse a reference you can only watch — a video playing on a site (YouTube, Vimeo…: nothing is downloaded), an animation, a Motion piece, an app demo — before writing a style brief, or to check your own piece over time. ' +
        'Open the page first (panel_navigate); for a video it samples the <video> by seeking, so the times are exact and the frames are at the video\'s own resolution. ' +
        'For anything that is not a <video>, pass seekCode (mode "seek"): it puts the page at time t and the panel is screenshotted. ' +
        'Many frames make several numbered sheets (24 each by default). The images are saved to the media gallery and do NOT enter your context unless see: true. ' +
        'If the site blocks reading the video (cross-origin without CORS, DRM) it says so: use seek mode, or ask the user for the file.',
      inputSchema: (ctx.modelVision || ctx.visionModel ? SHEET_SCHEMA : SHEET_SCHEMA.omit({ see: true })) as typeof SHEET_SCHEMA,
      execute: async (input, { toolCallId }) => {
        const run = async (): Promise<string> => {
          const { from, to, step, count, selector, seekCode, settleMs, see } = input
          const mode = input.mode ?? (seekCode ? 'seek' : 'video')
          const tile = input.tile ?? DEFAULT_TILE
          const cols = input.cols ?? DEFAULT_COLS
          const perSheet = input.perSheet ?? DEFAULT_PER_SHEET
          const notes: string[] = []
          let times: number[]
          let labels: number[]
          let frames: Buffer[] = []

          if (mode === 'video') {
            const probe = (await panelRunScript(ctx.sessionId, videoProbeScript(selector))) as Record<string, unknown>
            if (probe.__error) return `Could not read the page: ${String(probe.__error)}`
            if (!probe.found) {
              const n = Number(probe.videos ?? 0)
              return (
                (n
                  ? `The page has ${n} <video> element(s) but none is ready (not loaded yet, or not the one you meant) — start it, wait a moment, or pass selector.`
                  : 'No <video> in the page.') +
                ' For an animation or a canvas pass seekCode (mode "seek"); to open a page use panel_navigate first.'
              )
            }
            const duration = Number(probe.duration)
            try {
              times = sampleTimes({ from, to, step, count, duration })
            } catch (err) {
              return `panel_sheet: ${(err as Error).message}`
            }
            if (duration < 1) notes.push(`The video reports only ${duration.toFixed(2)} s: on a site with ads the player may be showing one — check the time of the first frame.`)
            const actual: number[] = []
            for (let i = 0; i < times.length; i += 24) {
              const batch = times.slice(i, i + 24)
              const got = (await panelRunScript(
                ctx.sessionId,
                videoCaptureScript({ selector, times: batch, tile: Math.min(480, Math.max(tile, 160)) }),
                60_000,
              )) as { error?: string; message?: string; frames?: string[]; actual?: number[]; __error?: string }
              if (got.__error) return `Could not read the video: ${got.__error}`
              if (got.error === 'tainted') {
                return (
                  'The page does not let its video be read (a cross-origin source without CORS, or DRM): ' + String(got.message ?? '').slice(0, 160) + '\n' +
                  'Use mode "seek" with a seekCode that positions the page and the panel is screenshotted, or ask the user for the file.'
                )
              }
              if (got.error || !got.frames) return `Could not read the video: ${got.error ?? 'unknown error'} ${got.message ?? ''}`
              frames.push(...dataUrlsToBuffers(got.frames))
              actual.push(...(got.actual ?? batch))
            }
            labels = actual
          } else {
            if (!seekCode) return 'panel_sheet: seek mode needs seekCode — the code that puts the page at time `t`.'
            try {
              times = sampleTimes({ from, to, step, count })
            } catch (err) {
              return `panel_sheet: ${(err as Error).message}`
            }
            labels = times
            for (let i = 0; i < times.length; i += 1) {
              const res = (await panelRunScript(ctx.sessionId, seekScript(seekCode, times[i], i), 20_000)) as { __error?: string } | undefined
              if (res && typeof res === 'object' && res.__error) {
                return `seekCode failed at t=${times[i]} s (frame ${i + 1}): ${String(res.__error).slice(0, 300)}`
              }
              await delay(settleMs ?? 150)
              frames.push(await panelScreenshot(ctx.sessionId, false, { format: 'webp', maxWidth: Math.max(tile * 2, 480) }))
            }
          }

          const plan = planSheets(times, perSheet)
          const lines: string[] = []
          const seen: Array<{ base64: string; format: 'webp' | 'jpeg' }> = []
          let offset = 0
          for (let s = 0; s < plan.length; s += 1) {
            const n = plan[s].length
            const sheet = await composeSheet(frames.slice(offset, offset + n), labels.slice(offset, offset + n).map(timeLabel), { cols, tile })
            const media = await saveMedia(sheet.buffer, 'webp', {
              source: 'screenshot',
              sessionId: ctx.sessionId,
              name: `Sheet ${s + 1}/${plan.length} ${timeLabel(labels[offset])}–${timeLabel(labels[offset + n - 1])}`,
            })
            lines.push(
              describeSheet({ index: s + 1, total: plan.length, times: labels.slice(offset, offset + n), cols: sheet.cols, rows: sheet.rows, media }),
            )
            if (see === true && seen.length < MAX_SEEN_SHEETS) seen.push({ base64: sheet.buffer.toString('base64'), format: sheet.format })
            offset += n
          }

          let loaded = ''
          if (see === true) {
            if (ctx.visionModel) {
              const parts: string[] = []
              for (let i = 0; i < seen.length; i += 1) {
                const desc = await describeImage({ model: ctx.visionModel, imageDataUrl: `data:image/${seen[i].format};base64,${seen[i].base64}` })
                if (desc) parts.push(`[Sheet ${i + 1} — description by the vision model] ${desc}`)
              }
              if (parts.length) {
                sheetStash.set(toolCallId, { text: parts.join('\n\n') })
                loaded = ` Description of ${parts.length} sheet(s) loaded into your context (vision model ${ctx.visionModel.modelId}).`
              } else loaded = ' (see: true — the vision model could not describe the sheets.)'
            } else if (ctx.modelVision) {
              sheetStash.set(toolCallId, { images: seen })
              loaded = ` ${seen.length} sheet(s) loaded into your context${plan.length > seen.length ? ` (the first ${seen.length} of ${plan.length}; call again with from/to for the rest)` : ''}.`
            } else {
              loaded = ' (see: true ignored — this model has no vision; the sheets were NOT loaded into the context.)'
            }
          }
          const header = `${times.length} frames in ${plan.length} sheet(s) — ${mode === 'video' ? 'read from the page\'s video' : 'by seeking the page with your seekCode'}.`
          return [header, ...lines, ...notes].join('\n') + loaded
        }
        const TIMED_OUT = Symbol('sheetTimedOut')
        const outcome = await Promise.race([run(), delay(SHEET_TIMEOUT_MS).then(() => TIMED_OUT)])
        if (outcome === TIMED_OUT) {
          return `panel_sheet exceeded ${Math.round(SHEET_TIMEOUT_MS / 1000)} s and was abandoned. Ask for fewer frames (count/step) or a shorter from/to.`
        }
        return outcome
      },
      toModelOutput: ({ toolCallId, output }) => {
        const stashed = sheetStash.get(toolCallId)
        sheetStash.delete(toolCallId)
        if (!stashed) return { type: 'text', value: String(output) }
        if ('text' in stashed) return { type: 'text', value: `${String(output)}\n\n${stashed.text}` }
        const parts: ({ type: 'text'; text: string } | { type: 'image-data'; data: string; mediaType: string })[] = [{ type: 'text', text: String(output) }]
        for (const [i, img] of stashed.images.entries()) {
          if (Buffer.from(img.base64, 'base64').length <= MAX_MODEL_IMAGE_BYTES) {
            parts.push({ type: 'image-data', data: img.base64, mediaType: `image/${img.format}` })
          } else parts.push({ type: 'text', text: `[Sheet ${i + 1} omitted: it exceeds the ${Math.round(MAX_MODEL_IMAGE_BYTES / 1024)}KB limit — ask again with a smaller tile or fewer perSheet.]` })
        }
        return { type: 'content', value: parts }
      },
    }),
    show_image: tool({
      description:
        'Includes an image IN YOUR RESPONSE, visible to the user in the chat. Use fromPanel to attach a current screenshot of the panel browser, media for an image already captured by run_browser_script/capture_batch (orbit-media:// URL from the manifest), or path for an image in the working folder (e.g.: docs/login/screen.webp). The image appears at the point in the response where the tool was called — don\'t over-describe it afterward.',
      inputSchema: z.object({
        fromPanel: z.boolean().optional().describe('Captures the panel browser now and attaches it'),
        media: z
          .string()
          .optional()
          .describe('orbit-media:// URL returned by run_browser_script/capture_batch'),
        path: z
          .string()
          .optional()
          .describe('Relative path to an existing image in the working folder (png/jpg/webp/gif)'),
        alt: z.string().optional().describe('Short caption shown under the image'),
      }),
      execute: async ({ fromPanel, media, path: imagePath, alt }) => {
        // Image already registered (captured by script/batch): reuses the URL,
        // without duplicating the file on disk.
        if (media) {
          const entry = mediaIdFromUrl(media)
          if (!entry) return `Invalid media URL: ${media}`
          if (!(await getMediaEntry(entry))) return `Image not found in the registry: ${media}`
          return {
            mediaUrl: `orbit-media://${entry}`,
            alt: alt ?? '',
            message: 'Image attached to the reply — the user already sees it in the chat.',
          }
        }
        let buffer: Buffer
        let ext: string
        if (fromPanel) {
          buffer = await panelScreenshot(ctx.sessionId)
          ext = 'webp'
        } else if (imagePath) {
          ext = path.extname(imagePath).slice(1).toLowerCase()
          if (!IMAGE_EXTENSIONS.has(ext)) {
            return `Unsupported extension (${ext || 'no extension'}) — use png/jpg/webp/gif.`
          }
          buffer = await fsp.readFile(resolveSafePath(ctx, imagePath))
        } else {
          return 'Provide fromPanel, media or path.'
        }
        const mediaUrl = await saveMedia(buffer, ext, {
          source: 'chat',
          sessionId: ctx.sessionId,
          name: alt || (imagePath ? path.basename(imagePath) : 'panel'),
        })
        return {
          mediaUrl,
          alt: alt ?? '',
          message: 'Image attached to the reply — the user already sees it in the chat.',
        }
      },
    }),
  }
}
