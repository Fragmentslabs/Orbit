import { tool } from 'ai'
import { z } from 'zod'
import { saveArtifact, updateArtifact } from '../media'

/**
 * Artefatos HTML: o agente entrega uma página renderizável DENTRO da resposta
 * — dashboard, protótipo de tela, diagrama, relatório, simulador — em vez de
 * despejar um bloco de código que o usuário teria que salvar e abrir sozinho.
 *
 * O arquivo vai para orbit-data/artifacts e entra no mesmo registry das
 * imagens, então o artefato aparece na galeria de mídia e sobrevive ao chat.
 * A tool devolve só o id/URL: o HTML nunca entra no contexto de volta nem na
 * mensagem persistida.
 *
 * Disponível nos DOIS modos. No modo chat isso importa mais do que no código:
 * lá o agente não tem `write` nem `bash`, então o artefato é a única forma de
 * ele produzir algo visual — por isso o HTML chega pelo próprio input da tool.
 */

/** Teto do markup — acima disso é despejo de dados, não artefato. */
const MAX_HTML_BYTES = 2 * 1024 * 1024

function looksLikeDocument(html: string): boolean {
  const head = html.trimStart().slice(0, 200).toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html')
}

/**
 * Fragmento vira documento. O modelo às vezes manda só o corpo; sem
 * `<meta charset>` acentuação quebra e sem `color-scheme` a página pinta
 * branca por padrão.
 */
function ensureDocument(html: string, title: string): string {
  if (looksLikeDocument(html)) return html
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title.replace(/[<>&]/g, '')}</title>
<style>:root { color-scheme: light dark } body { margin: 0; font: 14px/1.5 system-ui, sans-serif }</style>
</head>
<body>
${html}
</body>
</html>`
}

const DESCRIPTION =
  'Creates an HTML artifact that renders INSIDE your response, visible and interactive for the user in the chat — and saved to the media gallery. Use it whenever the answer is better seen than described: dashboards, charts, screen prototypes, diagrams, interactive simulations, formatted reports, comparison tables. Send a complete, self-contained HTML document (inline CSS/JS; external scripts must come from a CDN). Do NOT use it for source code the user asked to have written into a project file — that is write/edit. After calling it, do not repeat the content in text: the user is already looking at it.'

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
          return `HTML muito grande (limite de ${Math.round(MAX_HTML_BYTES / 1024)}KB). Reduza os dados embutidos ou carregue-os sob demanda.`
        }
        const ref = await saveArtifact(ensureDocument(html, title), { title, sessionId })
        return {
          artifactId: ref.id,
          url: ref.url,
          title: ref.title,
          thumb: ref.thumb,
          revision: ref.revision,
          message:
            'Artefato anexado à resposta — o usuário já o vê renderizado no chat e ele está salvo na galeria. Para alterá-lo depois, use update_artifact com este artifactId.',
        }
      },
    }),
    update_artifact: tool({
      description:
        'Rewrites an artifact you already created in this conversation, keeping its place in the chat and its entry in the gallery. Pass the FULL new HTML (it replaces the file, there is no patching). Use this when the user asks for changes to something you rendered instead of creating a second artifact.',
      inputSchema: z.object({
        artifactId: z.string().describe('The artifactId returned by create_artifact (art_....html)'),
        html: z.string().min(1).describe('The complete new HTML document'),
        title: z.string().max(120).optional().describe('New title, if it changed'),
      }),
      execute: async ({ artifactId, html, title }) => {
        if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
          return `HTML muito grande (limite de ${Math.round(MAX_HTML_BYTES / 1024)}KB).`
        }
        const ref = await updateArtifact(artifactId, ensureDocument(html, title ?? artifactId), title)
        if (!ref) return `Artefato não encontrado: ${artifactId}. Crie um novo com create_artifact.`
        return {
          artifactId: ref.id,
          url: ref.url,
          title: ref.title,
          thumb: ref.thumb,
          revision: ref.revision,
          message: 'Artefato atualizado — o usuário já vê a nova versão no chat.',
        }
      },
    }),
  }
}
