import { tool, type ToolSet } from 'ai'
import sharp from 'sharp'
import { z } from 'zod'
import { downloadImage } from '../image-search/download'
import { recallResult, rememberResults } from '../image-search/cache'
import { buildContactSheet } from '../image-search/sheet'
import { MAX_RESULTS, searchImages } from '../image-search/search'
import type { ImageProvider, ImageResult } from '../image-search/types'
import { getMediaEntry, mediaIdFromUrl, saveMedia } from '../media'

/**
 * Buscar e importar imagens de fontes abertas (Wikimedia Commons e Openverse).
 *
 * O agente PESQUISA, olha uma folha de miniaturas e importa as que escolheu; cada
 * uma entra como imagem do app (`img_…`) levando autor e licença. Daí em diante é
 * o fluxo de qualquer anexo: motion_asset a leva para uma peça. O crédito é parte
 * do que ele recebe de volta, porque a licença costuma exigir que apareça.
 *
 * Só imagem raster, só de acervos que informam a licença. Nada aqui lê ou baixa
 * de uma página qualquer da web — para isso existe o webfetch.
 */

const sheetStash = new Map<string, string>()
const MAX_IMPORT = 8

function describe(result: ImageResult, n: number): string {
  const size = result.width && result.height ? `${result.width}x${result.height}` : 'size unknown'
  const by = result.credit.creator ? `, by ${result.credit.creator}` : ''
  const from = result.origin ? ` via ${result.origin}` : ''
  return `${n}. ${result.id} — "${result.title}"${by} · ${result.credit.license} · ${size} · ${result.provider === 'commons' ? 'Wikimedia Commons' : 'Openverse'}${from}`
}

