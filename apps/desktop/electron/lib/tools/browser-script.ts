import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { runBrowserScript, type CaptureItem } from '../browser-script'
import { resolveSafePath, type ToolContext } from './context'

/**
 * Automação de browser em lote (engine oculta — ver browser-script.ts).
 *
 * - `run_browser_script`: o agente escreve JS com a API `orbit` e recebe de
 *   volta o manifesto das imagens. As fotos NÃO entram no contexto do modelo:
 *   ficam em orbit-data/media e o retorno traz só nome, URL e dimensões.
 * - `capture_batch`: açúcar para o caso comum (uma lista de URLs → uma foto de
 *   cada), gerado como script trivial e executado na mesma engine.
 *
 * Nenhuma das duas escreve no repositório do usuário: o script vai para
 * orbit-data/scripts/<taskId>/ e a pasta é apagada ao terminar (keep preserva).
 */

const API_DOC = `Available inside the script (global \`orbit\`, all async — use await):
- await orbit.goto(url, { viewport: { width, height } })
- await orbit.capture(name, { fullPage, format: 'webp'|'png'|'jpeg', maxWidth })
- await orbit.evaluate(fn | 'js source')  → runs in the page, returns JSON
- await orbit.waitFor(selector, { timeout })
- await orbit.resize(width, height)
- await orbit.wait(ms)
- await orbit.manifest()  → captures so far
- await orbit.console({ level: 'all'|'warning'|'error', pattern, limit })  → the PAGE's console messages ({ at, level, message, source }); page errors also come back in the result automatically
- await orbit.hover(target)  → real mouse move over the target
- await orbit.drag(from, to, { steps, release })  → real mouse drag; release: false keeps the button pressed so you can orbit.capture() mid-drag, then orbit.drag(null, to2) to continue/drop or orbit.mouseUp()
  (target = CSS selector string or { x, y } in viewport px)
- await orbit.fetch(url, { method, headers, body, as: 'text'|'json' })  → HTTP GET/POST with the browser session's cookies (robots.txt, sitemap, JS bundles, APIs) → { status, url, headers, body } (body capped at 200k chars)
- await orbit.save(name, data, { format: 'text'|'json'|'base64' })  → writes an artifact under outDir (relative name, e.g. 'pages/home.json') → { path, name, bytes }; objects are saved as JSON
- console.log(...)  → comes back in the result`

function describeCaptures(captures: CaptureItem[]): string {
  if (captures.length === 0) return 'No images captured.'
  return captures
    .map((c) => `- ${c.name}: ${c.mediaUrl} (${c.width}×${c.height}, ${Math.round(c.size / 1024)}KB)`)
    .join('\n')
}

function describeArtifacts(result: Awaited<ReturnType<typeof runBrowserScript>>): string {
  if (result.artifacts.length === 0) return ''
  const lines = [
    '',
    `## Artifacts (${result.artifacts.length}) — saved in ${result.artifactsDir}`,
    ...result.artifacts
      .slice(0, 50)
      .map((a) => `- ${a.name} (${Math.round(a.bytes / 1024)}KB)`),
  ]
  if (result.artifacts.length > 50) {
    lines.push(`- … and ${result.artifacts.length - 50} more`)
  }
  return lines.join('\n')
}

function formatResult(
  result: Awaited<ReturnType<typeof runBrowserScript>>,
  header: string,
): string {
  const lines = [header, describeCaptures(result.captures)]
  if (result.logs.length > 0) {
    lines.push('', '## Console', result.logs.slice(0, 50).join('\n'))
  }
  if (result.returned !== undefined) {
    lines.push('', `## Retorno\n${JSON.stringify(result.returned, null, 2).slice(0, 2000)}`)
  }
  if (result.error) {
    lines.push('', `## Error\n${result.error}`)
  }
  if (result.captures.length > 0) {
    lines.push(
      '',
      'The images were saved (they are not in your context). To show one to the user: show_image({ media: "<mediaUrl>" }).',
    )
  }
  const artifacts = describeArtifacts(result)
  if (artifacts) lines.push(artifacts)
  return lines.join('\n')
}

