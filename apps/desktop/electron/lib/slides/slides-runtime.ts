/**
 * Navigation runtime of the slide decks — the ONLY place where the stage lives.
 *
 * The deck is ONE HTML file (`index.html` with one `<section class="slide">` per
 * slide) and has no JavaScript of its own. The one that assembles the stage, scales the 16:9 and
 * obeys the keyboard is this script, served by the `orbit-slides://` scheme as the
 * first script of the `<head>`.
 *
 * Why an injected runtime, and not the deck taking care of itself: this way the deck is
 * CONTENT (the agent writes an HTML and that is it, like an artifact), while
 * navigation, scaling, thumbnails, notes and printing belong to the app — the same
 * separation motion makes between composition and player. A hand-written deck
 * opens the same, and an old deck gains the new features without being rewritten.
 *
 * Since the script is the FIRST of the <head>, it runs before the <body> exists:
 * everything that touches the document happens inside `start()`, called on
 * DOMContentLoaded (the same caution as design-runtime). Without that the deck
 * would find zero slides and the stage would be born empty.
 *
 * The iframe runs in `sandbox="allow-scripts"` WITHOUT `allow-same-origin` (opaque
 * origin): the panel cannot reach the deck's DOM. The conversation is over postMessage with
 * `source: "orbit-slides"`:
 *
 *   deck → panel: ready (total, size, titles and notes), change (index),
 *                 error, request-fullscreen
 *   panel → deck: go(index), next, prev
 *
 * The text is a string on purpose: it runs IN the page, not in the main. The pure
 * parsing functions of the deck (slides-deck.ts) apply the SAME title and
 * note rules, and the tests cover them.
 */

/** Mark of the bridge messages (host ⇄ iframe). */
export const SLIDES_SOURCE = 'orbit-slides'

/** Reserved path that serves the runtime script from the deck folder. */
export const SLIDES_RUNTIME_PATH = '/__orbit_slides_runtime.js'

const RUNTIME_MARK = 'data-orbit-slides-runtime'

/** Default stage of a slide (16:9). The deck may declare another one in the <meta>. */
export const SLIDES_WIDTH = 1280
export const SLIDES_HEIGHT = 720

/**
 * The runtime script. No template literals in there on purpose: the whole file
 * is a string, and `$` + `{` in the middle of it would break the assembly.
 */
