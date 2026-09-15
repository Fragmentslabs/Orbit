import { tool } from 'ai'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { editImage, imageInfo, type ImageEdit } from '../image-ops'
import { getMediaEntry, listMedia, mediaIdFromUrl, readMedia, saveMedia } from '../media'
import { resolveSafePath, type ToolContext } from './context'
import type { DocumentToolScope } from './document'

/**
 * Edição de imagem sem modelo de geração.
 *
 * Redimensionar, recortar, comprimir, ajustar tom e tirar o fundo são trabalho
 * de pixel, não de invenção — e tratá-los como geração custaria caro, demoraria
 * e devolveria uma imagem PARECIDA em vez da mesma. Aqui a foto que entra é a
 * que sai, só que do tamanho e do jeito pedidos.
 *
 * A saída é sempre um arquivo NOVO na galeria, pela mesma regra do pdf_ops e
 * do docx_edit: o usuário anexou uma imagem, não autorizou sobrescrevê-la.
 * Gravar na pasta de trabalho só com `savePath`, e só quando ele pedir.
 */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'tiff', 'heic'])

export function createImageTools(scope: DocumentToolScope, ctx: ToolContext | null) {
  /**
   * Resolve a imagem por galeria ou por caminho na pasta de trabalho.
   *
   * A da galeria cobre o que o usuário anexou (todo anexo de imagem é
   * registrado lá) e o que o próprio agente produziu antes — inclusive a saída
   * desta tool, que é como se encadeiam duas edições.
   */
  const load = async (ref: string): Promise<{ bytes: Buffer; name: string } | string> => {
    const mediaId = mediaIdFromUrl(ref)
    if (mediaId) {
      const entry = await getMediaEntry(mediaId)
      if (entry) {
        const file = await readMedia(mediaId)
        if (!file) return `A imagem ${ref} está no registro mas o arquivo sumiu do disco.`
        return { bytes: file.buffer, name: entry.name || mediaId }
      }
      if (ref.startsWith('orbit-media://')) return `Imagem não encontrada na galeria: ${ref}`
    }
    if (!ctx) {
      return `Imagem não encontrada: ${ref}. No chat a referência é a URL orbit-media:// de uma imagem da galeria.`
    }
    const ext = path.extname(ref).slice(1).toLowerCase()
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return `Não parece uma imagem: ${ref} (aceita ${[...IMAGE_EXTENSIONS].join(', ')}).`
    }
    try {
      return { bytes: await fsp.readFile(resolveSafePath(ctx, ref)), name: path.basename(ref) }
    } catch (err) {
      return `Não foi possível abrir ${ref}: ${(err as Error).message}`
    }
  }

  const bytesLabel = (bytes: number) =>
    bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`

  return {
    image_list: tool({
      description:
        'Lists the images of this conversation with their orbit-media:// references, newest first — what the user attached and what was produced here. This is how you get the reference for an image the user sent: seeing an image in the conversation does NOT give you its reference, and image_info/image_edit need one. An attached photo is in this list even when you can already see it.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).optional().describe('How many to list (default 10)'),
      }),
      execute: async ({ limit }) => {
        const entries = await listMedia({ sessionId: scope.sessionId, kind: 'image' })
        if (entries.length === 0) {
          return 'Nenhuma imagem nesta conversa ainda. O usuário precisa anexar uma, ou ela precisa ser produzida aqui.'
        }
        const recent = entries
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit ?? 10)
          .map((entry) => {
            const size = entry.width && entry.height ? `${entry.width}x${entry.height}, ` : ''
            const origin = entry.source === 'user' ? 'anexada pelo usuário' : 'produzida aqui'
            return `orbit-media://${entry.id} — ${entry.name || 'sem nome'} (${size}${bytesLabel(
              entry.size,
            )}, ${origin})`
          })
        return `${recent.length} imagem(ns):\n${recent.join('\n')}`
      },
    }),

    image_info: tool({
      description:
        'Reads an image WITHOUT editing it: format, dimensions, file size, whether it has transparency, and the dominant colour. Call it before image_edit when the numbers matter — to crop you need the real dimensions. Do NOT feed the dominant colour into removeBackground: it is a binned approximation, and that tool reads the real background off the image border itself. ref: an orbit-media:// URL (attachments and generated images are all in the gallery) or, in code mode, a path in the working folder.',
      inputSchema: z.object({
        ref: z.string().describe('orbit-media:// URL, or a path in the working folder'),
      }),
      execute: async ({ ref }) => {
        const src = await load(ref)
        if (typeof src === 'string') return src
        try {
          const info = await imageInfo(src.bytes)
          return `${src.name}: ${info.format} ${info.width}x${info.height}, ${bytesLabel(
            info.sizeBytes,
          )}, ${info.hasAlpha ? 'com transparência' : 'sem transparência'}, cor predominante ${
            info.dominant
          } (aproximada).`
        } catch (err) {
          return `Não foi possível ler ${src.name}: ${(err as Error).message}`
        }
      },
    }),

    image_edit: tool({
      description:
        'Edits an existing image by pixel processing — no generation model involved, so the photo that goes in is the same one that comes out, only resized/adjusted. Combine as many operations as you need in ONE call; they are applied in a fixed order: EXIF orientation, crop, trim, rotate/flip, background removal, resize, colour, flatten, encode.\n' +
        'Use it for: resizing, cropping, compressing to a size limit (maxBytes), converting format, adjusting brightness/saturation/hue/contrast, greyscale, blur/sharpen, and removing a background.\n' +
        'removeBackground spreads from the EDGES of the image, so it only clears background CONNECTED to the border — a white shirt inside the subject survives a white wall being removed. It compares COLOUR rather than brightness, so a lit backdrop that shades from one side to the other still keys cleanly. Both the background colour and the tolerance are MEASURED FROM THE IMAGE: omit them on the first attempt, and correct only if the reported result is wrong — guessing a tolerance is how the subject gets eaten. It handles a flat or nearly flat background (product shot, studio portrait, logo, screenshot); it does NOT separate hair from a busy scene, which needs a segmentation model. The result reports how much was cleared and the threshold used: a very low percentage means it failed, not that the image had little background.\n' +
        'The result is ALWAYS a new image in the gallery, shown in your reply — the original is never overwritten. Pass savePath only when the user asked for the file to be written into the working folder.',
      inputSchema: z.object({
        ref: z.string().describe('orbit-media:// URL, or a path in the working folder'),
        resize: z
          .object({
            width: z.number().int().positive().optional(),
            height: z.number().int().positive().optional(),
            fit: z.enum(['cover', 'contain', 'fill', 'inside', 'outside']).optional()
              .describe('inside (default) fits within the box keeping proportions; cover fills and crops'),
            enlarge: z.boolean().optional().describe('Allow growing past the original size (off by default)'),
            background: z.string().optional().describe('Fill colour when contain leaves gaps, e.g. "#ffffff"'),
          })
          .optional(),
        crop: z
          .object({
            left: z.number().int().min(0),
            top: z.number().int().min(0),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .optional()
          .describe('Rectangle in pixels of the image as displayed — call image_info first for the real size'),
        trim: z
          .object({ threshold: z.number().min(0).max(255).optional() })
          .optional()
          .describe('Cuts the uniform border around the image (scan margin, screenshot bar)'),
        rotate: z.number().optional().describe('Degrees, clockwise'),
        flip: z.boolean().optional().describe('Mirror vertically'),
        flop: z.boolean().optional().describe('Mirror horizontally'),
        removeBackground: z
          .object({
            color: z.string().optional()
              .describe('Background colour. OMIT IT: the colour is read from the image border, which is more accurate than a guess. Pass one only when the border is not the background.'),
            tolerance: z.number().min(0).max(100).optional()
              .describe('OMIT IT on the first attempt: measured from the image itself, which is the only place the right value exists. Pass 0-100 only to correct a reported result — higher to clear leftover background, lower if the subject was eaten.'),
            despill: z.boolean().optional()
              .describe('Removes the background colour left clinging to the subject edge. On by default; turn it off only if it is washing out a subject that is genuinely the background colour.'),
            feather: z.number().min(0).max(20).optional()
              .describe('Softens the cut edge, in pixels. 0 (default) is a hard cut; 1-2 looks better on a photo.'),
          })
          .optional(),
        grayscale: z.boolean().optional(),
        negate: z.boolean().optional(),
        brightness: z.number().positive().optional().describe('1 = unchanged, 1.2 = 20% brighter'),
        saturation: z.number().min(0).optional().describe('1 = unchanged, 0 = greyscale, >1 = more vivid'),
        hue: z.number().optional().describe('Colour wheel rotation, in degrees'),
        contrast: z.number().positive().optional().describe('1 = unchanged, applied around mid grey'),
        gamma: z.number().min(1).max(3).optional(),
        normalize: z.boolean().optional().describe('Stretches the histogram — rescues a washed-out photo'),
        blur: z.number().min(0.3).max(100).optional(),
        sharpen: z.boolean().optional(),
        tint: z.string().optional().describe('Tints the image with this colour, e.g. "#1e40af"'),
        flatten: z.string().optional().describe('Flattens transparency onto this colour (required for JPEG)'),
        format: z.enum(['png', 'jpeg', 'webp']).optional(),
        quality: z.number().int().min(1).max(100).optional().describe('1-100, ignored for PNG'),
        maxBytes: z.number().int().positive().optional()
          .describe('Byte ceiling: lowers quality and then dimensions until it fits'),
        savePath: z.string().optional()
          .describe('Relative path in the working folder to ALSO write the file to — only when the user asked'),
        alt: z.string().optional().describe('Short caption shown under the image in the chat'),
      }),
      execute: async ({ ref, savePath, alt, ...edit }) => {
        const src = await load(ref)
        if (typeof src === 'string') return src

        const requested = Object.entries(edit).filter(([, value]) => value !== undefined)
        if (requested.length === 0) {
          return 'Nenhuma operação pedida — informe ao menos uma (resize, crop, removeBackground, format…).'
        }

        let result
        try {
          result = await editImage(src.bytes, edit as ImageEdit)
        } catch (err) {
          return `Não foi possível editar ${src.name}: ${(err as Error).message}`
        }

        const base = src.name.replace(/\.[^.]+$/, '')
        const mediaUrl = await saveMedia(result.bytes, result.format === 'jpeg' ? 'jpg' : result.format, {
          source: 'chat',
          sessionId: scope.sessionId,
          name: `${base} (editada)`,
        })

        let savedTo: string | null = null
        if (savePath && ctx) {
          try {
            const target = resolveSafePath(ctx, savePath)
            await fsp.mkdir(path.dirname(target), { recursive: true })
            await fsp.writeFile(target, result.bytes)
            savedTo = savePath
          } catch (err) {
            savedTo = `falhou (${(err as Error).message})`
          }
        }

        const notes: string[] = [
          `${result.format} ${result.width}x${result.height}, ${bytesLabel(result.bytes.length)}`,
        ]
        if (result.backgroundRemoved !== undefined) {
          const percent = Math.round(result.backgroundRemoved * 100)
          // O limiar usado vai junto porque é o ponto de partida da correção:
          // sem ele, ajustar a tolerância seria adivinhar de novo do zero.
          const limiar =
            result.backgroundLimit === undefined
              ? ''
              : ` (limiar ${result.backgroundLimit.toFixed(0)} de 100)`
          notes.push(
            `fundo ${result.backgroundColor} recortado em ${percent}% da imagem${limiar}${
              percent < 5
                ? ' — quase nada saiu: confira a cor do fundo ou aumente a tolerância'
                : percent > 97
                  ? ' — saiu quase tudo: a tolerância provavelmente comeu o assunto'
                  : ''
            }`,
          )
        }
        if (result.compression) notes.push(`compressão: ${result.compression}`)
        if (savedTo) notes.push(`gravada em ${savedTo}`)

        // Mesmo formato do show_image: o chat-engine transforma isto numa
        // ImagePart, então o usuário VÊ o resultado em vez de ler sobre ele.
        return {
          mediaUrl,
          alt: alt ?? '',
          message: `${src.name} → ${notes.join(' · ')}. A imagem está na resposta; o original não foi alterado.`,
        }
      },
    }),
  }
}
