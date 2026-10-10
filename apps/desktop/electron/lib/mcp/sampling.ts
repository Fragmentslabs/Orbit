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
 * SAMPLING — o "MCP inverso".
 *
 * Num servidor MCP comum o fluxo é: o Orbit (cliente) chama as ferramentas do
 * app. Aqui é o contrário: o APP (servidor) pede `sampling/createMessage` e o
 * Orbit — que tem o modelo e as credenciais — responde. O app ganha IA sem
 * gerir API key nenhuma.
 *
 * O pedido pode trazer `tools`: as funções do PRÓPRIO app, com `inputSchema`.
 * Nesse caso o modelo não devolve texto solto — devolve `tool_use` com os
 * argumentos já preenchidos dentro do schema, e **quem executa é o app**. É
 * isso que torna o resultado padronizado: o parâmetro é validado pelo schema
 * declarado pela aplicação, e a execução nunca sai do controle dela.
 *
 * Dois limites deliberados:
 * - os tokens de saída são limitados (o app está gastando a conta do usuário);
 * - o handler NÃO executa nada: sem `execute` nas tools, o modelo apenas
 *   escolhe e preenche. O ciclo (resultado → nova tentativa) é do app, que
 *   manda o `tool_result` no pedido seguinte.
 *
 * A tradução das mensagens vive em sampling-messages.ts, que é pura e testada.
 */

/** Teto de saída por pedido de app — acima disso é o app pedindo demais. */
const SAMPLING_MAX_TOKENS = 4096
const DEFAULT_MAX_TOKENS = 1024

/** Modelo de reserva quando ainda não há modelo selecionado em disco. */
const FALLBACK_MODEL = { providerId: 'openai', modelId: 'gpt-4o' }

/**
 * O que o Orbit declara ao conectar: sem estas capabilities um servidor que
 * mandasse `sampling/createMessage` receberia "method not found" — um client
 * MCP comum só FALA com o servidor, nunca responde a ele.
 */
export function samplingCapabilities() {
  return { sampling: { tools: {} } }
}

/** O modelo do pedido: o auxiliar das Preferências, senão o selecionado. */
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
 * Responde um `sampling/createMessage`.
 *
 * Devolve `tool_use` (o app executa e, se o resultado não servir, manda o
 * `tool_result` no pedido seguinte para o modelo corrigir) ou texto, quando o
 * pedido não trouxe ferramentas.
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
    `[mcp:sampling] ${serverName} pediu uma resposta — ${messages.length} mensagem(ns), ` +
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

    // Blocos de SAMPLING (não ContentBlock): é esta união que tem `tool_use`.
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

    // Duas formas de resposta, e o schema é diferente em cada uma: só a
    // variante COM tools aceita um ARRAY de blocos (é ela que carrega
    // `tool_use`). Sem tools, o MCP espera UM bloco — devolver array ali é
    // recusado na validação, do lado do app.
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
    // O erro sobe como erro JSON-RPC do pedido: o app precisa saber que não
    // houve resposta (chave ausente, modelo indisponível) em vez de receber um
    // texto vazio que passaria por resposta do modelo.
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[mcp:sampling] falha ao responder ${serverName}:`, message)
    throw new Error(`Orbit não conseguiu responder à amostragem: ${message}`)
  }
}

/** Liga o handler de sampling no client de um servidor. */
export function attachSamplingHandler(client: Client, serverName: string): void {
  client.setRequestHandler(CreateMessageRequestSchema, (request) =>
    handleSampling(serverName, request as CreateMessageRequest),
  )
}
