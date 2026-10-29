/**
 * Arquivos servidos ao app mobile por HTTP.
 *
 * O celular não tem os protocols do Electron, então cada coisa que ele precisa
 * ver (imagem, áudio, vídeo, artefato, documento, peça de motion/design/slides
 * e a fonte da biblioteca) sai por uma rota só:
 *
 *     /api/file/<escopo>/<id>/<token>/<caminho-relativo>
 *
 * O token vai num SEGMENTO do caminho, e não na query, porque uma peça
 * referencia as suas dependências por caminho relativo (`base.css`, `clip.mp4`,
 * `Pricing.html`). Resolvido contra o documento, o relativo herda o diretório
 * do token — é o que faz `/api/file/design/dsg_x/<token>/base.css` funcionar
 * sem reescrever nada dentro da peça.
 *
 * O alias `/api/media/<id>?t=` continua valendo para imagens: ele já está
 * entregue e funcionando no celular, e não há por que mexer no que não quebrou.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { readArtifactAsset, readMedia } from './media'
import { resolveAudioFile } from './audio-store'
import { videoFilePath } from './video/store'
import { getMotion, resolveMotionFile } from './video/motion-store'
import { getDesign, resolveDesignFile } from './design/design-store'
import { getSlides, resolveSlidesFile } from './slides/slides-store'
import { resolveFontFile } from './fonts/store'
import { isAssetScope, createAssetToken, validateAssetToken, type AssetScope } from './companion-token'
import { FONT_SCHEME } from '@shared/media'

/**
 * Tipos por extensão para os arquivos que passam por aqui. Cobre o que aparece
 * dentro de uma peça (html/css/js/fontes/mídia) e o que os players pedem.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'video/webm',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
}

function contentTypeOf(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Sem cache por padrão. Todo arquivo daqui pode ser REESCRITO no lugar mantendo
 * o mesmo id — `update_artifact` reescreve a página, `motion_edit` reescreve a
 * composição, `image_edit` pode regravar a imagem. Cachear serviria a revisão
 * antiga, e o sintoma seria "editei e não mudou no celular".
 */
const CACHE_REWRITABLE = 'no-store'

/** O arquivo pedido, já resolvido para um buffer (pequenos) ou um caminho. */
interface ResolvedAsset {
  buffer?: Buffer
  file?: string
  contentType: string
  cache: string
}

/** Caminho relativo da entrada de uma peça (motion/slides), com `/`. */
function entryRelative(folder: string, entry: string): string {
  return path.relative(folder, entry).split(path.sep).join('/')
}

/** `text/html` e `text/css` — os dois tipos que podem citar uma fonte. */
function isTextualAsset(contentType: string): boolean {
  return /^text\/(?:html|css)/.test(contentType)
}

/**
 * As URLs de fonte que o `<style>` do `font_use` (e o `fontFacesForFamily` do
 * design) gravam no documento: `orbit-font://f/<arquivo>`.
 *
 * O `FONT_SCHEME` não tem metacaractere, então não precisa de escape na regex.
 */
const FONT_URL_RE = new RegExp(`${FONT_SCHEME}://f/([A-Za-z0-9._-]+)`, 'g')

/**
 * Troca `orbit-font://f/<arquivo>` pela URL HTTP assinada.
 *
 * O scheme da fonte só existe DENTRO do Electron: num artefato carregado pelo
 * WebView do celular ele não resolve e a fonte cai para a do sistema, em
 * silêncio — o sintoma é "no telefone o layout usa outra fonte". Como o arquivo
 * da fonte tem nome validado (`<hash>.<ext>`, o mesmo do armazém), o token sai
 * por arquivo e no escopo `font`.
 *
 * Isto vale SÓ no caminho HTTP do companion: o handler do protocolo
 * (handleFontRequest, e o HTML que o desktop carrega) continua vendo a URL
 * original — o `orbit-font://` precisa seguir funcionando na janela.
 */
function rewriteFontUrls(text: string, base: string): string {
  if (!text.includes(`${FONT_SCHEME}://f/`)) return text
  return text.replace(FONT_URL_RE, (whole, file: string) => {
    if (!resolveFontFile(file)) return whole
    return `${base}/api/file/font/${file}/${createAssetToken('font', file)}`
  })
}

/** Resposta a partir de um buffer, reescrevendo as fontes quando ele é textual. */
function bufferAsset(
  buffer: Buffer,
  contentType: string,
  base: string,
  cache: string = CACHE_REWRITABLE,
): ResolvedAsset {
  return {
    buffer: isTextualAsset(contentType)
      ? Buffer.from(rewriteFontUrls(buffer.toString('utf8'), base), 'utf8')
      : buffer,
    contentType,
    cache,
  }
}

/**
 * Um arquivo do disco, com a mesma reescrita das fontes quando é HTML/CSS.
 *
 * Texto sai do BUFFER (é pequeno e o Range não serve para nada nele); o resto
 * continua saindo pelo caminho e é transmitido com Range pelo serveAsset.
 */
async function fileAsset(file: string, base: string): Promise<ResolvedAsset | null> {
  const contentType = contentTypeOf(file)
  if (!isTextualAsset(contentType)) {
    return { file, contentType, cache: CACHE_REWRITABLE }
  }
  const raw = await fsp.readFile(file).catch(() => null)
  if (!raw) return null
  return bufferAsset(raw, contentType, base)
}

