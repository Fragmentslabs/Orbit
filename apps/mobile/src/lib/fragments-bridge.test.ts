import { describe, expect, it } from 'vitest'
import { fragmentHostUrl, offlineResult, parseFragmentMessage, previewAllows, previewRefusal, replyScript, themeScript } from './fragments-bridge'

describe('parseFragmentMessage', () => {
  it('accepts a call, a ready and a log, and nothing else', () => {
    expect(parseFragmentMessage('{"type":"call","id":3,"method":"store.get","params":{"key":"a"}}')).toEqual({
      type: 'call',
      id: 3,
      method: 'store.get',
      params: { key: 'a' },
    })
    expect(parseFragmentMessage('{"type":"ready"}')).toEqual({ type: 'ready' })
    expect(parseFragmentMessage('{"type":"log","level":"error","message":"boom"}')).toEqual({ type: 'log', level: 'error', message: 'boom' })
    for (const bad of ['', 'nope', '[]', '{"type":"other"}', '{"type":"call","id":"1","method":"x"}', '{"type":"call","id":-1,"method":"x"}', '{"type":"call","id":1.5,"method":"x"}', '{"type":"call","id":1,"method":""}', '{"type":"log"}']) {
      expect(parseFragmentMessage(bad)).toBeNull()
    }
  })

  it('drops a message that is far too big or a method name that is not a method', () => {
    expect(parseFragmentMessage(`{"type":"call","id":1,"method":"${'x'.repeat(41)}"}`)).toBeNull()
    expect(parseFragmentMessage(`{"type":"call","id":1,"method":"store.set","params":"${'x'.repeat(600 * 1024)}"}`)).toBeNull()
  })
})

describe('replyScript', () => {
  it('answers a call through the host page, with the error shape the SDK reads', () => {
    expect(replyScript(7, { ok: true, value: { text: 'oi' } })).toBe('window.__orbitReply({"id":7,"ok":true,"value":{"text":"oi"}});true;')
    expect(replyScript(8, { ok: false, error: { code: 'permission_denied', message: 'no' } })).toBe(
      'window.__orbitReply({"id":8,"ok":false,"error":{"code":"permission_denied","message":"no"}});true;',
    )
  })

  it('cannot be broken out of by what the desktop sends back', () => {
    const script = replyScript(1, { ok: true, value: 'a\u2028b"});alert(1);//' })
    expect(script).not.toContain('\u2028')
    expect(script.endsWith(';true;')).toBe(true)
    // The text stays inside one JSON string: the quote is escaped.
    expect(script).toContain('\\"});alert(1);//')
  })

  it('has an answer for a call that never reached the desktop', () => {
    expect(offlineResult('x')).toEqual({ ok: false, error: { code: 'offline', message: 'x' } })
  })
})

describe('the host address and the theme', () => {
  it('points at the reserved file under the signed folder, with the theme', () => {
    expect(fragmentHostUrl('http://192.168.0.2:3848/api/file/fragment/frag-a-1/tok/', 'dark')).toBe(
      'http://192.168.0.2:3848/api/file/fragment/frag-a-1/tok/__orbit-host.html?theme=dark',
    )
    expect(fragmentHostUrl('http://h/api/file/fragment/x/tok', 'light')).toBe('http://h/api/file/fragment/x/tok/__orbit-host.html?theme=light')
    expect(themeScript('dark')).toBe("window.__orbitTheme('dark');true;")
  })
})

describe('the preview in the list', () => {
  it('may read what the fragment stored and does nothing else', () => {
    expect(previewAllows('store.get')).toBe(true)
    expect(previewAllows('store.keys')).toBe(true)
    for (const method of ['store.set', 'store.delete', 'ai.generate', 'http.fetch', 'mcp.call', 'notify.show', 'models.set', 'permissions.request', 'constructor']) {
      expect(previewAllows(method)).toBe(false)
    }
    expect(previewRefusal()).toEqual({ ok: false, error: { code: 'preview', message: 'This is a read-only preview.' } })
  })
})
