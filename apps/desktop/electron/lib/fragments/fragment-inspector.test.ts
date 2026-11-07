import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { FRAGMENT_INSPECTOR } from './fragment-inspector'
import { injectFragmentSdk } from './fragment-sdk'

type Listener = (event: unknown) => void

/** Runs the real injected picker against a fake page with one nested element. */
function page() {
  const js = FRAGMENT_INSPECTOR.replace(/^[\s\S]*?<script>/, '').replace(/<\/script>\s*$/, '')
  const sent: Record<string, unknown>[] = []
  const win: Record<string, Listener[]> = {}
  const doc: Record<string, Listener[]> = {}
  const parentObj = { postMessage: (m: Record<string, unknown>) => sent.push(m) }
  const documentElement = { style: {} as Record<string, string>, appendChild() {} }
  const ctx: Record<string, unknown> = {
    window: { addEventListener: (n: string, f: Listener) => (win[n] ||= []).push(f) },
    parent: parentObj,
    location: { search: '?__t=tok' },
    document: {
      documentElement,
      createElement: () => ({ style: {}, getBoundingClientRect: () => ({}) }),
      addEventListener: (n: string, f: Listener) => (doc[n] ||= []).push(f),
      removeEventListener: (n: string, f: Listener) => (doc[n] = (doc[n] || []).filter((x) => x !== f)),
    },
    URLSearchParams,
    Array,
  }
  vm.createContext(ctx)
  vm.runInContext(js, ctx)
  const button = {
    nodeType: 1,
    tagName: 'BUTTON',
    id: '',
    className: 'btn primary',
    innerText: '  Save   all ',
    outerHTML: '<button class="btn primary">Save all</button>',
    parentElement: { nodeType: 1, tagName: 'DIV', id: 'toolbar', children: [] as unknown[], className: '' },
    getBoundingClientRect: () => ({ left: 1, top: 2, width: 3, height: 4 }),
  }
  button.parentElement.children = [button]
  const ask = (on: boolean, source: unknown = parentObj) =>
    win.message.forEach((f) => f({ source, data: { type: 'orbit:inspect', on } }))
  const click = () => (doc.click || []).forEach((f) => f({ target: button, preventDefault() {}, stopPropagation() {} }))
  return { sent, ask, click, parentObj }
}

describe('inspector in a simulated page', () => {
  it('stays silent until the host asks, then reports the clicked element', () => {
    const p = page()
    p.click()
    expect(p.sent).toHaveLength(0)

    p.ask(true)
    p.click()
    expect(p.sent[0]).toMatchObject({
      __orbit: 1,
      t: 'tok',
      inspect: { tag: 'button', selector: '#toolbar > button.btn.primary', text: 'Save all' },
    })
  })

  it('ignores a request that does not come from the host, and stops when told to', () => {
    const p = page()
    p.ask(true, {})
    p.click()
    expect(p.sent).toHaveLength(0)

    p.ask(true)
    p.ask(false)
    p.click()
    expect(p.sent).toHaveLength(0)
  })
})

describe('injection', () => {
  it('puts the picker next to the SDK, once', () => {
    const html = injectFragmentSdk('<html><head></head><body></body></html>')
    expect(html.match(/orbit-fragment-inspector/g)).toHaveLength(1)
    expect(injectFragmentSdk(html)).toBe(html)
  })
})
