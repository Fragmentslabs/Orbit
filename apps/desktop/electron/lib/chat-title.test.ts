import { describe, expect, it } from 'vitest'
import {
  looksLikeToolCall,
  resolveTitle,
  titleFromAttachmentNames,
  titleFromUserText,
  truncateTitle,
} from './chat-title'

const BENCHMARK_PROMPT =
  'Benchmark de navegação de código. Use SOMENTE glob, grep, ls e read.\n\nResponda às 4 perguntas sobre este projeto.'

/**
 * Com deepseek-v4.1-flash (opencode-go), o modelo de título executou a tarefa
 * da mensagem em vez de nomeá-la e devolveu a chamada de ferramenta como texto
 * — que virou o título do chat na barra lateral.
 */
describe('resolveTitle', () => {
  const fallback = titleFromUserText(BENCHMARK_PROMPT)

  it('descarta o DSML da DeepSeek e usa a mensagem do usuário', () => {
    const dsml =
      '<｜DSML｜function_calls>\n<｜DSML｜invoke name="codesearch">\n' +
      '<｜DSML｜parameter name="query">resolveSafePath</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>'
    expect(looksLikeToolCall(dsml)).toBe(true)
    expect(resolveTitle(dsml, fallback)).toBe('Benchmark de navegação de código')
    // A forma já mutilada que ficou gravada também é reconhecida
    expect(resolveTitle('<｜DSML｜ calls <｜DSML｜ invoke name="codesearch"', fallback)).toBe(fallback)
  })

  it('descarta <toolcall> com JSON e usa a mensagem do usuário', () => {
    const toolcall = '<toolcall>{"name":"ls","arguments":{"path":"."}}</toolcall>'
    expect(looksLikeToolCall(toolcall)).toBe(true)
    expect(resolveTitle(toolcall, fallback)).toBe('Benchmark de navegação de código')
  })

  it('descarta outras formas de chamada de ferramenta', () => {
    for (const raw of [
      '{"name":"ls","arguments":{"path":"."}}',
      '<tool_call>\n{"name": "read", "arguments": {"file": "a.ts"}}\n</tool_call>',
      '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>ls',
      '[TOOL_CALLS] [{"name": "ls", "arguments": {}}]',
      '<function=ls>{"path": "."}</function>',
    ]) {
      expect(resolveTitle(raw, fallback)).toBe(fallback)
    }
  })

  it('mantém títulos legítimos', () => {
    expect(looksLikeToolCall('Benchmark de navegação no Orbit')).toBe(false)
    expect(resolveTitle('**Benchmark de navegação no Orbit**', fallback)).toBe('Benchmark de navegação no Orbit')
    expect(resolveTitle('<think>hmm</think>Análise do projeto', fallback)).toBe('Análise do projeto')
  })

  it('usa a reserva quando a limpeza não deixa nada', () => {
    expect(resolveTitle('<think></think>  ', fallback)).toBe(fallback)
  })
})

describe('titleFromUserText', () => {
  it('pega a primeira frase da primeira linha e respeita o limite', () => {
    expect(titleFromUserText('\n\nComo funciona o cache? Quero detalhes.')).toBe('Como funciona o cache')
    expect(titleFromUserText('a '.repeat(60)).length).toBeLessThanOrEqual(50)
    expect(truncateTitle('x'.repeat(80))).toHaveLength(50)
  })
})

describe('titleFromAttachmentNames', () => {
  it('usa o nome do primeiro anexo, sem extensão', () => {
    expect(titleFromAttachmentNames([{ filename: 'Contrato de aluguel.pdf' }])).toBe('Contrato de aluguel')
    expect(titleFromAttachmentNames([{ filename: 'relatorio_final.xlsx' }])).toBe('relatorio final')
  })

  it('ignora chips e anexos sem nome', () => {
    expect(
      titleFromAttachmentNames([
        { filename: 'foto.png', chip: true },
        {},
        { filename: 'planta-baixa.jpg' },
      ]),
    ).toBe('planta baixa')
  })

  it('não come um "ponto decimal" no lugar da extensão', () => {
    expect(titleFromAttachmentNames([{ filename: 'versao 1.2' }])).toBe('versao 1.2')
  })

  it('devolve vazio quando não há nada utilizável', () => {
    expect(titleFromAttachmentNames(undefined)).toBe('')
    expect(titleFromAttachmentNames([{}])).toBe('')
  })
})
