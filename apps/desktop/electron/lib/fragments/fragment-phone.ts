import type { FragmentPhoneEntry } from '@shared/companion'
import { FRAGMENT_PHONE_HOST_FILE, type FragmentManifest } from '@shared/fragments'

/**
 * A fragment on the phone. The desktop shows the page in an iframe inside a tab that is the
 * courier of its `window.orbit` calls; the phone does the same, with a small HOST page: it holds
 * the iframe, checks the token of the load on every message, and hands the calls to the app, which
 * sends them to the desktop (`fragments:call`) and gives the answer back. The SDK inside the
 * fragment is the very one the desktop injects — nothing in the page knows it is on a phone.
 *
 * Reserved file name under the fragment's signed address.
 */
export const FRAGMENT_HOST_FILE = FRAGMENT_PHONE_HOST_FILE

/** The host page never loads anything but the fragment's own files, in a frame. */
export const FRAGMENT_HOST_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "frame-src 'self'",
].join('; ')

export function fragmentHostHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
html,body{margin:0;height:100%;background:transparent}
iframe{position:fixed;inset:0;width:100%;height:100%;border:0;background:transparent}
</style>
</head>
<body>
<iframe id="f" sandbox="allow-scripts allow-same-origin" title="fragment"></iframe>
<script>
(function () {
  var frame = document.getElementById('f')
  // Token of THIS load: the SDK stamps it on every message, so a page that navigated itself
  // somewhere else (and does not know it) is ignored.
  var token = Math.random().toString(36).slice(2) + Date.now().toString(36)
  var params = new URLSearchParams(location.search)
  var theme = params.get('theme') === 'dark' ? 'dark' : 'light'
  // 'cover': the desktop is taking the picture of this page for the phone's list. Nobody answers the page's
  // calls here, so the host does — reads only, through the signed folder — and says when it has settled.
  var cover = params.get('cover') === '1'
  var coverReads = { 'store.get': 1, 'store.keys': 1 }
  function answerCover(d) {
    if (!coverReads[d.method]) {
      toPage({ __orbit: 1, id: d.id, ok: false, error: { code: 'preview', message: 'This is a read-only preview.' } })
      return
    }
    var query = 'm=' + encodeURIComponent(d.method) + '&p=' + encodeURIComponent(JSON.stringify(d.params || {}))
    fetch('__orbit-call?' + query).then(function (r) { return r.json() }).then(function (result) {
      toPage({ __orbit: 1, id: d.id, ok: result.ok === true, value: result.value, error: result.error })
    }).catch(function () {
      toPage({ __orbit: 1, id: d.id, ok: false, error: { code: 'offline', message: 'The read failed.' } })
    })
  }

  function toApp(message) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message))
  }
  function toPage(message) {
    if (frame.contentWindow) frame.contentWindow.postMessage(message, '*')
  }

  window.addEventListener('message', function (e) {
    if (e.source !== frame.contentWindow) return
    var d = e.data
    if (!d || d.__orbit !== 1 || d.t !== token) return
    if (d.log && typeof d.log.message === 'string') {
      toApp({ type: 'log', level: d.log.level, message: String(d.log.message).slice(0, 2000) })
      return
    }
    if (typeof d.id === 'number' && typeof d.method === 'string') {
      if (cover) answerCover(d)
      else toApp({ type: 'call', id: d.id, method: d.method, params: d.params })
    }
  })

  // The app's answers, and the theme of the app.
  window.__orbitReply = function (m) {
    toPage({ __orbit: 1, id: m.id, ok: m.ok === true, value: m.value, error: m.error })
  }
  window.__orbitTheme = function (t) {
    theme = t === 'dark' ? 'dark' : 'light'
    toPage({ type: 'orbit:theme', theme: theme })
  }
  frame.addEventListener('load', function () {
    toPage({ type: 'orbit:theme', theme: theme })
    toApp({ type: 'ready' })
    // Give the page a moment to read its data and paint it, then say it is ready for the picture.
    if (cover) setTimeout(function () { document.title = 'orbit-cover-ready' }, 1400)
  })
  frame.src = 'index.html?__t=' + token
})()
</script>
</body>
</html>`
}

/** What the phone's list needs about a fragment; `url` is the signed address of the host page. */
export function fragmentPhoneEntry(manifest: FragmentManifest, url: string, untrusted = false): FragmentPhoneEntry {
  return {
    id: manifest.id,
    name: manifest.name,
    icon: manifest.icon,
    pinned: manifest.pinned.list,
    revision: manifest.revision,
    updatedAt: manifest.updatedAt,
    requests: manifest.requests,
    grants: manifest.grants,
    hosts: manifest.hosts,
    mcp: manifest.mcp,
    untrusted,
    ...(manifest.sessionId ? { sessionId: manifest.sessionId } : {}),
    url,
  }
}
