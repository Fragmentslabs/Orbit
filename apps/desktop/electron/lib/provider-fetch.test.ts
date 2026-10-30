import { afterEach, describe, expect, it, vi } from 'vitest'

import { SESSION_HEADER, providerFetch } from './provider-fetch'

/**
 * The session header is the only reason OpenCode Zen/Go agrees to route
 * a request. It already goes in the provider's settings; the wrapper is the safety
 * net: it restores the missing header in any request and repeats the call
 * once when the gateway refuses the session. Erring here does not show up as an obvious
 * bug — the turn simply dies for the user.
 */

const REFUSAL =
  'Error from provider (Console Go): Request is missing x-opencode-session and cannot be ' +
  'routed efficiently. Please see https://opencode.ai/docs/go/#where-can-i-use-it'

const URL_GO = 'https://opencode.ai/zen/go/v1/chat/completions'

function headersOf(call: unknown[]): Headers {
  return new Headers((call[1] as RequestInit).headers)
}

function stubFetch(responses: Array<() => Response>) {
  const calls: unknown[][] = []
  const impl = vi.fn(async (...args: unknown[]) => {
    calls.push(args)
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]
    return next!()
  })
  vi.stubGlobal('fetch', impl)
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('providerFetch', () => {
  it('reinjects the header when the provider settings did not send it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = stubFetch([() => new Response('{}', { status: 200 })])

    await providerFetch('orbit_conv1')(URL_GO, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    })

    expect(headersOf(calls[0]!).get(SESSION_HEADER)).toBe('orbit_conv1')
    // Reinjecting means the header left the expected path: it has to be
    // logged, it is what explains the failure in the field.
    expect(warn).toHaveBeenCalledOnce()
  })

  it('never sends an empty header (the gateway treats empty as missing)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = stubFetch([() => new Response('{}', { status: 200 })])

    await providerFetch('')(URL_GO, { method: 'POST', body: '{}' })

    expect(headersOf(calls[0]!).get(SESSION_HEADER)).toMatch(/^orbit_[0-9a-f-]{36}$/)
  })

  it('preserves the header that already came from resolveModel', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = stubFetch([() => new Response('{}', { status: 200 })])

    await providerFetch('orbit_conv1')(URL_GO, {
      method: 'POST',
      body: '{}',
      headers: { [SESSION_HEADER]: 'ses_do_call', 'content-type': 'application/json' },
    })

    expect(headersOf(calls[0]!).get(SESSION_HEADER)).toBe('ses_do_call')
    expect(warn).not.toHaveBeenCalled()
  })

  it('retries once with the new id when the gateway refuses the session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = stubFetch([
      () => new Response(REFUSAL, { status: 400 }),
      () => new Response('{"ok":true}', { status: 200 }),
    ])

    const rotate = vi.fn(() => 'orbit_new')
    const response = await providerFetch('orbit_conv1', rotate)(URL_GO, {
      method: 'POST',
      body: '{"stream":true}',
      headers: { [SESSION_HEADER]: 'orbit_conv1' },
    })

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(rotate).toHaveBeenCalledWith('orbit_conv1')
    expect(headersOf(calls[0]!).get(SESSION_HEADER)).toBe('orbit_conv1')
    expect(headersOf(calls[1]!).get(SESSION_HEADER)).toBe('orbit_new')
    // The original body is resent (the SDK sends JSON as a string).
    expect((calls[1]![1] as RequestInit).body).toBe('{"stream":true}')
    expect(warn).toHaveBeenCalledOnce()
  })

  it('does not retry when there is no rotation callback (generates its own id)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = stubFetch([
      () => new Response(REFUSAL, { status: 400 }),
      () => new Response('{"ok":true}', { status: 200 }),
    ])

    await providerFetch('orbit_conv1')(URL_GO, { method: 'POST', body: '{}' })

    const rotated = headersOf(calls[1]!).get(SESSION_HEADER)
    expect(calls).toHaveLength(2)
    expect(rotated).toMatch(/^orbit_[0-9a-f-]{36}$/)
    expect(rotated).not.toBe('orbit_conv1')
  })

  it.each([
    ['a refused auth', 401, '{"error":{"message":"Incorrect API key provided"}}'],
    ['generic gateway error', 500, 'Internal server error'],
    ['model unavailable', 400, '{"error":{"message":"Model is unavailable"}}'],
  ])('does not retry %s', async (_label, status, body) => {
    const calls = stubFetch([() => new Response(body, { status })])

    const response = await providerFetch('orbit_conv1')(URL_GO, { method: 'POST', body: '{}' })

    expect(response.status).toBe(status)
    expect(calls).toHaveLength(1)
  })

  it('does not retry when the body cannot be resent (stream)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = stubFetch([() => new Response(REFUSAL, { status: 400 })])
    const stream = new ReadableStream()

    await providerFetch('orbit_conv1')(URL_GO, { method: 'POST', body: stream })

    expect(calls).toHaveLength(1)
  })

  it('does not retry a request aborted by the user', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const controller = new AbortController()
    controller.abort()
    const calls = stubFetch([() => new Response(REFUSAL, { status: 400 })])

    await providerFetch('orbit_conv1')(URL_GO, {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    })

    expect(calls).toHaveLength(1)
  })
})
