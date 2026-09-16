import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * A volta completa do SVG pela galeria.
 *
 * O svg-ops.test.ts cobre a manipulação do texto. O que se verifica aqui é o
 * que faltava para o formato EXISTIR no Orbit: ser aceito, servido com o tipo
 * certo, lido de volta e rasterizado. Sem essa ponta, o agente sabia escrever
 * SVG e não tinha o que fazer com ele.
 */

const userData = path.join(os.tmpdir(), `orbit-svg-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

type ToolLike = { execute: (input: Record<string, unknown>) => Promise<unknown> }

let tools: Record<string, ToolLike>
let media: typeof import('../media')

const ICONE = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#ff0000"/></svg>`

beforeAll(async () => {
  media = await import('../media')
  const { createSvgTools } = await import('./svg')
  tools = createSvgTools({ sessionId: 'sessao1' }, null) as unknown as Record<string, ToolLike>
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('svg_create', () => {
  it('vira arquivo .svg de verdade na galeria', async () => {
    const out = (await tools.svg_create.execute({ markup: ICONE, title: 'bolinha' })) as {
      mediaUrl: string
      message: string
    }
    // A chave mediaUrl é o que faz o chat materializar a imagem na resposta.
    expect(out.mediaUrl).toMatch(/^orbit-media:\/\/\w+\.svg$/)

    const id = media.mediaIdFromUrl(out.mediaUrl)!
    const file = await media.readMedia(id)
    // Servido como imagem, que é o que permite desenhá-lo em <img> — onde
    // script embutido não executa.
    expect(file!.contentType).toBe('image/svg+xml')
    expect(file!.buffer.toString('utf8')).toContain('<svg')
  })

  it('recusa markup sem viewBox — sem ele o SVG não escala', async () => {
    const semBox = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`
    const out = (await tools.svg_create.execute({ markup: semBox })) as string
    expect(out).toContain('viewBox')
  })

  it('recusa script, que acompanharia o arquivo baixado', async () => {
    const out = (await tools.svg_create.execute({
      markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>`,
    })) as string
    expect(out).toMatch(/script/i)
  })
})

describe('svg_info e svg_edit', () => {
  let url: string

  beforeAll(async () => {
    const criado = (await tools.svg_create.execute({ markup: ICONE, title: 'base' })) as {
      mediaUrl: string
    }
    url = criado.mediaUrl
  })

  it('svg_info relata as cores reais, sem abrir o arquivo à mão', async () => {
    const out = (await tools.svg_info.execute({ ref: url })) as string
    expect(out).toContain('#ff0000')
    expect(out).toContain('0 0 24 24')
  })

  it('recolorir devolve um SVG novo, com a cor trocada', async () => {
    const out = (await tools.svg_edit.execute({
      ref: url,
      recolorMap: { '#ff0000': '#2563eb' },
    })) as { mediaUrl: string; message: string }
    expect(out.message).toContain('1 pintura')

    const lido = await media.readMedia(media.mediaIdFromUrl(out.mediaUrl)!)
    expect(lido!.buffer.toString('utf8')).toContain('#2563eb')
  })

  it('mapa que não casa avisa em vez de entregar cópia como sucesso', async () => {
    const out = (await tools.svg_edit.execute({
      ref: url,
      recolorMap: { '#00ff00': '#000000' },
    })) as { message: string }
    expect(out.message).toContain('nenhuma pintura casou')
  })

  it('rasteriza nítido no tamanho pedido — o caminho do favicon', async () => {
    // O ponto do vetor: 512 a partir de um arquivo de 24, sem upscale.
    const out = (await tools.svg_edit.execute({
      ref: url,
      width: 512,
      rasterize: 'png',
    })) as { mediaUrl: string; message: string }

    const png = await media.readMedia(media.mediaIdFromUrl(out.mediaUrl)!)
    const meta = await sharp(png!.buffer).metadata()
    expect(meta.format).toBe('png')
    expect(meta.width).toBe(512)
  })

  it('o SVG de origem não é alterado por nenhuma edição', async () => {
    const original = await media.readMedia(media.mediaIdFromUrl(url)!)
    expect(original!.buffer.toString('utf8')).toContain('#ff0000')
  })

  it('pedido sem operação nenhuma não gera cópia silenciosa', async () => {
    const out = (await tools.svg_edit.execute({ ref: url })) as string
    expect(out).toContain('Nenhuma operação pedida')
  })

  it('apontar para um raster explica em vez de estourar', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer()
    const raster = await media.saveMedia(png, 'png', { source: 'chat', sessionId: 'sessao1' })
    const out = (await tools.svg_info.execute({ ref: raster })) as string
    expect(out).toContain('não é um SVG')
  })
})
