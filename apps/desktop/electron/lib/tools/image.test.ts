import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * A volta completa da edição de imagem: achar a referência, editar por ela e
 * devolver algo que o chat consiga MOSTRAR.
 *
 * O image-ops.test.ts cobre o processamento; o que se verifica aqui é a
 * ligação com a galeria, que é onde a foto anexada pelo usuário vive — sem
 * ela as operações existiriam sem nada para operar.
 */

const userData = path.join(os.tmpdir(), `orbit-image-test-${process.pid}`)

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

beforeAll(async () => {
  media = await import('../media')
  const { createImageTools } = await import('./image')
  // ctx null = modo chat: a única origem é a galeria, que é o caso do usuário
  // que arrastou uma foto para a conversa.
  tools = createImageTools({ sessionId: 'sessao1' }, null) as unknown as Record<string, ToolLike>
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

/** Assunto vermelho sobre fundo branco, como uma foto de produto. */
async function productShot(): Promise<Buffer> {
  return sharp({ create: { width: 80, height: 80, channels: 3, background: '#ffffff' } })
    .composite([
      {
        input: await sharp({
          create: { width: 30, height: 30, channels: 3, background: '#c81e1e' },
        })
          .png()
          .toBuffer(),
        top: 25,
        left: 25,
      },
    ])
    .png()
    .toBuffer()
}

describe('tools de imagem', () => {
  it('image_list encontra a imagem anexada e devolve a referência', async () => {
    await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'sessao1',
      name: 'produto.png',
    })
    const listed = (await tools.image_list.execute({})) as string
    expect(listed).toContain('produto.png')
    expect(listed).toContain('anexada pelo usuário')
    expect(listed).toMatch(/orbit-media:\/\/img_\w+\.png/)
  })

  it('não confunde a imagem de outra conversa com a desta', async () => {
    await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'outra-sessao',
      name: 'de-outro-chat.png',
    })
    expect((await tools.image_list.execute({})) as string).not.toContain('de-outro-chat.png')
  })

  it('image_info lê pela referência da galeria', async () => {
    const url = await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'sessao1',
      name: 'medida.png',
    })
    const info = (await tools.image_info.execute({ ref: url })) as string
    expect(info).toContain('80x80')
    expect(info).toContain('png')
  })

  it('image_edit devolve o formato que o chat sabe renderizar', async () => {
    const url = await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'sessao1',
      name: 'reduzir.png',
    })
    const result = (await tools.image_edit.execute({ ref: url, resize: { width: 40 } })) as {
      mediaUrl: string
      message: string
    }
    // O chat-engine materializa a ImagePart a partir de mediaUrl: sem essa
    // chave o usuário só leria sobre a edição em vez de vê-la.
    expect(result.mediaUrl).toMatch(/^orbit-media:\/\//)
    expect(result.message).toContain('40x40')

    // E o resultado entra na galeria, o que permite encadear outra edição.
    const saved = await media.readMedia(media.mediaIdFromUrl(result.mediaUrl)!)
    expect((await sharp(saved!.buffer).metadata()).width).toBe(40)
  })

  it('image_edit relata quanto do fundo saiu', async () => {
    const url = await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'sessao1',
      name: 'fundo.png',
    })
    const result = (await tools.image_edit.execute({
      ref: url,
      removeBackground: {},
    })) as { message: string }
    expect(result.message).toMatch(/fundo #ffffff recortado em 8\d%/)
  })

  it('avisa quando o recorte de fundo não pegou nada, em vez de entregar calado', async () => {
    const url = await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'sessao1',
      name: 'errado.png',
    })
    const result = (await tools.image_edit.execute({
      ref: url,
      removeBackground: { color: '#00ff00', tolerance: 0 },
    })) as { message: string }
    expect(result.message).toContain('quase nada saiu')
  })

  it('o original continua intacto na galeria depois da edição', async () => {
    const url = await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'sessao1',
      name: 'intacta.png',
    })
    await tools.image_edit.execute({ ref: url, resize: { width: 20 } })
    const original = await media.readMedia(media.mediaIdFromUrl(url)!)
    expect((await sharp(original!.buffer).metadata()).width).toBe(80)
  })

  it('referência inexistente explica o problema em vez de estourar', async () => {
    const out = (await tools.image_edit.execute({
      ref: 'orbit-media://img_naoexiste.png',
      resize: { width: 10 },
    })) as string
    expect(out).toContain('não encontrada')
  })

  it('pedido sem nenhuma operação não gera uma cópia silenciosa', async () => {
    const url = await media.saveMedia(await productShot(), 'png', {
      source: 'user',
      sessionId: 'sessao1',
      name: 'vazia.png',
    })
    const out = (await tools.image_edit.execute({ ref: url })) as string
    expect(out).toContain('Nenhuma operação pedida')
  })

  it('no chat, um caminho de arquivo não vira leitura de disco', async () => {
    // Sem pasta de trabalho não há o que resolver, e aceitar o caminho seria
    // ler um arquivo qualquer da máquina a partir de um texto do modelo.
    const out = (await tools.image_info.execute({ ref: '../../etc/passwd.png' })) as string
    expect(out).toContain('Imagem não encontrada')
  })
})
