import { tool } from 'ai'
import { z } from 'zod'

/**
 * Pesquisa e leitura da web, portadas do opencode:
 * - websearch usa o endpoint MCP público da Exa (mesmo do opencode)
 * - webfetch baixa a página e converte HTML em texto legível
 */

const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'
const FETCH_TIMEOUT = 30_000
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024

interface McpResult {
  result?: { content?: { type: string; text?: string }[] }
}

function parseMcpResponse(body: string): string | undefined {
  const tryParse = (payload: string) => {
    try {
      const data = JSON.parse(payload) as McpResult
      return data.result?.content?.find((item) => item.text)?.text
    } catch {
      return undefined
    }
  }

  const trimmed = body.trim()
  if (trimmed.startsWith('{')) {
    const direct = tryParse(trimmed)
    if (direct) return direct
  }
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const data = tryParse(line.slice(6))
    if (data) return data
  }
  return undefined
}

export async function searchWeb(query: string, numResults = 8): Promise<string> {
  const res = await fetch(EXA_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'web_search_exa',
        arguments: { query, type: 'auto', numResults, livecrawl: 'fallback' },
      },
    }),
    signal: AbortSignal.timeout(25_000),
  })
  if (!res.ok) throw new Error(`Busca falhou com status ${res.status}`)
  const body = await res.text()
  return parseMcpResponse(body) ?? 'Nenhum resultado encontrado. Tente outra consulta.'
}

export function createWebSearchTool() {
  return tool({
    description:
      'Searches the web and returns results with titles, URLs, and content snippets. Use for current information.',
    inputSchema: z.object({
      query: z.string().describe('Search query'),
      numResults: z.number().optional().describe('Number of results (default: 8)'),
    }),
    execute: async ({ query, numResults }) => searchWeb(query, numResults ?? 8),
  })
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, arr) => line !== '' || arr[i - 1] !== '')
    .join('\n')
    .trim()
}

/**
 * Baixa uma página e devolve o texto legível e o título.
 *
 * Separado da tool porque o painel de fontes usa o mesmo caminho: adicionar um
 * site como fonte é baixar a página e guardar o texto — não faria sentido ter
 * dois extratores de HTML com resultados diferentes para o mesmo endereço.
 */
export async function fetchReadablePage(
  url: string,
  maxChars = 100_000,
): Promise<{ title: string; text: string }> {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('A URL deve começar com http:// ou https://')
  }
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })
  if (!res.ok) throw new Error(`Requisição falhou com status ${res.status}`)

  const raw = await res.text()
  if (raw.length > MAX_RESPONSE_SIZE) throw new Error('Resposta excede o limite de 5MB')

  const isHtml = (res.headers.get('content-type') ?? '').includes('text/html')
  const title = isHtml ? decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? '').trim() : ''
  return {
    title: title || new URL(url).hostname,
    text: (isHtml ? htmlToText(raw) : raw).slice(0, maxChars),
  }
}

export function createWebFetchTool() {
  return tool({
    description: 'Downloads a URL\'s content and returns it as readable text.',
    inputSchema: z.object({
      url: z.string().describe('http(s) URL to fetch'),
    }),
    execute: async ({ url }) => (await fetchReadablePage(url)).text,
  })
}
