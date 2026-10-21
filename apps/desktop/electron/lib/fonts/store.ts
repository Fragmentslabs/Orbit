import { app, protocol } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { FONT_SCHEME } from '@shared/media'
import { withAssetLock, writeFileAtomic } from '../asset-lock'

/**
 * Biblioteca de fontes do Orbit: `orbit-data/fonts` (índice + `files/`) e o
 * scheme `orbit-font://` que a serve.
 *
 * O armazém é CONTENT-ADDRESSED (o nome do arquivo é o hash do conteúdo): baixar
 * a mesma família duas vezes, ou duas famílias que compartilham um subset, não
 * duplica byte nenhum. O índice guarda o que a UI e o agente precisam saber para
 * usar a fonte — família, licença, subsets e os arquivos com peso/estilo/range.
 *
 * Nada é copiado para o projeto: o artboard, a composição de motion e a janela
 * do app declaram o mesmo `@font-face` apontando para cá (o scheme manda CORS,
 * que é o que fonte em origem opaca exige). É o mesmo desenho do
 * `orbit-design://`/`orbit-motion://`.
 */

export interface FontFileRef {
  /** Nome do arquivo em `files/` (hash do conteúdo + extensão). */
  file: string
  subset: string
  /** Peso CSS: `400` no estático, `100 900` na variável. */
  weight: string
  style: 'normal' | 'italic'
  /** `unicode-range` do subset, quando o pacote informa. */
  unicodeRange?: string
}

export interface OrbitFont {
  /** Slug do Fontsource (ex.: `inter`, `jetbrains-mono`). */
  id: string
  family: string
  category?: string
  license?: { type: string; url?: string; attribution?: string }
  /** Variável: um arquivo cobre a faixa de pesos inteira. */
  variable: boolean
  weights: string[]
  styles: string[]
  subsets: string[]
  files: FontFileRef[]
  addedAt: number
}

interface FontIndex {
  v: 1
  fonts: OrbitFont[]
}

const SAFE_FILE = /^[a-f0-9]{32}\.(?:woff2|woff|ttf|otf)$/
const MIME: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

export function fontsRoot(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'fonts')
}

export function fontFilesDir(): string {
  return path.join(fontsRoot(), 'files')
}

function indexFile(): string {
  return path.join(fontsRoot(), 'index.json')
}

let cache: { mtimeMs: number; fonts: OrbitFont[] } | null = null

/** O índice, reaproveitado enquanto o arquivo não muda no disco. */
export async function listFonts(): Promise<OrbitFont[]> {
  const stat = await fsp.stat(indexFile()).catch(() => null)
  if (!stat) {
    cache = null
    return []
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.fonts
  try {
    const parsed = JSON.parse(await fsp.readFile(indexFile(), 'utf8')) as FontIndex
    const fonts = Array.isArray(parsed?.fonts) ? parsed.fonts : []
    cache = { mtimeMs: stat.mtimeMs, fonts }
    return fonts
  } catch {
    return cache?.fonts ?? []
  }
}

async function writeIndex(fonts: OrbitFont[]): Promise<void> {
  await fsp.mkdir(fontsRoot(), { recursive: true })
  await writeFileAtomic(indexFile(), JSON.stringify({ v: 1, fonts } satisfies FontIndex, null, 2))
  cache = null
}

/** Acha por slug ou por família (sem diferenciar maiúsculas). */
export async function findFont(ref: string): Promise<OrbitFont | null> {
  const wanted = ref.trim().toLowerCase()
  if (!wanted) return null
  const fonts = await listFonts()
  return (
    fonts.find((font) => font.id.toLowerCase() === wanted) ??
    fonts.find((font) => font.family.toLowerCase() === wanted) ??
    null
  )
}

/** Grava o arquivo no armazém e devolve o nome (hash) — o mesmo byte não entra duas vezes. */
export async function storeFontFile(buffer: Buffer, ext: string): Promise<string> {
  const name = `${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32)}.${ext}`
  await fsp.mkdir(fontFilesDir(), { recursive: true })
  const target = path.join(fontFilesDir(), name)
  const exists = await fsp
    .stat(target)
    .then((stat) => stat.isFile())
    .catch(() => false)
  if (!exists) await writeFileAtomic(target, buffer)
  return name
}

/** Insere ou atualiza uma família no índice (id do Fontsource é a chave). */
export async function addFont(font: OrbitFont): Promise<OrbitFont> {
  return withAssetLock('fonts:index', async () => {
    const fonts = await listFonts()
    const next = fonts.filter((item) => item.id !== font.id)
    const previous = fonts.find((item) => item.id === font.id)
    next.push({ ...font, addedAt: previous?.addedAt ?? font.addedAt })
    next.sort((a, b) => a.family.localeCompare(b.family))
    await writeIndex(next)
    return font
  })
}

export function fontUrl(file: string): string {
  return `${FONT_SCHEME}://f/${file}`
}

/** O `@font-face` de cada arquivo da biblioteca — uma declaração só, usada em todo alvo. */
export function fontFaceCss(fonts: OrbitFont[]): string {
  const blocks: string[] = []
  for (const font of fonts) {
    const family = font.family.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    for (const ref of font.files) {
      const range = ref.unicodeRange ? `\n  unicode-range: ${ref.unicodeRange};` : ''
      blocks.push(
        `@font-face {\n  font-family: '${family}';\n  font-style: ${ref.style};\n  font-weight: ${ref.weight};\n  font-display: swap;\n  src: url('${fontUrl(ref.file)}') format('woff2');${range}\n}`,
      )
    }
  }
  return blocks.join('\n')
}

/** Todas as fontes da biblioteca, prontas para injetar num documento. */
export async function allFontFacesCss(): Promise<string> {
  return fontFaceCss(await listFonts())
}

/**
 * O `@font-face` da família pedida, quando ela vem da biblioteca.
 *
 * Vazio quando o nome não está instalado aqui - aí a fonte é do sistema (ou
 * inventada) e não há nada a declarar: o Chromium resolve pelo nome, como
 * sempre fez.
 */
export async function fontFacesForFamily(family: string): Promise<string> {
  const wanted = family.trim().toLowerCase()
  if (!wanted) return ''
  const fonts = await listFonts()
  const match = fonts.find((font) => font.family.trim().toLowerCase() === wanted)
  return match ? fontFaceCss([match]) : ''
}

export function registerFontSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FONT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // Fonte é recurso CORS-obrigatório: sem isto o artboard (origem opaca)
        // e a janela do app baixariam o arquivo e o descartariam.
        corsEnabled: true,
      },
    },
  ])
}

export async function handleFontRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  const headers = { 'Access-Control-Allow-Origin': '*' }
  if (!SAFE_FILE.test(name)) return new Response('not found', { status: 404, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } })
  const file = path.join(fontFilesDir(), name)
  const size = await fsp
    .stat(file)
    .then((stat) => (stat.isFile() ? stat.size : null))
    .catch(() => null)
  if (size === null) return new Response('not found', { status: 404, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } })
  const type = MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
  const stream = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream
  return new Response(size > 0 ? stream : new Uint8Array(0), {
    headers: {
      ...headers,
      'Content-Type': type,
      'Content-Length': String(size),
      // O nome é o hash do conteúdo: o arquivo nunca muda.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}

export function registerFontProtocol(): void {
  protocol.handle(FONT_SCHEME, handleFontRequest)
}
