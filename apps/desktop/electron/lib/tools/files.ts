import { tool } from 'ai'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { IGNORED_DIRS, resolveSafePath, type ToolContext } from './context'
import {
  documentHeader,
  extractDocumentFile,
  isDocumentPath,
  pageLabel,
  pageLocator,
  pageWindow,
} from '../documents'

/**
 * Ferramentas de arquivo portadas do opencode (read/write/edit/ls/glob/grep)
 * em versão enxuta: mesmas semânticas, sem LSP nem tracking de mutação.
 */

const MAX_READ_LINES = 2000
const MAX_LINE_LENGTH = 2000
const MAX_GREP_MATCHES = 100
const MAX_GLOB_RESULTS = 200

/** Quantas páginas de documento uma leitura devolve por padrão. Baixo de
 *  propósito: o ponto da paginação é o agente pedir mais quando precisar, não
 *  arrastar o documento inteiro para o contexto em duas chamadas. */
const DEFAULT_DOC_PAGES = 3
const MAX_DOC_PAGES = 20

/**
 * Leitura de documento (PDF/DOCX/planilha) com a MESMA semântica offset/limit
 * do arquivo de texto — só que a unidade é página, não linha. Reaproveitar o
 * `read` em vez de criar uma tool nova é deliberado: o modelo já sabe paginar
 * com offset/limit, e um `read` que engasga em .pdf é justamente o bug que
 * isto corrige.
 */
async function readDocument(file: string, offset?: number, limit?: number): Promise<string> {
  const doc = await extractDocumentFile(file)
  if (doc.totalPages === 0) {
    return `<document path="${file}" kind="${doc.kind}">\n(nenhum texto extraível — provavelmente um PDF digitalizado, sem camada de texto)\n</document>`
  }
  const { from, to, pages } = pageWindow(doc, offset, limit, DEFAULT_DOC_PAGES, MAX_DOC_PAGES)
  const body = pages
    .map((page) => `--- ${pageLabel(page, doc.kind)} ---\n${page.text || '(página sem texto)'}`)
    .join('\n\n')
  return `${documentHeader(file, doc, { from, to })}\n${body}\n</document>`
}

export function createReadTool(ctx: ToolContext) {
  return tool({
    description:
      'Reads a file. For text files, returns the content with line numbers (offset/limit = lines). Also reads PDF, DOCX and spreadsheets, returning the extracted text a few pages at a time (offset/limit = pages; a spreadsheet is paged by sheet, and a large sheet is split into row ranges) — never the whole document at once, so use grep to locate the relevant part of a long document and then read around it.',
    inputSchema: z.object({
      filePath: z.string().describe('File path (relative to the working folder or absolute)'),
      offset: z.number().optional().describe('Start line — or start page, in a document (1-indexed)'),
      limit: z.number().optional().describe('Number of lines — or pages, in a document'),
    }),
    execute: async ({ filePath, offset, limit }) => {
      const file = resolveSafePath(ctx, filePath)
      if (isDocumentPath(file)) return readDocument(file, offset, limit)
      const raw = await fs.readFile(file, 'utf8')
      const lines = raw.split('\n')
      const start = Math.max((offset ?? 1) - 1, 0)
      const count = Math.min(limit ?? MAX_READ_LINES, MAX_READ_LINES)
      const slice = lines.slice(start, start + count)
      const body = slice
        .map((line, i) => `${String(start + i + 1).padStart(5)}| ${line.slice(0, MAX_LINE_LENGTH)}`)
        .join('\n')
      const truncated = start + count < lines.length ? `\n… (${lines.length} linhas no total)` : ''
      return `<file path="${file}">\n${body}${truncated}\n</file>`
    },
  })
}

export function createWriteTool(ctx: ToolContext) {
  return tool({
    description: 'Creates or overwrites a file with the given content.',
    inputSchema: z.object({
      filePath: z.string().describe('File path'),
      content: z.string().describe('Full file content'),
    }),
    execute: async ({ filePath, content }) => {
      const file = resolveSafePath(ctx, filePath)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, content, 'utf8')
      return `Arquivo escrito: ${file} (${content.length} caracteres)`
    },
  })
}

function replaceOnce(content: string, oldString: string, newString: string): string | null {
  // Correspondência exata primeiro; depois tenta ignorando espaços à direita
  // de cada linha (fallback simplificado dos "replacers" do opencode).
  if (content.includes(oldString)) {
    return content.replace(oldString, newString)
  }
  const normalize = (s: string) => s.split('\n').map((l) => l.trimEnd()).join('\n')
  const normalizedContent = normalize(content)
  const normalizedOld = normalize(oldString)
  const idx = normalizedContent.indexOf(normalizedOld)
  if (idx < 0) return null
  // Mapeia o índice normalizado de volta para o conteúdo original por linhas
  const linesBefore = normalizedContent.slice(0, idx).split('\n').length - 1
  const oldLineCount = normalizedOld.split('\n').length
  const lines = content.split('\n')
  const replaced = [
    ...lines.slice(0, linesBefore),
    newString,
    ...lines.slice(linesBefore + oldLineCount),
  ]
  return replaced.join('\n')
}

