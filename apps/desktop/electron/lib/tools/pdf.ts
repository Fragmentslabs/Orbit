import { tool } from 'ai'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { documentKindOf } from '../document-pages'

import { fillForm, mergePdfs, parsePageRange, readFormFields, readMetadata, transformPdf } from '../pdf-ops'
import { DEFAULT_IMAGE_MIN_SIZE, extractPdfImages } from '../pdf'
import { saveDerivedPdf, saveMedia } from '../media'
import { readSessionDocument, readSessionDocumentBytes } from '../session-documents'
import { resolveSafePath, type ToolContext } from './context'
import type { DocumentToolScope } from './document'

/**
 * Manipulação de PDFs existentes: juntar, recortar, girar, carimbar e
 * preencher formulário.
 *
 * Toda saída é um arquivo NOVO no storage do Orbit, que aparece na conversa
 * como documento e sai pelo botão de baixar — mesma regra da edição de .docx:
 * o usuário anexou o documento, não autorizou mexer nele. Gravar no projeto
 * só com `savePath`, e só quando ele pedir.
 */

export function createPdfOpsTools(scope: DocumentToolScope, ctx: ToolContext | null) {
  /** Resolve um PDF por anexo ou por caminho na pasta de trabalho. */
  const load = async (ref: string): Promise<{ bytes: Buffer; name: string } | string> => {
    if (/^(doc|src)[0-9]+$/.test(ref)) {
      const found = await readSessionDocument(scope.sessionId, ref)
      if (found) {
        if (found.doc.kind !== 'pdf') return `${ref} (${found.doc.filename}) is not a PDF.`
        const bytes = await readSessionDocumentBytes(scope.sessionId, ref)
        if (!bytes) return `The original file of ${found.doc.filename} was not kept. Ask for it to be attached again.`
        return { bytes, name: found.doc.filename }
      }
    }
    if (!ctx) return `Document not found: ${ref}. Use doc_list to see the attachments.`
    if (documentKindOf(ref) !== 'pdf') return `Not a PDF: ${ref}.`
    try {
      return { bytes: await fsp.readFile(resolveSafePath(ctx, ref)), name: path.basename(ref) }
    } catch (err) {
      return `Could not open ${ref}: ${(err as Error).message}`
    }
  }

  /** Grava a saída: sempre no Orbit; no projeto só quando pedido. */
  const deliver = async (
    bytes: Buffer,
    title: string,
    sourceName: string,
    savePath?: string,
  ) => {
    const ref = await saveDerivedPdf(bytes, {
      title,
      sourceName,
      sessionId: scope.sessionId,
      directory: scope.directory,
    })
    let savedTo: string | null = null
    if (savePath && ctx) {
      try {
        const target = resolveSafePath(ctx, savePath)
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.writeFile(target, bytes)
        savedTo = savePath
      } catch (err) {
        savedTo = `(failed to write to ${savePath}: ${(err as Error).message})`
      }
    }
    return {
      documentId: ref.id,
      title: ref.title,
      previewUrl: ref.previewUrl,
      formats: ref.formats,
      thumb: ref.thumb,
      revision: ref.revision,
      savedTo,
    }
  }

  const savePathSchema = z
    .string()
    .optional()
    .describe(
      'ONLY when the user explicitly asked to write into the working folder. Without it the new PDF stays in Orbit and the user downloads it from the card.',
    )

  return {
    pdf_merge: tool({
      description:
        'Joins several PDFs into a single new one, in the order given, and shows it in the conversation with a download button. The source files are not modified.',
      inputSchema: z.object({
        sources: z
          .array(z.string())
          .min(2)
          .max(20)
          .describe('Document ids from doc_list (doc1, src2…) or PDF paths in the working folder'),
        title: z.string().max(150).optional(),
        savePath: savePathSchema,
      }),
      execute: async ({ sources, title, savePath }) => {
        const loaded: { bytes: Buffer; name: string }[] = []
        for (const ref of sources) {
          const one = await load(ref)
          if (typeof one === 'string') return one
          loaded.push(one)
        }
        try {
          const { bytes, pages } = await mergePdfs(loaded.map((l) => l.bytes))
          const out = await deliver(
            bytes,
            title || `${loaded[0].name.replace(/\.pdf$/i, '')} + ${loaded.length - 1}`,
            loaded.map((l) => l.name).join(', '),
            savePath,
          )
          return { ...out, pages, message: `${loaded.length} PDFs merged into ${pages} pages.` }
        } catch (err) {
          return `Failed to merge: ${(err as Error).message}`
        }
      },
    }),

    pdf_transform: tool({
      description:
        'Produces a new PDF from an existing one: pick and REORDER pages, rotate, and/or stamp a watermark. Pages use a range like "1-3,7,10-12" and the order you write is the order they come out, so this also removes pages (list the ones to keep) and reorders them. The source is not modified.',
      inputSchema: z.object({
        source: z.string().describe('Attached document id or PDF path in the working folder'),
        pages: z
          .string()
          .optional()
          .describe('Range like "1-3,7". Omit to keep every page (useful when only rotating or stamping).'),
        rotate: z.number().optional().describe('Degrees to rotate: 90, 180 or 270. Added to the current rotation.'),
        watermark: z.string().optional().describe('Diagonal translucent text, e.g. "CONFIDENCIAL"'),
        metadata: z
          .object({
            title: z.string().optional(),
            author: z.string().optional(),
            subject: z.string().optional(),
            keywords: z.string().optional().describe('Comma-separated'),
          })
          .optional()
          .describe('Document properties written into the new file (what a reader shows under Properties)'),
        title: z.string().max(150).optional(),
        savePath: savePathSchema,
      }),
      execute: async ({ source, pages, rotate, watermark, metadata, title, savePath }) => {
        const src = await load(source)
        if (typeof src === 'string') return src
        try {
          // O total só é conhecido depois de abrir, então a faixa é expandida
          // aqui e não no schema.
          const probe = await transformPdf(src.bytes, {})
          const selected = pages ? parsePageRange(pages, probe.total) : undefined
          if (pages && (!selected || selected.length === 0)) {
            return `No valid pages in "${pages}" — the document has ${probe.total}.`
          }
          const result = await transformPdf(src.bytes, {
            pages: selected,
            rotate,
            watermark,
            metadata,
          })
          const out = await deliver(
            result.bytes,
            title || src.name.replace(/\.pdf$/i, ''),
            src.name,
            savePath,
          )
          return {
            ...out,
            pages: result.pages,
            totalOriginal: result.total,
            message: `New PDF with ${result.pages} of ${result.total} pages${watermark ? ', with a watermark' : ''}.`,
          }
        } catch (err) {
          return `Failed to transform ${src.name}: ${(err as Error).message}`
        }
      },
    }),

    pdf_form_fields: tool({
      description:
        'Lists the form fields of a PDF with their names, types and current values. Read this BEFORE pdf_form_fill: fields are matched by their INTERNAL name, which is rarely the label printed next to the box.',
      inputSchema: z.object({ source: z.string() }),
      execute: async ({ source }) => {
        const src = await load(source)
        if (typeof src === 'string') return src
        try {
          const fields = await readFormFields(src.bytes)
          if (fields.length === 0) {
            return `${src.name} has no form fields. If the form is a printed one (lines to fill in by hand), there is nothing to fill in programmatically.`
          }
          return fields
            .map((f) => {
              const value = f.value ? ` = ${JSON.stringify(f.value)}` : ''
              const options = f.options?.length ? ` [${f.options.join(' | ')}]` : ''
              return `${f.name} (${f.type})${value}${options}`
            })
            .join('\n')
        } catch (err) {
          return `Failed to read the fields of ${src.name}: ${(err as Error).message}`
        }
      },
    }),

    pdf_form_fill: tool({
      description:
        'Fills a PDF form and saves the result as a new file, shown in the conversation with a download button. Use pdf_form_fields first to get the exact field names. Set flatten when the form is being SENT (it makes the values permanent); leave it off when the person still has to fill more.',
      inputSchema: z.object({
        source: z.string(),
        values: z
          .record(z.string(), z.string())
          .describe('Field name → value. For checkboxes use "true"/"false".'),
        flatten: z.boolean().optional().describe('Make the filled values permanent (not editable)'),
        title: z.string().max(150).optional(),
        savePath: savePathSchema,
      }),
      execute: async ({ source, values, flatten, title, savePath }) => {
        const src = await load(source)
        if (typeof src === 'string') return src
        try {
          const result = await fillForm(src.bytes, values, flatten ?? false)
          if (result.filled.length === 0) {
            return `No field was filled in ${src.name} — the names did not match: ${result.missing.join(', ')}. Use pdf_form_fields for the exact names.`
          }
          const out = await deliver(
            result.bytes,
            title || `${src.name.replace(/\.pdf$/i, '')} preenchido`,
            src.name,
            savePath,
          )
          return {
            ...out,
            filled: result.filled,
            notFound: result.missing,
            message: `${result.filled.length} field(s) filled${
              result.missing.length > 0 ? `; ${result.missing.length} not found` : ''
            }${flatten ? ', form flattened' : ''}.`,
          }
        } catch (err) {
          return `Failed to fill ${src.name}: ${(err as Error).message}`
        }
      },
    }),
    pdf_metadata: tool({
      description:
        'Reads the document properties of a PDF: title, author, subject, keywords, producer, dates and page count — what a reader shows under Properties. To CHANGE them, use pdf_transform with its metadata field, which writes a new file.',
      inputSchema: z.object({ source: z.string() }),
      execute: async ({ source }) => {
        const src = await load(source)
        if (typeof src === 'string') return src
        try {
          const meta = await readMetadata(src.bytes)
          const linhas = Object.entries(meta)
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => `${k}: ${v}`)
          return linhas.length > 0
            ? `${src.name}\n${linhas.join('\n')}`
            : `${src.name} declares no metadata.`
        } catch (err) {
          return `Failed to read the metadata of ${src.name}: ${(err as Error).message}`
        }
      },
    }),

    pdf_extract_images: tool({
      description:
        'Extracts the images EMBEDDED in a PDF (the actual figures, not a picture of the page) and saves them to the media gallery, where the user can view and download them. Use it to reuse a chart, a logo or a scanned signature. To see how a page LOOKS instead, use pdf_view_page.',
      inputSchema: z.object({
        source: z.string(),
        pages: z.string().optional().describe('Range like "1-3,7". Omit for the whole document.'),
        max: z.number().optional().describe('Cap on how many images to extract (default 20)'),
        minSize: z
          .number()
          .optional()
          .describe(
            `Skip images whose width OR height is at or below this many pixels (default ${DEFAULT_IMAGE_MIN_SIZE}). It filters out the rules, hairlines and background slices a laid-out PDF is full of. Lower it (or pass 0) when the user is after something small, like a logo or a signature.`,
          ),
      }),
      execute: async ({ source, pages, max, minSize }) => {
        const src = await load(source)
        if (typeof src === 'string') return src
        try {
          // O total só é conhecido depois de abrir; 10000 é um teto folgado
          // apenas para a faixa ser expandida sem truncar nada de verdade.
          const wanted = pages ? parsePageRange(pages, 10_000) : undefined
          const floor = minSize ?? DEFAULT_IMAGE_MIN_SIZE
          const images = await extractPdfImages(new Uint8Array(src.bytes), {
            pages: wanted,
            max,
            minSize: floor,
          })
          if (images.length === 0) {
            // Dizer só "não encontrei" seria enganoso: o piso descarta em
            // silêncio, e a saída é justamente baixá-lo.
            return `No image larger than ${floor}px found in ${src.name}${
              pages ? ` on pages ${pages}` : ''
            }.${
              floor > 0
                ? ` If the figure you are after is small (a logo, a signature), retry with a smaller minSize — 0 returns all of them.`
                : ''
            } A text-only PDF has no images; to see how the page looks use pdf_view_page.`
          }
          const saved: string[] = []
          for (const image of images) {
            const url = await saveMedia(image.png, 'png', {
              source: 'chat',
              sessionId: scope.sessionId,
              name: `${src.name} p${image.pageNumber} ${image.name}`,
            })
            saved.push(`${url} — page ${image.pageNumber}, ${image.width}×${image.height}`)
          }
          return `${saved.length} image(s) extracted from ${src.name} and saved to the gallery:\n${saved.join(
            '\n',
          )}\n\nTo show one to the user in your reply: show_image({ media: "<orbit-media://…>" }).`
        } catch (err) {
          return `Failed to extract images from ${src.name}: ${(err as Error).message}`
        }
      },
    }),
  }
}
