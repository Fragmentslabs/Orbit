import { describe, expect, it, vi } from 'vitest'

import type { CatalogModel, CatalogProvider, SendMessageInput } from '@shared/chat'

/**
 * O caso real que motivou estes testes: o models.dev renomeou o DeepSeek V4.1
 * Flash do OpenCode Go de "deepseek-flash" para "deepseek-v4.1-flash" (o id
 * velho virou a família). Os chats salvos com o id velho passaram a sair sem
 * `reasoning_effort` — o modelo respondia sem pensar, com "High" na tela.
 */
const flash = (id: string, release: string): CatalogModel => ({
  id,
  name: id,
  family: 'deepseek-flash',
  reasoning: true,
  reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
  tool_call: true,
  attachment: false,
  release_date: release,
})

const opencodeGo: CatalogProvider = {
  id: 'opencode-go',
  name: 'OpenCode Go',
  env: [],
  npm: '@ai-sdk/openai-compatible',
  models: {
    'deepseek-v4-flash': flash('deepseek-v4-flash', '2026-07-31'),
    'deepseek-v4.1-flash': flash('deepseek-v4.1-flash', '2026-09-10'),
  },
}

vi.mock('../catalog', () => ({
  getProvider: async (id: string) => (id === opencodeGo.id ? opencodeGo : undefined),
}))
// providers.ts importa o electron; daqui só sai a regra do adaptador.
vi.mock('../providers', () => ({ isServedByOpenAiCompatible: () => true }))

const { buildProviderOptions, generateVariants, toModelInput } = await import('./index')

const input = (modelId: string, variantId?: string): SendMessageInput => ({
  sessionId: 's1',
  text: 'oi',
  providerId: 'opencode-go',
  modelId,
  mode: 'code',
  options: { reasoning: { enabled: true, variantId } },
})

describe('níveis de reasoning vindos do catálogo', () => {
  it('oferece só os níveis que o models.dev declara', () => {
    const variants = generateVariants(toModelInput('opencode-go', opencodeGo.npm, opencodeGo.models['deepseek-v4.1-flash']))
    expect(Object.keys(variants)).toEqual(['low', 'high', 'max'])
  })

  it('modelo só liga/desliga não ganha níveis inventados', () => {
    const model = { ...opencodeGo.models['deepseek-v4.1-flash'], id: 'longcat-2.0', reasoning_options: [{ type: 'toggle' }] }
    expect(generateVariants(toModelInput('opencode-go', opencodeGo.npm, model))).toEqual({})
  })

  it('liga/desliga junto com níveis usa os níveis', () => {
    const model = {
      ...opencodeGo.models['deepseek-v4.1-flash'],
      reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high'] }],
    }
    expect(Object.keys(generateVariants(toModelInput('opencode-go', opencodeGo.npm, model)))).toEqual(['low', 'high'])
  })

  it('sem reasoning_options, mantém a lista conhecida', () => {
    const model = { ...opencodeGo.models['deepseek-v4.1-flash'], reasoning_options: undefined }
    const variants = generateVariants(toModelInput('opencode-go', opencodeGo.npm, model))
    expect(Object.keys(variants)).toEqual(['low', 'medium', 'high', 'max'])
  })
})

describe('buildProviderOptions', () => {
  it('manda o nível escolhido', async () => {
    expect(await buildProviderOptions(input('deepseek-v4.1-flash', 'high'))).toEqual({
      opencodeGo: { reasoningEffort: 'high' },
    })
  })

  it('segue o id renomeado em vez de sair sem reasoning', async () => {
    expect(await buildProviderOptions(input('deepseek-flash', 'high'))).toEqual({
      opencodeGo: { reasoningEffort: 'high' },
    })
  })

  it('nível que o modelo não tem vira o vizinho mais forte', async () => {
    expect(await buildProviderOptions(input('deepseek-flash', 'medium'))).toEqual({
      opencodeGo: { reasoningEffort: 'high' },
    })
  })

  it('modelo que sumiu sem sucessor continua sem opções', async () => {
    expect(await buildProviderOptions(input('modelo-que-nao-existe', 'high'))).toBeUndefined()
  })
})
