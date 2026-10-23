import { tool } from 'ai'
import path from 'node:path'
import { z } from 'zod'
import { getCodeIndex, peekCodeIndex, type CodeIndex } from '../code-index/store'
import {
  renderOutline,
  renderRefs,
  renderRepoMap,
  renderSearch,
  resolveSymbol,
  searchSymbols,
  signatureChanges,
} from '../code-index/query'
import { resolveSafePath, type ToolContext } from './context'

/**
 * Navegação de código pelo índice de símbolos (code-index): achar onde algo
 * está, ver um arquivo sem os corpos e saber quem usa o quê. Existe para
 * trocar a rodada grep → read → read por uma chamada que já devolve o trecho
 * certo com arquivo:linha — menos tool calls, menos tokens.
 */

/** A pasta (principal ou anexada) que contém o caminho; sem caminho, a principal. */
function rootFor(ctx: ToolContext, target?: string): { root: string; rel?: string } {
  if (!target) return { root: ctx.directory }
  const abs = resolveSafePath(ctx, target)
  const roots = [ctx.directory, ...ctx.extraDirectories].map((r) => path.resolve(r))
  const root = roots
    .filter((r) => abs === r || abs.startsWith(`${r}${path.sep}`))
    .sort((a, b) => b.length - a.length)[0] ?? ctx.directory
  const rel = path.relative(root, abs).split(path.sep).join('/')
  return { root, rel: rel || undefined }
}

async function ready(root: string, abort: AbortSignal): Promise<CodeIndex> {
  const index = getCodeIndex(root)
  await index.refresh(abort)
  return index
}

export function createCodeTools(ctx: ToolContext) {
  return {
    code_search: tool({
      description:
        'Find code by what it does or by name, over a live symbol index of the project (always in sync, uncommitted edits included). Returns the best-matching functions/classes with file:line spans, the start of their source (top results) and, under "called at", the exact file:line of each call (caller → file:line) — usually enough to answer or edit without grep or read. Prefer it to grep for locating code; use grep for exact text (strings, config values).',
      inputSchema: z.object({
        query: z.string().describe('What you are looking for, in plain words or identifiers (e.g. "retry backoff for uploads", "buildToolSet")'),
        path: z.string().optional().describe('Only search under this folder'),
        limit: z.number().optional().describe('Max results (default 5)'),
        full: z.boolean().optional().describe('Show the whole source of every result instead of the first lines of the top 3'),
      }),
      execute: async ({ query, path: scope, limit, full }) => {
        const { root, rel } = rootFor(ctx, scope)
        const index = await ready(root, ctx.abort)
        const hits = searchSymbols(index, query, { limit: Math.min(limit ?? 5, 15), scope: rel })
        if (hits.length === 0) return 'No matching symbols. Try other words, or grep for exact text.'
        return renderSearch(index, hits, { full })
      },
    }),

    code_outline: tool({
      description:
        'Signatures of every function/class in a file with their line ranges, which ones are exported, and how many places use each — the file without its bodies, a fraction of the tokens of read. Without filePath: a map of the project (folders, main symbols, most-used code) to get oriented in an unfamiliar repo.',
      inputSchema: z.object({
        filePath: z.string().optional().describe('File to outline; omit for the project map'),
        path: z.string().optional().describe('Project map only: restrict to this folder'),
      }),
      execute: async ({ filePath, path: scope }) => {
        if (!filePath) {
          const { root, rel } = rootFor(ctx, scope)
          return renderRepoMap(await ready(root, ctx.abort), { scope: rel })
        }
        const { root, rel } = rootFor(ctx, filePath)
        const index = await ready(root, ctx.abort)
        const outline = rel ? renderOutline(index, rel) : null
        return outline ?? `${filePath} is not in the index (unsupported language or not a source file) — use read.`
      },
    }),

    code_refs: tool({
      description:
        'Who uses a symbol (direction "in", default) or what it uses ("out"), with every line of each use. depth > 1 walks transitively and returns the blast radius grouped by file — run it before changing a signature or refactoring to find every affected file. symbol: a name, Class.method, or a file path (everything the file defines).',
      inputSchema: z.object({
        symbol: z.string().describe('Function/class name, Class.method, or file path'),
        direction: z.enum(['in', 'out']).optional().describe('"in" = who uses it (default); "out" = what it uses'),
        depth: z.number().optional().describe('1 = direct (default); 2-5 = transitive blast radius'),
        path: z.string().optional().describe('Disambiguate: only symbols defined under this folder'),
      }),
      execute: async ({ symbol, direction, depth, path: scope }) => {
        const looksLikeFile = /[/\\]/.test(symbol) || /\.\w{1,5}$/.test(symbol)
        const { root, rel } = rootFor(ctx, looksLikeFile ? symbol : scope)
        const index = await ready(root, ctx.abort)
        const keys = resolveSymbol(index, looksLikeFile ? (rel ?? symbol) : symbol, looksLikeFile ? undefined : rel)
        if (keys.length === 0) return `No symbol "${symbol}" in the index — check the name, or use code_search.`
        const body = renderRefs(index, keys, {
          direction: direction ?? 'in',
          depth: Math.max(1, Math.min(depth ?? 1, 5)),
        })
        const definitions = new Set(keys.map((k) => k.slice(0, k.lastIndexOf('#'))))
        const note = !looksLikeFile && definitions.size > 1 ? `"${symbol}" is defined in ${definitions.size} files: ${[...definitions].slice(0, 5).join(', ')} — pass path to pick one.\n` : ''
        return note + body
      },
    }),
  }
}

/**
 * Chamado pelo edit/write depois de gravar: re-indexa o arquivo e, se uma
 * assinatura usada em outro arquivo mudou, devolve o aviso. Só age com o
 * índice já quente — o edit nunca paga a primeira construção.
 */
export async function afterEditNote(ctx: ToolContext, file: string): Promise<string> {
  try {
    const { root, rel } = rootFor(ctx, file)
    const index = peekCodeIndex(root)
    if (!index || !rel) {
      // Aquece em segundo plano para as próximas consultas.
      if (!index) void getCodeIndex(root).refresh().catch(() => {})
      return ''
    }
    if (!index.warm) return ''
    const before = index.files.get(rel)?.defs ?? []
    const graph = index.getGraph()
    await index.touch(rel)
    return signatureChanges(index, graph, rel, before)
  } catch {
    return ''
  }
}
