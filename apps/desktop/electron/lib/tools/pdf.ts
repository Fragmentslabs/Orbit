import { tool } from 'ai'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { documentKindOf } from '../document-pages'

import { fillForm, mergePdfs, parsePageRange, readFormFields, readMetadata, transformPdf } from '../pdf-ops'
import { extractPdfImages } from '../pdf'
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
    if (ref.startsWith('doc')) {
      const found = await readSessionDocument(scope.sessionId, ref)
      if (found) {
        if (found.doc.kind !== 'pdf') return `${ref} (${found.doc.filename}) não é PDF.`
        const bytes = await readSessionDocumentBytes(scope.sessionId, ref)
        if (!bytes) return `O arquivo original de ${found.doc.filename} não foi preservado. Peça para anexar de novo.`
        return { bytes, name: found.doc.filename }
      }
    }
    if (!ctx) return `Documento não encontrado: ${ref}. Use doc_list para ver os anexos.`
    if (documentKindOf(ref) !== 'pdf') return `Não é um PDF: ${ref}.`
    try {
      return { bytes: await fsp.readFile(resolveSafePath(ctx, ref)), name: path.basename(ref) }
    } catch (err) {
      return `Não foi possível abrir ${ref}: ${(err as Error).message}`
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
        savedTo = `(falhou ao gravar em ${savePath}: ${(err as Error).message})`
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
          .describe('Attached document ids (doc1, doc2…) or PDF paths in the working folder'),
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
          return { ...out, pages, message: `${loaded.length} PDFs juntados em ${pages} páginas.` }
        } catch (err) {
          return `Erro ao juntar: ${(err as Error).message}`
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
            return `Nenhuma página válida em "${pages}" — o documento tem ${probe.total}.`
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
            message: `Novo PDF com ${result.pages} de ${result.total} páginas${watermark ? ', com marca d’água' : ''}.`,
          }
        } catch (err) {
          return `Erro ao transformar ${src.name}: ${(err as Error).message}`
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
            return `${src.name} não tem campos de formulário. Se o formulário for impresso (linhas para preencher à mão), não há o que preencher programaticamente.`
          }
          return fields
            .map((f) => {
              const value = f.value ? ` = ${JSON.stringify(f.value)}` : ''
              const options = f.options?.length ? ` [${f.options.join(' | ')}]` : ''
              return `${f.name} (${f.type})${value}${options}`
            })
            .join('\n')
        } catch (err) {
          return `Erro ao ler campos de ${src.name}: ${(err as Error).message}`
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
            return `Nenhum campo foi preenchido em ${src.name} — os nomes não bateram: ${result.missing.join(', ')}. Use pdf_form_fields para os nomes exatos.`
          }
          const out = await deliver(
            result.bytes,
            title || `${src.name.replace(/\.pdf$/i, '')} preenchido`,
            src.name,
            savePath,
          )
          return {
            ...out,
            preenchidos: result.filled,
            naoEncontrados: result.missing,
            message: `${result.filled.length} campo(s) preenchidos${
              result.missing.length > 0 ? `; ${result.missing.length} não encontrados` : ''
            }${flatten ? ', formulário achatado' : ''}.`,
          }
        } catch (err) {
          return `Erro ao preencher ${src.name}: ${(err as Error).message}`
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
            : `${src.name} não declara nenhum metadado.`
        } catch (err) {
          return `Erro ao ler metadados de ${src.name}: ${(err as Error).message}`
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
      }),
      execute: async ({ source, pages, max }) => {
        const src = await load(source)
        if (typeof src === 'string') return src
        try {
          // O total só é conhecido depois de abrir; 10000 é um teto folgado
          // apenas para a faixa ser expandida sem truncar nada de verdade.
          const wanted = pages ? parsePageRange(pages, 10_000) : undefined
          const images = await extractPdfImages(new Uint8Array(src.bytes), { pages: wanted, max })
          if (images.length === 0) {
            return `Nenhuma imagem embutida encontrada em ${src.name}${
              pages ? ` nas páginas ${pages}` : ''
            }. Um PDF só de texto não tem imagens; para ver a aparência da página use pdf_view_page.`
          }
          const saved: string[] = []
          for (const image of images) {
            const url = await saveMedia(image.png, 'png', {
              source: 'chat',
              sessionId: scope.sessionId,
              name: `${src.name} p${image.pageNumber} ${image.name}`,
            })
            saved.push(`${url} — página ${image.pageNumber}, ${image.width}×${image.height}`)
          }
          return `${saved.length} imagem(ns) extraída(s) de ${src.name} e salvas na galeria:\n${saved.join(
            '\n',
          )}\n\nPara mostrar alguma ao usuário na resposta: show_image({ media: "<orbit-media://…>" }).`
        } catch (err) {
          return `Erro ao extrair imagens de ${src.name}: ${(err as Error).message}`
        }
      },
    }),
  }
}
