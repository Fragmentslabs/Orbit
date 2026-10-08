import { describe, expect, it, vi } from 'vitest'

import { MAX_MCP_TEXT_CHARS, mcpResultToText, type McpResultScope } from './result'

/**
 * O defeito de origem: o bloco `image` de um screenshot do Nodara virava
 * JSON.stringify — 3,3M caracteres de base64 no contexto — e o provedor
 * recusava o request por estouro de janela. Imagem vai para a galeria; o
 * modelo recebe só a referência.
 */

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64')

function scope(overrides: Partial<McpResultScope> = {}): McpResultScope {
  return {
    saveImage: vi.fn(async (data: Buffer) => ({
      url: 'orbit-media://img_abc.png',
      width: 1220,
      height: 2712,
      bytes: data.length,
    })),
    canShow: true,
    canDescribe: true,
    ...overrides,
  }
}

describe('mcpResultToText', () => {
  it('grava a imagem na galeria e nunca devolve o base64', async () => {
    const s = scope()
    const text = await mcpResultToText(
      {
        content: [
          { type: 'text', text: 'Screenshot captured\nFile: C:\\shot.png' },
          { type: 'image', data: PNG_B64, mimeType: 'image/png', annotations: { audience: ['user'] } },
        ],
      },
      s,
    )

    expect(s.saveImage).toHaveBeenCalledWith(Buffer.from('fake-png-bytes'), 'image/png')
    expect(text).not.toContain(PNG_B64)
    expect(text).toContain('Screenshot captured')
    expect(text).toContain('[Image saved: orbit-media://img_abc.png (1220×2712')
    expect(text).toContain('show_image({ media:')
    expect(text).toContain('describe_image(')
  })

  it('sem modo Visão, aponta para ferramentas de texto/estrutura em vez de describe_image', async () => {
    const text = await mcpResultToText(
      { content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }] },
      scope({ canDescribe: false }),
    )

    expect(text).not.toContain('describe_image')
    expect(text).toContain('cannot see images')
    expect(text).toContain('accessibility tree')
  })

  it('não oferece show_image quando o turno não tem a tool', async () => {
    const text = await mcpResultToText(
      { content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }] },
      scope({ canShow: false }),
    )
    expect(text).not.toContain('show_image')
  })

  it('imagem que não pôde ser gravada vira aviso, não base64', async () => {
    const text = await mcpResultToText(
      { content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }] },
      scope({ saveImage: async () => { throw new Error('disco cheio') } }),
    )
    expect(text).toContain('[Image omitted')
    expect(text).not.toContain(PNG_B64)
  })

  it('recurso binário embutido e áudio também ficam de fora', async () => {
    const text = await mcpResultToText(
      {
        content: [
          { type: 'audio', data: PNG_B64, mimeType: 'audio/wav' },
          { type: 'resource', resource: { uri: 'file:///x.bin', mimeType: 'application/octet-stream', blob: PNG_B64 } },
          { type: 'resource', resource: { uri: 'file:///x.txt', text: 'conteúdo' } },
        ],
      },
      scope(),
    )
    expect(text).not.toContain(PNG_B64)
    expect(text).toContain('[Audio omitted')
    expect(text).toContain('[Binary resource omitted: file:///x.bin')
    expect(text).toContain('conteúdo')
  })

  it('corta texto gigante sem perder a orientação da imagem', async () => {
    const text = await mcpResultToText(
      {
        content: [
          { type: 'text', text: 'x'.repeat(MAX_MCP_TEXT_CHARS * 2) },
          { type: 'image', data: PNG_B64, mimeType: 'image/png' },
        ],
      },
      scope(),
    )
    expect(text.length).toBeLessThan(MAX_MCP_TEXT_CHARS + 2_000)
    expect(text).toContain('output truncated')
    expect(text).toContain('show_image')
  })

  it('mantém o formato antigo para resultado sem content', async () => {
    expect(await mcpResultToText({ toolResult: 42 }, scope())).toBe('{"toolResult":42}')
    expect(await mcpResultToText({ content: [] }, scope())).toBe('(sem retorno)')
  })
})
