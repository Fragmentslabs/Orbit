import type { ModelInput, VariantPayload } from './types'

/**
 * Options baseline por provedor (portadas do opencode transform.ts → options()),
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

  // Google: sempre incluir pensamentos; Gemini 3 exige thinkingLevel.
  if ((model.npm === '@ai-sdk/google' || model.npm === '@ai-sdk/google-vertex') && model.reasoning) {
    result.thinkingConfig = {
      includeThoughts: true,
      ...(apiId.includes('gemini-3') ? { thinkingLevel: 'high' } : {}),
    }
  }

  return result
}
