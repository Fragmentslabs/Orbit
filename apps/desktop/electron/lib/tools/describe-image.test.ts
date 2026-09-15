import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * De onde o describe_image tira a imagem.
 *
 * O anexo do turno vive num registry que morre com o turno. Se essa fosse a
 * única origem, "olhe antes de editar" só funcionaria na mensagem em que a
 * foto chegou — e o pedido seguinte ("agora escreve na jaqueta") seria feito
 * no escuro. A origem da galeria é o que torna a orientação verdadeira, então
 * é ela que estes testes protegem.
 */

const userData = path.join(os.tmpdir(), `orbit-describe-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

/** Registry do turno, em memória, e um describeImage que só guarda o que
 *  recebeu — o que se quer verificar é QUAL imagem chegou até ele. */
const turnImages: { url: string }[] = []
const recebido: { imageDataUrl?: string } = {}

vi.mock('../vision', () => ({
  getTurnImages: () => turnImages,
  describeImage: async (opts: { imageDataUrl: string }) => {
    recebido.imageDataUrl = opts.imageDataUrl
    return 'descrição'
  },
}))

type ToolLike = { execute: (input: Record<string, unknown>) => Promise<unknown> }

let tool: ToolLike
let media: typeof import('../media')
let galleryUrl: string

beforeAll(async () => {
  media = await import('../media')
  const { createDescribeImageTool } = await import('./describe-image')
  tool = createDescribeImageTool({
    sessionId: 'sessao1',
    text: 'o que tem na foto',
    visionModel: { providerId: 'p', modelId: 'm' },
  } as never) as unknown as ToolLike

  const png = await sharp({
    create: { width: 24, height: 16, channels: 3, background: '#c81e1e' },
  })
    .png()
    .toBuffer()
  galleryUrl = await media.saveMedia(png, 'png', { source: 'user', sessionId: 'sessao1' })
})

beforeEach(() => {
  turnImages.length = 0
  recebido.imageDataUrl = undefined
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('describe_image', () => {
  it('resolve o anexo do turno pelo número', async () => {
    turnImages.push({ url: 'data:image/png;base64,AAAA' })
    await tool.execute({ ref: 1 })
    expect(recebido.imageDataUrl).toBe('data:image/png;base64,AAAA')
  })

  it('resolve uma imagem da galeria pela URL — a origem que faz olhar-antes valer', async () => {
    await tool.execute({ ref: galleryUrl })
    expect(recebido.imageDataUrl).toMatch(/^data:image\/png;base64,/)

    // E são os bytes certos, não um placeholder qualquer.
    const bytes = Buffer.from(recebido.imageDataUrl!.split(',')[1], 'base64')
    const meta = await sharp(bytes).metadata()
    expect(meta.width).toBe(24)
    expect(meta.height).toBe(16)
  })

  it('aceita o número em forma de texto, que o modelo erra com frequência', async () => {
    turnImages.push({ url: 'data:image/png;base64,BBBB' })
    await tool.execute({ ref: '1' })
    expect(recebido.imageDataUrl).toBe('data:image/png;base64,BBBB')
  })

  it('número fora do turno explica onde pegar a referência certa', async () => {
    await expect(tool.execute({ ref: 3 })).rejects.toThrow(/image_list/)
  })

  it('referência inexistente na galeria não vira descrição inventada', async () => {
    await expect(tool.execute({ ref: 'orbit-media://img_naoexiste.png' })).rejects.toThrow(
      /não encontrada/,
    )
    expect(recebido.imageDataUrl).toBeUndefined()
  })
})
