import { USER_AGENT } from './search'
import type { Fetcher, ImageResult } from './types'

/**
 * Baixar a imagem escolhida. O endereço veio da resposta de uma API, então não é
 * confiável: só https, nunca para a rede local, com teto de tamanho e só se o
 * conteúdo for mesmo uma imagem raster. O Openverse aponta para o acervo de
 * origem (Flickr, NASA…), que às vezes recusa o acesso direto — aí o endereço
 * alternativo, servido pelo próprio provedor, entra no lugar.
 */

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 25_000

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** O endereço é https e não aponta para a máquina ou a rede local? */
export function isSafeImageUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
  // IPv6 literal (entre colchetes) ou IPv4: só passa se for público.
  if (host.startsWith('[')) return false
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false
  }
  return true
}

export interface DownloadedImage {
  buffer: Buffer
  ext: string
  mime: string
}

async function fetchOnce(url: string, fetcher: Fetcher): Promise<DownloadedImage> {
  if (!isSafeImageUrl(url)) throw new Error('unsafe or non-https image address')
  const res = await fetcher(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`the server answered ${res.status}`)
  const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const ext = MIME_EXT[mime]
  if (!ext) throw new Error(`not a supported image (${mime || 'unknown type'})`)
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_IMAGE_BYTES) throw new Error(`image is ${(declared / 1e6).toFixed(0)} MB, above the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`)

  // Lê aos poucos: o content-length pode faltar ou mentir.
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body?.getReader()
  if (!reader) throw new Error('empty response')
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel()
      throw new Error(`image is above the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`)
    }
    chunks.push(value)
  }
  return { buffer: Buffer.concat(chunks), ext, mime }
}

/** Baixa o arquivo do resultado; se o endereço principal falha, tenta o alternativo. */
export async function downloadImage(result: ImageResult, fetcher: Fetcher = fetch): Promise<DownloadedImage> {
  try {
    return await fetchOnce(result.downloadUrl, fetcher)
  } catch (first) {
    if (!result.fallbackUrl) throw first
    try {
      return await fetchOnce(result.fallbackUrl, fetcher)
    } catch {
      throw first
    }
  }
}