export function createEditTool(ctx: ToolContext) {
  return tool({
    description:
      'Edits a file by replacing oldString with newString. oldString must be unique in the file (include enough context) or use replaceAll.',
    inputSchema: z.object({
      filePath: z.string().describe('File path'),
      oldString: z.string().describe('Exact text to replace'),
      newString: z.string().describe('New text'),
      replaceAll: z.boolean().optional().describe('Replace all occurrences'),
    }),
    execute: async ({ filePath, oldString, newString, replaceAll }) => {
      const file = resolveSafePath(ctx, filePath)
      const content = await fs.readFile(file, 'utf8')
      if (oldString === newString) throw new Error('oldString e newString são iguais')

      let next: string | null
      if (replaceAll) {
        if (!content.includes(oldString)) throw new Error('oldString não encontrado no arquivo')
        next = content.split(oldString).join(newString)
      } else {
        const occurrences = content.split(oldString).length - 1
        if (occurrences > 1) {
          throw new Error(`oldString aparece ${occurrences} vezes; inclua mais contexto ou use replaceAll`)
        }
        next = replaceOnce(content, oldString, newString)
        if (next === null) throw new Error('oldString não encontrado no arquivo')
      }
      await fs.writeFile(file, next, 'utf8')
      return `Arquivo editado: ${file}`
    },
  })
}

export function createListTool(ctx: ToolContext) {
  return tool({
    description: 'Lists files and folders in a directory.',
    inputSchema: z.object({
      dirPath: z.string().optional().describe('Directory (default: working folder)'),
    }),
    execute: async ({ dirPath }) => {
      const dir = resolveSafePath(ctx, dirPath ?? '.')
      const entries = await fs.readdir(dir, { withFileTypes: true })
      const listing = entries
        .filter((e) => !IGNORED_DIRS.has(e.name))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join('\n')
      return listing || '(diretório vazio)'
    },
  })
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '§GLOBSTAR§')
    .replace(/\*\*/g, '§GLOBSTAR§')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/§GLOBSTAR§/g, '(?:.*/)?')
  return new RegExp(`^${escaped}$`)
}

async function* walkFiles(root: string, abort: AbortSignal): AsyncGenerator<string> {
  const stack = [root]
  while (stack.length > 0) {
    if (abort.aborted) return
    const dir = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) yield full
    }
  }
}

export function createGlobTool(ctx: ToolContext) {
  return tool({
    description: 'Finds files by glob pattern (e.g.: "**/*.ts", "src/**/*.tsx").',
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern'),
      dirPath: z.string().optional().describe('Base directory (default: working folder)'),
    }),
    execute: async ({ pattern, dirPath }) => {
      const base = resolveSafePath(ctx, dirPath ?? '.')
      const regex = globToRegExp(pattern)
      const matches: string[] = []
      for await (const file of walkFiles(base, ctx.abort)) {
        const rel = path.relative(base, file).replace(/\\/g, '/')
        if (regex.test(rel)) {
          matches.push(rel)
          if (matches.length >= MAX_GLOB_RESULTS) break
        }
      }
      if (matches.length === 0) return 'Nenhum arquivo encontrado'
      const suffix = matches.length >= MAX_GLOB_RESULTS ? '\n… (resultados truncados)' : ''
      return matches.join('\n') + suffix
    },
  })
}

export function createGrepTool(ctx: ToolContext) {
  return tool({
    description:
      'Searches for a pattern (regex) in file contents. Also searches inside PDF, DOCX and spreadsheets, reporting the page instead of the line (file:p12) — this is how you locate the relevant part of a long document before reading it.',
    inputSchema: z.object({
      pattern: z.string().describe('Regular expression'),
      dirPath: z.string().optional().describe('Base directory (default: working folder)'),
      include: z.string().optional().describe('File glob filter (e.g.: "*.ts")'),
    }),
    execute: async ({ pattern, dirPath, include }) => {
      const base = resolveSafePath(ctx, dirPath ?? '.')
      const regex = new RegExp(pattern)
      const includeRegex = include ? globToRegExp(include.includes('/') ? include : `**/${include}`) : null
      const results: string[] = []

      for await (const file of walkFiles(base, ctx.abort)) {
        const rel = path.relative(base, file).replace(/\\/g, '/')
        if (includeRegex && !includeRegex.test(rel)) continue

        // Documento: busca no texto extraído (cacheado) e reporta a PÁGINA.
        // Sem isto o walk pulava o arquivo — PDF é binário e cai no teste de
        // \0 abaixo —, então o agente nem sabia que havia conteúdo ali.
        if (isDocumentPath(file)) {
          try {
            const doc = await extractDocumentFile(file)
            for (const page of doc.pages) {
              for (const line of page.text.split('\n')) {
                if (!regex.test(line)) continue
                results.push(
                  `${rel}:${pageLocator(page, doc.kind)}: ${line.trim().slice(0, 250)}`,
                )
                break // uma ocorrência por página basta para localizar o trecho
              }
              if (results.length >= MAX_GREP_MATCHES) break
            }
          } catch {
            // documento ilegível (protegido, corrompido) — segue o walk
          }
          if (results.length >= MAX_GREP_MATCHES) break
          continue
        }

        let content: string
        try {
          const stat = await fs.stat(file)
          if (stat.size > 2 * 1024 * 1024) continue
          content = await fs.readFile(file, 'utf8')
          if (content.includes('\0')) continue
        } catch {
          continue
        }
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 250)}`)
            if (results.length >= MAX_GREP_MATCHES) break
          }
        }
        if (results.length >= MAX_GREP_MATCHES) break
      }

      if (results.length === 0) return 'Nenhuma ocorrência encontrada'
      const suffix = results.length >= MAX_GREP_MATCHES ? '\n… (resultados truncados)' : ''
      return results.join('\n') + suffix
    },
  })
}
