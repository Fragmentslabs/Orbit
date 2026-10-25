import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { HOISTED_IMAGE_NOTE, hoistToolImages } from './tool-images'

const IMAGE = 'iVBORw0KGgoAAAANSUhEUg=='

function toolMessage(output: unknown): ModelMessage[] {
  return [
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'see_screen', output: output as never }],
    },
  ]
}

function content(...parts: Array<Record<string, unknown>>): unknown {
  return { type: 'content', value: parts }
}

describe('hoistToolImages', () => {
  it('tira a imagem do resultado da tool e a entrega como mensagem de usuário', () => {
    const messages = toolMessage(
      content({ type: 'text', text: 'Screen 1200×780 px.' }, { type: 'image-data', data: IMAGE, mediaType: 'image/jpeg' }),
    )

    const result = hoistToolImages(messages)

    expect(result.images).toBe(1)
    const output = (result.messages[0] as { content: Array<{ output: { type: string; value: string } }> }).content[0]
      .output
    expect(output.type).toBe('text')
    expect(output.value).toContain('Screen 1200×780 px.')
    expect(output.value).toContain(HOISTED_IMAGE_NOTE)

    const user = result.messages[1] as { role: string; content: Array<Record<string, unknown>> }
    expect(user.role).toBe('user')
    expect(user.content).toContainEqual({ type: 'file', data: IMAGE, mediaType: 'image/jpeg' })
  })

  it('não mexe em resultado que já é texto', () => {
    const messages = toolMessage({ type: 'text', value: 'sem imagem' })
    const result = hoistToolImages(messages)
    expect(result.images).toBe(0)
    expect(result.messages).toBe(messages)
  })

  it('é idempotente: a segunda passada não duplica a mensagem', () => {
    const once = hoistToolImages(
      toolMessage(content({ type: 'text', text: 'ok' }, { type: 'image-data', data: IMAGE, mediaType: 'image/webp' })),
    )
    const twice = hoistToolImages(once.messages)
    expect(twice.images).toBe(0)
    expect(twice.messages).toBe(once.messages)
  })

  it('leva mais de uma imagem do mesmo resultado', () => {
    const result = hoistToolImages(
      toolMessage(
        content(
          { type: 'text', text: 'duas' },
          { type: 'image-data', data: 'a', mediaType: 'image/png' },
          { type: 'image-data', data: 'b', mediaType: 'image/png' },
        ),
      ),
    )
    expect(result.images).toBe(2)
    const user = result.messages[1] as { content: Array<Record<string, unknown>> }
    expect(user.content.filter((p) => p.type === 'file')).toHaveLength(2)
  })
})
