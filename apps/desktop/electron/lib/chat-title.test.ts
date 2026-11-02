import { describe, expect, it } from 'vitest'
import {
  attachmentTextHint,
  looksLikeRefusal,
  looksLikeToolCall,
  resolveTitle,
  titleFromAttachmentNames,
  titleFromUserText,
  truncateTitle,
} from './chat-title'

const BENCHMARK_PROMPT =
  'Code navigation benchmark. Use ONLY glob, grep, ls and read.\n\nAnswer the 4 questions about this project.'

/**
 * With deepseek-v4.1-flash (opencode-go), the title model executed the message's
 * task instead of naming it and returned the tool call as text
 * — which became the chat title in the sidebar.
 */
describe('resolveTitle', () => {
  const fallback = titleFromUserText(BENCHMARK_PROMPT)

  it('discards DeepSeek DSML and uses the user message', () => {
    const dsml =
      '<｜DSML｜function_calls>\n<｜DSML｜invoke name="codesearch">\n' +
      '<｜DSML｜parameter name="query">resolveSafePath</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>'
    expect(looksLikeToolCall(dsml)).toBe(true)
    expect(resolveTitle(dsml, fallback)).toBe('Code navigation benchmark')
    // The already mutilated form that got written is recognized as well
    expect(resolveTitle('<｜DSML｜ calls <｜DSML｜ invoke name="codesearch"', fallback)).toBe(fallback)
  })

  it('discards <toolcall> with JSON and uses the user message', () => {
    const toolcall = '<toolcall>{"name":"ls","arguments":{"path":"."}}</toolcall>'
    expect(looksLikeToolCall(toolcall)).toBe(true)
    expect(resolveTitle(toolcall, fallback)).toBe('Code navigation benchmark')
  })

  it('discards other forms of tool call', () => {
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

  it('keeps legitimate titles', () => {
    expect(looksLikeToolCall('Navigation benchmark in Orbit')).toBe(false)
    expect(resolveTitle('**Navigation benchmark in Orbit**', fallback)).toBe('Navigation benchmark in Orbit')
    expect(resolveTitle('<think>hmm</think>Project analysis', fallback)).toBe('Project analysis')
  })

  it('uses the fallback when the cleanup leaves nothing', () => {
    expect(resolveTitle('<think></think>  ', fallback)).toBe(fallback)
  })
})

/**
 * Told that "the user sent files" and given nothing it could read, the title
 * model answered the prompt instead of naming the chat: "Não consigo acessar os
 * arquivos anexados" became the title of the conversation.
 */
describe('looksLikeRefusal', () => {
  it('rejects what a model answers when it cannot read the attachments', () => {
    for (const raw of [
      'Não consigo acessar os arquivos anexados',
      'Não tenho acesso aos arquivos.',
      "I can't access the attached files.",
      'I am unable to open the files you attached.',
      'No puedo acceder a los archivos adjuntos.',
    ]) {
      expect(looksLikeRefusal(raw)).toBe(true)
      expect(resolveTitle(raw, 'Relatório')).toBe('Relatório')
    }
  })

  it('keeps a title that only sounds like a problem', () => {
    expect(looksLikeRefusal('Painel de vendas sem acesso')).toBe(false)
    expect(resolveTitle('Painel de vendas sem acesso', 'x')).toBe('Painel de vendas sem acesso')
  })
})

describe('attachmentTextHint', () => {
  it('reads the beginning of a text data URL (base64)', () => {
    const url = `data:text/markdown;base64,${Buffer.from('# Orçamento\nconteúdo').toString('base64')}`
    expect(attachmentTextHint([{ url, mime: 'text/markdown' }])).toBe('# Orçamento\nconteúdo')
  })

  it('ignores what is not text, and what is not a data URL', () => {
    expect(attachmentTextHint([{ url: 'data:image/png;base64,AAAA', mime: 'image/png' }])).toBe('')
    expect(attachmentTextHint([{ url: 'blob:x', mime: 'text/plain' }])).toBe('')
    expect(attachmentTextHint(undefined)).toBe('')
  })
})

describe('titleFromUserText', () => {
  it('takes the first sentence of the first line and respects the limit', () => {
    expect(titleFromUserText('\n\nHow does the cache work? I want details.')).toBe('How does the cache work')
    expect(titleFromUserText('a '.repeat(60)).length).toBeLessThanOrEqual(50)
    expect(truncateTitle('x'.repeat(80))).toHaveLength(50)
  })
})

describe('titleFromAttachmentNames', () => {
  it('uses the name of the first attachment, without the extension', () => {
    expect(titleFromAttachmentNames([{ filename: 'Rental agreement.pdf' }])).toBe('Rental agreement')
    expect(titleFromAttachmentNames([{ filename: 'final_report.xlsx' }])).toBe('final report')
  })

  it('ignores chips and attachments without a name', () => {
    expect(
      titleFromAttachmentNames([
        { filename: 'photo.png', chip: true },
        {},
        { filename: 'floor-plan.jpg' },
      ]),
    ).toBe('floor plan')
  })

  it('does not eat a "decimal point" in place of the extension', () => {
    expect(titleFromAttachmentNames([{ filename: 'version 1.2' }])).toBe('version 1.2')
  })

  it('returns empty when there is nothing usable', () => {
    expect(titleFromAttachmentNames(undefined)).toBe('')
    expect(titleFromAttachmentNames([{}])).toBe('')
  })
})
