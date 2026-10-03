import type { ModelInput, VariantPayload } from './types'
import { isKimiFamily } from './variants'

/**
 * Options baseline por provedor,
 * aplicadas quando o thinking está ativo antes do merge com a variant. Inclui
 * flags não-reasoning que precisam acompanhar (store, promptCacheKey,
 * toolStreaming) e o comportamento padrão de reasoning de cada SDK.
 */
export function buildBaseOptions(model: ModelInput, sessionId: string): VariantPayload {
  const result: VariantPayload = {}
  const apiId = model.apiId

  // Anthropic servindo modelos não-claude: tool streaming instável.
  if (model.npm === '@ai-sdk/anthropic' && !apiId.includes('claude')) {
    result.toolStreaming = false
  }

  if (model.npm === '@ai-sdk/openai' || model.npm === '@ai-sdk/azure') {
    result.store = false
    result.promptCacheKey = sessionId
  }

  // Baseline gpt-5 (não-chat, não-pro): esforço médio com resumo de reasoning.
  if (apiId.includes('gpt-5') && !apiId.includes('gpt-5-chat') && !apiId.includes('gpt-5-pro')) {
    result.reasoningEffort = 'medium'
    if (model.npm === '@ai-sdk/openai' || model.npm === '@ai-sdk/azure') {
      result.reasoningSummary = 'auto'
      result.include = ['reasoning.encrypted_content']
    }
  }

  const compatible = model.npm === '@ai-sdk/openai-compatible'

  // Provedores que só devolvem o raciocínio quando ele é pedido no corpo da
  // requisição — sem isto, o modelo responde sem pensar e nada acusa a falta.
  // O adaptador openai-compatible repassa esses campos crus ao provedor.
  if (
    model.providerId === 'baseten' ||
    (model.providerId === 'opencode' && ['kimi-k2-thinking', 'glm-4.6'].includes(apiId))
  ) {
    result.chat_template_args = { enable_thinking: true }
  }
  if (['zai', 'zhipuai'].some((id) => model.providerId.includes(id)) && compatible) {
    result.thinking = { type: 'enabled', clear_thinking: false }
  }
  // DashScope (Alibaba CN) exige `enable_thinking`; o kimi-k2-thinking já pensa sozinho.
  if (model.providerId === 'alibaba-cn' && model.reasoning && compatible && !apiId.includes('kimi-k2-thinking')) {
    result.enable_thinking = true
  }

  // MiniMax M3 pela interface da Anthropic começa com o thinking desligado,
  // ao contrário da de chat completions.
  if (apiId.toLowerCase().includes('minimax-m3') && model.npm === '@ai-sdk/anthropic') {
    result.thinking = { type: 'adaptive' }
  }
  // Kimi pelos transportes da Anthropic: esforço adaptativo, com resumo para o
  // raciocínio sobreviver ao reenvio nos turnos seguintes.
  if (
    (model.npm === '@ai-sdk/anthropic' || model.npm === '@ai-sdk/google-vertex/anthropic') &&
    isKimiFamily(model) &&
    model.reasoning
  ) {
    result.thinking = { type: 'adaptive', display: 'summarized' }
    result.effort = 'high'
  }

  // OpenRouter: Gemini novo só pensa com esforço pedido.
  if (model.npm === '@openrouter/ai-sdk-provider' && apiId.includes('gemini') && !/gemini-(?:(?:flash|pro)-)?[12](?:[.-]|$)/i.test(apiId)) {
    result.reasoning = { effort: 'high' }
  }

  // Google: sempre incluir pensamentos; Gemini 3 exige thinkingLevel.
  if ((model.npm === '@ai-sdk/google' || model.npm === '@ai-sdk/google-vertex') && model.reasoning) {
    result.thinkingConfig = {
      includeThoughts: true,
      ...(apiId.includes('gemini-3') ? { thinkingLevel: 'high' } : {}),
    }
  }

  return result
}
