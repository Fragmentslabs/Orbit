import { tool } from 'ai'
import fsp from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'

import { assertSafeSvg, recolorSvg, resizeSvg, svgInfo } from '../svg-ops'
import { vectorizeImage } from '../vectorize'
import { getMediaEntry, mediaIdFromUrl, readMedia, saveMedia } from '../media'
import { resolveSafePath, type ToolContext } from './context'
import type { DocumentToolScope } from './document'

/**
 * SVG: vetorizar, criar, inspecionar, recolorir e rasterizar.
 *
 * Separado das tools de imagem porque a natureza é outra. Editar um PNG é
 * reprocessar pixel; editar um SVG é reescrever texto — e é essa diferença que
 * dá o valor. Trocar a cor de um logo em SVG devolve o MESMO logo, em qualquer
 * tamanho; a mesma troca num PNG devolve uma aproximação do que já estava lá.
 *
 * Os dois caminhos de conversão moram aqui, porque é onde são pedidos: SVG →
 * PNG ("me dá o ícone em 512") pelo sharp, e PNG → SVG pelo vectorize.ts, que
 * é escrito à mão justamente porque o sharp lê SVG mas não escreve.
 */

export function createSvgTools(scope: DocumentToolScope, ctx: ToolContext | null) {
  /** Carrega o markup por galeria ou por caminho na pasta de trabalho. */
  const load = async (ref: string): Promise<{ markup: string; name: string } | string> => {
    const mediaId = mediaIdFromUrl(ref)
    if (mediaId) {
      if (!mediaId.endsWith('.svg')) return `${ref} is not an SVG — use image_edit for raster images.`
      const entry = await getMediaEntry(mediaId)
      if (entry) {
        const file = await readMedia(mediaId)
        if (!file) return `SVG ${ref} is in the registry but its file is gone from disk.`
        return { markup: file.buffer.toString('utf8'), name: entry.name || mediaId }
      }
      if (ref.startsWith('orbit-media://')) return `SVG not found in the gallery: ${ref}`
    }
    if (!ctx) return `SVG not found: ${ref}. In chat the reference is the gallery's orbit-media:// URL.`
    if (!ref.toLowerCase().endsWith('.svg')) return `Not an .svg file: ${ref}`
    try {
      return { markup: await fsp.readFile(resolveSafePath(ctx, ref), 'utf8'), name: path.basename(ref) }
    } catch (err) {
      return `Could not open ${ref}: ${(err as Error).message}`
    }
  }

  /** Entrega: sempre um arquivo NOVO na galeria; no projeto só com savePath. */
  const deliver = async (
    markup: string,
    name: string,
    savePath?: string,
  ): Promise<{ mediaUrl: string; savedTo: string | null }> => {
    const mediaUrl = await saveMedia(Buffer.from(markup, 'utf8'), 'svg', {
      source: 'chat',
      sessionId: scope.sessionId,
      name,
    })
    let savedTo: string | null = null
    if (savePath && ctx) {
      try {
        const target = resolveSafePath(ctx, savePath)
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.writeFile(target, markup, 'utf8')
        savedTo = savePath
      } catch (err) {
        savedTo = `failed (${(err as Error).message})`
      }
    }
    return { mediaUrl, savedTo }
  }

  /** Carrega uma imagem RASTER da galeria — a entrada da vetorização. */
  const loadRaster = async (ref: string): Promise<{ bytes: Buffer; name: string } | string> => {
    const id = mediaIdFromUrl(ref)
    if (id) {
      if (id.endsWith('.svg')) return `${ref} is already an SVG.`
      const entry = await getMediaEntry(id)
      if (entry) {
        const file = await readMedia(id)
        if (!file) return `Image ${ref} is in the registry but its file is gone from disk.`
        return { bytes: file.buffer, name: entry.name || id }
      }
      if (ref.startsWith('orbit-media://')) return `Image not found in the gallery: ${ref}`
    }
    if (!ctx) return `Image not found: ${ref}. In chat the reference is the gallery's orbit-media:// URL.`
    try {
      return { bytes: await fsp.readFile(resolveSafePath(ctx, ref)), name: path.basename(ref) }
    } catch (err) {
      return `Could not open ${ref}: ${(err as Error).message}`
    }
  }

  return {
    svg_vectorize: tool({
      description:
        'Traces a raster image into a real SVG: flat colour regions become paths that scale and can be recoloured afterwards. The image is quantised to a few colours first, so this suits what is MADE of flat regions — a logo, an icon, line art, a silhouette, a screenshot of a shape.\n' +
        'It does NOT suit photographs. A photo technically produces a valid SVG and the result is junk: every gradient becomes bands, the file ends up larger than the original and looks nothing like it. The result reports that when it happens — read the warnings and pass them on instead of delivering silently.\n' +
        'dropBackground removes the colour that fills the border, which is what gives a cut-out icon instead of a coloured rectangle. Fewer colours give a cleaner drawing; more give a closer one.',
      inputSchema: z.object({
        ref: z.string().describe('orbit-media:// URL of a raster image, or a path in the working folder'),
        colors: z.number().int().min(2).max(32).optional()
          .describe('OMIT IT: the tracer measures the drawing and picks. More colours is not more faithful on a battered file — the extra ones are edge blend, and each becomes a ghost outline beside the real stroke. Pass a number only to correct a reported result.'),
        dropBackground: z.boolean().optional()
          .describe('Drop the border colour so the result is cut out rather than a rectangle'),
        tolerance: z.number().min(0).max(10).optional()
          .describe('Simplification in pixels (default 1). Higher = fewer points, straighter outlines.'),
        savePath: z.string().optional(),
        alt: z.string().optional(),
      }),
      execute: async ({ ref, colors, dropBackground, tolerance, savePath, alt }) => {
        const src = await loadRaster(ref)
        if (typeof src === 'string') return src
        let out
        try {
          out = await vectorizeImage(src.bytes, { colors, dropBackground, tolerance })
        } catch (err) {
          return `Could not vectorize ${src.name}: ${(err as Error).message}`
        }
        if (out.paths === 0) {
          return `${src.name}: nothing was traced — the image has no flat-colour region that can become a shape.`
        }
        const base = src.name.replace(/\.[^.]+$/, '')
        const { mediaUrl, savedTo } = await deliver(out.svg, `${base} (vetor)`, savePath)
        return {
          mediaUrl,
          alt: alt ?? '',
          message:
            `${src.name} → SVG ${out.width}x${out.height}, ${out.usedColors} colours, ${out.paths} layer(s), ` +
            `${out.points} points, colours ${out.colors.join(' ')}` +
            `${savedTo ? `, saved to ${savedTo}` : ''}.` +
            (out.warnings.length > 0 ? ` WARNING: ${out.warnings.join(' ')}` : ''),
        }
      },
    }),

    svg_create: tool({
      description:
        'Saves SVG markup you wrote as a real .svg file in the gallery, shown in your reply and downloadable. This is how a vector icon you draw becomes something the user can actually use — writing the markup in a message only produces text they have to copy out.\n' +
        'Good for geometric icons, badges, diagrams, simple marks. Be honest about the limit: a brand logo is a design decision, not a code one, and markup you invent will look like it — offer it as a starting point, not a finished identity.\n' +
        'Include a viewBox: without it the file cannot be scaled. <script> and event handlers are refused, since the file leaves here for other places.',
      inputSchema: z.object({
        markup: z.string().describe('The complete <svg>…</svg> markup, with a viewBox'),
        title: z.string().optional().describe('Short name shown in the gallery'),
        savePath: z.string().optional()
          .describe('Relative path in the working folder to ALSO write it to — only when asked'),
      }),
      execute: async ({ markup, title, savePath }) => {
        try {
          assertSafeSvg(markup)
        } catch (err) {
          return (err as Error).message
        }
        const info = svgInfo(markup)
        if (!info.viewBox) {
          return 'Missing viewBox: without it the SVG does not scale, which is the whole point of the format. Retry including viewBox.'
        }
        const { mediaUrl, savedTo } = await deliver(markup, title || 'ícone', savePath)
        return {
          mediaUrl,
          alt: title ?? '',
          message: `SVG created (viewBox ${info.viewBox}${
            info.colors.length > 0 ? `, colours ${info.colors.join(' ')}` : ''
          })${savedTo ? `, saved to ${savedTo}` : ''}. It is in the reply and can be downloaded.`,
        }
      },
    }),

    svg_info: tool({
      description:
        'Reads an SVG WITHOUT changing it: display size, viewBox and the list of colours actually present, normalised. Call it before recolouring — it is how you learn which colours to map without asking the user to open the file.',
      inputSchema: z.object({
        ref: z.string().describe('orbit-media:// URL, or a path in the working folder'),
      }),
      execute: async ({ ref }) => {
        const src = await load(ref)
        if (typeof src === 'string') return src
        try {
          const info = svgInfo(src.markup)
          return `${src.name}: ${info.width ?? '?'}x${info.height ?? '?'}, viewBox ${
            info.viewBox ?? 'missing'
          }, colours: ${info.colors.length > 0 ? info.colors.join(' ') : 'none fixed (uses currentColor or CSS)'}`
        } catch (err) {
          return `Could not read ${src.name}: ${(err as Error).message}`
        }
      },
    }),

    svg_edit: tool({
      description:
        'Recolours and/or resizes an existing SVG, keeping the drawing. Recolouring reaches fill/stroke attributes and inline style; it does NOT touch rules inside a <style> block, which is real CSS with selectors — the result reports how many paints changed, so an SVG painted only by CSS comes back as 0 rather than passing as done.\n' +
        'Resizing never touches the viewBox: that is the coordinate system, and changing it would crop the drawing rather than scale it. One side alone keeps the proportion.\n' +
        '`none` and `currentColor` are left alone on purpose: the first is the absence of paint that makes a shape an outline, the second is what lets an icon be recoloured by the page using it.\n' +
        'Pass `rasterize` to get a PNG at a given width instead — that is the path for a favicon or an app icon.',
      inputSchema: z.object({
        ref: z.string().describe('orbit-media:// URL, or a path in the working folder'),
        recolorMap: z.record(z.string(), z.string()).optional()
          .describe('From → to, e.g. {"#ff0000": "#2563eb"}. Call svg_info first to learn what is there.'),
        recolorAll: z.string().optional()
          .describe('Paints EVERY colour with this one — the monochrome variant of an icon'),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        rasterize: z.enum(['png', 'webp']).optional()
          .describe('Deliver a raster at the requested size instead of the SVG'),
        savePath: z.string().optional()
          .describe('Relative path in the working folder to ALSO write it to — only when asked'),
        alt: z.string().optional(),
      }),
      execute: async ({ ref, recolorMap, recolorAll, width, height, rasterize, savePath, alt }) => {
        const src = await load(ref)
        if (typeof src === 'string') return src

        let markup = src.markup
        const notes: string[] = []
        try {
          if (recolorMap || recolorAll) {
            const out = recolorSvg(markup, { map: recolorMap, all: recolorAll })
            markup = out.markup
            notes.push(
              out.changed === 0
                ? 'no paint matched — check the colours with svg_info, or the file is painted via <style>'
                : `${out.changed} paint(s) replaced`,
            )
          }
          if (width || height) {
            markup = resizeSvg(markup, { width, height })
            notes.push(`size ${width ?? 'auto'}x${height ?? 'auto'}`)
          }
        } catch (err) {
          return `Could not edit ${src.name}: ${(err as Error).message}`
        }
        if (notes.length === 0) {
          return 'No operation requested — provide recolorMap, recolorAll, width/height or rasterize.'
        }

        const base = src.name.replace(/\.svg$/i, '')

        if (rasterize) {
          // O sharp lê SVG e desenha na resolução pedida — é o que entrega um
          // favicon nítido a partir do mesmo arquivo, sem nada de upscale.
          const pipeline = sharp(Buffer.from(markup, 'utf8'))
          if (width || height) pipeline.resize({ width, height, fit: 'contain', background: '#00000000' })
          const bytes = await (rasterize === 'webp' ? pipeline.webp() : pipeline.png()).toBuffer()
          const mediaUrl = await saveMedia(bytes, rasterize, {
            source: 'chat',
            sessionId: scope.sessionId,
            name: `${base} (${rasterize})`,
          })
          const meta = await sharp(bytes).metadata()
          return {
            mediaUrl,
            alt: alt ?? '',
            message: `${src.name} → ${rasterize} ${meta.width}x${meta.height} · ${notes.join(' · ')}. The original SVG was not changed.`,
          }
        }

        const { mediaUrl, savedTo } = await deliver(markup, `${base} (editado)`, savePath)
        return {
          mediaUrl,
          alt: alt ?? '',
          message: `${src.name} → ${notes.join(' · ')}${
            savedTo ? `, saved to ${savedTo}` : ''
          }. The original was not changed.`,
        }
      },
    }),
  }
}
