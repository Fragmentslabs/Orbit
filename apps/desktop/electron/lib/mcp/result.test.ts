import { describe, expect, it, vi } from 'vitest'

import { MAX_MCP_TEXT_CHARS, mcpResultToText, type McpResultScope } from './result'

/**
 * The original defect: the `image` block of a Nodara screenshot became JSON.stringify —
 * 3.3M characters of base64 in the context — and the provider refused the request for
 * overflowing the window. The image goes to the gallery; the model only gets the
 * reference.
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
  it('saves the image in the gallery and never returns the base64', async () => {
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

  it('with no Vision mode, it points to text/structure tools instead of describe_image', async () => {
    const text = await mcpResultToText(
      { content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }] },
      scope({ canDescribe: false }),
    )

    expect(text).not.toContain('describe_image')
    expect(text).toContain('cannot see images')
    expect(text).toContain('accessibility tree')
  })

  it('does not offer show_image when the turn has no such tool', async () => {
    const text = await mcpResultToText(
      { content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }] },
      scope({ canShow: false }),
    )
    expect(text).not.toContain('show_image')
  })

  it('an image that could not be saved becomes a warning, not base64', async () => {
    const text = await mcpResultToText(
      { content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }] },
      scope({ saveImage: async () => { throw new Error('disco cheio') } }),
    )
    expect(text).toContain('[Image omitted')
    expect(text).not.toContain(PNG_B64)
  })

  it('an embedded binary resource and audio also stay out', async () => {
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

  it('cuts a giant text without losing the image orientation', async () => {
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

  it('keeps the old format for a result with no content', async () => {
    expect(await mcpResultToText({ toolResult: 42 }, scope())).toBe('{"toolResult":42}')
    expect(await mcpResultToText({ content: [] }, scope())).toBe('(no return)')
  })
})
