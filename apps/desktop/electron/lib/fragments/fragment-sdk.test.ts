import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { FRAGMENT_SDK } from './fragment-sdk'

/**
 * `window.orbit` runs inside a string the scheme injects, so a typo there would only show up
 * as a blank fragment. This runs the real script against a fake page.
 */
describe('SDK in a simulated sandboxed page', () => {
  it('round-trips store.get, rejects with err.code, forwards logs and theme', async () => {
    const js = FRAGMENT_SDK.replace(/^[\s\S]*?<script>/, '').replace(/<\/script>\s*$/, '')
    type Msg = { id?: number; log?: { level: string; message: string } } & Record<string, unknown>
    type Listener = (event: unknown) => void
    const sent: Msg[] = []
    const listeners: Record<string, Listener[]> = {}
    const parentObj = { postMessage: (m: Msg) => sent.push(m) }
    const win: Record<string, unknown> = {
      addEventListener: (n: string, f: Listener) => (listeners[n] ||= []).push(f),
      parent: parentObj,
    }
    const ctx: Record<string, unknown> = {
      window: win, parent: parentObj, location: { search: '?rev=3&__t=tok123' },
      document: { documentElement: { classList: { contains: () => true } } },
      console: { log() {}, info() {}, warn() {}, error() {} },
      URLSearchParams, setTimeout, clearTimeout, Error, Promise, JSON, Array,
    }
    ctx.globalThis = ctx
    vm.createContext(ctx)
    vm.runInContext(js, ctx)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orbit = win.orbit as any
    expect(orbit.sdk).toBe(1)
    expect(orbit.theme).toBe('dark')

    const p = orbit.store.get('a')
    expect(sent[0]).toMatchObject({ __orbit: 1, t: 'tok123', method: 'store.get', params: { key: 'a' } })
    listeners.message.forEach((f) => f({ source: parentObj, data: { __orbit: 1, id: sent[0].id, ok: true, value: 42 } }))
    expect(await p).toBe(42)

    const q = orbit.ai.generate({ prompt: 'x' })
    listeners.message.forEach((f) => f({ source: parentObj, data: { __orbit: 1, id: sent[1].id, ok: false, error: { code: 'permission_denied', message: 'no' } } }))
    await expect(q).rejects.toMatchObject({ code: 'permission_denied' })

    // messages from anything but the parent are ignored
    const r = orbit.store.keys()
    listeners.message.forEach((f) => f({ source: {}, data: { __orbit: 1, id: sent[2].id, ok: true, value: ['evil'] } }))
    listeners.message.forEach((f) => f({ source: parentObj, data: { __orbit: 1, id: sent[2].id, ok: true, value: ['ok'] } }))
    expect(await r).toEqual(['ok'])

    let themed = ''
    orbit.on('theme', (t: string) => (themed = t))
    listeners.message.forEach((f) => f({ source: parentObj, data: { type: 'orbit:theme', theme: 'light' } }))
    expect(themed).toBe('light')

    ;(ctx.console as { error: (...a: unknown[]) => void }).error('boom', { a: 1 })
    expect(sent.find((m) => m.log)?.log).toMatchObject({ level: 'error', message: 'boom {"a":1}' })
    listeners.error.forEach((f) => f({ message: 'x is not defined', filename: 'orbit-fragment://f/app.js', lineno: 7 }))
    expect(sent.at(-1)?.log?.message).toBe('x is not defined (app.js:7)')
  })
})
