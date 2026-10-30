import { describe, expect, it } from 'vitest'

import { classifyProviderError, errorToText, isRecoverableErrorKind, isTransientErrorKind } from './errors'
import { ProviderResolutionError } from './provider-errors'

/**
 * This classification decides whether the model rotation fires. Erring low
 * lets the fallback never happen; erring high spends a call on every
 * model of the rotation for an error that switching models does not solve (auth, for
 * example). Neither of the two shows up as a bug on screen — hence the test.
 *
 * The payloads below are the real shapes in which each provider sends the error:
 * the reason usually comes in `code`/`type`, not in the message.
 */

describe('errorToText', () => {
  it('uses the Error message', () => {
    expect(errorToText(new Error('boom'))).toBe('boom')
  })

  it('walks down the nested error/message chain of the gateways', () => {
    expect(errorToText({ error: { error: { message: 'rate limited' } } })).toBe('rate limited')
  })

  it('does not blow up on a cyclic chain', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.error = cyclic
    expect(() => errorToText(cyclic)).not.toThrow()
  })

  it('serializes an object without message instead of "[object Object]"', () => {
    expect(errorToText({ status: 500 })).not.toContain('[object Object]')
  })
})

describe('classifyProviderError', () => {
  it('preserves the raw text in the detail', () => {
    const { detail } = classifyProviderError(new Error('Upstream said no'))
    expect(detail).toBe('Upstream said no')
  })

  describe('moderation', () => {
    it.each([
      ['DashScope/Qwen', { error: { code: 'data_inspection_failed', message: 'blocked' } }],
      ['OpenAI content filter', { error: { code: 'content_filter', message: 'The response was filtered' } }],
      ['Gemini', new Error('Candidate blocked: PROHIBITED_CONTENT')],
      ['Bedrock guardrail', new Error('Request blocked by guardrail policy')],
    ])('classifies %s as moderation', (_label, payload) => {
      expect(classifyProviderError(payload).kind).toBe('moderation')
    })
  })

  describe('model unavailable', () => {
    it.each([
      ['OpenAI', { error: { code: 'model_not_found', message: 'The model does not exist' } }],
      ['OpenRouter', new Error('No endpoints found for meta-llama/llama-4')],
      ['generico', new Error('gpt-9 is not supported by this provider')],
    ])('classifies %s as model-unavailable', (_label, payload) => {
      expect(classifyProviderError(payload).kind).toBe('model-unavailable')
    })
  })

  describe('rate limit', () => {
    it.each([
      ['429 no statusCode', { statusCode: 429, message: 'Too Many Requests' }],
      ['OpenCode Zen', new Error('FreeUsageLimitError: free tier exhausted')],
      ['quota', { error: { message: 'You exceeded your current quota' } }],
      ['RATE_LIMIT_EXCEEDED', new Error('RATE_LIMIT_EXCEEDED')],
    ])('classifies %s as rate-limit', (_label, payload) => {
      expect(classifyProviderError(payload).kind).toBe('rate-limit')
    })

    it('beats network when the 429 comes with a retry-after', () => {
      // 429 and 503 may show up in the same payload; rate-limit is the most
      // specific and is checked first on purpose.
      const payload = { statusCode: 429, message: 'Too Many Requests, retry-after: 30' }
      expect(classifyProviderError(payload).kind).toBe('rate-limit')
    })
  })

  describe('network', () => {
    it.each([
      ['local server down', new Error('connect ECONNREFUSED 127.0.0.1:11434')],
      ['DNS', new Error('getaddrinfo ENOTFOUND api.example.com')],
      ['undici', new Error('UND_ERR_CONNECT_TIMEOUT')],
      ['Vercel SDK', new Error('fetch failed')],
      ['Overloaded Anthropic', { error: { type: 'overloaded_error' }, statusCode: 529 }],
      ['gateway', { statusCode: 502, message: 'Bad Gateway' }],
    ])('classifies %s as network', (_label, payload) => {
      expect(classifyProviderError(payload).kind).toBe('network')
    })

    it('classifies the OpenCode Go session refusal as network (rotatable)', () => {
      // The request was not even routed, but the turn cannot die: the rotation
      // goes on (providerFetch already retried once with a new id).
      const err = new Error(
        'Error from provider (Console Go): Request is missing x-opencode-session and ' +
          'cannot be routed efficiently. Please see https://opencode.ai/docs/go/#where-can-i-use-it',
      )
      const { kind } = classifyProviderError(err)
      expect(kind).toBe('network')
      expect(isRecoverableErrorKind(kind)).toBe(true)
    })
  })

  describe('context overflow', () => {
    /**
     * The case that motivated the kind: the turn requested 3.4M tokens on a 1M model.
     * Classified as `rate-limit`, the UI told you to "wait or switch
     * models" — and the rotation repeated the same giant request on every model of the
     * sequence, all with the same answer.
     */
    const overflow =
      "Error from provider (Console Go): Upstream request failed: [invalid_request_error] " +
      "This model's maximum context length is 1048576 tokens. However, you requested 3463912 " +
      'tokens (3463912 in the messages, 0 in the completion). Please reduce the length of the ' +
      'messages or completion.'

    it('classifies the context overflow and does NOT rotate', () => {
      const { kind } = classifyProviderError(new Error(overflow))
      expect(kind).toBe('context-length')
      expect(isRecoverableErrorKind(kind)).toBe(false)
    })

    it.each([
      ['OpenAI', { error: { code: 'context_length_exceeded', message: 'too long' } }],
      ['Anthropic', new Error('prompt is too long: 213423 tokens > 200000 maximum')],
      [
        'Anthropic with max_tokens',
        new Error('input length and `max_tokens` exceed context limit: 190000 + 32000 > 200000'),
      ],
      [
        'Google',
        new Error('The input token count (1200000) exceeds the maximum number of tokens allowed'),
      ],
    ])('recognizes the %s shape', (_label, payload) => {
      expect(classifyProviderError(payload).kind).toBe('context-length')
    })

    /**
     * Regression of the real defect: `matchable` serialized the whole error, and the SDK's
     * APICallError carries `responseHeaders`. Since every OpenAI-compatible
     * provider returns `x-ratelimit-*` on EVERY response, the
     * /rate[ _-]?limit/ pattern matched on any failure of those providers —
     * the true reason was never reached.
     */
    it('ignores x-ratelimit-* headers when classifying', () => {
      const err = Object.assign(new Error(overflow), {
        statusCode: 400,
        responseHeaders: {
          'x-ratelimit-limit-requests': '100',
          'x-ratelimit-remaining-tokens': '9999',
        },
      })
      expect(classifyProviderError(err).kind).toBe('context-length')
    })

    /**
     * Same defect, another field: APICallError also keeps
     * `requestBodyValues` — the whole prompt (conversation, system, tool
     * descriptions). An "is not supported" anywhere in the conversation made
     * a DNS failure arrive as "the provider does not serve this model".
     */
    it('ignores the request body when classifying', () => {
      const apiError = Object.assign(new Error('Cannot connect to API: getaddrinfo ENOTFOUND opencode.ai'), {
        requestBodyValues: {
          model: 'deepseek-v4.1-flash',
          messages: [{ role: 'user', content: 'the SQL Server backup is not supported in docker?' }],
        },
      })
      const retryError = Object.assign(
        new Error('Failed after 3 attempts. Last error: Cannot connect to API: getaddrinfo ENOTFOUND opencode.ai'),
        { errors: [apiError, apiError, apiError], lastError: apiError },
      )
      expect(classifyProviderError(retryError).kind).toBe('network')
    })

    it('but still recognizes the real rate-limit, which comes in the status/body', () => {
      const err = Object.assign(new Error('Upstream request failed'), {
        statusCode: 429,
        responseHeaders: { 'x-ratelimit-remaining-requests': '0' },
      })
      const { kind } = classifyProviderError(err)
      expect(kind).toBe('rate-limit')
      expect(isRecoverableErrorKind(kind)).toBe(true)
    })
  })

  describe('provider configuration', () => {
    it.each([
      ['unknown provider', new ProviderResolutionError('Unknown provider: x', 'unknown-provider')],
      [
        'missing key',
        new ProviderResolutionError('No API key configured for Anthropic. Add one in Settings.', 'missing-key'),
      ],
      ['SDK not bundled', new ProviderResolutionError('Missing SDK: @ai-sdk/x', 'missing-sdk')],
    ])('classifies %s as provider-config', (_label, payload) => {
      expect(classifyProviderError(payload).kind).toBe('provider-config')
    })

    it('beats the provider defaults (an id with "429" does not become rate-limit)', () => {
      const err = new ProviderResolutionError('Unknown provider: gateway-429', 'unknown-provider')
      expect(classifyProviderError(err).kind).toBe('provider-config')
    })

    it('does not rotate — switching models does not fix configuration', () => {
      expect(isRecoverableErrorKind('provider-config')).toBe(false)
    })
  })

  describe('what must NOT rotate', () => {
    it.each([
      ['invalid key', { error: { code: 'invalid_api_key', message: 'Incorrect API key provided' } }],
      ['401', { statusCode: 401, message: 'Unauthorized' }],
      ['403', { statusCode: 403, message: 'Forbidden' }],
      // Context overflow left here: it got a kind of its own (`context-length`,
      // covered above). It still does not rotate — what changed is that now the
      // UI knows how to say what solves it, instead of showing the raw text.
    ])('leaves %s as unknown (switching models does not fix it)', (_label, payload) => {
      const { kind } = classifyProviderError(payload)
      expect(kind).toBe('unknown')
      expect(isRecoverableErrorKind(kind)).toBe(false)
    })
  })

  it('never throws, not even with a getter that blows up', () => {
    const hostile = {
      get error() {
        throw new Error('getter explodiu')
      },
    }
    expect(() => classifyProviderError(hostile)).not.toThrow()
  })
})

describe('isRecoverableErrorKind', () => {
  it('rotates the four kinds that switching models solves', () => {
    for (const kind of ['moderation', 'model-unavailable', 'rate-limit', 'network'] as const) {
      expect(isRecoverableErrorKind(kind)).toBe(true)
    }
  })

  it('does not rotate unknown', () => {
    expect(isRecoverableErrorKind('unknown')).toBe(false)
  })
})

describe('isTransientErrorKind', () => {
  it('only network and rate-limit earn another round on the same model', () => {
    expect(isTransientErrorKind('network')).toBe(true)
    expect(isTransientErrorKind('rate-limit')).toBe(true)
    expect(isTransientErrorKind('model-unavailable')).toBe(false)
    expect(isTransientErrorKind('moderation')).toBe(false)
    expect(isTransientErrorKind('context-length')).toBe(false)
  })
})
