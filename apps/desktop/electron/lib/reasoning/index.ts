import type { JSONValue, ModelMessage, ToolContent } from 'ai'
import type { CatalogProvider, SendMessageInput } from '@shared/chat'
import { getProvider } from '../catalog'
import { isServedByOpenAiCompatible } from '../providers'
import { mergeOptions } from './merge'
import { buildBaseOptions } from './options'
import { generateVariants, toModelInput } from './variants'

export { buildBaseOptions } from './options'
export { buildSmallOptions } from './small-options'
export type { ModelInput, VariantMap, VariantPayload } from './types'
export { generateVariants, isAlwaysOnModel, toModelInput, variantLabel } from './variants'

/**
 * Namespace de providerOptions lido por cada SDK empacotado. Provedores que
 * caem no adaptador openai-compatible usam o id do provedor como namespace
 * (createOpenAICompatible({ name: provider.id }) em providers.ts).
 */
const SDK_NAMESPACES: Record<string, string> = {
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/google': 'google',
  '@ai-sdk/openai': 'openai',
}

/**
 * Constrói o providerOptions da requisição a partir da configuração de
 * reasoning: baseline do provedor → payload da variant selecionada → wrap no
 * namespace do SDK. Retorna undefined quando thinking está desligado ou o
 * modelo não suporta reasoning.
 */
export async function buildProviderOptions(
  input: SendMessageInput,
): Promise<Record<string, Record<string, JSONValue>> | undefined> {
  const reasoning = input.options.reasoning
  if (!reasoning?.enabled) return undefined

  const provider = await getProvider(input.providerId)
  const model = provider?.models[input.modelId]
  if (!provider || !model?.reasoning) return undefined

  const modelInput = toModelInput(input.providerId, provider.npm, model)
  const variants = generateVariants(modelInput)

  // Variant desconhecida ou não selecionada: usa apenas o baseline.
  const variantPayload =
    reasoning.variantId && variants[reasoning.variantId] ? variants[reasoning.variantId] : {}

  const base = buildBaseOptions(modelInput, input.sessionId)
  const merged = mergeOptions(base, variantPayload)
  if (Object.keys(merged).length === 0) return undefined

  const namespace = SDK_NAMESPACES[modelInput.npm] ?? input.providerId
  return { [namespace]: merged as Record<string, JSONValue> }
}

/**
 * Campo usado para reenviar o raciocínio na mensagem do assistente — portado
 * do opencode (provider.ts → interleaved default). Modelos DeepSeek servidos
 * pelo adaptador openai-compatible usam `reasoning_content`; o DeepSeek exige
 * o campo em TODAS as mensagens de assistente em turnos seguintes, mesmo
 * quando vazio (senão a API retorna 400). O gate usa a regra de resolução real
 * do runtime (isServedByOpenAiCompatible), não só o npm do catálogo — senão
 * provedores como OpenRouter (npm "@openrouter/ai-sdk-provider", servido via
 * createOpenAICompatible no resolveModel) ficariam de fora.
 */
export function interleavedReasoningField(
  provider: CatalogProvider | undefined,
  modelId: string,
): string | undefined {
  if (isServedByOpenAiCompatible(provider?.npm) && modelId.toLowerCase().includes('deepseek')) {
    return 'reasoning_content'
  }
  return undefined
}

/**
 * Garante que o conteúdo de mensagens de tool nunca quebre o conversor do
 * adaptador openai-compatible: ele lê `output.type` de cada part que não seja
 * `tool-approval-response` (openai-compatible/dist/internal/index.js, case
 * "tool") e lança `TypeError: Cannot read properties of undefined (reading
 * 'type')` quando `output` está ausente — edge cases do tool loop do SDK podem
 * produzir parts assim. Parts sem output válido viram um `tool-result` com
 * output de texto neutro; conteúdo que não é array (ex: string, que o
 * `for...of` do conversor iteraria por caracteres) é normalizado para array; e
 * null/undefined vira `[]` (o SDK descarta mensagens de tool vazias). Retorna
 * a mesma referência quando nada muda.
 */
