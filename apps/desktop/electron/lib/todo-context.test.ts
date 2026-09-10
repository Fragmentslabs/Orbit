import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '@shared/chat'
import { engineAnnotations, stripEngineMarkers } from './todo-context'

/**
 * Duas responsabilidades com falha silenciosa:
 *
 * 1. `engineAnnotations` cola ao histórico o veredito MEDIDO do turno (o
 *    snapshot do filesystem) ao lado da narrativa do agente. Se parar de
 *    emitir, "implementei X" volta a viajar sozinho pelo histórico e os
 *    turnos seguintes tratam a alegação como fato.
 * 2. `stripEngineMarkers` impede que esses mesmos marcadores vazem para o
 *    texto que o usuário lê — o modelo copia o formato quando o histórico é
 *    longo.
 */

const message = (over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: 'm1', role: 'assistant', parts: [], createdAt: 0, ...over }) as ChatMessage

const todoPart = (items: { content: string; status: string }[]) =>
  ({ type: 'tool', tool: 'todowrite', state: 'done', input: { items } }) as never

describe('engineAnnotations', () => {
  it('sem TODO e sem snapshot, não anota nada', () => {
    expect(engineAnnotations(message())).toBe('')
  })

  it('reemite o estado da TODO, que os ToolParts não levam ao modelo', () => {
    const out = engineAnnotations(
      message({
        parts: [
          todoPart([
            { content: 'Ler o código', status: 'completed' },
            { content: 'Escrever o teste', status: 'in_progress' },
            { content: 'Rodar a suíte', status: 'pending' },
          ]),
        ],
      }),
    )
    expect(out).toContain('[TODO for this response]')
    expect(out).toContain('- [x] Ler o código')
    expect(out).toContain('- [~] Escrever o teste')
    expect(out).toContain('- [ ] Rodar a suíte')
  })

  it('usa a última chamada de todowrite do turno', () => {
    const out = engineAnnotations(
      message({
        parts: [
          todoPart([{ content: 'Antiga', status: 'pending' }]),
          todoPart([{ content: 'Atual', status: 'completed' }]),
        ],
      }),
    )
    expect(out).toContain('Atual')
    expect(out).not.toContain('Antiga')
  })

  it('registra que nada foi escrito quando o snapshot diz unchanged', () => {
    const out = engineAnnotations(message({ snapshot: { verified: 'unchanged' } as never }))
    expect(out).toContain('NO file was modified in this turn')
  })

  it('desmente a checklist quando ela diz "completed" e nada mudou no disco', () => {
    // O par narrativa + medição é o ponto todo do módulo: sem esta anotação a
    // checklist marcada vira a prova mais convincente do histórico.
    const out = engineAnnotations(
      message({
        parts: [todoPart([{ content: 'Implementar', status: 'completed' }])],
        snapshot: { verified: 'unchanged' } as never,
      }),
    )
    expect(out).toContain('Marking an item done is a claim, not evidence')
  })

  it('lista os arquivos medidos quando houve escrita', () => {
    const out = engineAnnotations(
      message({ snapshot: { verified: 'changed', files: ['src/a.ts', 'src/b.ts'] } as never }),
    )
    expect(out).toContain('2 file(s) modified')
    expect(out).toContain('src/a.ts, src/b.ts')
  })

  it('resume a lista de arquivos longa em vez de gastar contexto', () => {
    const files = Array.from({ length: 15 }, (_, i) => `src/f${i}.ts`)
    const out = engineAnnotations(message({ snapshot: { verified: 'changed', files } as never }))
    expect(out).toContain('15 file(s) modified')
    expect(out).toContain('(+3 more)')
  })

  it('avisa sobre turno truncado pelo limite de passos', () => {
    const out = engineAnnotations(message({ truncated: true } as never))
    expect(out).toContain('interrupted by hitting the step/tool limit')
  })

  it('reemite o lembrete de TODO não fechada', () => {
    const out = engineAnnotations(message({ todoReminder: true } as never))
    expect(out).toContain('still marked as "in_progress"')
  })
})

describe('stripEngineMarkers', () => {
  it('não mexe em texto sem marcador', () => {
    expect(stripEngineMarkers('Resposta normal.')).toBe('Resposta normal.')
  })

  it('remove o rodapé que o modelo copia do contexto', () => {
    const out = stripEngineMarkers('Pronto, ajustei o seletor.\n\n[Verified record: 1 file(s) modified in this turn — a.ts]')
    expect(out).toBe('Pronto, ajustei o seletor.')
  })

  it('remove aviso [SYSTEM: ...] em linha própria', () => {
    expect(stripEngineMarkers('Texto.\n[SYSTEM: the TODO items above were marked completed]\nMais texto.')).toBe(
      'Texto.\nMais texto.',
    )
  })

  it('preserva menção em prosa — a linha não é só o marcador', () => {
    const prosa = 'A linha [Verified record: ...] serve para desmentir a narrativa.'
    expect(stripEngineMarkers(prosa)).toBe(prosa)
  })

  it('preserva marcador dentro de bloco de código', () => {
    // Este repositório discute os próprios marcadores no código e nos docs.
    const texto = 'Exemplo:\n```\n[Verified record: NO file was modified in this turn]\n```\nFim.'
    expect(stripEngineMarkers(texto)).toContain('[Verified record:')
  })
})
