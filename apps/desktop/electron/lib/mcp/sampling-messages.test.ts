import { describe, expect, it } from 'vitest'
import type { SamplingMessage, Tool } from '@modelcontextprotocol/sdk/types.js'
import { blockToText, toAiTools, toModelMessages, toStopReason } from './sampling-messages'

describe('toModelMessages', () => {
  it('takes user text as a user message', () => {
    const messages = [
      { role: 'user', content: { type: 'text', text: 'Beber água de 5 em 5 dias' } },
    ] satisfies SamplingMessage[]

    expect(toModelMessages(messages)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Beber água de 5 em 5 dias' }] },
    ])
  })

  it('takes the image as an image part, with the declared mimeType', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
      },
    ] satisfies SamplingMessage[]

    expect(toModelMessages(messages)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', image: 'AAAA', mediaType: 'image/png' },
        ],
      },
    ])
  })

  it('takes the assistant tool_use as a tool-call', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will create' },
          { type: 'tool_use', id: 'call-1', name: 'stacks_create_task', input: { title: 'Drink water' } },
        ],
      },
    ] satisfies SamplingMessage[]

    expect(toModelMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will create' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'stacks_create_task',
            input: { title: 'Drink water' },
          },
        ],
      },
    ])
  })

  it('splits the tool_result into a tool-role message and recovers the tool name by id', () => {
    // The app returned the result of the execution: in MCP that travels together with the
    // user message, and the ai-sdk wants its own `tool` message — with the NAME of the
    // tool, which the MCP result does not carry (only the id).
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: 'stacks_create_task', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'call-1', content: [{ type: 'text', text: 'error: invalid interval' }] },
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
            output: { type: 'text', value: 'error: invalid interval' },
          },
        ],
      },
    ])
  })

  it('marks the result with no content instead of sending it empty', () => {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'call-9', content: [] }],
      },
    ] satisfies SamplingMessage[]

    // Without text/image, no user message is born: only the one for the result.
    expect(toModelMessages(messages)).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-9',
            toolName: 'desconhecida',
            output: { type: 'text', value: '(no content)' },
          },
        ],
      },
    ])
  })
})

describe('blockToText', () => {
  it('joins the texts and marks what is not text', () => {
    expect(
      blockToText([
        { type: 'text', text: 'line 1' },
        { type: 'image', data: 'AA', mimeType: 'image/png' },
        { type: 'text', text: 'line 2' },
      ]),
    ).toBe('line 1\n[image]\nline 2')
  })

  it('with no blocks, it returns an empty string', () => {
    expect(blockToText(undefined)).toBe('')
    expect(blockToText([])).toBe('')
  })
})

describe('toAiTools', () => {
  const tools: Tool[] = [
    {
      name: 'stacks_create_task',
      description: 'Creates a task in Stacks.',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, priority: { enum: ['low', 'high'] } },
        required: ['title'],
      },
    },
  ]

  it('uses the name declared by the app and keeps the description and the schema', () => {
    const set = toAiTools(tools)
    expect(Object.keys(set)).toEqual(['stacks_create_task'])
    expect(set.stacks_create_task.description).toBe('Creates a task in Stacks.')
    expect(set.stacks_create_task.inputSchema).toBeTruthy()
  })

  it('an empty app schema does not become an absent schema', () => {
    const set = toAiTools([{ name: 'without_props', inputSchema: { type: 'object' } }])
    expect(set.without_props.inputSchema).toBeTruthy()
  })
})

describe('toStopReason', () => {
  it('toolUse when the model called a tool', () => {
    expect(toStopReason('tool-calls', true)).toBe('toolUse')
  })

  it('maxTokens when it cut at the output limit', () => {
    expect(toStopReason('length', false)).toBe('maxTokens')
  })

  it('endTurn no resto', () => {
    expect(toStopReason('stop', false)).toBe('endTurn')
  })
})
