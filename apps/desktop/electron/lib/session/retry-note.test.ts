import { describe, expect, it } from 'vitest'
import type { ChatMessage, TextPart, ToolPart } from '@shared/chat'
import { retryContextNote } from './retry-note'

function failed(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'a1', role: 'assistant', parts: [], createdAt: 0, ...over }
}

let next = 0
function tool(state: ToolPart['state'], error?: string): ToolPart {
  return { id: `t${next++}`, type: 'tool', tool: 'write', state, ...(error ? { error } : {}) }
}
function text(content: string): TextPart {
  return { id: `x${next++}`, type: 'text', text: content, state: 'done' }
}

describe('retryContextNote', () => {
  it('sem nada executado: diz que o trabalho começa do mesmo ponto', () => {
    const note = retryContextNote(failed({ error: 'rate limited' }))
    expect(note).toContain('RETRY')
    expect(note).toContain('rate limited')
    expect(note).toContain('nothing had run')
  })

  it('com tool calls e arquivos escritos: lista os caminhos e manda conferir', () => {
    const note = retryContextNote(
      failed({
        error: 'tool blew up',
        parts: [tool('done'), tool('error', 'boom')],
        snapshot: { authored: ['src/a.ts', 'src/b.ts'] },
      }),
    )
    expect(note).toContain('after 2 tool calls (1 of them ended in error)')
    expect(note).toContain('src/a.ts, src/b.ts')
    expect(note).toContain('may be half-done')
  })

  it('nunca cita mais de 12 caminhos — o resto vira contagem', () => {
    const authored = Array.from({ length: 15 }, (_, i) => `f${i}.ts`)
    const note = retryContextNote(failed({ parts: [tool('done')], snapshot: { authored } }))
    expect(note).toContain('f11.ts')
    expect(note).not.toContain('f12.ts')
    expect(note).toContain('(+3 more)')
  })

  it('interrompido pela pessoa (sem erro): diz que foi interrompido', () => {
    const note = retryContextNote(failed({ parts: [tool('error', 'Interrupted.')] }))
    expect(note).toContain('was interrupted')
    expect(note).toContain('check the real state')
  })

  it('leva o fim do que já foi escrito, para o modelo não se contradizer', () => {
    const note = retryContextNote(
      failed({
        error: 'boom',
        parts: [text('Vou refatorar o store.\n\nComecei pelo sendMessage'), tool('done')],
      }),
    )
    expect(note).toContain('its last text stopped at')
    expect(note).toContain('Comecei pelo sendMessage')
    expect(note.split('\n')).toHaveLength(1)
  })

  it('caminho com colchete não quebra o marcador', () => {
    const note = retryContextNote(failed({ parts: [tool('done')], snapshot: { authored: ['src/[id].tsx'] } }))
    expect(note).toContain('src/id.tsx')
    expect(note.slice(0, -1)).not.toContain(']')
  })

  it('o texto do erro não quebra o marcador: uma linha, sem "]" interno', () => {
    const note = retryContextNote(
      failed({ error: 'Invalid value for \'tools\':\n[invalid_value] maximum is 128 ] oops' }),
    )
    expect(note.split('\n')).toHaveLength(1)
    expect(note.startsWith('[SYSTEM: ')).toBe(true)
    expect(note.endsWith(']')).toBe(true)
    // Um único "]" — o do fim. Qualquer outro faria a linha não casar com
    // ENGINE_MARKER_LINE e o marcador vazaria para a resposta visível.
    expect(note.slice(0, -1)).not.toContain(']')
    expect(note).toContain('maximum is 128')
  })
})
