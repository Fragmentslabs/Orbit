import { jsonSchema, tool, type ModelMessage, type ToolSet } from 'ai'
import type { ContentBlock, SamplingMessage, Tool } from '@modelcontextprotocol/sdk/types.js'

/**
 * Tradução entre o vocabulário do MCP (sampling) e o do ai-sdk.
 *
 * Módulo puro — sem electron, sem storage, sem rede — porque é aqui que mora o
 * que dá errado em silêncio: o `tool_result` não é uma mensagem no MCP, é um
 * bloco dentro da mensagem do usuário; e o nome da tool não vem no resultado,
 * só o id. Um teste cobre exatamente essas duas voltas.
 */

/** Texto de um bloco de conteúdo do MCP (o que for imagem vira marca). */
export function blockToText(content: ContentBlock[] | undefined): string {
  if (!content?.length) return ''
  return content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'image') return '[imagem]'
      if (block.type === 'audio') return '[áudio]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

type UserPart = { type: 'text'; text: string } | { type: 'image'; image: string; mediaType: string }
type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
type ToolResultPart = {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: { type: 'text'; value: string }
}

/**
 * Blocos de sampling → mensagens do ai-sdk.
 *
 * O mapeamento não é 1:1: no MCP o `tool_result` viaja DENTRO de uma mensagem
 * de usuário, enquanto o ai-sdk o quer numa mensagem de role `tool` — daí a
 * mensagem extra que este laço empurra. O nome da tool não vem no resultado
 * (só o id), então ele é recuperado do `tool_use` visto antes na conversa.
 */
export function toModelMessages(messages: SamplingMessage[]): ModelMessage[] {
  const out: ModelMessage[] = []
  const toolNames = new Map<string, string>()

  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content]

    if (message.role === 'assistant') {
      const parts: AssistantPart[] = []
      for (const block of blocks) {
        if (block.type === 'text') parts.push({ type: 'text', text: block.text })
        else if (block.type === 'tool_use') {
          toolNames.set(block.id, block.name)
          parts.push({ type: 'tool-call', toolCallId: block.id, toolName: block.name, input: block.input })
        } else console.warn('[mcp:sampling] bloco ignorado na resposta:', block.type)
      }
      if (parts.length) out.push({ role: 'assistant', content: parts })
      continue
    }

    const parts: UserPart[] = []
    const results: ToolResultPart[] = []
    for (const block of blocks) {
      if (block.type === 'text') parts.push({ type: 'text', text: block.text })
      else if (block.type === 'image') parts.push({ type: 'image', image: block.data, mediaType: block.mimeType })
      else if (block.type === 'tool_result') {
        results.push({
          type: 'tool-result',
          toolCallId: block.toolUseId,
          toolName: toolNames.get(block.toolUseId) ?? 'desconhecida',
          output: { type: 'text', value: blockToText(block.content) || '(sem conteúdo)' },
        })
      } else console.warn('[mcp:sampling] bloco ignorado no pedido:', block.type)
    }
    if (parts.length) out.push({ role: 'user', content: parts })
    if (results.length) out.push({ role: 'tool', content: results })
  }

  return out
}

/**
 * Tools declaradas pelo app → ToolSet do ai-sdk.
 *
 * SEM `execute`: o Orbit não executa nada. O modelo escolhe e preenche os
 * parâmetros, e quem roda a função é o app — a execução nunca sai do controle
 * de quem declarou a ferramenta.
 */
export function toAiTools(tools: Tool[]): ToolSet {
  const set: ToolSet = {}
  for (const definition of tools) {
    set[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema((definition.inputSchema ?? { type: 'object' }) as Record<string, unknown>),
    })
  }
  return set
}

/** `finishReason` do modelo → `stopReason` do MCP. */
export function toStopReason(finishReason: string, usedTools: boolean): string {
  if (usedTools) return 'toolUse'
  if (finishReason === 'length') return 'maxTokens'
  return 'endTurn'
}
