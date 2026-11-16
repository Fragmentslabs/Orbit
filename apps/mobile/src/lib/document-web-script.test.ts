import { describe, expect, it } from 'vitest'
import {
  DOC_SCRIPT,
  ZOOM_MAX,
  ZOOM_MIN,
  findScript,
  jumpScript,
  parseDocMessage,
  stepZoom,
} from './document-web-script'

describe('parseDocMessage', () => {
  it('reads the outline and drops malformed items', () => {
    const msg = parseDocMessage(JSON.stringify({ type: 'outline', items: [{ id: 'a', title: 'T', level: 2 }, { id: 1 }, null] }))
    expect(msg).toEqual({ type: 'outline', items: [{ id: 'a', title: 'T', level: 2 }] })
  })
  it('reads find progress', () => {
    expect(parseDocMessage('{"type":"find","count":3,"index":1}')).toEqual({ type: 'find', count: 3, index: 1 })
  })
  it('ignores anything else', () => {
    expect(parseDocMessage('not json')).toBeNull()
    expect(parseDocMessage('{"type":"slides"}')).toBeNull()
    expect(parseDocMessage('3')).toBeNull()
  })
})

describe('scripts', () => {
  it('the injected page script is valid JavaScript', () => {
    expect(() => new Function(DOC_SCRIPT)).not.toThrow()
  })
  it('encodes the query so a quote cannot break out', () => {
    const js = findScript('a"); alert(1); ("')
    expect(() => new Function(js)).not.toThrow()
    expect(js).toContain('\\"')
  })
  it('jump targets by id', () => {
    expect(jumpScript('p3')).toBe('window.__od&&window.__od.jump("p3");true;')
  })
})

describe('stepZoom', () => {
  it('steps without float drift and clamps', () => {
    expect(stepZoom(1, 1)).toBe(1.2)
    expect(stepZoom(1.2, 1)).toBe(1.4)
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN)
  })
})

describe('the script in a page', () => {
  const posts: unknown[] = []
  const setup = (html: string) => {
    posts.length = 0
    document.body.innerHTML = html
    ;(window as unknown as { __od?: unknown }).__od = undefined
    ;(window as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = {
      postMessage: (d: string) => posts.push(JSON.parse(d)),
    }
    Element.prototype.scrollIntoView = () => {}
    new Function(DOC_SCRIPT)()
  }
  const run = (js: string) => new Function(js)()

  it('reports the headings as the outline', () => {
    setup('<h1>Title</h1><p>x</p><h3 id="k">Deep</h3>')
    expect(posts[0]).toEqual({
      type: 'outline',
      items: [
        { id: 'od-h0', title: 'Title', level: 1 },
        { id: 'k', title: 'Deep', level: 3 },
      ],
    })
  })

  it('finds, steps and clears matches', () => {
    setup('<p>Foo bar foo</p><p>other FOO</p>')
    run(findScript('foo'))
    expect(document.querySelectorAll('mark.od-hit')).toHaveLength(3)
    expect(posts.at(-1)).toEqual({ type: 'find', count: 3, index: 0 })
    run('window.__od.step(-1);true;')
    expect(posts.at(-1)).toEqual({ type: 'find', count: 3, index: 2 })
    run('window.__od.clear();true;')
    expect(document.querySelectorAll('mark')).toHaveLength(0)
    expect(document.body.textContent).toBe('Foo bar fooother FOO')
  })

  it('treats regex characters in the query literally', () => {
    setup('<p>a.b (c) a+b</p>')
    run(findScript('(c)'))
    expect(document.querySelectorAll('mark.od-hit')).toHaveLength(1)
  })
})
