import { tool } from 'ai'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { editDocx, readDocxParagraphs } from '../docx-edit'
import { saveDerivedDocx } from '../media'
import { readSessionDocument, readSessionDocumentBytes } from '../session-documents'
import { documentKindOf } from '../document-pages'
import { resolveSafePath, type ToolContext } from './context'
import type { DocumentToolScope } from './document'

/**
 * Editar um .docx que veio de fora, preservando a formatação.
 *
 * O resultado é sempre uma CÓPIA. O arquivo do usuário não é alterado: a cópia
 * nasce no storage do Orbit, aparece na conversa como documento e sai de lá
 * pelo botão de baixar. Gravar por cima do original é outra coisa, pede pedido
 * explícito, e é o que `savePath` faz — mesma convenção do
 * panel_screenshot({ savePath }), que também só escreve no projeto quando o
 * usuário pede.
 *
 * A fidelidade não é imitação: a cópia PARTE dos bytes originais e troca só o
 * texto pedido dentro do XML. Estilos, fontes, cabeçalho, imagens e numeração
 * continuam sendo os do arquivo de origem porque nunca foram tocados.
 */

const replacementSchema = z.object({
  find: z.string().min(1).describe('Exact text to find, as it READS in the document'),
  replace: z.string().describe('Replacement text (empty string deletes)'),
  all: z.boolean().optional().describe('Replace every occurrence (default: only the first)'),
})

export function createDocxEditTools(scope: DocumentToolScope, ctx: ToolContext | null) {
  /** Resolve a fonte do .docx: anexo da conversa ou arquivo da pasta. */
  const loadSource = async (
    docId: string | undefined,
    filePath: string | undefined,
  ): Promise<{ bytes: Buffer; name: string } | string> => {
    if (filePath) {
      if (!ctx) return 'filePath só funciona no modo código. Use docId.'
      if (documentKindOf(filePath) !== 'docx') return `Não é um .docx: ${filePath}.`
      try {
        return { bytes: await fsp.readFile(resolveSafePath(ctx, filePath)), name: path.basename(filePath) }
      } catch (err) {
        return `Não foi possível abrir ${filePath}: ${(err as Error).message}`
      }
    }
    if (docId) {
      const found = await readSessionDocument(scope.sessionId, docId)
      if (!found) return `Documento não encontrado: ${docId}. Use doc_list.`
      if (found.doc.kind !== 'docx') {
        return `${docId} (${found.doc.filename}) não é .docx — é ${found.doc.kind}.`
      }
      const bytes = await readSessionDocumentBytes(scope.sessionId, docId)
      if (!bytes) {
        return `O arquivo original de ${found.doc.filename} não foi preservado (anexo anterior a este suporte). Peça ao usuário para anexá-lo de novo.`
      }
      return { bytes, name: found.doc.filename }
    }
    return 'Informe docId (documento anexado) ou filePath (.docx da pasta de trabalho).'
  }

  return {
    docx_edit: tool({
      description:
        'Edits an existing .docx by replacing text, and saves the result as a NEW copy that appears in the conversation with a download button — the original file is never modified. Formatting is preserved exactly, because the copy starts from the original bytes and only the requested text changes. Use it when the user attaches a Word document and asks to change something in it. For a document you wrote yourself, use update_document instead.',
      inputSchema: z.object({
        docId: z.string().optional().describe('Attached .docx (from doc_list)'),
        filePath: z.string().optional().describe('.docx in the working folder (code mode)'),
        replacements: z.array(replacementSchema).min(1).max(50),
        title: z.string().max(150).optional().describe('Title for the copy (default: the original name)'),
        savePath: z
          .string()
          .optional()
          .describe(
            'ONLY when the user explicitly asked to write the file into the working folder. Without it the copy stays in Orbit and the user downloads it from the card.',
          ),
      }),
      execute: async ({ docId, filePath, replacements, title, savePath }) => {
        const source = await loadSource(docId, filePath)
        if (typeof source === 'string') return source

        let edited: { bytes: Buffer; applied: number[] }
        try {
          edited = await editDocx(source.bytes, replacements)
        } catch (err) {
          return `Erro ao editar ${source.name}: ${(err as Error).message}`
        }

        // Trecho não encontrado é o erro mais provável e o mais silencioso: o
        // Word fragmenta o texto, e o agente costuma buscar por algo que ele
        // parafraseou. Dizer QUAIS falharam é o que permite corrigir.
        const missed = replacements
          .map((r, i) => ({ find: r.find, count: edited.applied[i] }))
          .filter((r) => r.count === 0)
        if (missed.length === replacements.length) {
          return `Nenhum dos trechos foi encontrado em ${source.name}: ${missed
            .map((m) => `"${m.find}"`)
            .join(', ')}. Use doc_read para ver o texto exato — a busca é literal, sem normalizar espaços nem acentos.`
        }

        const name = title || source.name.replace(/\.docx$/i, '')
        const ref = await saveDerivedDocx(edited.bytes, {
          title: name,
          sourceName: source.name,
          sessionId: scope.sessionId,
          directory: scope.directory,
        })

        let savedTo: string | null = null
        if (savePath && ctx) {
          try {
            const target = resolveSafePath(ctx, savePath)
            await fsp.mkdir(path.dirname(target), { recursive: true })
            await fsp.writeFile(target, edited.bytes)
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
          applied: edited.applied,
          naoEncontrados: missed.map((m) => m.find),
          savedTo,
          message: `Cópia editada de ${source.name} criada — o original não foi alterado. O usuário já a vê na resposta e pode baixá-la pelo card.${
            missed.length > 0 ? ` Atenção: ${missed.length} trecho(s) não foram encontrados.` : ''
          }`,
        }
      },
    }),

    docx_paragraphs: tool({
      description:
        'Lists the paragraphs of a .docx with their exact text, numbered. Read this BEFORE docx_edit: the replacement is literal, so you need the text exactly as it is in the file — not as you remember or paraphrased it.',
      inputSchema: z.object({
        docId: z.string().optional(),
        filePath: z.string().optional(),
        from: z.number().optional().describe('First paragraph (1-indexed, default 1)'),
        limit: z.number().optional().describe('How many paragraphs (default 40)'),
      }),
      execute: async ({ docId, filePath, from, limit }) => {
        const source = await loadSource(docId, filePath)
        if (typeof source === 'string') return source
        try {
          const paragraphs = await readDocxParagraphs(source.bytes)
          const start = Math.max(1, Math.round(from ?? 1))
          const count = Math.min(Math.max(1, Math.round(limit ?? 40)), 200)
          const slice = paragraphs.slice(start - 1, start - 1 + count)
          const body = slice
            .map((text, i) => `${start + i}: ${text || '(vazio)'}`)
            .join('\n')
          const rest =
            start - 1 + slice.length < paragraphs.length
              ? `\n… mais ${paragraphs.length - (start - 1 + slice.length)} parágrafos (use from para continuar)`
              : ''
          return `${source.name} — ${paragraphs.length} parágrafos\n\n${body}${rest}`
        } catch (err) {
          return `Erro ao ler ${source.name}: ${(err as Error).message}`
        }
      },
    }),
  }
}