export function createBrowserScriptTools(ctx: ToolContext): ToolSet {
  return {
    run_browser_script: tool({
      description: `Runs a JavaScript automation script in a hidden browser (shares the panel browser's cookies/logins) and takes screenshots in bulk — dozens of shots in a single call, without images entering your context. Use it for repetitive work: many URLs, theme/color variations, several viewports, loops with conditions, crawling a site.\n\nThe loop runs inside the browser engine, not in the model: one call can visit dozens of pages. Use orbit.save() to write the results as files (HTML, JSON, assets) and orbit.fetch() for cheap requests (robots.txt, sitemap, JS bundles, APIs) that reuse the session cookies.\n\n${API_DOC}`,
      inputSchema: z.object({
        script: z
          .string()
          .describe('Script body (async, top-level await allowed). Use the global `orbit` API.'),
        taskId: z
          .string()
          .optional()
          .describe('Short task name (letters, digits, - and _) — groups the captures'),
        timeoutMs: z.number().int().min(5_000).max(600_000).optional().describe('Limit (default 120s)'),
        keep: z.boolean().optional().describe('Keeps the script folder after running (debugging)'),
        outDir: z
          .string()
          .optional()
          .describe(
            'Folder inside the working folder where orbit.save() writes its artifacts (e.g. ".orbit/recon/site"). Without it, artifacts go to a temporary task folder.',
          ),
      }),
      execute: async ({ script, taskId, timeoutMs, keep, outDir }) => {
        const result = await runBrowserScript({
          script,
          sessionId: ctx.sessionId,
          taskId,
          timeoutMs,
          keep,
          source: 'script',
          // resolveSafePath mantém a saída dentro da pasta de trabalho.
          outDir: outDir ? resolveSafePath(ctx, outDir) : undefined,
        })
        const header = result.timedOut
          ? `Script "${result.taskId}" stopped by timeout — captures up to that point:`
          : `Script "${result.taskId}" finished — ${result.captures.length} image(s):`
        return formatResult(result, header)
      },
    }),

    capture_batch: tool({
      description:
        'Takes a batch of screenshots in one call: a list of URLs (each with an optional viewport/fullPage) captured in a hidden browser. Shortcut for the common case — for loops, conditions, or interaction with the page, use run_browser_script. The images do NOT enter your context; the result is a manifest.',
      inputSchema: z.object({
        steps: z
          .array(
            z.object({
              url: z.string().describe('Full URL (http/https)'),
              name: z.string().optional().describe('Name for the image (default: step-N)'),
              fullPage: z.boolean().optional().describe('Captures the whole page, not just the viewport'),
              format: z.enum(['webp', 'png', 'jpeg']).optional().describe('Default webp'),
              viewport: z
                .object({ width: z.number().int().min(280).max(3840), height: z.number().int().min(400).max(2160) })
                .optional(),
            }),
          )
          .min(1)
          .max(50),
        taskId: z.string().optional().describe('Short task name — groups the captures'),
      }),
      execute: async ({ steps, taskId }) => {
        // Gera o script trivial e roda na MESMA engine do run_browser_script:
        // uma chamada de tool, laço local (sem ida e volta ao modelo por foto).
        const script = `const steps = ${JSON.stringify(steps)}
for (let i = 0; i < steps.length; i++) {
  const step = steps[i]
  await orbit.goto(step.url, step.viewport ? { viewport: step.viewport } : {})
  await orbit.capture(step.name || ('step-' + (i + 1)), { fullPage: !!step.fullPage, format: step.format || 'webp' })
}`
        const result = await runBrowserScript({
          script,
          sessionId: ctx.sessionId,
          taskId,
          source: 'batch',
        })
        const header = result.timedOut
          ? `Batch "${result.taskId}" stopped by timeout — captures up to that point:`
          : `Batch "${result.taskId}": ${result.captures.length}/${steps.length} image(s) captured:`
        return formatResult(result, header)
      },
    }),
  }
}
