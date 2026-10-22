import path from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { recordBrowserScript, type RecordStep } from '../browser-record'
import { addVideoToGallery } from '../video/video-gallery'
import type { ToolContext } from './context'

/**
 * `browser_record` — grava um ROTEIRO no browser oculto e entrega um MP4.
 *
 * Diferente de `run_browser_script` (JS livre, feito para fotos), aqui o script
 * são passos declarativos e a saída é vídeo. O valor é o timing: o roteiro roda
 * na velocidade das ações, não na do agente pensando entre elas — por isso o
 * vídeo tem a duração do fluxo, e não a duração da conversa.
 *
 * Só existe quando o browser está permitido no turno (mesma porta do
 * run_browser_script) e, por escolha de produto, só deve ser chamada quando o
 * USUÁRIO pede uma gravação — nunca por iniciativa do agente para "olhar" uma
 * página (para isso existem panel_* e capture_batch).
 */

const STEPS_DOC = `Steps run in order; each one is visible in the video:
- { "do": "goto", "url": "https://..." } — navigate and wait for load
- { "do": "click", "selector" | "text" | "x"/"y", "waitMs" } — move the cursor, click, wait
- { "do": "type", "selector" | "text" | "x"/"y", "value", "clear", "submit", "typeDelayMs" } — click the field, then type character by character
- { "do": "hover", "selector" | "text" | "x"/"y" }
- { "do": "scroll", "dy" | "to": "top"|"bottom" | "selector" } — smooth scroll
- { "do": "wait", "ms" } — hold the frame
- { "do": "waitFor", "selector", "timeoutMs" } — wait for an element (does not add a visible action)
- { "do": "press", "key": "Enter"|"Tab"|"Escape" }
- { "do": "move", "x", "y" } — move the cursor only

Targeting: prefer "selector" (CSS), then "text" (visible label/aria-label/placeholder). "x"/"y" are CSS pixels of the viewport and are the last resort. The cursor is drawn at exactly the point that gets clicked, so it always lands on the target.

Pacing: the video is as long as the actions take. Give each state a moment to be read — a click to a new screen usually wants 600-1200ms of "wait" before the next step.`;