function sanitizeToolContent(content: ToolContent): ToolContent {
  if (content == null) return []
  if (!Array.isArray(content)) {
    const text = String(content)
    if (text.length === 0) return []
    return [
      {
        type: 'tool-result',
        toolCallId: '',
        toolName: '',
        output: { type: 'text', value: text },
      },
    ]
  }
  let changed = false
  const parts = content.map((part) => {
    if (part != null && typeof part === 'object') {
      if (part.type === 'tool-approval-response') return part
      if (part.type === 'tool-result' && part.output && typeof part.output.type === 'string') {
        return part
      }
    }
    changed = true
    const raw = part as { toolCallId?: unknown; toolName?: unknown }
    return {
      type: 'tool-result' as const,
      toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : '',
      toolName: typeof raw.toolName === 'string' ? raw.toolName : '',
      output: {
        type: 'text' as const,
        value:
          typeof part === 'string' || typeof part === 'number' || typeof part === 'boolean'
            ? String(part)
            : '[resultado indisponível]',
      },
    }
  })
  return changed ? parts : content
}

/**
 * Move o raciocínio das mensagens de assistente para o providerOptions do
 * SDK — portado do opencode (transform.ts → normalizeMessages). Sempre define
 * o campo, mesmo vazio: provedores como o DeepSeek exigem o reasoning_content
 * de volta em todas as mensagens de assistente em turnos subsequentes, e o
 * conversor do @ai-sdk/openai-compatible descartaria um valor vazio vindo dos
 * parts (ele só emite `reasoning_content` quando `reasoning.length > 0`).
 *
 * Também roda sempre (independente do campo de reasoning) a sanitização de
 * mensagens de tool via sanitizeToolContent — protege o conversor de parts
 * malformadas produzidas por edge cases do tool loop do SDK.
 *
 * É idempotente: se a mensagem não tem parts de reasoning (porque já foi
 * normalizada antes, ex: prepareStep), preserva o valor já presente no
 * providerOptions em vez de sobrescrever com vazio. Retorna a mesma referência
 * quando nada muda (para o prepareStep devolver `{}` e o SDK pular a reescrita).
 */
export function normalizeMessages(msgs: ModelMessage[], field?: string): ModelMessage[] {
  let changed = false
  const result = msgs.map((msg): ModelMessage => {
    if (msg.role === 'tool') {
      const content = sanitizeToolContent(msg.content)
      if (content !== msg.content) changed = true
      return content === msg.content ? msg : { ...msg, content }
    }
    if (msg.role !== 'assistant' || !field || !Array.isArray(msg.content)) return msg
    changed = true
    const reasoningParts = msg.content.filter(
      (part): part is Extract<ModelMessage, { role: 'assistant' }>['content'][number] & {
        type: 'reasoning'
        text: string
      } => part.type === 'reasoning',
    )
    const existing = msg.providerOptions?.openaiCompatible as Record<string, JSONValue> | undefined
    const reasoningContent =
      reasoningParts.length > 0
        ? reasoningParts.map((part) => part.text).join('')
        : ((existing?.[field] as string | undefined) ?? '')
    const filteredContent = msg.content.filter((part) => part.type !== 'reasoning')
    return {
      ...msg,
      content: filteredContent,
      providerOptions: {
        ...msg.providerOptions,
        openaiCompatible: {
          ...existing,
          [field]: reasoningContent,
        },
      },
    }
  })
  return changed ? result : msgs
}

/**
 * prepareStep para fluxos com tool loop (subagentes, exploração do /init,
 * orquestrador) que reaplica a normalização de reasoning a cada passo: o SDK
 * reconstrói as mensagens entre steps e pode descartar o reasoning_content
 * vazio retornado numa chamada de tool (DeepSeek exige o campo de volta em
 * TODAS as mensagens de assistente, senão responde 400 invalid_request_error).
 *
 * Retorna um prepareStep a ser passado em streamText/generateText — sempre
 * presente: sem o campo interleaved ele ainda sanitiza mensagens de tool
 * (sanitizeToolContent), evitando o crash do conversor openai-compatible em
 * parts malformadas. Espelha a lógica do chat-engine para que subagentes e o
 * agente principal compartilhem o mesmo suporte.
 */
export function reasoningPrepareStep(
  provider: CatalogProvider | undefined,
  modelId: string,
): ({ messages }: { messages: ModelMessage[] }) => { messages?: ModelMessage[] } | Record<string, never> {
  const field = interleavedReasoningField(provider, modelId)
  return ({ messages }) => {
    const normalized = normalizeMessages(messages, field)
    return normalized === messages ? {} : { messages: normalized }
  }
}
