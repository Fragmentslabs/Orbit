import { tool } from 'ai'
import fsp from 'node:fs/promises'
import { z } from 'zod'
import { mediaKind } from '@shared/media'
import { getMediaEntry, mutateArtifact, saveArtifact, updateArtifact } from '../media'
import { applyTextEdits } from './piece-common'

/**
 * HTML artifacts: the agent delivers a renderable page INSIDE the response
 * — dashboard, screen prototype, diagram, report, simulator — instead of
 * dumping a code block the user would have to save and open themselves.
 *
 * The file goes to orbit-data/artifacts and enters the same registry as the
 * images, so the artifact shows up in the media gallery and survives the chat.
 * The tool returns only the id/URL: the HTML never comes back into the context nor into the
 * persisted message.
 *
 * Available in BOTH modes. In chat mode this matters more than in code:
 * there the agent has no `write` nor `bash`, so the artifact is the only way for
 * it to produce something visual — that is why the HTML arrives through the tool's own input.
 */

/** Markup cap — above that it is a data dump, not an artifact. */
const MAX_HTML_BYTES = 2 * 1024 * 1024

function looksLikeDocument(html: string): boolean {
  const head = html.trimStart().slice(0, 200).toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html')
}

/**
 * A fragment becomes a document. The model sometimes sends only the body; without
 * `<meta charset>` accented characters break and without `color-scheme` the page paints
 * white by default.
 */
function ensureDocument(html: string, title: string): string {
  if (looksLikeDocument(html)) return html
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title.replace(/[<>&]/g, '')}</title>
<style>:root { color-scheme: light dark } body { margin: 0; font-size: 14px; line-height: 1.5 }</style>
</head>
<body>
${html}
</body>
</html>`
}

const DESCRIPTION =
  'Creates an HTML artifact that renders INSIDE your response, visible and interactive for the user in the chat — and saved to the media gallery. Use it whenever the answer is better seen than described: dashboards, charts, screen prototypes, diagrams, interactive simulations, formatted reports, comparison tables. Send a complete, self-contained HTML document (inline CSS/JS; external scripts must come from a CDN). The page already carries the Orbit design-system CSS variables (--background, --card, --primary, --border, --radius…): style with them unless the user asked for another look. Do NOT use it for source code the user asked to have written into a project file — that is write/edit. After calling it, do not repeat the content in text: the user is already looking at it. Fonts: for a specific typeface, run font_use and paste the @font-face block it returns - the orbit-font:// URL resolves inside the artifact.'

export function createArtifactTools(sessionId: string) {
  return {
    create_artifact: tool({
      description: DESCRIPTION,
      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .max(120)
          .describe('Short title shown in the card header and in the gallery'),
        html: z
          .string()
          .min(1)
          .describe('Complete, self-contained HTML document (inline styles and scripts)'),
      }),
      execute: async ({ title, html }) => {
        if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
          return `HTML too large (limit ${Math.round(MAX_HTML_BYTES / 1024)}KB). Reduce the embedded data or load it on demand.`
        }
        const ref = await saveArtifact(ensureDocument(html, title), { title, sessionId })
        return {
          artifactId: ref.id,
          url: ref.url,
          title: ref.title,
          thumb: ref.thumb,
          revision: ref.revision,
          message:
            'Artifact attached to the reply — the user already sees it rendered in the chat and it is saved in the gallery. To change it later, use update_artifact with this artifactId.',
        }
      },
    }),
    update_artifact: tool({
      description:
        'Rewrites an artifact — any artifact of this or another conversation whose artifactId you were given. Keeps its place in the chat and its entry in the gallery. Pass the FULL new HTML (it replaces the file, there is no patching). Use this when the user asks for changes to something you rendered instead of creating a second artifact; read_artifact first if you need the current HTML.',
      inputSchema: z.object({
        artifactId: z.string().describe('The artifactId returned by create_artifact (art_....html)'),
        html: z.string().min(1).describe('The complete new HTML document'),
        title: z.string().max(120).optional().describe('New title, if it changed'),
      }),
      execute: async ({ artifactId, html, title }) => {
        if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
          return `HTML too large (limit ${Math.round(MAX_HTML_BYTES / 1024)}KB).`
        }
        const ref = await updateArtifact(artifactId, ensureDocument(html, title ?? artifactId), title)
        if (!ref) return `Artifact not found: ${artifactId}. Create a new one with create_artifact.`
        return {
          artifactId: ref.id,
          url: ref.url,
          title: ref.title,
          thumb: ref.thumb,
          revision: ref.revision,
          message: 'Artifact updated — the user already sees the new version in the chat.',
        }
      },
    }),
    edit_artifact: tool({
      description:
        'Edits an artifact with EXACT text replacements, applied in order (oldText must exist and be unique unless replaceAll) — like the edit tool. Prefer this over update_artifact for small changes: it does not resend the whole document. If another conversation changed the artifact since you read it, your oldText will not match and the edit fails — then read_artifact and retry with the current text.',
      inputSchema: z.object({
        artifactId: z.string().describe('The artifactId (art_....html) from an attachment note or a previous create_artifact'),
        edits: z
          .array(
            z.object({
              oldText: z.string().describe('Exact current text (copy it, including indentation)'),
              newText: z.string(),
              replaceAll: z.boolean().optional(),
            }),
          )
          .min(1),
        title: z.string().max(120).optional().describe('New title, if it changed'),
      }),
      execute: async ({ artifactId, edits, title }) => {
        const ref = await mutateArtifact(
          artifactId,
          (html) => {
            const next = applyTextEdits(html, edits)
            if (Buffer.byteLength(next, 'utf8') > MAX_HTML_BYTES) {
              throw new Error(`HTML too large (limit ${Math.round(MAX_HTML_BYTES / 1024)}KB).`)
            }
            return next
          },
          title,
        )
        if (!ref) return `Artifact not found: ${artifactId}. Create a new one with create_artifact.`
        return {
          artifactId: ref.id,
          url: ref.url,
          title: ref.title,
          thumb: ref.thumb,
          revision: ref.revision,
          message: `Artifact updated with ${edits.length} edit${edits.length === 1 ? '' : 's'} — the user already sees the new version in the chat.`,
        }
      },
    }),
    read_artifact: tool({
      description:
        'Returns the current HTML of an artifact by artifactId (from any conversation). Use it before update_artifact when you need the exact current content — the user may have asked for changes since you wrote it.',
      inputSchema: z.object({
        artifactId: z.string().describe('The artifactId (art_....html) from an attachment note or a previous create_artifact'),
      }),
      execute: async ({ artifactId }) => {
        const entry = await getMediaEntry(artifactId)
        if (!entry || mediaKind(entry) !== 'artifact') return `Artifact not found: ${artifactId}`
        try {
          return await fsp.readFile(entry.path, 'utf8')
        } catch {
          return `Artifact file is missing on disk: ${artifactId}`
        }
      },
    }),
  }
}