export function createBrowserRecordTools(ctx: ToolContext): ToolSet {
  return {
    browser_record: tool({
      description:
        'Records a SCRIPTED screencast of a web page into an MP4 and shows it in your reply. Use it ONLY when the user explicitly asks for a recording, a demo video or a walkthrough of a page/app — never on your own initiative, and never as a way to inspect a page (that is panel_* / run_browser_script).\n\n' +
        'Runs in the hidden browser (same cookies/logins as the panel), so no screen-recording permission is needed and no window pops up. Every step executes immediately in sequence, so a 30-second demo takes ~30 seconds to record — not the minutes it would take to film the agent thinking between tool calls.\n\n' +
        `- url: the page to open BEFORE recording starts (the video opens on it, already loaded)\n- steps: the script, in order\n- viewport: { width, height } (default 1280×800)\n- width: final video width in px (default: captured size)\n- quality: auto | low | medium | high | max (default auto — 60 fps/high on a strong machine, 30 fps/low on a weak one; an explicit level always wins)\n- name: title in the gallery\n\n${STEPS_DOC}`,
      inputSchema: z.object({
        url: z.string().optional().describe('Page opened before the recording starts (no white screen at the beginning)'),
        steps: z
          .array(
            z.discriminatedUnion('do', [
              z.object({
                do: z.literal('goto'),
                url: z.string(),
                waitMs: z.number().int().min(0).max(30_000).optional(),
              }),
              z.object({
                do: z.literal('click'),
                selector: z.string().optional().describe('CSS selector'),
                text: z.string().optional().describe('Visible label, aria-label or placeholder'),
                x: z.number().optional().describe('CSS px'),
                y: z.number().optional().describe('CSS px'),
                waitMs: z.number().int().min(0).max(30_000).optional().describe('Pause after the click before the next step'),
              }),
              z.object({
                do: z.literal('type'),
                selector: z.string().optional(),
                text: z.string().optional(),
                x: z.number().optional(),
                y: z.number().optional(),
                value: z.string(),
                clear: z.boolean().optional().describe('Select-all before typing (replaces the current content)'),
                submit: z.boolean().optional().describe('Press Enter after typing'),
                typeDelayMs: z
                  .number()
                  .int()
                  .min(0)
                  .max(120)
                  .optional()
                  .describe('Delay between characters (default 40ms — this is what makes typing visible)'),
                waitMs: z.number().int().min(0).max(30_000).optional(),
              }),
              z.object({
                do: z.literal('hover'),
                selector: z.string().optional(),
                text: z.string().optional(),
                x: z.number().optional(),
                y: z.number().optional(),
              }),
              z.object({
                do: z.literal('scroll'),
                dy: z.number().optional().describe('Pixels to scroll (default 600)'),
                to: z.enum(['top', 'bottom']).optional(),
                selector: z.string().optional().describe('Scroll this element into view instead'),
              }),
              z.object({ do: z.literal('wait'), ms: z.number().int().min(0).max(60_000) }),
              z.object({
                do: z.literal('waitFor'),
                selector: z.string(),
                timeoutMs: z.number().int().min(100).max(30_000).optional(),
              }),
              z.object({ do: z.literal('press'), key: z.string().describe('Enter, Tab, Escape…') }),
              z.object({ do: z.literal('move'), x: z.number(), y: z.number() }),
            ]),
          )
          .min(1)
          .max(60)
          .describe('The screenplay: actions in order, each one recorded'),
        viewport: z
          .object({ width: z.number().int().min(320).max(2560), height: z.number().int().min(240).max(1600) })
          .optional()
          .describe('Default 1280×800 — use 390×844 for a phone-shaped recording'),
        width: z.number().int().min(320).max(2560).optional().describe('Final video width (default: captured)'),
        quality: z
          .enum(['auto', 'low', 'medium', 'high', 'max'])
          .optional()
          .describe(
            'Recording profile. "auto" (default) follows this machine — a strong one records at 60 fps in high quality, a weak one drops to 30 fps/low so the take does not stutter. An explicit level ALWAYS wins: even on a weak machine, "high"/"max" is recorded as asked (the result reports the fps the machine actually delivered).',
          ),
        fps: z
          .number()
          .int()
          .min(10)
          .max(60)
          .optional()
          .describe('Overrides the profile fps (default: from quality, 60 on high/max)'),
        cursor: z.boolean().optional().describe('Draw the cursor overlay (default true)'),
        tailMs: z.number().int().min(0).max(5000).optional().describe('Hold on the last frame (default 500ms)'),
        name: z.string().max(60).optional().describe('Title in the gallery'),
      }),
      execute: async (input, options) => {
        const result = await recordBrowserScript({
          sessionId: ctx.sessionId,
          url: input.url,
          steps: input.steps as RecordStep[],
          viewport: input.viewport,
          width: input.width,
          quality: input.quality,
          fps: input.fps,
          cursor: input.cursor,
          tailMs: input.tailMs,
          name: input.name,
          signal: options?.abortSignal ?? ctx.abort,
        })

        const { entry } = await addVideoToGallery({
          file: result.file,
          name: input.name ?? path.basename(result.file, path.extname(result.file)),
          sessionId: ctx.sessionId,
          source: 'script',
        })

        const lines = [
          `Recording ready: ${Math.round(result.durationMs / 100) / 10}s, ${result.frames} frames, ${result.engine} · ${result.fps} fps, ${result.steps} step(s).`,
          `Quality: ${result.quality} · ${result.fps} fps · crf ${result.crf} (machine: ${result.tier}).`,
          `Gallery: ${entry.id}`,
        ]
        // Pedir acima do que a máquina aguenta é permitido — mas o agente precisa
        // saber, para não prometer um take perfeito. O sinal é o TIER, não o
        // `capturedFps`: uma página parada também emite poucos quadros, e usar
        // esse número aqui acusaria falta de máquina onde só faltou movimento.
        if ((result.quality === 'high' || result.quality === 'max') && result.tier === 'weak') {
          lines.push(
            'Note: this machine scored "weak" — the take was recorded at the requested quality, but the encoder may have repeated frames to hold the fps. Lower "quality" (or "fps") if smooth motion matters more than sharpness.',
          )
        }
        if (result.logs.length > 0) lines.push('', ...result.logs)
        return {
          message: lines.join('\n'),
          videoUrl: entry.videoUrl,
          title: entry.name ?? input.name ?? 'recording',
          durationMs: entry.durationMs,
          path: entry.path,
        }
      },
    }),
  }
}
