import { describe, expect, it } from 'vitest'
import type { SamplingMessage, Tool } from '@modelcontextprotocol/sdk/types.js'
import { blockToText, toAiTools, toModelMessages, toStopReason } from './sampling-messages'

describe('toModelMessages', () => {
  it('leva texto do usuário como mensagem de usuário', () => {
    const messages = [
      { role: 'user', content: { type: 'text', text: 'Beber água de 5 em 5 dias' } },
    ] satisfies SamplingMessage[]

    expect(toModelMessages(messages)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Beber água de 5 em 5 dias' }] },
    ])
  })

  it('leva a imagem como parte de imagem, com o mimeType declarado', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'o que é isto?' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
      },
    ] satisfies SamplingMessage[]

    expect(toModelMessages(messages)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'o que é isto?' },
          { type: 'image', image: 'AAAA', mediaType: 'image/png' },
        ],
      },
    ])
  })

  it('leva o tool_use do assistente como tool-call', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'vou criar' },
          { type: 'tool_use', id: 'call-1', name: 'stacks_create_task', input: { title: 'Beber água' } },
        ],
      },
    ] satisfies SamplingMessage[]

    expect(toModelMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'vou criar' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'stacks_create_task',
            input: { title: 'Beber água' },
          },
        ],
      },
    ])
  })

  it('separa o tool_result numa mensagem de role tool e recupera o nome da tool pelo id', () => {
    // O app devolveu o resultado da execução: no MCP isso viaja junto da
    // mensagem do usuário, e o ai-sdk quer uma mensagem `tool` própria — com o
    // NOME da ferramenta, que o resultado do MCP não carrega (só o id).
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: 'stacks_create_task', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'call-1', content: [{ type: 'text', text: 'erro: interval inválido' }] },
        ],
      },
    ] satisfies SamplingMessage[]

    expect(toModelMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'stacks_create_task', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'stacks_create_task',
            output: { type: 'text', value: 'erro: interval inválido' },
          },
        ],
      },
    ])
  })

  it('marca o resultado sem conteúdo em vez de mandar vazio', () => {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'call-9', content: [] }],
      },
    ] satisfies SamplingMessage[]

    // Sem texto/imagem, não nasce mensagem de usuário: só a do resultado.
    expect(toModelMessages(messages)).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-9',
            toolName: 'desconhecida',
            output: { type: 'text', value: '(sem conteúdo)' },
          },
        ],
      },
    ])
  })
})

describe('blockToText', () => {
  it('junta os textos e marca o que não é texto', () => {
    expect(
      blockToText([
        { type: 'text', text: 'linha 1' },
        { type: 'image', data: 'AA', mimeType: 'image/png' },
        { type: 'text', text: 'linha 2' },
      ]),
    ).toBe('linha 1\n[imagem]\nlinha 2')
  })

  it('sem blocos, devolve string vazia', () => {
    expect(blockToText(undefined)).toBe('')
    expect(blockToText([])).toBe('')
  })
})

describe('toAiTools', () => {
  const tools: Tool[] = [
    {
      name: 'stacks_create_task',
      description: 'Cria uma tarefa no Stacks.',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, priority: { enum: ['low', 'high'] } },
        required: ['title'],
      },
    },
  ]

  it('usa o nome declarado pelo app e mantém a descrição e o schema', () => {
    const set = toAiTools(tools)
    expect(Object.keys(set)).toEqual(['stacks_create_task'])
    expect(set.stacks_create_task.description).toBe('Cria uma tarefa no Stacks.')
    expect(set.stacks_create_task.inputSchema).toBeTruthy()
  })

  it('schema vazio do app não vira schema ausente', () => {
    const set = toAiTools([{ name: 'sem_props', inputSchema: { type: 'object' } }])
    expect(set.sem_props.inputSchema).toBeTruthy()
  })
})

describe('toStopReason', () => {
  it('toolUse quando o modelo chamou uma ferramenta', () => {
    expect(toStopReason('tool-calls', true)).toBe('toolUse')
  })

  it('maxTokens quando cortou pelo limite de saída', () => {
    expect(toStopReason('length', false)).toBe('maxTokens')
  })

  it('endTurn no resto', () => {
    expect(toStopReason('stop', false)).toBe('endTurn')
  })
})
