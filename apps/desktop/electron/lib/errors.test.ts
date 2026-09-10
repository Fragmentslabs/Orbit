import { describe, expect, it } from 'vitest'

import { classifyProviderError, errorToText, isRecoverableErrorKind } from './errors'
import { ProviderResolutionError } from './provider-errors'

/**
 * Esta classificação decide se a rotação de modelos dispara. Errar para menos
 * deixa o fallback nunca acontecer; errar para mais gasta uma chamada em cada
 * modelo da rotação por um erro que trocar de modelo não resolve (auth, por
 * exemplo). Nenhum dos dois aparece como bug na tela — daí o teste.
 *
 * Os payloads abaixo são as formas reais em que cada provedor manda o erro:
 * o motivo costuma vir em `code`/`type`, não na mensagem.
 */

describe('errorToText', () => {
  it('usa a mensagem do Error', () => {
    expect(errorToText(new Error('boom'))).toBe('boom')
  })

  it('desce pela cadeia error/message aninhada dos gateways', () => {
    expect(errorToText({ error: { error: { message: 'rate limited' } } })).toBe('rate limited')
  })

  it('não estoura em cadeia ciclica', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.error = cyclic
    expect(() => errorToText(cyclic)).not.toThrow()
  })

  it('serializa objeto sem message em vez de "[object Object]"', () => {
    expect(errorToText({ status: 500 })).not.toContain('[object Object]')
  })
})

describe('classifyProviderError', () => {
  it('preserva o texto cru no detail', () => {
    const { detail } = classifyProviderError(new Error('Upstream said no'))
    expect(detail).toBe('Upstream said no')
  })

  describe('moderação', () => {
    it.each([
      ['DashScope/Qwen', { error: { code: 'data_inspection_failed', message: 'blocked' } }],
      ['OpenAI content filter', { error: { code: 'content_filter', message: 'The response was filtered' } }],
      ['Gemini', new Error('Candidate blocked: PROHIBITED_CONTENT')],
      ['Bedrock guardrail', new Error('Request blocked by guardrail policy')],
    ])('classifica %s como moderation', (_label, payload) => {
      expect(classifyProviderError(payload).kind).toBe('moderation')
    })
  })

  describe('modelo indisponível', () => {
    it.each([
      ['OpenAI', { error: { code: 'model_not_found', message: 'The model does not exist' } }],
      ['OpenRouter', new Error('No endpoints found for meta-llama/llama-4')],
      ['generico', new Error('gpt-9 is not supported by this provider')],
    ])('classifica %s como model-unavailable', (_label, payload) => {
      expect(classifyProviderError(payload).kind).toBe('model-unavailable')
    })
  })

  describe('rate limit', () => {
    it.each([
      ['429 no statusCode', { statusCode: 429, message: 'Too Many Requests' }],
      ['OpenCode Zen', new Error('FreeUsageLimitError: free tier exhausted')],
      ['quota', { error: { message: 'You exceeded your current quota' } }],
      ['RATE_LIMIT_EXCEEDED', new Error('RATE_LIMIT_EXCEEDED')],
    ])('classifica %s como rate-limit', (_label, payload) => {
      expect(classifyProviderError(payload).kind).toBe('rate-limit')
    })

    it('vence a rede quando o 429 vem junto de retry-after', () => {
      // 429 e 503 podem aparecer no mesmo payload; rate-limit é o mais
      // específico e é checado primeiro de propósito.
      const payload = { statusCode: 429, message: 'Too Many Requests, retry-after: 30' }
      expect(classifyProviderError(payload).kind).toBe('rate-limit')
    })
  })

  describe('rede', () => {
    it.each([
      ['servidor local desligado', new Error('connect ECONNREFUSED 127.0.0.1:11434')],
      ['DNS', new Error('getaddrinfo ENOTFOUND api.example.com')],
      ['undici', new Error('UND_ERR_CONNECT_TIMEOUT')],
      ['SDK da Vercel', new Error('fetch failed')],
      ['Anthropic sobrecarregado', { error: { type: 'overloaded_error' }, statusCode: 529 }],
      ['gateway', { statusCode: 502, message: 'Bad Gateway' }],
    ])('classifica %s como network', (_label, payload) => {
      expect(classifyProviderError(payload).kind).toBe('network')
    })

    it('classifica a recusa de sessão do OpenCode Go como network (rotacionável)', () => {
      // A requisição nem foi roteada, mas o turno não pode morrer: a rotação
      // segue adiante (o providerFetch já repetiu uma vez com id novo).
      const err = new Error(
        'Error from provider (Console Go): Request is missing x-opencode-session and ' +
          'cannot be routed efficiently. Please see https://opencode.ai/docs/go/#where-can-i-use-it',
      )
      const { kind } = classifyProviderError(err)
      expect(kind).toBe('network')
      expect(isRecoverableErrorKind(kind)).toBe(true)
    })
  })

  describe('configuração do provedor', () => {
    it.each([
      ['provedor desconhecido', new ProviderResolutionError('Unknown provider: x', 'unknown-provider')],
      [
        'chave ausente',
        new ProviderResolutionError('No API key configured for Anthropic. Add one in Settings.', 'missing-key'),
      ],
      ['SDK não empacotado', new ProviderResolutionError('Missing SDK: @ai-sdk/x', 'missing-sdk')],
    ])('classifica %s como provider-config', (_label, payload) => {
      expect(classifyProviderError(payload).kind).toBe('provider-config')
    })

    it('vence os padrões do provedor (id com "429" não vira rate-limit)', () => {
      const err = new ProviderResolutionError('Unknown provider: gateway-429', 'unknown-provider')
      expect(classifyProviderError(err).kind).toBe('provider-config')
    })

    it('não rotaciona — trocar de modelo não conserta configuração', () => {
      expect(isRecoverableErrorKind('provider-config')).toBe(false)
    })
  })

  describe('o que NÃO pode rotacionar', () => {
    it.each([
      ['chave inválida', { error: { code: 'invalid_api_key', message: 'Incorrect API key provided' } }],
      ['401', { statusCode: 401, message: 'Unauthorized' }],
      ['403', { statusCode: 403, message: 'Forbidden' }],
      ['contexto estourado', { error: { code: 'context_length_exceeded', message: "This model's maximum context length is 128000 tokens" } }],
    ])('deixa %s como unknown (trocar de modelo não resolve)', (_label, payload) => {
      const { kind } = classifyProviderError(payload)
      expect(kind).toBe('unknown')
      expect(isRecoverableErrorKind(kind)).toBe(false)
    })
  })

  it('nunca lança, nem com getter que estoura', () => {
    const hostile = {
      get error() {
        throw new Error('getter explodiu')
      },
    }
    expect(() => classifyProviderError(hostile)).not.toThrow()
  })
})

describe('isRecoverableErrorKind', () => {
  it('rotaciona os quatro kinds que trocar de modelo resolve', () => {
    for (const kind of ['moderation', 'model-unavailable', 'rate-limit', 'network'] as const) {
      expect(isRecoverableErrorKind(kind)).toBe(true)
    }
  })

  it('não rotaciona unknown', () => {
    expect(isRecoverableErrorKind('unknown')).toBe(false)
  })
})
