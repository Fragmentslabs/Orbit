/**
 * `window.orbit` — the only door out of a fragment page.
 *
 * Injected by the scheme at the top of the HTML (see fragment-protocol.ts), so it exists
 * before any script of the fragment. The page runs in an opaque origin (sandboxed
 * iframe, no allow-same-origin): it cannot reach the Orbit window, so every call is a
 * postMessage to the tab that hosts the iframe, which forwards it to the main process.
 * The main process is who decides — the page only asks.
 *
 * Every message carries the token of THIS load (`?__t=`, set by the tab). A page that
 * navigated itself somewhere else does not know it, and the tab ignores it.
 */
export const FRAGMENT_SDK_MARK = '<!-- orbit-fragment-sdk -->'

export const FRAGMENT_SDK = `${FRAGMENT_SDK_MARK}
<script>
(function () {
  var token = new URLSearchParams(location.search).get('__t') || ''
  var seq = 0
  var pending = {}
  var listeners = {}
  var logged = 0

  function fail(code, message) {
    var err = new Error(message)
    err.code = code
    return err
  }
  function post(message) {
    message.__orbit = 1
    message.t = token
    parent.postMessage(message, '*')
  }
  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq
      var timer = setTimeout(function () {
        delete pending[id]
        reject(fail('timeout', method + ' timed out'))
      }, 120000)
      pending[id] = { resolve: resolve, reject: reject, timer: timer }
      post({ id: id, method: method, params: params })
    })
  }
  function emit(name, data) {
    var list = (listeners[name] || []).slice()
    for (var i = 0; i < list.length; i++) {
      try { list[i](data) } catch (e) { console.error(e) }
    }
  }

  var orbit = {
    sdk: 1,
    theme: document.documentElement.classList.contains('orbit-dark') ? 'dark' : 'light',
    store: {
      get: function (key) { return call('store.get', { key: key }) },
      set: function (key, value) { return call('store.set', { key: key, value: value }) },
      delete: function (key) { return call('store.delete', { key: key }) },
      keys: function () { return call('store.keys') }
    },
    ai: {
      generate: function (options) { return call('ai.generate', options) }
    },
    on: function (name, fn) {
      (listeners[name] = listeners[name] || []).push(fn)
      return function () {
        listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn })
      }
    }
  }
  window.orbit = orbit

  window.addEventListener('message', function (e) {
    if (e.source !== parent) return
    var d = e.data
    if (!d) return
    if (d.type === 'orbit:theme') {
      orbit.theme = d.theme === 'dark' ? 'dark' : 'light'
      emit('theme', orbit.theme)
      return
    }
    if (!d.__orbit) return
    var p = pending[d.id]
    if (!p) return
    delete pending[d.id]
    clearTimeout(p.timer)
    if (d.ok) p.resolve(d.value)
    else p.reject(fail((d.error && d.error.code) || 'error', (d.error && d.error.message) || 'call failed'))
  })

  // The page's console and errors go to the tab, so the agent can read them
  // (fragment_logs) and fix its own mistakes.
  function describe(value) {
    if (typeof value === 'string') return value
    if (value instanceof Error) return value.stack || value.message
    try { return JSON.stringify(value) } catch (e) { return String(value) }
  }
  function report(level, parts) {
    if (logged++ > 200) return
    post({ log: { level: level, message: parts.map(describe).join(' ') } })
  }
  ;['log', 'info', 'warn', 'error'].forEach(function (level) {
    var original = console[level]
    console[level] = function () {
      report(level, Array.prototype.slice.call(arguments))
      return original.apply(console, arguments)
    }
  })
  window.addEventListener('error', function (e) {
    report('error', [e.message + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : '')])
  })
  window.addEventListener('unhandledrejection', function (e) {
    report('error', ['Unhandled rejection: ' + describe(e.reason)])
  })
})()
</script>`

/** Puts the SDK at the very start of <head> (or of the document) so it loads first. */
export function injectFragmentSdk(html: string): string {
  if (html.includes(FRAGMENT_SDK_MARK)) return html
  const head = /<head(\s[^>]*)?>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + '\n' + FRAGMENT_SDK + '\n' + html.slice(at)
  }
  return FRAGMENT_SDK + '\n' + html
}
