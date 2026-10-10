import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CreateMessageResult, CreateMessageResultWithTools } from '@modelcontextprotocol/sdk/types.js'

/**
 * O encanamento do "MCP inverso": um servidor MCP de verdade pede uma
 * amostragem e recebe resposta.
 *
 * Só o modelo é dublado (não há credencial num teste); o resto é o caminho
 * real — capability declarada, handler ligado, transporte, resposta montada.
 * O que este teste existe para pegar é justamente o que falha calado: sem a
 * capability o servidor levaria "method not found", e o app veria um erro
 * incompreensível em vez da resposta.
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

/** Servidor + client ligados por um transporte em memória, com o handler ligado. */
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
  it('responde texto quando o app não manda ferramentas', async () => {
    generateText.mockResolvedValue({ text: 'Beber água', toolCalls: [], finishReason: 'stop' })
    const { server } = await connectedPair()

    const result = (await server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'Beber água de 5 em 5 dias' } }],
      maxTokens: 500,
    })) as CreateMessageResult

    expect(result.role).toBe('assistant')
    expect(result.stopReason).toBe('endTurn')
    // Bloco ÚNICO: sem tools o MCP recusa array de conteúdo.
    expect(result.content).toEqual({ type: 'text', text: 'Beber água' })
  })

  it('devolve tool_use preenchido e NÃO executa a ferramenta', async () => {
    generateText.mockResolvedValue({
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [
        {
          toolCallId: 'call-1',
          toolName: 'stacks_create_task',
          input: { title: 'Beber água', recurrence: { freq: 'daily', interval: 5 } },
        },
      ],
    })
    const { server } = await connectedPair()

    const result = (await server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'Beber água de 5 em 5 dias' } }],
      maxTokens: 500,
      tools: [
        {
          name: 'stacks_create_task',
          description: 'Cria uma tarefa no Stacks.',
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
        input: { title: 'Beber água', recurrence: { freq: 'daily', interval: 5 } },
      },
    ])

    // A ferramenta foi OFERECIDA ao modelo e nada mais: quem executa é o app.
    const call = generateText.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(Object.keys(call.tools as object)).toEqual(['stacks_create_task'])
    expect(call.toolChoice).toBe('required')
  })

  it('limita os tokens de saída pedidos pelo app', async () => {
    generateText.mockResolvedValue({ text: 'ok', toolCalls: [], finishReason: 'stop' })
    const { server } = await connectedPair()

    await server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'oi' } }],
      maxTokens: 999_999,
    })

    const call = generateText.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(call.maxOutputTokens).toBe(4096)
  })

  it('leva o systemPrompt do app como system do modelo', async () => {
    generateText.mockResolvedValue({ text: 'ok', toolCalls: [], finishReason: 'stop' })
    const { server } = await connectedPair()

    await server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'oi' } }],
      systemPrompt: 'Você converte frases em tarefas.',
      maxTokens: 100,
    })

    const call = generateText.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(call.system).toBe('Você converte frases em tarefas.')
  })

  it('falha do modelo vira erro do pedido, não resposta vazia', async () => {
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
