/**
 * Inspect mode, the page's half. The host asks (`orbit:inspect`), the page highlights the
 * element under the pointer and reports the one that was clicked; the host decides what
 * to do with it. Dormant until asked, so a fragment that never gets inspected pays nothing.
 *
 * The page is another origin: the host cannot read its DOM, so the picker has to live
 * here. What leaves is a small description (tag, selector, text, html), clipped — the same
 * shape the panel browser reports for a selected element.
 */
export const FRAGMENT_INSPECTOR_MARK = '<!-- orbit-fragment-inspector -->'

export const FRAGMENT_INSPECTOR = `${FRAGMENT_INSPECTOR_MARK}
<script>
(function () {
  var token = new URLSearchParams(location.search).get('__t') || ''
  var active = false
  var box = null

  function post(message) {
    message.__orbit = 1
    message.t = token
    parent.postMessage(message, '*')
  }
  function clip(value, max) {
    value = String(value == null ? '' : value).replace(/\\s+/g, ' ').trim()
    return value.length > max ? value.slice(0, max) + '…' : value
  }
  // A selector the agent can search for: an id when there is one, else tag.class steps with
  // :nth-of-type where siblings share the tag, climbing at most 5 levels.
  function selectorOf(el) {
    var parts = []
    while (el && el.nodeType === 1 && el !== document.documentElement && parts.length < 5) {
      if (el.id) { parts.unshift('#' + el.id); break }
      var part = el.tagName.toLowerCase()
      var cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).filter(Boolean).slice(0, 2)
      if (cls.length) part += '.' + cls.join('.')
      var parentEl = el.parentElement
      if (parentEl) {
        var same = Array.prototype.filter.call(parentEl.children, function (c) { return c.tagName === el.tagName })
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')'
      }
      parts.unshift(part)
      el = parentEl
    }
    return parts.join(' > ')
  }
  function highlight(el) {
    if (!box) {
      box = document.createElement('div')
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #10b981;background:rgba(16,185,129,.12);border-radius:3px;transition:all 60ms'
      document.documentElement.appendChild(box)
    }
    var r = el.getBoundingClientRect()
    box.style.display = 'block'
    box.style.left = r.left + 'px'
    box.style.top = r.top + 'px'
    box.style.width = r.width + 'px'
    box.style.height = r.height + 'px'
  }
  function onMove(e) {
    var el = e.target
    if (el && el.nodeType === 1 && el !== box) highlight(el)
  }
  function onClick(e) {
    e.preventDefault()
    e.stopPropagation()
    var el = e.target
    if (!el || el.nodeType !== 1) return
    post({ inspect: {
      tag: el.tagName.toLowerCase(),
      selector: selectorOf(el),
      text: clip(el.innerText || el.textContent, 200),
      html: clip(el.outerHTML, 800)
    } })
  }
  function onKey(e) {
    if (e.key === 'Escape') post({ inspect: { cancel: true } })
  }
  function setActive(on) {
    if (on === active) return
    active = on
    var fn = on ? 'addEventListener' : 'removeEventListener'
    // Capture, so the page's own handlers never see the pick.
    document[fn]('mousemove', onMove, true)
    document[fn]('click', onClick, true)
    document[fn]('keydown', onKey, true)
    document.documentElement.style.cursor = on ? 'crosshair' : ''
    if (!on && box) box.style.display = 'none'
  }
  window.addEventListener('message', function (e) {
    if (e.source !== parent || !e.data || e.data.type !== 'orbit:inspect') return
    setActive(e.data.on === true)
  })
})()
</script>`
