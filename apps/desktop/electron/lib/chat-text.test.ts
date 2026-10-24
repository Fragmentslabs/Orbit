import { describe, expect, it } from 'vitest'
import type { ChatMessage, MessagePart, ReasoningPart, TextPart, ToolPart } from '@shared/chat'
import { lastProseText, lastTextRunStart } from '@shared/chat-text'

let seq = 0
const texto = (t: string, source?: TextPart['source']): TextPart => ({
  id: `p${++seq}`,
  type: 'text',
  text: t,
  state: 'done',
  ...(source ? { source } : {}),
})
const raciocinio = (t: string): ReasoningPart => ({
  id: `p${++seq}`,
  type: 'reasoning',
  text: t,
  state: 'done',
})
const ferramenta = (): ToolPart => ({
  id: `p${++seq}`,
  type: 'tool',
  tool: 'bash',
  state: 'done',
  output: 'ok',
})

const mensagem = (...parts: MessagePart[]): ChatMessage => ({
  id: 'msg_1',
  role: 'assistant',
  parts,
  createdAt: 0,
})

describe('lastProseText', () => {
  it('devolve a resposta, não a narração anterior à ferramenta', () => {
    const m = mensagem(
      texto('Vou implementar. Primeiro preciso reler as peças.'),
      ferramenta(),
      texto('Implementado. O título agora nasce no envio.'),
    )
    expect(lastProseText(m)).toBe('Implementado. O título agora nasce no envio.')
  })

  it('junta texto separado só por raciocínio (auto-continue)', () => {
    const m = mensagem(
      ferramenta(),
      texto('Primeira metade da resposta.'),
      raciocinio('retomando de onde cortou'),
      texto('Segunda metade.'),
    )
    expect(lastProseText(m)).toBe('Primeira metade da resposta.\nSegunda metade.')
  })

  it('ignora o texto do engine depois da resposta', () => {
    const m = mensagem(
      ferramenta(),
      texto('A resposta.'),
      texto('verificação anti-overclaim', 'nudge'),
      texto('fechando a checklist', 'todo'),
      texto('nada a corrigir', 'internal'),
    )
    expect(lastProseText(m)).toBe('A resposta.')
  })

  it('turno que termina pensando mantém a última prosa', () => {
    const m = mensagem(ferramenta(), texto('A resposta.'), raciocinio('conferindo'))
    expect(lastProseText(m)).toBe('A resposta.')
  })

  it('não trata anexo nem legenda de visão como resposta', () => {
    const m = mensagem(
      ferramenta(),
      texto('conteúdo extraído do PDF', 'attachment'),
      texto('Analisando imagem…', 'vision'),
    )
    expect(lastProseText(m)).toBe('')
  })

  it('sem texto nenhum devolve vazio', () => {
    expect(lastProseText(mensagem(ferramenta()))).toBe('')
  })
})

describe('lastTextRunStart', () => {
  it('aponta o início do último bloco', () => {
    const parts = [texto('narração'), ferramenta(), texto('resposta')]
    expect(lastTextRunStart(parts.map((part) => ({ kind: 'part', part })))).toBe(2)
  })

  it('requireProse ignora um bloco que só tem raciocínio', () => {
    const parts = [texto('resposta'), ferramenta(), raciocinio('pensando')]
    const segments = parts.map((part) => ({ kind: 'part', part }))
    expect(lastTextRunStart(segments)).toBe(2)
    expect(lastTextRunStart(segments, true)).toBe(0)
  })
})
