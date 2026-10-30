import { jsonSchema, tool, type ModelMessage, type ToolSet } from 'ai'
import type { ContentBlock, SamplingMessage, Tool } from '@modelcontextprotocol/sdk/types.js'

/**
 * Translation between the MCP (sampling) vocabulary and the ai-sdk one.
 *
 * A pure module — no electron, no storage, no network — because this is where things
 * fail silently: the `tool_result` is not a message in MCP, it is a block inside the
 * user message; and the tool name does not come in the result, only the id. A test
 * covers exactly those two round trips.
 */

/** Text of an MCP content block (whatever is an image becomes a marker). */
export function blockToText(content: ContentBlock[] | undefined): string {
  if (!content?.length) return ''
  return content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'image') return '[image]'
      if (block.type === 'audio') return '[audio]'
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
 * Sampling blocks → ai-sdk messages.
 *
 * The mapping is not 1:1: in MCP the `tool_result` travels INSIDE a user message,
 * while the ai-sdk wants it in a message with role `tool` — hence the extra message
 * this loop pushes. The tool name does not come in the result (only the id), so it is
 * retrieved from the `tool_use` seen earlier in the conversation.
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
        } else console.warn('[mcp:sampling] block ignored in the response:', block.type)
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
          output: { type: 'text', value: blockToText(block.content) || '(no content)' },
        })
      } else console.warn('[mcp:sampling] block ignored in the request:', block.type)
    }
    if (parts.length) out.push({ role: 'user', content: parts })
    if (results.length) out.push({ role: 'tool', content: results })
  }

  return out
}

/**
 * Tools declared by the app → ai-sdk ToolSet.
 *
 * WITHOUT `execute`: Orbit executes nothing. The model chooses and fills in the
 * parameters, and whoever runs the function is the app — execution never leaves the
 * control of whoever declared the tool.
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

/** Model `finishReason` → MCP `stopReason`. */
export function toStopReason(finishReason: string, usedTools: boolean): string {
  if (usedTools) return 'toolUse'
  if (finishReason === 'length') return 'maxTokens'
  return 'endTurn'
}