/**
 * Traduz (escopo, id, relativo) no arquivo que existe no disco. `null` = não
 * existe, id inválido ou caminho que escapa da raiz da peça — quem chama
 * responde 404 sem distinguir os casos, para não virar sonda de disco.
 *
 * O `relativo` chega PERCENT-ENCODED e quem decodifica é o `resolve*File` de
 * cada store (o mesmo contrato dos handlers de scheme). Decodificar aqui
 * decodificaria duas vezes.
 */
async function resolveAsset(
  scope: AssetScope,
  id: string,
  relative: string,
  /** `http://host:porta` como o celular enxerga o desktop — a base das URLs
   *  de fonte reescritas dentro do HTML/CSS. */
  base: string,
): Promise<ResolvedAsset | null> {
  switch (scope) {
    case 'media': {
      const media = await readMedia(id)
      if (!media) return null
      return {
        buffer: media.buffer,
        contentType: media.contentType,
        cache: 'private, max-age=86400',
      }
    }

    case 'artifact': {
      const asset = await readArtifactAsset(id)
      if (!asset) return null
      return bufferAsset(asset.buffer, asset.contentType, base)
    }

    case 'audio': {
      const file = resolveAudioFile(id)
      if (!file) return null
      return { file, contentType: contentTypeOf(file), cache: CACHE_REWRITABLE }
    }

    case 'video': {
      const file = await videoFilePath(id)
      if (!file) return null
      return { file, contentType: contentTypeOf(file), cache: CACHE_REWRITABLE }
    }

    case 'motion': {
      const entry = await getMotion(id)
      if (!entry) return null
      const file = resolveMotionFile(entry.folder, relative || entryRelative(entry.folder, entry.entry))
      if (!file) return null
      return fileAsset(file, base)
    }

    case 'design': {
      const entry = await getDesign(id)
      if (!entry) return null
      const file = resolveDesignFile(entry.folder, relative || 'canvas.json')
      if (!file) return null
      return fileAsset(file, base)
    }

    case 'slides': {
      const entry = await getSlides(id)
      if (!entry) return null
      const file = resolveSlidesFile(entry.folder, relative || entryRelative(entry.folder, entry.entry))
      if (!file) return null
      return fileAsset(file, base)
    }

    case 'font': {
      const file = resolveFontFile(id)
      if (!file) return null
      // O nome é o hash do conteúdo: o mesmo byte nunca é regravado com outro
      // nome, então aqui o cache imutável é seguro (ao contrário do resto).
      return {
        file,
        contentType: contentTypeOf(file),
        cache: 'public, max-age=31536000, immutable',
      }
    }
  }
}

/** O `Range` como o `<video>`/`<audio>` pedem: início e fim em bytes. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '')
  if (!match) return null
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2] || 0))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  return { start, end }
}

/**
 * Serve um arquivo do desktop para o celular.
 *
 * Range é obrigatório aqui: sem ele o vídeo não toca e o áudio não busca
 * posição — os players perguntam o tamanho e pedem pedaços, e o `<video>` do
 * WebView também. Quem decide é o header, e a resposta é 206 quando vem.
 */
export async function serveAsset(
  req: IncomingMessage,
  res: ServerResponse,
  scope: string,
  id: string,
  token: string,
  relative: string,
): Promise<void> {
  const headers = (extra: Record<string, string>) => ({
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    ...extra,
  })

  if (!isAssetScope(scope) || !validateAssetToken(scope, id, token)) {
    res.writeHead(401, headers({ 'Content-Type': 'application/json' }))
    res.end(JSON.stringify({ error: 'Token inválido ou expirado' }))
    return
  }

  const asset = await resolveAsset(scope, id, relative, `http://${req.headers.host ?? 'localhost'}`)
  if (!asset) {
    res.writeHead(404, headers({ 'Content-Type': 'text/plain; charset=utf-8' }))
    res.end('not found')
    return
  }

  const head = req.method === 'HEAD'

  if (asset.buffer) {
    res.writeHead(200, headers({
      'Content-Type': asset.contentType,
      'Content-Length': String(asset.buffer.length),
      'Cache-Control': asset.cache,
    }))
    res.end(head ? undefined : asset.buffer)
    return
  }

  const file = asset.file as string
  let size: number
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile()) throw new Error('not a file')
    size = stat.size
  } catch {
    res.writeHead(404, headers({ 'Content-Type': 'text/plain; charset=utf-8' }))
    res.end('not found')
    return
  }

  const range = parseRange(req.headers.range, size)
  if (range && (range.start >= size || range.start > range.end)) {
    res.writeHead(416, headers({ 'Content-Range': `bytes */${size}` }))
    res.end()
    return
  }

  const start = range?.start ?? 0
  const end = range?.end ?? Math.max(0, size - 1)
  const length = size === 0 ? 0 : end - start + 1

  res.writeHead(range ? 206 : 200, headers({
    'Content-Type': asset.contentType,
    'Content-Length': String(length),
    'Cache-Control': asset.cache,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  }))

  if (head || size === 0) {
    res.end()
    return
  }

  const stream = fs.createReadStream(file, { start, end })
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}
