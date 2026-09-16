import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * O que sobra de uma imagem colada no chat.
 *
 * A bolha guarda um thumbnail de propósito — duplicar a foto inteira no
 * histórico a reenviaria a cada turno. Mas o ORIGINAL precisa continuar
 * alcançável: é ele que o visualizador amplia e que os botões de copiar e
 * salvar entregam. Guardar só o thumbnail faz o preview esticar 320px para a
 * tela inteira e o "salvar" devolver a miniatura no lugar da foto.
 */

const userData = path.join(os.tmpdir(), `orbit-anexo-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

let media: typeof import('./media')

beforeAll(async () => {
  media = await import('./media')
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

/** Uma foto grande o bastante para o thumbnail de 320px ser uma perda real. */
async function foto(): Promise<Buffer> {
  return sharp({ create: { width: 1600, height: 900, channels: 3, background: '#3b7dd8' } })
    .png()
    .toBuffer()
}

describe('imagem colada no chat', () => {
  it('a galeria guarda o ORIGINAL, no tamanho em que chegou', async () => {
    const original = await foto()
    const url = await media.saveMedia(original, 'png', {
      source: 'user',
      sessionId: 'sessao1',
      name: 'colada.png',
    })

    const guardada = await media.readMedia(media.mediaIdFromUrl(url)!)
    const meta = await sharp(guardada!.buffer).metadata()
    expect(meta.width).toBe(1600)
    expect(meta.height).toBe(900)
  })

  it('a referência da galeria é utilizável como origem de imagem', async () => {
    // É o que o visualizador recebe em vez do thumbnail, e o que os botões de
    // copiar e salvar resolvem.
    const url = await media.saveMedia(await foto(), 'png', { source: 'user', sessionId: 'sessao1' })
    expect(url).toMatch(/^orbit-media:\/\/img_\w+\.png$/)
    expect(media.mediaIdFromUrl(url)).toBeTruthy()
    expect(await media.readMedia(media.mediaIdFromUrl(url)!)).not.toBeNull()
  })

  it('cada formato volta com a SUA extensão, inclusive o SVG', async () => {
    // O "salvar" usa isto para nomear o arquivo. Deduzir a extensão do tipo do
    // conteúdo fazia `image/svg+xml` virar ".svg+xml", e antes disso o vetor
    // saía salvo como PNG — porque o mapa de tipos não conhecia SVG. O id, que
    // nós mesmos escolhemos ao gravar, não depende de ninguém lembrar de nada.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>'
    const casos: [Buffer, string, string][] = [
      [await foto(), 'png', 'image/png'],
      [Buffer.from(svg, 'utf8'), 'svg', 'image/svg+xml'],
    ]
    for (const [bytes, ext, contentType] of casos) {
      const url = await media.saveMedia(bytes, ext, { source: 'chat', sessionId: 'sessao1' })
      const lido = await media.readMedia(media.mediaIdFromUrl(url)!)
      expect(lido!.ext).toBe(ext)
      expect(lido!.contentType).toBe(contentType)
    }
  })

  it('o thumbnail da bolha é pequeno o bastante para a perda importar', async () => {
    // Fixa a premissa do conserto: se o thumbnail já fosse grande, esticá-lo
    // não seria problema e este caminho todo seria desnecessário.
    const original = await foto()
    const thumb = await sharp(original)
      .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer()
    const meta = await sharp(thumb).metadata()
    expect(meta.width).toBe(320)
    expect(thumb.length).toBeLessThan(original.length / 4)
  })
})
