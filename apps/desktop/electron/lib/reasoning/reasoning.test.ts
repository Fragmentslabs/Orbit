import { describe, expect, it, vi } from 'vitest'

import type { CatalogModel, CatalogProvider, SendMessageInput } from '@shared/chat'

/**
 * O caso real que motivou estes testes: o models.dev renomeou o DeepSeek V4.1
 * Flash de um gateway de "deepseek-flash" para "deepseek-v4.1-flash" (o id
 * velho virou a família). Os chats salvos com o id velho passaram a sair sem
 * `reasoning_effort` — o modelo respondia sem pensar, com "High" na tela.
 */
const model = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  name: id,
  reasoning: true,
  tool_call: true,
  attachment: false,
  limit: { context: 200_000, output: 32_000 },
  ...extra,
})

const flash = (id: string, release: string) =>
  model(id, {
    family: 'deepseek-flash',
    reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
    release_date: release,
  })

const gateway: CatalogProvider = {
  id: 'gateway-go',
  name: 'Gateway Go',
  env: [],
  npm: '@ai-sdk/openai-compatible',
  models: {
    'deepseek-v4-flash': flash('deepseek-v4-flash', '2026-07-31'),
    'deepseek-v4.1-flash': flash('deepseek-v4.1-flash', '2026-09-10'),
  },
}

vi.mock('../catalog', () => ({
  getProvider: async (id: string) => (id === gateway.id ? gateway : undefined),
}))
// providers.ts importa o electron; daqui só sai a regra do adaptador.
vi.mock('../providers', () => ({ isServedByOpenAiCompatible: () => true }))

const { buildBaseOptions, buildProviderOptions, generateVariants, toModelInput } = await import('./index')

const input = (modelId: string, variantId?: string): SendMessageInput => ({
  sessionId: 's1',
  text: 'oi',
  providerId: gateway.id,
  modelId,
  mode: 'code',
  options: { reasoning: { enabled: true, variantId } },
})

const levels = (providerId: string, npm: string, m: CatalogModel, apiUrl?: string) =>
  generateVariants(toModelInput(providerId, npm, m, apiUrl))

const compat = '@ai-sdk/openai-compatible'

describe('níveis declarados pelo catálogo', () => {
  it('oferece só os níveis que o provedor declara', () => {
    expect(Object.keys(levels(gateway.id, compat, gateway.models['deepseek-v4.1-flash']))).toEqual([
      'low',
      'high',
      'max',
    ])
  })

  it('vale mais que a lista de "sempre pensa"', () => {
    const kimi = model('kimi-k2.6', { reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] })
    expect(levels('gateway', compat, kimi)).toEqual({
      low: { reasoningEffort: 'low' },
      high: { reasoningEffort: 'high' },
    })
  })

  it('cada SDK recebe o nível no próprio formato', () => {
    const declared = model('m', { reasoning_options: [{ type: 'effort', values: ['high'] }] })
    expect(levels('openrouter', '@openrouter/ai-sdk-provider', declared)).toEqual({
      high: { reasoning: { effort: 'high' } },
    })
    expect(levels('google', '@ai-sdk/google', declared)).toEqual({
      high: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } },
    })
  })

  it('SDK sem níveis descarta os níveis em vez de inventar um formato', () => {
    const declared = model('command-a', { reasoning_options: [{ type: 'effort', values: ['high'] }] })
    expect(levels('cohere', '@ai-sdk/cohere', declared)).toEqual({})
  })

  it('lista vazia no catálogo = sem controle', () => {
    expect(levels('gateway', compat, model('m', { reasoning_options: [] }))).toEqual({})
  })

  it('liga/desliga onde o SDK tem campo para isso', () => {
    const toggle = model('command-a-reasoning', { reasoning_options: [{ type: 'toggle' }] })
    expect(levels('cohere', '@ai-sdk/cohere', toggle)).toEqual({
      none: { thinking: { type: 'disabled' } },
      high: { thinking: { type: 'enabled' } },
    })
  })

  it('liga/desliga sem campo conhecido cai nas regras por nome', () => {
    const toggle = model('longcat-2.0', { reasoning_options: [{ type: 'toggle' }] })
    expect(Object.keys(levels('gateway', compat, toggle))).toEqual(['low', 'medium', 'high'])
  })

  it('orçamento de tokens vira os níveis high e max', () => {
    const budget = model('claude-x', { reasoning_options: [{ type: 'budget_tokens', min: 1024 }] })
    expect(levels('anthropic', '@ai-sdk/anthropic', budget)).toEqual({
      high: { thinking: { type: 'enabled', budgetTokens: 16_000 } },
      max: { thinking: { type: 'enabled', budgetTokens: 31_999 } },
    })
  })

  it('sem reasoning_options, valem as regras por nome', () => {
    const plain = { ...gateway.models['deepseek-v4.1-flash'], reasoning_options: undefined }
    expect(Object.keys(levels(gateway.id, compat, plain))).toEqual(['low', 'medium', 'high', 'max'])
  })
})

