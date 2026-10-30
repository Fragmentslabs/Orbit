import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CreateMessageResult, CreateMessageResultWithTools } from '@modelcontextprotocol/sdk/types.js'

/**
 * The plumbing of the "reverse MCP": a real MCP server asks for a sample and gets an
 * answer.
 *
 * Only the model is doubled (there is no credential in a test); the rest is the real
 * path — capability declared, handler attached, transport, answer assembled. What this
 * test exists to catch is exactly what fails quietly: without the capability the server
 * would get "method not found", and the app would see an incomprehensible error instead
 * of the answer.
 */

const generateText = vi.fn()

vi.mock('../storage', () => ({ readJson: vi.fn(async () => null) }))
vi.mock('../app-settings', () => ({ getAppSettings: () => ({ auxModel: null, auxReasoning: null }) }))
vi.mock('../aux-model', () => ({
  resolveAuxModel: async () => ({ model: { modelo: 'falso' }, fallback: true }),
}))
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: (...args: unknown[]) => generateText(...args) }
})

const { attachSamplingHandler, samplingCapabilities } = await import('./sampling')

/** Server + client connected by an in-memory transport, with the handler attached. */
async function connectedPair() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client(
    { name: 'orbit', version: '0' },
    { capabilities: samplingCapabilities() },
  )
  attachSamplingHandler(client, 'stacks')
  const server = new Server({ name: 'stacks', version: '1' }, { capabilities: {} })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return { client, server }
}

describe('sampling', () => {
  it('answers with text when the app sends no tools', async () => {
    generateText.mockResolvedValue({ text: 'Drink water', toolCalls: [], finishReason: 'stop' })
    const { server } = await connectedPair()

    const result = (await server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'Drink water every 5 days' } }],
      maxTokens: 500,
    })) as CreateMessageResult

    expect(result.role).toBe('assistant')
    expect(result.stopReason).toBe('endTurn')
    // A SINGLE block: without tools MCP refuses an array of content.
    expect(result.content).toEqual({ type: 'text', text: 'Drink water' })
  })

  it('returns a filled tool_use and does NOT run the tool', async () => {
    generateText.mockResolvedValue({
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [
        {
          toolCallId: 'call-1',
          toolName: 'stacks_create_task',
          input: { title: 'Drink water', recurrence: { freq: 'daily', interval: 5 } },
        },
      ],
    })
    const { server } = await connectedPair()

    const result = (await server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'Drink water every 5 days' } }],
      maxTokens: 500,
      tools: [
        {
          name: 'stacks_create_task',
          description: 'Creates a task in Stacks.',
          inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        },
      ],
      toolChoice: { mode: 'required' },
    })) as CreateMessageResultWithTools

    expect(result.stopReason).toBe('toolUse')
    expect(result.content).toEqual([
      {
        type: 'tool_use',
        id: 'call-1',
        name: 'stacks_create_task',
        input: { title: 'Drink water', recurrence: { freq: 'daily', interval: 5 } },
      },
    ])

    // The tool was OFFERED to the model and nothing more: whoever executes is the app.
    const call = generateText.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(Object.keys(call.tools as object)).toEqual(['stacks_create_task'])
    expect(call.toolChoice).toBe('required')
  })

  it('limits the output tokens requested by the app', async () => {
    generateText.mockResolvedValue({ text: 'ok', toolCalls: [], finishReason: 'stop' })
    const { server } = await connectedPair()

    await server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'oi' } }],
      maxTokens: 999_999,
    })

    const call = generateText.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(call.maxOutputTokens).toBe(4096)
  })

  it('takes the app systemPrompt as the model system', async () => {
    generateText.mockResolvedValue({ text: 'ok', toolCalls: [], finishReason: 'stop' })
    const { server } = await connectedPair()

    await server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'oi' } }],
      systemPrompt: 'You turn sentences into tasks.',
      maxTokens: 100,
    })

    const call = generateText.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(call.system).toBe('You turn sentences into tasks.')
  })

  it('a model failure becomes a request error, not an empty response', async () => {
    generateText.mockRejectedValue(new Error('No API key configured for OpenAI'))
    const { server } = await connectedPair()

    await expect(
      server.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: 'oi' } }],
        maxTokens: 100,
      }),
    ).rejects.toThrow(/No API key configured/)
  })
})
