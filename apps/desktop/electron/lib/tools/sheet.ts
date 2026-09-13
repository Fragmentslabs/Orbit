import { tool } from 'ai'
import fsp from 'node:fs/promises'
import { z } from 'zod'
import { documentKindOf, readSheetRows } from '../documents'
import { formatQueryResult, runSheetQuery, SheetQueryError, type SheetQuery } from '../sheet-query'
import { readSessionDocumentBytes, readSessionDocument } from '../session-documents'
import { resolveSafePath, type ToolContext } from './context'

/**
 * Consulta sobre planilha: filtrar, agrupar, somar.
 *
 * Ler a planilha e somar "de cabeça" é caro e ERRADO — o modelo percorrendo
 * milhares de linhas gasta contexto proporcional ao arquivo e erra a
 * aritmética de um jeito que não aparece na resposta. Aqui o número é
 * calculado pelo runtime.
 *
 * A tool aceita as duas fontes que o Orbit tem: `filePath` (planilha do
 * repositório, só no modo código, onde existe pasta de trabalho) e `docId`
 * (planilha anexada na conversa, nos dois modos).
 */

const conditionSchema = z.object({
  column: z.string().describe('Column name, as written in the header row'),
  op: z
    .enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'empty', 'notEmpty'])
    .describe('Comparison. Numeric when both sides are numbers, otherwise case-insensitive text.'),
  value: z.union([z.string(), z.number(), z.boolean()]).optional().describe('Not needed for empty/notEmpty'),
})

const aggregateSchema = z.object({
  fn: z.enum(['sum', 'avg', 'min', 'max', 'count']),
  column: z.string().optional().describe('Column to aggregate. Omit with count to count rows.'),
  as: z.string().optional().describe('Name for this column in the result'),
})

const DESCRIPTION =
  'Queries a spreadsheet: filters rows, groups them and computes sum/avg/min/max/count — the runtime does the arithmetic, so the number is exact. ALWAYS prefer this over reading rows and adding them up yourself: reading thousands of rows is expensive and mental arithmetic over them is unreliable. The first row is taken as the header, and columns are referenced by their header name. Source: filePath for a spreadsheet in the working folder, or docId for one attached to the conversation.'

export function createSheetQueryTool(sessionId: string, ctx: ToolContext | null) {
  return tool({
    description: DESCRIPTION,
    inputSchema: z.object({
      filePath: z.string().optional().describe('Spreadsheet in the working folder (code mode)'),
      docId: z.string().optional().describe('Attached spreadsheet id (from doc_list)'),
      sheet: z.string().optional().describe('Sheet name (default: the first one)'),
      where: z.array(conditionSchema).optional().describe('Conditions, combined with AND'),
      groupBy: z.array(z.string()).optional().describe('Columns to group by'),
      aggregate: z.array(aggregateSchema).optional().describe('Aggregations to compute per group'),
      select: z.array(z.string()).optional().describe('Columns to return when there is no aggregation'),
      orderBy: z
        .object({ column: z.string(), direction: z.enum(['asc', 'desc']).optional() })
        .optional()
        .describe('Sort the result by one of ITS OWN columns'),
      limit: z.number().optional().describe('Max rows returned (capped at 200)'),
    }),
    execute: async ({ filePath, docId, sheet, ...query }) => {
      // ── fonte ───────────────────────────────────────────────────────────
      let bytes: Buffer
      let label: string
      if (filePath) {
        if (!ctx) return 'filePath só funciona no modo código (não há pasta de trabalho aqui). Use docId.'
        if (documentKindOf(filePath) !== 'spreadsheet') {
          return `Não é uma planilha: ${filePath}. Esta tool só lê .xlsx/.xls/.ods/.csv.`
        }
        try {
          bytes = await fsp.readFile(resolveSafePath(ctx, filePath))
        } catch (err) {
          return `Não foi possível abrir ${filePath}: ${(err as Error).message}`
        }
        label = filePath
      } else if (docId) {
        const found = await readSessionDocument(sessionId, docId)
        if (!found) return `Documento não encontrado: ${docId}. Use doc_list para ver os disponíveis.`
        if (found.doc.kind !== 'spreadsheet') {
          return `${docId} (${found.doc.filename}) não é planilha — é ${found.doc.kind}. Use doc_read/doc_search.`
        }
        const stored = await readSessionDocumentBytes(sessionId, docId)
        if (!stored) {
          // Anexo anterior a esta cópia: melhor avisar do que calcular sobre o
          // texto formatado e devolver um número silenciosamente errado.
          return `A planilha ${found.doc.filename} foi anexada antes do suporte a consulta e não tem mais o arquivo original. Anexe de novo para poder somar; por ora dá para lê-la com doc_read.`
        }
        bytes = stored
        label = found.doc.filename
      } else {
        return 'Informe filePath (planilha da pasta de trabalho) ou docId (planilha anexada).'
      }

      // ── consulta ────────────────────────────────────────────────────────
      try {
        const { rows, sheetName, sheetNames } = readSheetRows(bytes, sheet)
        const result = runSheetQuery(rows, query as SheetQuery)
        const other =
          sheetNames.length > 1 ? ` · outras abas: ${sheetNames.filter((n) => n !== sheetName).join(', ')}` : ''
        return `${label} · aba "${sheetName}"${other}\n\n${formatQueryResult(result)}`
      } catch (err) {
        // Erro de consulta (coluna inexistente, aba errada) é informação útil
        // para o modelo corrigir a chamada, não falha da tool.
        if (err instanceof SheetQueryError) return err.message
        return `Erro ao consultar ${label}: ${(err as Error).message}`
      }
    },
  })
}
