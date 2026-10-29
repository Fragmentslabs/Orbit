/**
 * Arquivos servidos ao app mobile por HTTP.
 *
 * O celular não tem os protocols do Electron, então cada coisa que ele precisa
 * ver (imagem, áudio, vídeo, artefato, documento, peça de motion/design/slides)
 * sai por uma rota só:
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
import { isAssetScope, validateAssetToken, type AssetScope } from './companion-token'

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
      return { buffer: asset.buffer, contentType: asset.contentType, cache: CACHE_REWRITABLE }
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
      return { file, contentType: contentTypeOf(file), cache: CACHE_REWRITABLE }
    }

    case 'design': {
      const entry = await getDesign(id)
      if (!entry) return null
      const file = resolveDesignFile(entry.folder, relative || 'canvas.json')
      if (!file) return null
      return { file, contentType: contentTypeOf(file), cache: CACHE_REWRITABLE }
    }

    case 'slides': {
      const entry = await getSlides(id)
      if (!entry) return null
      const file = resolveSlidesFile(entry.folder, relative || entryRelative(entry.folder, entry.entry))
      if (!file) return null
      return { file, contentType: contentTypeOf(file), cache: CACHE_REWRITABLE }
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

  const asset = await resolveAsset(scope, id, relative)
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
