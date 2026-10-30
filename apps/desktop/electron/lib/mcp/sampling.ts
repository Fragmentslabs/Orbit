import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  CreateMessageRequestSchema,
  type CreateMessageRequest,
  type CreateMessageResult,
  type CreateMessageResultWithTools,
  type SamplingMessageContentBlock,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { generateText } from 'ai'
import { StorageKeys } from '@shared/chat'
import { getAppSettings } from '../app-settings'
import { resolveAuxModel } from '../aux-model'
import { readJson } from '../storage'
import { toAiTools, toModelMessages, toStopReason } from './sampling-messages'

/**
 * SAMPLING — the "reverse MCP".
 *
 * In a common MCP server the flow is: Orbit (client) calls the app's tools. Here it is
 * the opposite: the APP (server) asks for `sampling/createMessage` and Orbit — which has
 * the model and the credentials — answers. The app gains AI without managing any API
 * key.
 *
 * The request may bring `tools`: the functions of the app ITSELF, with `inputSchema`. In
 * that case the model does not return loose text — it returns `tool_use` with the
 * arguments already filled in inside the schema, and **whoever executes is the app**.
 * That is what makes the result standardized: the parameter is validated by the schema
 * declared by the application, and execution never leaves its control.
 *
 * Two deliberate limits:
 * - the output tokens are limited (the app is spending the user's account);
 * - the handler does NOT execute anything: without `execute` on the tools, the model
 *   only chooses and fills in. The cycle (result → another attempt) belongs to the app,
 *   which sends the `tool_result` in the next request.
 *
 * The translation of the messages lives in sampling-messages.ts, which is pure and
 * tested.
 */

/** Output ceiling per app request — above that the app is asking too much. */
const SAMPLING_MAX_TOKENS = 4096
const DEFAULT_MAX_TOKENS = 1024

/** Fallback model when there is no model selected on disk yet. */
const FALLBACK_MODEL = { providerId: 'openai', modelId: 'gpt-4o' }

/**
 * What Orbit declares when connecting: without these capabilities a server that sent
 * `sampling/createMessage` would get "method not found" — a common MCP client only
 * TALKS to the server, it never answers it.
 */
export function samplingCapabilities() {
  return { sampling: { tools: {} } }
}

/** The request's model: the auxiliary one from Preferences, otherwise the selected one. */
async function samplingModel() {
  const stored = await readJson<{ providerId?: string; modelId?: string }>(StorageKeys.selectedModel)
  const conversation =
    stored?.providerId && stored?.modelId
      ? { providerId: stored.providerId, modelId: stored.modelId }
      : FALLBACK_MODEL
  const { auxModel } = getAppSettings()
  const resolved = await resolveAuxModel(conversation)
  return {
    ...resolved,
    name: resolved.fallback ? conversation.modelId : (auxModel?.modelId ?? conversation.modelId),
  }
}

/**
 * Answers a `sampling/createMessage`.
 *
 * Returns `tool_use` (the app executes and, if the result does not serve, sends the
 * `tool_result` in the next request for the model to correct it) or text, when the
 * request brought no tools.
 */
async function handleSampling(
  serverName: string,
  request: CreateMessageRequest,
): Promise<CreateMessageResult | CreateMessageResultWithTools> {
  const { messages, systemPrompt, maxTokens, tools, toolChoice } = request.params
  const model = await samplingModel()
  const maxOutputTokens = Math.min(
    Math.max(1, Math.trunc(maxTokens ?? DEFAULT_MAX_TOKENS)),
    SAMPLING_MAX_TOKENS,
  )
  const hasTools = Boolean(tools?.length)

  console.log(
    `[mcp:sampling] ${serverName} asked for a response — ${messages.length} message(s), ` +
      `${tools?.length ?? 0} tool(s), maxTokens=${maxOutputTokens}`,
  )

  try {
    const result = await generateText({
      model: model.model,
      providerOptions: model.providerOptions,
      system: systemPrompt,
      messages: toModelMessages(messages),
      maxOutputTokens,
      ...(hasTools
        ? {
            tools: toAiTools(tools as Tool[]),
            toolChoice:
              toolChoice?.mode === 'required'
                ? ('required' as const)
                : toolChoice?.mode === 'none'
                  ? ('none' as const)
                  : ('auto' as const),
          }
        : {}),
    })

    // SAMPLING blocks (not ContentBlock): it is this union that has `tool_use`.
    const blocks: SamplingMessageContentBlock[] = []
    if (result.text) blocks.push({ type: 'text', text: result.text })
    for (const call of result.toolCalls ?? []) {
      blocks.push({
        type: 'tool_use',
        id: call.toolCallId,
        name: call.toolName,
        input: (call.input ?? {}) as Record<string, unknown>,
      })
    }
    const usedTools = blocks.some((block) => block.type === 'tool_use')

    // Two shapes of answer, and the schema is different in each one: only the variant WITH
    // tools accepts an ARRAY of blocks (it is the one that carries `tool_use`). Without
    // tools, MCP expects ONE block — returning an array there is refused in validation, on
    // the app's side.
    if (hasTools) {
      return {
        model: model.name,
        role: 'assistant',
        content: blocks.length ? blocks : [{ type: 'text', text: '' }],
        stopReason: toStopReason(result.finishReason, usedTools),
      } satisfies CreateMessageResultWithTools
    }

    return {
      model: model.name,
      role: 'assistant',
      content: { type: 'text', text: result.text ?? '' },
      stopReason: toStopReason(result.finishReason, false),
    } satisfies CreateMessageResult
  } catch (err) {
    // The error goes up as a JSON-RPC error of the request: the app has to know that there
    // was no answer (missing key, model unavailable) instead of receiving an empty text
    // that would pass for a model response.
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[mcp:sampling] failed to answer ${serverName}:`, message)
    throw new Error(`Orbit could not answer the sampling request: ${message}`)
  }
}

/** Attaches the sampling handler to a server's client. */
export function attachSamplingHandler(client: Client, serverName: string): void {
  client.setRequestHandler(CreateMessageRequestSchema, (request) =>
    handleSampling(serverName, request as CreateMessageRequest),
  )
}
