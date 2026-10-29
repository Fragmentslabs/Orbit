import { describe, expect, it } from 'vitest'
import { usageFromHistory } from './metrics'

/** Uma mensagem no formato do AI SDK: `content` é a lista de partes. */
function mensagem(partes: unknown[]): unknown {
  return { role: 'assistant', content: partes }
}

describe('uso lido do histórico', () => {
  it('conta tool-call por nome e não repete a mesma tool', () => {
    const uso = usageFromHistory([
      mensagem([
        { type: 'tool-call', toolName: 'pdf_merge' },
        { type: 'tool-call', toolName: 'pdf_merge' },
        { type: 'tool-call', toolName: 'git_status' },
      ]),
    ])
    expect(uso.calls).toEqual(['git_status', 'pdf_merge'])
  })

  it('conta tools_load à parte — é o hop que a telemetria quer medir', () => {
    const uso = usageFromHistory([
      mensagem([
        { type: 'tool-call', toolName: 'tools_load' },
        { type: 'tool-call', toolName: 'tools_load' },
        { type: 'tool-call', toolName: 'pdf_merge' },
      ]),
    ])
    expect(uso.loads).toBe(2)
    expect(uso.calls).toEqual(['pdf_merge', 'tools_load'])
  })

  it('só conta resultado marcado como erro', () => {
    const uso = usageFromHistory([
      mensagem([
        { type: 'tool-result', isError: true },
        { type: 'tool-result', isError: false },
        { type: 'tool-result' },
      ]),
    ])
    expect(uso.failed).toBe(1)
  })

  it('ignora mensagem sem content em lista e parte que não é tool', () => {
    const uso = usageFromHistory([
      { role: 'user', content: 'texto solto' },
      null,
      mensagem([{ type: 'text', text: 'oi' }, { type: 'tool-call' }]),
    ])
    expect(uso).toEqual({ loads: 0, calls: [], failed: 0 })
  })
})