describe('regras por nome do modelo', () => {
  it('MiniMax M3 liga e desliga de verdade', () => {
    expect(levels('minimax', compat, model('minimax-m3'))).toEqual({
      none: { thinking: { type: 'disabled' } },
      thinking: { thinking: { type: 'adaptive' } },
    })
    expect(levels('nvidia', compat, model('minimax-m3'))).toEqual({
      none: { chat_template_kwargs: { thinking_mode: 'disabled' } },
      thinking: { chat_template_kwargs: { thinking_mode: 'enabled' } },
    })
  })

  it('GLM-5.2 tem níveis; os GLM anteriores só pensam', () => {
    expect(Object.keys(levels('zai', compat, model('glm-5.2')))).toEqual(['high', 'max'])
    expect(levels('zai', compat, model('glm-5.1'))).toEqual({})
  })

  it('Kimi pela interface da Anthropic usa esforço adaptativo', () => {
    const kimi = levels('moonshot', '@ai-sdk/anthropic', model('k2.6'), 'https://api.moonshot.ai/anthropic')
    expect(Object.keys(kimi)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(kimi.high).toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, effort: 'high' })
  })

  it('Gemma só liga/desliga', () => {
    expect(Object.keys(levels('google', '@ai-sdk/google', model('gemma-4')))).toEqual(['minimal', 'high'])
  })
})

describe('opções que pedem o raciocínio ao provedor', () => {
  const base = (providerId: string, m: CatalogModel, npm = compat) =>
    buildBaseOptions(toModelInput(providerId, npm, m), 's1')

  it('Z.ai e Zhipu só pensam com `thinking` no corpo', () => {
    expect(base('zai', model('glm-5.1')).thinking).toEqual({ type: 'enabled', clear_thinking: false })
  })

  it('DashScope exige enable_thinking', () => {
    expect(base('alibaba-cn', model('qwen3-max')).enable_thinking).toBe(true)
    expect(base('alibaba-cn', model('kimi-k2-thinking')).enable_thinking).toBeUndefined()
  })

  it('modelos servidos por template de chat pedem enable_thinking', () => {
    expect(base('opencode', model('glm-4.6')).chat_template_args).toEqual({ enable_thinking: true })
    expect(base('opencode', model('glm-5.1')).chat_template_args).toBeUndefined()
  })
})

describe('buildProviderOptions', () => {
  it('manda o nível escolhido', async () => {
    expect(await buildProviderOptions(input('deepseek-v4.1-flash', 'high'))).toEqual({
      gatewayGo: { reasoningEffort: 'high' },
    })
  })

  it('segue o id renomeado em vez de sair sem reasoning', async () => {
    expect(await buildProviderOptions(input('deepseek-flash', 'high'))).toEqual({
      gatewayGo: { reasoningEffort: 'high' },
    })
  })

  it('nível que o modelo não tem vira o vizinho mais forte', async () => {
    expect(await buildProviderOptions(input('deepseek-flash', 'medium'))).toEqual({
      gatewayGo: { reasoningEffort: 'high' },
    })
  })

  it('modelo que sumiu sem sucessor continua sem opções', async () => {
    expect(await buildProviderOptions(input('modelo-que-nao-existe', 'high'))).toBeUndefined()
  })
})