export const SLIDES_RUNTIME = `(() => {
  if (window.__orbitSlidesReady) return
  window.__orbitSlidesReady = true

  const SOURCE = '${SLIDES_SOURCE}'
  const PRINT = /(?:\\?|&)print=1/.test(location.search)

  const post = (message) => {
    try {
      parent.postMessage(Object.assign({ source: SOURCE }, message), '*')
    } catch (err) {}
  }

  function start() {
    // The stage size can come from the deck itself: <meta name="orbit-slides"
    // content="width=1920,height=1080">. Without the meta, 1280x720 (16:9).
    let width = ${SLIDES_WIDTH}
    let height = ${SLIDES_HEIGHT}
    const meta = document.querySelector('meta[name="orbit-slides"]')
    if (meta) {
      const raw = meta.getAttribute('content') || ''
      for (const pair of raw.split(/[,;]/)) {
        const at = pair.indexOf('=')
        if (at < 0) continue
        const key = pair.slice(0, at).trim()
        const num = Number(pair.slice(at + 1).trim())
        if (!isFinite(num) || num <= 0) continue
        if (key === 'width') width = Math.round(num)
        if (key === 'height') height = Math.round(num)
      }
    }

    const sections = []
    const all = document.querySelectorAll('.slide')
    for (const el of all) {
      // Only the TOP-level slides of the deck: a .slide inside another (a cover that
      // repeats the pattern) does not become a stop of the presentation.
      if (el.closest('.orbit-slides-stage')) continue
      sections.push(el)
    }

    if (sections.length === 0) {
      post({ type: 'error', message: 'no elements with class "slide" in the deck' })
      return
    }

    // ------------------------------------------------------------ structure
    const root = document.createElement('div')
    root.id = 'orbit-slides-root'
    const viewport = document.createElement('div')
    viewport.className = 'orbit-slides-viewport'
    const stage = document.createElement('div')
    stage.className = 'orbit-slides-stage'
    viewport.appendChild(stage)
    root.appendChild(viewport)

    const style = document.createElement('style')
    style.setAttribute('data-orbit-slides', '')
    style.textContent = [
      '#orbit-slides-root{position:fixed;inset:0;display:grid;place-items:center;overflow:hidden;z-index:2147483000}',
      '.orbit-slides-viewport{position:absolute;inset:0;display:grid;place-items:center;overflow:hidden}',
      '.orbit-slides-stage{position:absolute;left:50%;top:50%;width:' + width + 'px;height:' + height + 'px;transform-origin:center center}',
      '.orbit-slides-stage>.orbit-slide{position:absolute;inset:0;visibility:hidden;opacity:0;pointer-events:none}',
      '.orbit-slides-stage>.orbit-slide.is-current{visibility:visible;opacity:1;pointer-events:auto}',
      '.orbit-slides-stage aside.notes,.orbit-slides-stage [data-notes]{display:none !important}',
    ].join('\\n')
    document.head.appendChild(style)
    document.body.appendChild(root)

    // Printing/PDF: all the slides stacked, one per page, without scale and
    // without the interface — it is the same document, read from top to bottom.
    if (PRINT) {
      const printStyle = document.createElement('style')
      printStyle.setAttribute('data-orbit-slides-print', '')
      printStyle.textContent = [
        '@page{size:' + width + 'px ' + height + 'px;margin:0}',
        'html,body{margin:0;padding:0}',
        '#orbit-slides-root{position:static;display:block;overflow:visible}',
        '.orbit-slides-viewport{position:static;display:block;overflow:visible}',
        '.orbit-slides-stage{transform:none !important;left:auto !important;top:auto !important;width:auto !important;height:auto !important}',
        '.orbit-slides-stage>.orbit-slide{position:relative !important;inset:auto !important;visibility:visible !important;opacity:1 !important;pointer-events:auto !important;width:' + width + 'px;height:' + height + 'px;break-after:page;page-break-after:always}',
        // The forced break after the LAST slide generates a blank page at
        // the end of the PDF: Chromium respects the break-after even when there is
        // nothing else left to paginate.
        '.orbit-slides-stage>.orbit-slide:last-child{break-after:auto;page-break-after:auto}',
      ].join('\\n')
      document.head.appendChild(printStyle)
    }

    for (let i = 0; i < sections.length; i++) {
      const el = sections[i]
      el.classList.add('orbit-slide')
      // The deck can draw its own number with [data-index] (the house theme
      // uses it in the corner of the slide).
      el.setAttribute('data-index', String(i + 1))
      stage.appendChild(el)
    }

    // --------------------------------------------------------------- state
    let index = 0

    const text = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : '')

    const titleOf = (el, i) => {
      const explicit = el.getAttribute('data-title')
      if (explicit && explicit.trim()) return explicit.trim()
      const heading = el.querySelector('h1, h2, h3')
      return text(heading) || 'Slide ' + (i + 1)
    }

    // Notes: <aside class="notes"> counts by the TEXT; a filled data-notes counts
    // by the VALUE of the attribute (the same rule as slides-deck.ts, in the main).
    const notesOf = (el) => {
      const holder = el.querySelector('aside.notes, [data-notes]')
      if (!holder) return ''
      const value = holder.getAttribute('data-notes')
      return value && value.trim() ? value.trim() : text(holder)
    }

    const slides = sections.map((el, i) => ({ title: titleOf(el, i), notes: notesOf(el) }))

    const paint = () => {
      for (let i = 0; i < sections.length; i++) {
        if (i === index) sections[i].classList.add('is-current')
        else sections[i].classList.remove('is-current')
      }
    }

    const go = (next) => {
      const target = Math.max(0, Math.min(sections.length - 1, Math.round(next) || 0))
      const changed = target !== index
      index = target
      paint()
      if (changed) post({ type: 'change', index, total: sections.length })
    }

    const fit = () => {
      if (PRINT) return
      const vw = viewport.clientWidth || window.innerWidth
      const vh = viewport.clientHeight || window.innerHeight
      const scale = Math.min(vw / width, vh / height)
      // translate BEFORE the scale: the stage can be BIGGER than the window (a
      // narrow panel), and an item bigger than the container does not get centered
      // by grid/flex — it leaks to the right. Anchored at 50%/50% with
      // translate(-50%,-50%) the center of the slide is the center of the stage, always.
      stage.style.transform = 'translate(-50%, -50%) scale(' + scale + ')'
    }

    // -------------------------------------------------------------- events
    window.addEventListener('resize', fit)
    // The stage lives inside an iframe whose size is decided by the panel:
    // not every layout change arrives as a "resize" event on the window of the
    // iframe (a panel that opens a sidebar, for example). The observer
    // guarantees that the scale follows the REAL size of the stage.
    if (typeof ResizeObserver === 'function') {
      try {
        new ResizeObserver(() => fit()).observe(viewport)
      } catch (err) {}
    }

    window.addEventListener('message', (event) => {
      const data = event.data
      if (!data || data.source !== SOURCE) return
      if (data.type === 'go') go(Number(data.index))
      else if (data.type === 'next') go(index + 1)
      else if (data.type === 'prev') go(index - 1)
    })

    window.addEventListener('keydown', (event) => {
      const target = event.target
      const tag = target && target.tagName ? String(target.tagName).toLowerCase() : ''
      // A field inside the slide is still a field: the arrows and the space are its own.
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) return
      const key = event.key
      if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'PageDown' || key === ' ' || key === 'Enter') {
        event.preventDefault()
        go(index + 1)
      } else if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp' || key === 'Backspace') {
        event.preventDefault()
        go(index - 1)
      } else if (key === 'Home') {
        event.preventDefault()
        go(0)
      } else if (key === 'End') {
        event.preventDefault()
        go(sections.length - 1)
      } else if (key === 'f' || key === 'F') {
        // Fullscreen belongs to the APP WINDOW, not to the iframe: the host decides.
        event.preventDefault()
        post({ type: 'request-fullscreen' })
      }
    })

    // A click advances (presenting is clicking), except on top of something clickable — a
    // link or button inside the slide belongs to the slide.
    viewport.addEventListener('click', (event) => {
      const target = event.target
      if (!target || !target.closest) return
      if (target.closest('a, button, input, textarea, select, label, [data-no-advance]')) return
      const selection = window.getSelection && window.getSelection()
      if (selection && String(selection).length > 0) return
      go(index + 1)
    })

    // ------------------------------------------------------------------ start
    paint()
    fit()
    window.orbitSlides = {
      version: 1,
      get index() {
        return index
      },
      total: sections.length,
      width,
      height,
      go,
      next: () => go(index + 1),
      prev: () => go(index - 1),
    }

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(fit).catch(() => {})
    }

    post({ type: 'ready', total: sections.length, width, height, slides, print: PRINT })
  }

  // The script is the first one of the <head>: the document is still being read.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()`

/**
 * Puts the runtime as the first script of the `<head>` (idempotent). Without a `<head>`,
 * it creates one; without an `<html>`, the script goes in front of the document.
 */
export function injectSlidesRuntime(html: string): string {
  if (html.includes(RUNTIME_MARK)) return html
  const tag = `<script ${RUNTIME_MARK} src="${SLIDES_RUNTIME_PATH}"></script>`
  const head = /<head[^>]*>/i.exec(html)
  if (head) return `${html.slice(0, head.index + head[0].length)}${tag}${html.slice(head.index + head[0].length)}`
  const htmlTag = /<html[^>]*>/i.exec(html)
  if (htmlTag) {
    return `${html.slice(0, htmlTag.index + htmlTag[0].length)}<head>${tag}</head>${html.slice(htmlTag.index + htmlTag[0].length)}`
  }
  return tag + html
}
