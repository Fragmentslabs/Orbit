import type { ModelInput, VariantPayload } from './types'
import { isKimiFamily } from './variants'

/**
 * Baseline options per provider,
 * applied when thinking is active before the merge with the variant. Includes
 * non-reasoning flags that need to come along (store, promptCacheKey,
 * toolStreaming) and each SDK's default reasoning behavior.
 */
export function buildBaseOptions(model: ModelInput, sessionId: string): VariantPayload {
  const result: VariantPayload = {}
  const apiId = model.apiId

  // Anthropic serving non-claude models: unstable tool streaming.
  if (model.npm === '@ai-sdk/anthropic' && !apiId.includes('claude')) {
    result.toolStreaming = false
  }

  if (model.npm === '@ai-sdk/openai' || model.npm === '@ai-sdk/azure') {
    result.store = false
    result.promptCacheKey = sessionId
  }

  // gpt-5 baseline (non-chat, non-pro): medium effort with a reasoning summary.
  if (apiId.includes('gpt-5') && !apiId.includes('gpt-5-chat') && !apiId.includes('gpt-5-pro')) {
    result.reasoningEffort = 'medium'
    if (model.npm === '@ai-sdk/openai' || model.npm === '@ai-sdk/azure') {
      result.reasoningSummary = 'auto'
      result.include = ['reasoning.encrypted_content']
    }
  }

  const compatible = model.npm === '@ai-sdk/openai-compatible'

  // Providers that only return the reasoning when it is requested in the request
  // body — without this, the model answers without thinking and nothing flags the absence.
  // The openai-compatible adapter passes these raw fields through to the provider.
  if (
    model.providerId === 'baseten' ||
    (model.providerId === 'opencode' && ['kimi-k2-thinking', 'glm-4.6'].includes(apiId))
  ) {
    result.chat_template_args = { enable_thinking: true }
  }
  if (['zai', 'zhipuai'].some((id) => model.providerId.includes(id)) && compatible) {
    result.thinking = { type: 'enabled', clear_thinking: false }
  }
  // DashScope (Alibaba CN) requires `enable_thinking`; kimi-k2-thinking already thinks on its own.
  if (model.providerId === 'alibaba-cn' && model.reasoning && compatible && !apiId.includes('kimi-k2-thinking')) {
    result.enable_thinking = true
  }

  // MiniMax M3 through the Anthropic interface starts with thinking off,
  // unlike the chat completions one.
  if (apiId.toLowerCase().includes('minimax-m3') && model.npm === '@ai-sdk/anthropic') {
    result.thinking = { type: 'adaptive' }
  }
  // Kimi through the Anthropic transports: adaptive effort, with a summary so the
  // reasoning survives the resend in subsequent turns.
  if (
    (model.npm === '@ai-sdk/anthropic' || model.npm === '@ai-sdk/google-vertex/anthropic') &&
    isKimiFamily(model) &&
    model.reasoning
  ) {
    result.thinking = { type: 'adaptive', display: 'summarized' }
    result.effort = 'high'
  }

  // OpenRouter: the new Gemini only thinks with a requested effort.
  if (model.npm === '@openrouter/ai-sdk-provider' && apiId.includes('gemini') && !/gemini-(?:(?:flash|pro)-)?[12](?:[.-]|$)/i.test(apiId)) {
    result.reasoning = { effort: 'high' }
  }

  // Google: always include thoughts; Gemini 3 requires thinkingLevel.
  if ((model.npm === '@ai-sdk/google' || model.npm === '@ai-sdk/google-vertex') && model.reasoning) {
    result.thinkingConfig = {
      includeThoughts: true,
      ...(apiId.includes('gemini-3') ? { thinkingLevel: 'high' } : {}),
    }
  }

  return result
}
