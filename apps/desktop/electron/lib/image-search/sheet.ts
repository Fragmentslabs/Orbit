import sharp, { type OverlayOptions } from 'sharp'
import type { Fetcher, ImageResult } from './types'
import { USER_AGENT } from './search'

/**
 * Uma folha com as miniaturas dos resultados, cada uma com seu número. É o que
 * deixa o agente ESCOLHER a imagem olhando, e não só pelo título: sem ela, "foto
 * de leão" traria desenho, estátua e mapa com a mesma confiança. Uma imagem só
 * por busca — oito miniaturas custam o mesmo que uma foto.
 */

const CELL_W = 320
const CELL_H = 220
const COLUMNS = 4
export const MAX_SHEET_CELLS = 8
const THUMB_TIMEOUT_MS = 10_000
const MAX_THUMB_BYTES = 1_500_000

async function thumbnail(result: ImageResult, fetcher: Fetcher): Promise<Buffer | null> {
  try {
    const res = await fetcher(result.thumbUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' },
      signal: AbortSignal.timeout(THUMB_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    return buffer.length > 0 && buffer.length <= MAX_THUMB_BYTES ? buffer : null
  } catch {
    return null
  }
}

function label(n: number): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="28"><rect width="34" height="28" rx="5" fill="#000" fill-opacity="0.75"/><text x="17" y="20" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">${n}</text></svg>`
  return Buffer.from(svg)
}

/** Monta a folha; `null` quando nenhuma miniatura pôde ser lida. */
export async function buildContactSheet(results: ImageResult[], fetcher: Fetcher = fetch): Promise<Buffer | null> {
  const picked = results.slice(0, MAX_SHEET_CELLS)
  const thumbs = await Promise.all(picked.map((r) => thumbnail(r, fetcher)))
  const rows = Math.ceil(picked.length / COLUMNS)
  const composites: OverlayOptions[] = []
  let any = false
  for (let i = 0; i < picked.length; i += 1) {
    const left = (i % COLUMNS) * CELL_W
    const top = Math.floor(i / COLUMNS) * CELL_H
    const raw = thumbs[i]
    if (raw) {
      try {
        const cell = await sharp(raw).rotate().resize(CELL_W - 4, CELL_H - 4, { fit: 'cover' }).toBuffer()
        composites.push({ input: cell, left: left + 2, top: top + 2 })
        any = true
      } catch {
        // miniatura ilegível: a célula fica vazia, só com o número
      }
    }
    composites.push({ input: label(i + 1), left: left + 6, top: top + 6 })
  }
  if (!any) return null
  return sharp({
    create: { width: CELL_W * COLUMNS, height: CELL_H * rows, channels: 3, background: '#1b1b1b' },
  })
    .composite(composites)
    .webp({ quality: 72 })
    .toBuffer()
}