export function createImageSearchTools(scope: { sessionId: string; modelVision: boolean }): ToolSet {
  return {
    image_search: tool({
      description:
        'Searches openly licensed images on Wikimedia Commons and Openverse (no key needed) and returns candidates with their license and author, plus — when you can see images — a numbered sheet of thumbnails so you CHOOSE by looking, not by the title. ' +
        'Use it when a video, a page or a document needs a photo you do not have: animals, places, objects, history, nature. Search in English for the best coverage and try a second, more specific query before settling for a poor match. ' +
        'Results are not in your context as files: call image_import with the ids you chose. license: "commercial" (default — safe for a published video), "public-domain" (no credit needed) or "any". ' +
        'The license usually REQUIRES a credit to be shown with the image; image_import hands you the exact line.',
      inputSchema: z.object({
        query: z.string().min(2).describe('What to look for, e.g. "African lion male savanna"'),
        count: z.number().int().min(1).max(MAX_RESULTS).optional().describe('How many candidates (default 8)'),
        license: z.enum(['commercial', 'public-domain', 'any']).optional(),
        orientation: z.enum(['landscape', 'portrait', 'square']).optional().describe('landscape for 16:9 video, portrait for 9:16'),
        provider: z.enum(['all', 'commons', 'openverse']).optional(),
        minWidth: z.number().int().min(200).max(6000).optional().describe('Minimum width in px (default 1000; a 1080p frame wants 1920)'),
      }),
      execute: async ({ query, count = 8, license = 'commercial', orientation, provider = 'all', minWidth = 1000 }, { toolCallId }) => {
        const providers: ImageProvider[] = provider === 'all' ? ['commons', 'openverse'] : [provider]
        const { results, warnings } = await searchImages({ query, limit: count, license, providers, orientation, minWidth })
        rememberResults(results)
        if (results.length === 0) {
          return [
            `No images found for "${query}" with license=${license}, minWidth=${minWidth}${orientation ? `, ${orientation}` : ''}.`,
            ...warnings.map((w) => `Warning: ${w}`),
            'Try other words (English, more specific or more general), lower minWidth, or license "any" if a credit line is acceptable.',
          ].join('\n')
        }
        if (scope.modelVision) {
          const sheet = await buildContactSheet(results)
          if (sheet) sheetStash.set(toolCallId, sheet.toString('base64'))
        }
        return [
          `${results.length} candidate(s) for "${query}" (license: ${license}):`,
          ...results.map((r, i) => describe(r, i + 1)),
          ...warnings.map((w) => `Warning: ${w}`),
          scope.modelVision
            ? 'The sheet shows them in this order. Pick the ones that actually show what you need, then call image_import with their ids.'
            : 'You cannot see the thumbnails: choose from the titles and say so to the user if the match is uncertain. Then call image_import with the ids.',
        ].join('\n')
      },
      toModelOutput: ({ toolCallId, output }) => {
        const sheet = sheetStash.get(toolCallId)
        sheetStash.delete(toolCallId)
        if (!sheet) return { type: 'text', value: String(output) }
        return {
          type: 'content',
          value: [
            { type: 'text', text: String(output) },
            { type: 'image-data', data: sheet, mediaType: 'image/webp' },
          ],
        }
      },
    }),

    image_import: tool({
      description:
        'Brings images found by image_search into the app so they can be used: each one becomes an image with a ref (img_…) that motion_asset / the Media tab understand, and keeps its author and license. ' +
        'Import only what you will use. The result gives the CREDIT LINE for each image — the license usually requires it to be shown with the image, so put it in the piece (a caption, or a credits card at the end of the video) and mention it to the user.',
      inputSchema: z.object({
        ids: z.array(z.string()).min(1).max(MAX_IMPORT).describe('Ids from image_search (wc:… / ov:…)'),
      }),
      execute: async ({ ids }) => {
        const lines: string[] = []
        const imported: Array<{ mediaUrl: string; alt: string }> = []
        for (const id of ids) {
          const result = recallResult(id)
          if (!result) {
            lines.push(`${id}: not in the last search results (they expire) — run image_search again.`)
            continue
          }
          try {
            const { buffer, ext } = await downloadImage(result)
            // Confere que decodifica de verdade (e o que o servidor chamou de imagem é imagem).
            const meta = await sharp(buffer).metadata()
            if (!meta.width || !meta.height) throw new Error('the file is not a readable image')
            const url = await saveMedia(buffer, ext, {
              source: 'chat',
              sessionId: scope.sessionId,
              name: result.title,
              credit: result.credit,
            })
            const ref = mediaIdFromUrl(url) ?? url
            imported.push({ mediaUrl: url, alt: result.title })
            lines.push(`${id} → ref ${ref} · ${meta.width}x${meta.height} · ${result.credit.license}\nCredit: ${result.credit.attribution}`)
          } catch (err) {
            lines.push(`${id}: could not be imported — ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        lines.push(
          imported.length > 0
            ? 'The imported images already appear in your reply — do NOT embed them again with markdown ![](…) (the chat blocks those). Say which is which by the numbers/titles above. Use a ref with motion_asset to put one in a composition, and keep the credit lines: show them in the piece.'
            : 'Nothing was imported.',
        )
        return { message: lines.join('\n'), images: imported }
      },
      // O modelo lê o relatório; as imagens vão para a resposta pelo chat-engine.
      toModelOutput: ({ output }) => ({ type: 'text', value: typeof output === 'string' ? output : (output as { message: string }).message }),
    }),
  }
}

/**
 * Mostra ao usuário, NA RESPOSTA, uma imagem que já está no app (a que o
 * image_import trouxe, a que ele anexou). O modo chat não tinha como fazer isso:
 * o show_image completo vive no modo código, junto com o navegador do painel. Sem
 * ele o agente escrevia markdown de imagem — que o chat bloqueia — e o usuário via
 * "[Image blocked]" no lugar da foto.
 */
export function createGalleryShowImageTool(): ToolSet {
  return {
    show_image: tool({
      description:
        'Includes an image that is already in the app IN YOUR RESPONSE, visible to the user. media: its reference (the img_… ref or orbit-media:// URL from image_import / image_list). ' +
        'This is the ONLY way to show an image in the chat — markdown ![](url) images are blocked, for web URLs and for orbit-media:// alike. Images from image_import and image_edit appear on their own; use this one to show an earlier image again.',
      inputSchema: z.object({
        media: z.string().describe('img_… reference or orbit-media:// URL'),
        alt: z.string().optional().describe('Short caption shown under the image'),
      }),
      execute: async ({ media, alt }) => {
        const id = mediaIdFromUrl(media.trim())
        if (!id) return `Invalid media reference: ${media}`
        if (!(await getMediaEntry(id))) return `Image not found in the app: ${media}`
        return { mediaUrl: `orbit-media://${id}`, alt: alt ?? '', message: 'Image attached to the reply — the user already sees it in the chat.' }
      },
    }),
  }
}
