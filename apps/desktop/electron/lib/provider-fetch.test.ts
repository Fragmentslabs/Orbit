import { afterEach, describe, expect, it, vi } from 'vitest'

import { SESSION_HEADER, providerFetch } from './provider-fetch'

/**
 * O header de sessão é o único motivo pelo qual o OpenCode Zen/Go aceita rotear
 * uma requisição. Ele já vai nas settings do provider; o wrapper é a rede de
 * segurança: repõe o header que faltar em qualquer requisição e repete a chamada
 * uma vez quando o gateway recusa a sessão. Errar aqui não aparece como bug
 * óbvio — o turno simplesmente morre para o usuário.
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
  it('reinjeta o header quando as settings do provider não o mandaram', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = stubFetch([() => new Response('{}', { status: 200 })])

    await providerFetch('orbit_conv1')(URL_GO, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    })

    expect(headersOf(calls[0]!).get(SESSION_HEADER)).toBe('orbit_conv1')
    // Reinjetar significa que o header saiu do caminho esperado: precisa ficar
    // registrado, é o que explica a falha em campo.
    expect(warn).toHaveBeenCalledOnce()
  })

  it('nunca manda header vazio (o gateway trata vazio como ausente)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = stubFetch([() => new Response('{}', { status: 200 })])

    await providerFetch('')(URL_GO, { method: 'POST', body: '{}' })

    expect(headersOf(calls[0]!).get(SESSION_HEADER)).toMatch(/^orbit_[0-9a-f-]{36}$/)
  })

  it('preserva o header que já veio do resolveModel', async () => {
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

  it('repete uma vez com o id novo quando o gateway recusa a sessão', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = stubFetch([
      () => new Response(REFUSAL, { status: 400 }),
      () => new Response('{"ok":true}', { status: 200 }),
    ])

    const rotate = vi.fn(() => 'orbit_novo')
    const response = await providerFetch('orbit_conv1', rotate)(URL_GO, {
      method: 'POST',
      body: '{"stream":true}',
      headers: { [SESSION_HEADER]: 'orbit_conv1' },
    })

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(rotate).toHaveBeenCalledWith('orbit_conv1')
    expect(headersOf(calls[0]!).get(SESSION_HEADER)).toBe('orbit_conv1')
    expect(headersOf(calls[1]!).get(SESSION_HEADER)).toBe('orbit_novo')
    // O corpo original é reenviado (o SDK manda JSON como string).
    expect((calls[1]![1] as RequestInit).body).toBe('{"stream":true}')
    expect(warn).toHaveBeenCalledOnce()
  })

  it('não repete quando não há callback de rotação (gera id próprio)', async () => {
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
    ['auth recusada', 401, '{"error":{"message":"Incorrect API key provided"}}'],
    ['erro genérico do gateway', 500, 'Internal server error'],
    ['modelo indisponível', 400, '{"error":{"message":"Model is unavailable"}}'],
  ])('não repete %s', async (_label, status, body) => {
    const calls = stubFetch([() => new Response(body, { status })])

    const response = await providerFetch('orbit_conv1')(URL_GO, { method: 'POST', body: '{}' })

    expect(response.status).toBe(status)
    expect(calls).toHaveLength(1)
  })

  it('não repete quando o corpo não pode ser reenviado (stream)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = stubFetch([() => new Response(REFUSAL, { status: 400 })])
    const stream = new ReadableStream()

    await providerFetch('orbit_conv1')(URL_GO, { method: 'POST', body: stream })

    expect(calls).toHaveLength(1)
  })

  it('não repete requisição abortada pelo usuário', async () => {
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
