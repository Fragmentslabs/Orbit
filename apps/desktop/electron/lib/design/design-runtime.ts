/**
 * The bridge that runs INSIDE each artboard (served by the orbit-design:// scheme
 * and injected as the first script of the <head>) — it is what makes the canvas
 * selectable and editable without a model parallel to the HTML.
 *
 * The artboard runs in a sandboxed iframe WITHOUT allow-same-origin: the panel cannot
 * reach its DOM. So this bridge is the one that reads and touches the DOM, and the two
 * talk over postMessage with `source: "orbit-design"`:
 *
 *   artboard → panel: ready (with the links to other screens), tree, hover,
 *                     select, info, rects, wheel, key, textEdited, navigate
 *                     (link clicked in presentation mode)
 *   panel → artboard: mode, select, hover, style, attr, text, tree
 *
 * The ADDRESS of an element is the path of child-element indices from the
 * <body> (`[1, 0, 2]`) — the same one the panel uses to find the element in the
 * SOURCE (DOMParser) and write the edit into the file. That is why the bridge lives in the
 * <head> and never puts anything in the <body>: the selection outline is drawn by the
 * panel, on top of the iframe, and not in here.
 */

/** Reserved path where the scheme serves the bridge. */
export const DESIGN_RUNTIME_PATH = '/__orbit_design_runtime.js'

const RUNTIME_MARK = 'data-orbit-design-runtime'

/** The properties the properties panel reads and edits (kebab-case). */
export const DESIGN_STYLE_PROPS = [
  'display',
  'position',
  'top',
  'left',
  'right',
  'bottom',
  'z-index',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'gap',
  'grid-template-columns',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration-line',
  'color',
  'background',
  'background-color',
  'opacity',
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'border',
  'border-width',
  'border-style',
  'border-color',
  'box-shadow',
  'overflow',
] as const

export const DESIGN_RUNTIME = `(() => {
  if (window.__orbitDesign) return
  window.__orbitDesign = true
  const SOURCE = 'orbit-design'
  const PROPS = ${JSON.stringify(DESIGN_STYLE_PROPS)}
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT', 'TITLE', 'BASE'])
  const MAX_NODES = 1500

  // In edit mode the artboard is a selection surface, not a document
  // to read: no text cursor and no native selection by dragging. The
  // exception is the text being edited (contenteditable), where the text cursor is
  // expected. That way the first click selects and drags instead of "promising"
  // text edition.
  const surface = document.createElement('style')
  surface.textContent =
    'html.__orbit-select, html.__orbit-select * { cursor: default !important; user-select: none !important; -webkit-user-select: none !important }' +
    'html.__orbit-select [contenteditable="true"], html.__orbit-select [contenteditable="true"] * { cursor: text !important; user-select: text !important; -webkit-user-select: text !important }' +
    'html.__orbit-select [contenteditable="true"] { outline: none !important }' +
    'html.__orbit-select [data-orbit-ui] { cursor: grab !important }' +
    'html.__orbit-drag, html.__orbit-drag * { cursor: grabbing !important }' +
    // Layer hidden by the eye of the Layers list: a VIEW state, never written to the source.
    '[data-orbit-hidden], [data-orbit-hidden] * { visibility: hidden !important; pointer-events: none !important }'
  ;(document.head || document.documentElement).appendChild(surface)
  document.documentElement.classList.add('__orbit-select')

  let selectMode = true
  let playMode = false
  let selected = null
  let group = []
  let dots = []
  let hovered = null
  let editing = null
  let editingResize = null
  let drag = null
  let pendingDown = null
  let suppressClick = false
  // The DOM tree is expensive to build (up to MAX_NODES nodes) and only the Layers
  // use it. It is sent when the panel ASKS for it ('tree') and, from then
  // on, on every structural change — never before that, and never after the
  // panel closes (the same request with want:false).
  let treeWanted = false

  const post = (message) => {
    try { parent.postMessage(Object.assign({ source: SOURCE }, message), '*') } catch (_) {}
  }

  const sendTree = () => { if (treeWanted) post({ type: 'tree', tree: tree() }) }

  const pathOf = (el) => {
    if (!el || el.nodeType !== 1) return null
    const path = []
    let node = el
    while (node && node !== document.body) {
      const up = node.parentElement
      if (!up) return null
      path.unshift(Array.prototype.indexOf.call(up.children, node))
      node = up
    }
    return node === document.body ? path : null
  }

  const byPath = (path) => {
    if (!Array.isArray(path)) return null
    let node = document.body
    for (let i = 0; i < path.length; i += 1) {
      const index = path[i]
      if (index < 0) {
  // TEXT node: only in the last place of the path.
        if (i !== path.length - 1 || !node) return null
        const child = node.childNodes[-index - 1]
        return child && child.nodeType === 3 ? child : null
      }
      node = node && node.children[index]
      if (!node) return null
    }
    return node
  }

  /** The path of a loose TEXT node: the parent's + the node index, negative. */
  const pathOfText = (node) => {
    const parent = node.parentElement
    if (!parent) return null
    const base = pathOf(parent)
    if (!base) return null
    const index = Array.prototype.indexOf.call(parent.childNodes, node)
    if (index < 0) return null
    return base.concat(-(index + 1))
  }

  /** The path of any target: element or text node. */
  const pathOfNode = (node) => (node && node.nodeType === 3 ? pathOfText(node) : pathOf(node))

  const rectOf = (el) => {
    if (!el) return null
    if (el.nodeType === 3) {
  // Loose text: the rectangle is the one of the RUN (the Range of the content).
      const range = document.createRange()
      range.selectNodeContents(el)
      const r = range.getBoundingClientRect()
      if (!r || (!r.width && !r.height)) return null
      return { x: r.left, y: r.top, w: r.width, h: r.height }
    }
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  }

  // The "dots" of the multiple selection (like in Figma): ONE CIRCLE per
  // selected item, at its CENTER. Each circle is that item's handle: dragging
  // by it reorders the group among themselves (the items that were NOT selected
  // stay where they are). Whoever drags the item itself is the one who can take it out
  // of the parent.
  //
  // They live in <html>, and not in <body>, so that they do not become extra children in the
  // tree/paths.
  //
  // The style is ALL with !important: the artboard CSS (which the agent writes)
  // may have a generic rule for div/button and deform the circle — width,
  // padding, transform. Here the circle is round always.
  const DOT_STYLE =
    'position:fixed !important;width:12px !important;height:12px !important;min-width:0 !important;min-height:0 !important;max-width:none !important;max-height:none !important;margin:0 !important;padding:0 !important;border:1.5px solid #0d99ff !important;border-radius:50% !important;box-sizing:border-box !important;transform:none !important;transform-origin:center !important;background:#fff !important;box-shadow:0 1px 3px rgba(0,0,0,0.3) !important;z-index:2147483647 !important;cursor:grab !important;pointer-events:auto !important;flex:none !important;line-height:0 !important;font-size:0 !important;overflow:hidden !important;clip-path:none !important;filter:none !important'

  const makeDot = (dot) => {
    dot.setAttribute('data-orbit-ui', '')
    dot.style.cssText = DOT_STYLE
    dot.style.setProperty('display', 'none', 'important')
    dot.addEventListener('pointerdown', (e) => {
      if (!selectMode || drag || editing || group.length < 2) return
      e.preventDefault()
      e.stopPropagation()
      const index = dots.indexOf(dot)
      const picked = group[index]
      if (!picked) return
  // Restricted drag: only the order among the selected items.
      startDrag([picked], e.clientX, e.clientY, true, group.slice())
    })
    document.documentElement.appendChild(dot)
    return dot
  }

  const syncDots = () => {
    if (!selectMode || drag || editing || group.length < 2) {
      for (const dot of dots) dot.style.setProperty('display', 'none', 'important')
      return
    }
    while (dots.length > group.length) {
      const dot = dots.pop()
      if (dot && dot.parentNode) dot.parentNode.removeChild(dot)
    }
    while (dots.length < group.length) dots.push(makeDot(document.createElement('div')))
    for (let i = 0; i < group.length; i += 1) {
      const dot = dots[i]
      const r = group[i].getBoundingClientRect()
      dot.style.setProperty('display', 'block', 'important')
      dot.style.setProperty('left', (r.left + r.width / 2 - 6) + 'px', 'important')
      dot.style.setProperty('top', (r.top + r.height / 2 - 6) + 'px', 'important')
    }
  }

  /** The paths of every member (empty when there is no selection). */
  const groupPaths = () => {
    const paths = []
    for (const el of group) {
      const path = pathOf(el)
      if (path) paths.push(path)
    }
    return paths
  }

  const kindOf = (el) => {
    const tag = el.tagName
    if (tag === 'IMG' || tag === 'PICTURE' || tag === 'VIDEO' || tag === 'CANVAS') return 'image'
    if (tag === 'svg' || tag === 'SVG') return 'svg'
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return 'input'
    const onlyText = el.children.length === 0 && (el.textContent || '').trim().length > 0
    return onlyText ? 'text' : 'box'
  }

  const labelOf = (el) => {
    if (el.id) return '#' + el.id
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/)[0] : ''
    if (cls) return '.' + cls
    return ''
  }

  const textOf = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)

  let count = 0
  const nodeOf = (el, path) => {
    count += 1
    const kind = kindOf(el)
    const node = {
      tag: el.tagName.toLowerCase(),
      label: labelOf(el),
      text: kind === 'text' || kind === 'input' ? textOf(el) : '',
      kind,
      path,
      hidden: el.hasAttribute('data-orbit-hidden'),
      children: [],
    }
    if (kind === 'svg') return node
  // Children in DOM ORDER, mixing elements and LOOSE TEXT (the text that
  // is not inside any element). Without that the text disappears from the
  // Layers list and cannot be grabbed — and it is real text on the screen.
  // In an element that ONLY has text, the element already is the layer: the text
  // inside it does not become a second layer.
    const onlyText = el.children.length === 0
    let elementIndex = 0
    const kids = el.childNodes
    for (let i = 0; i < kids.length && count < MAX_NODES; i += 1) {
      const child = kids[i]
      if (child.nodeType === 3) {
        if (onlyText) continue
        const text = (child.data || '').replace(/\\s+/g, ' ').trim()
        if (!text) continue
        count += 1
        node.children.push({
          tag: '#text',
          label: '',
          text: text.slice(0, 80),
          kind: 'text',
          path: path.concat(-(i + 1)),
          children: [],
        })
        continue
      }
      if (child.nodeType !== 1) continue
      const index = elementIndex
      elementIndex += 1
      if (SKIP.has(child.tagName)) continue
      node.children.push(nodeOf(child, path.concat(index)))
    }
    return node
  }

  const tree = () => {
    count = 0
    return nodeOf(document.body, [])
  }

  const infoOf = (el) => {
    if (!el) return null
    if (el.nodeType === 3) {
  // Loose text: it has no tag and no style of its own — the style comes from the parent
  // (it is inherited), and that is where the editing acts.
      const parent = el.parentElement
      const cs = getComputedStyle(parent || el)
      const inline = {}
      const computed = {}
      for (const prop of PROPS) {
        inline[prop] = parent ? parent.style.getPropertyValue(prop) : ''
        computed[prop] = cs.getPropertyValue(prop)
      }
      return {
        tag: '#text',
        label: '',
        kind: 'text',
        text: el.data,
        rect: rectOf(el),
        inline,
        computed,
        attrs: {},
        html: el.data.slice(0, 2000),
      }
    }
    const cs = getComputedStyle(el)
    const inline = {}
    const computed = {}
    for (const prop of PROPS) {
      inline[prop] = el.style.getPropertyValue(prop)
      computed[prop] = cs.getPropertyValue(prop)
    }
    const attrs = {}
    for (const name of ['id', 'class', 'src', 'href', 'alt', 'style']) {
      const value = el.getAttribute(name)
      if (value !== null) attrs[name] = value
    }
    const kind = kindOf(el)
    return {
      tag: el.tagName.toLowerCase(),
      label: labelOf(el),
      kind,
      text: kind === 'text' ? (el.textContent || '') : null,
      rect: rectOf(el),
      inline,
      computed,
      attrs,
      html: el.outerHTML.length > 2000 ? el.outerHTML.slice(0, 2000) + '…' : el.outerHTML,
    }
  }

  const sendInfo = () => {
    const path = selected ? pathOfNode(selected) : null
    post({ type: 'info', path, info: infoFor(selected) })
  }

  /**
   * The info of the selected item, with what DIFFERS in the group marked as "Mixed" —
   * it is what the panel shows when more than one element is selected.
   *
   * The comparison is of the EFFECTIVE value (the computed one): two elements that
   * really became equal are not "mixed", even if one of them has the
   * property in the style and the other inherits it.
   */
  const infoFor = (el) => {
    const info = infoOf(el)
    if (!info) return null
    const others = group.filter((member) => member !== el && member.nodeType === 1)
    if (others.length === 0) return info
    const values = (node) => {
      const cs = getComputedStyle(node)
      const out = {}
      for (const prop of PROPS) out[prop] = cs.getPropertyValue(prop)
      return out
    }
    const mine = values(el.nodeType === 1 ? el : el.parentElement || el)
  // The other members' values, read only once.
    const othersValues = others.map(values)
    const mixed = []
  // With more than one selected, the value in common becomes the VALUE of the
  // field (and not a blanked placeholder): it is what the selected items have in
  // common, and what the user sees. What differs is left without a value and shows "Mixed".
    const inline = {}
    for (const prop of PROPS) {
      const same = othersValues.every((other) => other[prop] === mine[prop])
      if (same) inline[prop] = mine[prop]
      else mixed.push(prop)
    }
    const mixedAttrs = []
    const attrs = {}
    for (const name of ['id', 'class', 'src', 'href', 'alt']) {
      const value = el.getAttribute ? el.getAttribute(name) || '' : ''
      const same = others.every((other) => (other.getAttribute(name) || '') === value)
      if (same) attrs[name] = value
      else mixedAttrs.push(name)
    }
  // Text is also a property: if one has a text and the other another, it is
  // "mixed" (and what the user types applies to all of them).
    const mixedText = info.text !== null && others.some((other) => (other.textContent || '') !== (el.textContent || ''))
    return { ...info, inline, attrs, mixed, mixedAttrs, mixedText }
  }

  const sendRects = () => {
    const extras = []
    for (const el of group) if (el !== selected) extras.push(rectOf(el))
    post({ type: 'rects', selected: rectOf(selected), hover: rectOf(hovered), group: extras })
    syncDots()
  }

  /** The target of a click: the element, but a whole <svg> counts as one. */
  const targetOf = (node) => {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement
    if (!el) return null
    const svg = el.closest && el.closest('svg')
    if (svg) {
      let top = svg
      while (top.parentElement && top.parentElement.closest('svg')) top = top.parentElement.closest('svg')
      el = top
    }
    if (el === document.documentElement || el === document.body) return document.body
    return el
  }

  /** The loose text node under the pointer (the browser knows how to tell). */
  const textNodeAtPoint = (x, y) => {
    try {
      if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y)
        const node = pos && pos.offsetNode
        return node && node.nodeType === 3 ? node : null
      }
      if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(x, y)
        const node = range && range.startContainer
        return node && node.nodeType === 3 ? node : null
      }
    } catch (_) {}
    return null
  }

  /**
   * The pointer target: the element — or the LOOSE TEXT inside it, which is
   * a layer of its own (no tag and no style: only content). In an element that is only
   * text, the element already is the layer.
   */
  const targetAt = (x, y, node) => {
    const el = targetOf(node)
    if (!el || el === document.body) return el
    if (el.children.length === 0) return el
    const text = textNodeAtPoint(x, y)
    if (text && text.parentElement === el) return text
    return el
  }

  const finishEditing = (commit) => {
    if (!editing) return
    const el = editing.el
    if (editingResize) { editingResize.disconnect(); editingResize = null }
    el.removeAttribute('contenteditable')
    if (!commit) {
      el.innerHTML = editing.html
    } else if (el.innerHTML !== editing.html) {
      post({ type: 'textEdited', path: pathOf(el), html: el.innerHTML })
    }
    editing = null
    // Without clearing the range, the highlight stays stuck on the screen — gray, because the
    // document lost the focus when clicking outside the canvas.
    const selection = window.getSelection()
    if (selection) selection.removeAllRanges()
    sendInfo()
    sendRects()
  }

  /** Puts the focus on the text being edited (the cursor is the one of the native double click). */
  const focusEditing = () => {
    if (!editing) return
    try { window.focus() } catch (_) {}
    editing.el.focus()
  }

  /** Enters the edition of the element's text (double click). Returns whether it started. */
  const startEditing = (el) => {
    if (!el || el === document.body || kindOf(el) !== 'text') return false
    if (editing && editing.el === el) return false
    if (editing) finishEditing(true)
    selected = el
    group = [el]
    editing = { el, html: el.innerHTML }
    el.setAttribute('contenteditable', 'true')
    // The selection box (drawn in the panel) has to FOLLOW the text: on
    // every keystroke (input) and on every size change we send the rectangle
    // again. Without this the border of the panel stood still while the text grew.
    if (typeof ResizeObserver !== 'undefined') {
      editingResize = new ResizeObserver(sendRects)
      editingResize.observe(el)
    }
    focusEditing()
    // Fallback: if the native mousedown did not give the focus to the iframe, the panel
    // focuses it (see 'focus'). We do not touch the selection here — whoever positions the
    // cursor is the native double click, so that typing works on the first try.
    post({ type: 'focus' })
    sendInfo()
    sendRects()
    return true
  }

  document.addEventListener('mousemove', (e) => {
    if (!selectMode || editing || drag) return
    if (e.target && e.target.closest && e.target.closest('[data-orbit-ui]')) return
    const el = targetAt(e.clientX, e.clientY, e.target)
    let next = el === document.body ? null : el
    // With Shift, the hover shows the item of the SAME LEVEL as the selection — the same
    // one the Shift+click would turn into. Passing over a background text does not light up
    // its box: it lights up the card's, which is what would enter the group.
    if (next && e.shiftKey && selected) {
      const level = pathOf(selected)
      if (level) next = snapLevel(next, level.length)
    }
    if (next === hovered) return
    hovered = next
    post({ type: 'hover', path: hovered ? pathOfNode(hovered) : null, rect: rectOf(hovered) })
  }, true)

  document.addEventListener('mouseleave', () => {
    if (!hovered) return
    hovered = null
    post({ type: 'hover', path: null, rect: null })
  })

  // Typing can break the line and change the height: the selection rectangle in the
  // panel follows in real time (the ResizeObserver covers the rest).
  document.addEventListener('input', (e) => {
    if (editing && editing.el.contains(e.target)) sendRects()
  }, true)

  // Double click on the SAME element enters edition. The critical point: on the double click
  // we do NOT cancel the pointerdown — that way the native mousedown happens, and it is what
  // gives the focus to the iframe and places the cursor. Canceling it left the focus in the
  // panel, and only a later click (already in edition) brought it back.
  let lastDown = { el: null, at: 0 }
  let freeClick = false

  const swallow = (e) => {
    if (!selectMode) return
    if (e.target && e.target.closest && e.target.closest('[data-orbit-ui]')) return
    if (editing && editing.el.contains(e.target)) return
    if (e.type === 'pointerdown') {
      suppressClick = false
      pendingDown = null
      const el = targetOf(e.target)
      const node = el === document.body ? null : el
      const now = e.timeStamp || Date.now()
      const double = Boolean(node) && node === lastDown.el && now - lastDown.at < 400
      lastDown = { el: node, at: now }
      freeClick = double && startEditing(node)
      if (freeClick) {
        // The edition is already active, but the gesture can still turn into a drag: who
        // decides is the threshold in the pointermove (dragging undoes the edition).
        pendingDown = { el: node, x: e.clientX, y: e.clientY }
        return
      }
      // It can still turn into a drag: the threshold is measured in the pointermove.
      if (node) pendingDown = { el: node, x: e.clientX, y: e.clientY }
    }
    if (freeClick) return
    e.preventDefault()
    e.stopPropagation()
  }
  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'submit', 'auxclick']) {
    document.addEventListener(type, swallow, true)
  }

  // ------------------------------------------------------------- drag
  // Reordering siblings like in Figma: the original element stays in the flow (faded,
  // as a placeholder), a clone follows the pointer, and when the clone crosses the
  // center of a sibling the DOM is reordered ON THE SPOT and the siblings slide (FLIP
  // with the Web Animations API, 160ms). At the end, the order becomes a message for the
  // panel to rewrite the source. Leaving the parent, the drag becomes a MOVE: the guides
  // (container frame + insertion line) show where it lands, and the target
  // is the container at the same level as the parent.
  const FLIP_MS = 160
  const FLIP_EASE = 'cubic-bezier(0.2, 0, 0, 1)'

  const axisOf = (parent) => {
    const cs = getComputedStyle(parent)
    const row = cs.display.indexOf('flex') >= 0 && cs.flexDirection.indexOf('row') === 0
    return row || cs.display.indexOf('grid') >= 0 ? 'x' : 'y'
  }

  const centerOf = (el, axis) => {
    const r = el.getBoundingClientRect()
    return axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2
  }

  const flip = (elements, mutate) => {
    const before = new Map()
    for (const el of elements) before.set(el, el.getBoundingClientRect())
    mutate()
    for (const el of elements) {
      const from = before.get(el)
      const to = el.getBoundingClientRect()
      const dx = from.left - to.left
      const dy = from.top - to.top
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
      el.animate(
        [{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }],
        { duration: FLIP_MS, easing: FLIP_EASE },
      )
    }
  }

  /** Document order: whoever comes before in the tree. */
  const domOrder = (a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1)

  /** Nodes injected by the bridge (ghost, guides and the dot) are not content. */
  const isInjected = (node) =>
    node.nodeType === 1 && (node.hasAttribute('data-orbit-drag') || node.hasAttribute('data-orbit-guide') || node.hasAttribute('data-orbit-ui'))

  /** "Real" children of a parent: the guides and the drag ghost do not count. */
  const realChildren = (parent) => Array.prototype.filter.call(parent.children, (child) => !isInjected(child))

  /** Applies an order (slot → original index) preserving the text nodes. */
  const applyOrder = (parent, order) => {
    const nodes = Array.prototype.slice.call(parent.childNodes)
    const elements = nodes.filter((node) => node.nodeType === 1 && !isInjected(node))
    if (elements.length !== order.length) return
    const next = order.map((index) => elements[index])
    let k = 0
    for (const node of nodes) parent.appendChild(node.nodeType === 1 && !isInjected(node) ? next[k++] : node)
  }

  const depthOf = (el) => {
    let depth = 0
    for (let node = el; node && node !== document.body; node = node.parentElement) depth += 1
    return depth
  }

  /**
   * Raises the element up to the requested DEPTH — the same level as the selection.
   * It is what the Shift+click uses: the group is always a set of siblings, and
   * never a mix of levels (nor something deep from the tree).
   */
  const snapLevel = (el, level) => {
    let node = el
    while (node && node !== document.body && depthOf(node) > level) {
      const parent = node.parentElement
      if (!parent || parent === document.body) break
      node = parent
    }
    return node
  }

  /** The content box (without border/padding): where frame and line are drawn. */
  const contentBox = (el) => {
    const rect = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const num = (value) => parseFloat(value) || 0
    return {
      left: rect.left + num(cs.borderLeftWidth) + num(cs.paddingLeft),
      top: rect.top + num(cs.borderTopWidth) + num(cs.paddingTop),
      width: Math.max(0, rect.width - num(cs.borderLeftWidth) - num(cs.borderRightWidth) - num(cs.paddingLeft) - num(cs.paddingRight)),
      height: Math.max(0, rect.height - num(cs.borderTopWidth) - num(cs.borderBottomWidth) - num(cs.paddingTop) - num(cs.paddingBottom)),
    }
  }

  const hideGuides = () => {
    if (!drag) return
    drag.guide.style.display = 'none'
    drag.frame.style.display = 'none'
  }

  const showGuides = (target) => {
    if (!drag) return
    const box = contentBox(target.parent)
    const kids = realChildren(target.parent)
    const reference = kids[target.index] || null
    const last = kids[kids.length - 1] || null
    drag.frame.style.display = 'block'
    drag.frame.style.left = box.left + 'px'
    drag.frame.style.top = box.top + 'px'
    drag.frame.style.width = box.width + 'px'
    drag.frame.style.height = box.height + 'px'
    drag.guide.style.display = 'block'
    if (axisOf(target.parent) === 'x') {
      const x = reference ? reference.getBoundingClientRect().left : (last ? last.getBoundingClientRect().right : box.left)
      drag.guide.style.left = (x - 1) + 'px'
      drag.guide.style.top = box.top + 'px'
      drag.guide.style.width = '2px'
      drag.guide.style.height = box.height + 'px'
    } else {
      const y = reference ? reference.getBoundingClientRect().top : (last ? last.getBoundingClientRect().bottom : box.top)
      drag.guide.style.left = box.left + 'px'
      drag.guide.style.top = (y - 1) + 'px'
      drag.guide.style.width = box.width + 'px'
      drag.guide.style.height = '2px'
    }
  }

  /** Returns the siblings to the original order (identity) — cancel, or aim outside the parent. */
  const restoreSiblings = (d) => {
    if (d.order.every((value, i) => value === i)) return false
    applyOrder(d.parent, d.siblings.map((_, i) => i))
    d.order = d.order.map((_, i) => i)
    d.index = d.originIndex
    return true
  }

  /**
   * Where the drag lands when the pointer leaves the parent: the target's container
   * stays at the SAME LEVEL as the parent (the height in the tree), like in Figma — dragging
   * between columns lands on the other column; over a card, at the level of the cards.
   * Over the parent itself (or a sibling) there is no target: it is the live reordering.
   */
  const crossTarget = (x, y) => {
    // Drag by the dot: it does not offer a way out of the parent — only the reordering among
    // the children where the group is.
    if (drag.restricted) return null
    const hit = document.elementFromPoint(x, y)
    if (!hit || (hit.closest && hit.closest('[data-orbit-ui]'))) return null
    if (drag.members.some((el) => el.contains(hit))) return null
    for (let node = hit; node && node !== document.documentElement; node = node.parentElement) {
      if (node === drag.parent || node.parentElement === drag.parent) return null
    }
    let parent = hit
    let depth = depthOf(hit)
    const want = depthOf(drag.parent)
    while (depth > want) { parent = parent.parentElement; depth -= 1 }
    while (parent && parent !== document.body && kindOf(parent) !== 'box') parent = parent.parentElement
    if (!parent || parent === document.documentElement) parent = document.body
    if (parent === drag.parent || drag.members.some((el) => el === parent || el.contains(parent))) return null
    const kids = realChildren(parent)
    const axis = axisOf(parent)
    const point = axis === 'x' ? x : y
    let index = kids.length
    for (let i = 0; i < kids.length; i += 1) {
      const rect = kids[i].getBoundingClientRect()
      const mid = axis === 'x' ? rect.left + rect.width / 2 : rect.top + rect.height / 2
      if (point < mid) { index = i; break }
    }
    return { parent, index }
  }

  /**
   * Starts a drag. "restricted" is the drag by the CIRCLE: it reorders the
   * group among themselves (and only among themselves — the siblings that were not selected
   * stay where they are) and does not offer a way out of the parent. "reorderGroup" is the set
   * being reordered; without it, the normal drag touches all the siblings.
   */
  const startDrag = (members, x, y, restricted, reorderGroup) => {
    if (!members || members.length === 0) return
    members = members.slice().sort(domOrder)
    const parent = members[0].parentElement
    if (!parent || members.some((el) => el.parentElement !== parent)) return
    const siblings = Array.prototype.slice.call(parent.children)
    const memberIndexes = []
    for (const el of members) {
      const index = siblings.indexOf(el)
      if (index < 0) return
      memberIndexes.push(index)
    }
    const others = siblings.filter((el) => members.indexOf(el) < 0)
    const originIndex = memberIndexes[0]
    if (restricted) {
      // The circle does not touch the selection: the group stays as it is, and the
      // reordered one is it (the set of the selected items).
    } else {
      if (group.indexOf(selected) < 0) selected = members[members.length - 1]
      group = members.slice()
    }
    const rects = members.map((el) => el.getBoundingClientRect())
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const r of rects) {
      if (r.left < left) left = r.left
      if (r.top < top) top = r.top
      if (r.right > right) right = r.right
      if (r.bottom > bottom) bottom = r.bottom
    }
    // The ghost is a wrapper at the END of <body> (it shifts no path)
    // with an absolute clone per member, and it receives the COMPUTED typography of each
    // original — without this it did not inherit the font/color that came from the grandparents and
    // fell back to the browser font (serif).
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-orbit-drag', '')
    wrapper.style.cssText =
      'position:fixed !important;left:' + left + 'px;top:' + top + 'px;width:' + (right - left) + 'px;height:' + (bottom - top) +
      'px;min-width:0 !important;min-height:0 !important;max-width:none !important;max-height:none !important;margin:0 !important;padding:0 !important;box-sizing:border-box !important;pointer-events:none !important;opacity:0.75 !important;z-index:2147483647 !important;transition:none !important;filter:drop-shadow(0 10px 24px rgba(0,0,0,0.25)) !important'
    const clones = members.map((el, i) => {
      const r = rects[i]
      const clone = el.cloneNode(true)
      const cs = getComputedStyle(el)
      for (const prop of ['font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-transform', 'text-indent', 'white-space', 'color', 'direction']) {
        clone.style.setProperty(prop, cs.getPropertyValue(prop))
      }
      clone.style.setProperty('position', 'absolute')
      clone.style.setProperty('left', (r.left - left) + 'px')
      clone.style.setProperty('top', (r.top - top) + 'px')
      clone.style.setProperty('width', r.width + 'px')
      clone.style.setProperty('height', r.height + 'px')
      clone.style.setProperty('margin', '0')
      clone.style.setProperty('box-sizing', 'border-box')
      clone.style.setProperty('pointer-events', 'none')
      clone.style.setProperty('transition', 'none')
      wrapper.appendChild(clone)
      return clone
    })
    document.body.appendChild(wrapper)
    const guide = document.createElement('div')
    guide.setAttribute('data-orbit-guide', '')
    guide.style.cssText =
      'position:fixed !important;min-width:0 !important;min-height:0 !important;max-width:none !important;max-height:none !important;margin:0 !important;padding:0 !important;box-sizing:border-box !important;pointer-events:none !important;z-index:2147483646 !important;background:#0d99ff !important;border-radius:1px !important;box-shadow:0 0 0 1px rgba(255,255,255,0.7) !important'
    document.body.appendChild(guide)
    const frame = document.createElement('div')
    frame.setAttribute('data-orbit-guide', '')
    frame.style.cssText =
      'position:fixed !important;min-width:0 !important;min-height:0 !important;max-width:none !important;max-height:none !important;margin:0 !important;padding:0 !important;box-sizing:border-box !important;pointer-events:none !important;z-index:2147483646 !important;outline:2px dashed #0d99ff !important;outline-offset:-2px !important;border-radius:2px !important;background:rgba(13,153,255,0.05) !important'
    document.body.appendChild(frame)
    guide.style.display = 'none'
    frame.style.display = 'none'
    const styles = members.map((el) => ({ el, opacity: el.style.opacity, pointerEvents: el.style.pointerEvents }))
    for (const el of members) {
      el.style.opacity = '0.25'
      el.style.pointerEvents = 'none'
    }
    // In the restricted drag (by the circle), the reordered set is the selected
    // group; its POSITIONS in the parent are the slots they occupy.
    const reorderMembers = restricted ? (reorderGroup || []).slice().sort(domOrder) : members
    const reorderIndexes = []
    for (const el of reorderMembers) {
      const index = siblings.indexOf(el)
      if (index < 0) return
      reorderIndexes.push(index)
    }
    drag = {
      members,
      parent,
      siblings,
      memberIndexes,
      others,
      originIndex,
      order: siblings.map((_, i) => i),
      axis: axisOf(parent),
      index: originIndex,
      clone: wrapper,
      clones,
      guide,
      frame,
      target: null,
      startX: x,
      startY: y,
      moved: false,
      styles,
      // Drag by the circle: it only reorders the group among themselves.
      restricted: Boolean(restricted),
      reorderMembers,
      reorderIndexes,
      // The current order of the selected items (indices inside reorderMembers).
      relative: reorderMembers.map((_, i) => i),
      picked: restricted ? members[0] : null,
    }
    document.documentElement.classList.add('__orbit-drag')
    hovered = null
    post({ type: 'hover', path: null, rect: null })
    post({ type: 'select', path: pathOf(selected), info: infoFor(selected), shift: false, group: groupPaths() })
    sendRects()
  }

  const moveDrag = (e) => {
    if (!drag) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    drag.clone.style.setProperty('transform', 'translate(' + dx + 'px,' + dy + 'px)', 'important')
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    drag.moved = true
    if (drag.restricted) {
      // Drag by the circle: the dragged item changes place AMONG THE
      // SELECTED ONES. The siblings that were not selected stay where
      // they are — only the slots of the selected items are swapped.
      const rect = drag.clone.getBoundingClientRect()
      const center = drag.axis === 'x' ? rect.left + rect.width / 2 : rect.top + rect.height / 2
      const picked = drag.reorderMembers.indexOf(drag.picked)
      const others = drag.relative.filter((i) => i !== picked)
      let index = others.length
      for (let i = 0; i < others.length; i += 1) {
        if (center < centerOf(drag.reorderMembers[others[i]], drag.axis)) { index = i; break }
      }
      const relative = others.slice(0, index).concat([picked], others.slice(index))
      const order = drag.siblings.map((_, i) => i)
      for (let j = 0; j < relative.length; j += 1) order[drag.reorderIndexes[j]] = drag.reorderIndexes[relative[j]]
      if (order.every((value, i) => value === drag.order[i])) return
      flip(drag.reorderMembers, () => applyOrder(drag.parent, order))
      drag.order = order
      drag.relative = relative
      sendRects()
      return
    }
    const target = crossTarget(e.clientX, e.clientY)
    if (target) {
      // Outside the parent: undoes the live order (the source is still the reference of the
      // paths on drop) and shows the guides of where the block lands.
      if (restoreSiblings(drag)) sendRects()
      drag.target = target
      showGuides(target)
      return
    }
    drag.target = null
    hideGuides()
    const rect = drag.clone.getBoundingClientRect()
    const center = drag.axis === 'x' ? rect.left + rect.width / 2 : rect.top + rect.height / 2
    let index = drag.others.length
    for (let i = 0; i < drag.others.length; i += 1) {
      if (center < centerOf(drag.others[i], drag.axis)) { index = i; break }
    }
    if (index === drag.index) return
    // The members become a contiguous block at the position "index" among the other
    // siblings: the new order is the "others" up to there, the block, and the rest.
    const otherOrder = drag.siblings.map((_, i) => i).filter((i) => drag.memberIndexes.indexOf(i) < 0)
    const nextOrder = otherOrder.slice(0, index).concat(drag.memberIndexes, otherOrder.slice(index))
    flip(drag.others.concat(drag.members), () => applyOrder(drag.parent, nextOrder))
    drag.order = nextOrder
    drag.index = index
    sendRects()
  }

  const endDrag = (commit) => {
    if (!drag) return
    const d = drag
    drag = null
    document.documentElement.classList.remove('__orbit-drag')
    const ghostRects = d.clones.map((clone) => clone.getBoundingClientRect())
    for (const entry of d.styles) {
      entry.el.style.opacity = entry.opacity
      entry.el.style.pointerEvents = entry.pointerEvents
    }
    if (d.clone.parentNode) d.clone.parentNode.removeChild(d.clone)
    if (d.guide.parentNode) d.guide.parentNode.removeChild(d.guide)
    if (d.frame.parentNode) d.frame.parentNode.removeChild(d.frame)
    if (!d.moved) {
      sendRects()
      return
    }
    suppressClick = true
    const target = commit && d.target && d.target.parent !== d.parent && !d.members.some((el) => el === d.target.parent || el.contains(d.target.parent)) ? d.target : null
    if (!commit) {
      // Undoes it in the DOM as the source does: the elements go back to the original order,
      // each one in the "slot" where the neighboring text node was (the drag never
      // touches the text nodes).
      restoreSiblings(d)
    } else if (target) {
      // Dropping on another parent: the live order goes back to the original so that the PATHS
      // match the source, the members move on the screen and the panel
      // rewrites it. The block enters the DOM order, each one before the SAME
      // reference.
      restoreSiblings(d)
      const parentPath = pathOf(target.parent)
      const fromPaths = d.members.map((el) => pathOf(el))
      if (parentPath && fromPaths.every((path) => path)) {
        const kids = realChildren(target.parent)
        const reference = kids[target.index] || null
        for (const el of d.members) target.parent.insertBefore(el, reference)
        // "Landing": each member starts from the position of its clone in the ghost and
        // slots into the destination.
        for (let i = 0; i < d.members.length; i += 1) {
          const el = d.members[i]
          const to = el.getBoundingClientRect()
          el.animate(
            [{ transform: 'translate(' + (ghostRects[i].left - to.left) + 'px,' + (ghostRects[i].top - to.top) + 'px)' }, { transform: 'none' }],
            { duration: FLIP_MS, easing: FLIP_EASE },
          )
        }
        post({ type: 'move', paths: fromPaths, parent: parentPath, index: target.index })
      }
    } else if (d.order.some((value, i) => value !== i)) {
      const parentPath = pathOf(d.parent)
      if (parentPath) post({ type: 'reorder', parent: parentPath, order: d.order })
    }
    post({ type: 'select', path: pathOfNode(selected), info: infoFor(selected), shift: false, group: groupPaths() })
    sendRects()
  }

  window.addEventListener('pointermove', (e) => {
    if (drag) { moveDrag(e); return }
    if (!pendingDown) return
    if (Math.abs(e.clientX - pendingDown.x) + Math.abs(e.clientY - pendingDown.y) < 4) return
    const p = pendingDown
    pendingDown = null
    // The double click on the text already entered edition on the pointerdown; if the gesture
    // turned into a drag, the edition is dropped (the "real" double click does not move).
    // On another element, the text being edited is confirmed before dragging.
    if (editing) finishEditing(editing.el !== p.el)
    // With more than one selected, dragging ANY PART of a member takes the
    // whole group along (and that is how the group can leave the parent). Clicking
    // (without dragging) keeps selecting the element under the pointer.
    const member = group.length > 1 ? group.find((el) => el === p.el || el.contains(p.el)) : null
    const members = member ? group.slice() : [p.el]
    selected = member ?? p.el
    group = members.slice()
    startDrag(members, p.x, p.y, false)
    if (drag) moveDrag(e)
  }, true)

  window.addEventListener('pointerup', () => {
    pendingDown = null
    if (drag) endDrag(true)
  }, true)

  window.addEventListener('pointercancel', () => {
    pendingDown = null
    if (drag) endDrag(false)
  }, true)

  const LINK_SKIP = /^(#|https?:|mailto:|tel:|javascript:|data:|blob:)/i
  document.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-orbit-ui]')) return
    // The click that closes a drag never reaches the user. The signal only falls on the
    // next pointerdown — that way the dblclick that follows it (the browser can
    // fire it even after a short drag) is also ignored.
    if (suppressClick) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (playMode && !selectMode) {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null
      if (!a) return
      const href = a.getAttribute('href') || ''
      if (!href || LINK_SKIP.test(href)) return
      // The artboard is a screen of a prototype: the relative link becomes "go to
      // that screen" — whoever decides which one it is (and whether it exists) is the panel.
      e.preventDefault()
      e.stopPropagation()
      post({ type: 'navigate', href })
      return
    }
    if (!selectMode) return
    if (editing && editing.el.contains(e.target)) return
    e.preventDefault()
    e.stopPropagation()
    if (editing) finishEditing(true)
    const el = targetAt(e.clientX, e.clientY, e.target)
    let node = el === document.body ? null : el
    if (node && e.shiftKey && selected) {
      // Shift works at the SAME LEVEL as the selection: the target goes up to the
      // depth of the selected item, so that the group does not become a mix of
      // levels (and does not suggest deep things from the tree).
      const level = pathOfNode(selected)
      if (level) node = snapLevel(node, level.length)
    }
    if (!node) {
      selected = null
      group = []
    } else if (node.nodeType === 3) {
      // Loose text: it enters the selection by itself — text does not form a group.
      selected = node
      group = []
    } else if (e.shiftKey && selected && selected !== node && selected.parentElement === node.parentElement) {
      // Shift toggles siblings in the group (like in Figma): clicking a member takes it
      // out, clicking a sibling puts it in — the last one clicked becomes the selected item.
      if (group.indexOf(node) >= 0) {
        group = group.filter((member) => member !== node)
        selected = group.length ? group[group.length - 1] : null
      } else {
        group = group.concat([node]).sort(domOrder)
        selected = node
      }
    } else {
      selected = node
      group = [node]
    }
    post({ type: 'select', path: selected ? pathOfNode(selected) : null, info: infoFor(selected), shift: e.shiftKey, group: groupPaths() })
    sendRects()
  }, true)

  // Right click: selects what is under the pointer (unless it already is part of the
  // selection, so the menu acts on the whole group) and asks the panel to open its menu.
  document.addEventListener('contextmenu', (e) => {
    if (!selectMode) return
    if (e.target && e.target.closest && e.target.closest('[data-orbit-ui]')) return
    e.preventDefault()
    e.stopPropagation()
    if (editing) finishEditing(true)
    const el = targetAt(e.clientX, e.clientY, e.target)
    const node = el === document.body ? null : el
    const inside = node && selected && (group.some((member) => member === node || member.contains(node)) || selected === node || selected.contains(node))
    if (!inside) {
      selected = node
      group = node && node.nodeType === 1 ? [node] : []
      post({ type: 'select', path: selected ? pathOfNode(selected) : null, info: infoFor(selected), shift: false, group: groupPaths() })
      sendRects()
    }
    post({ type: 'context', x: e.clientX, y: e.clientY })
  }, true)

  document.addEventListener('dblclick', (e) => {
    if (!selectMode) return
    if (e.target && e.target.closest && e.target.closest('[data-orbit-ui]')) return
    // A dblclick after a drag (short, still in the same neighborhood) cannot
    // become an edition.
    if (suppressClick) return
    // Without preventDefault: the native word selection of the double click is the
    // cursor the user expects. The edition has usually already started on the
    // pointerdown; here it is only the fallback.
    startEditing(targetOf(e.target))
  }, true)

  document.addEventListener('keydown', (e) => {
    if (drag) {
      if (e.key === 'Escape') { e.preventDefault(); endDrag(false) }
      return
    }
    if (editing) {
      if (e.key === 'Escape') { e.preventDefault(); finishEditing(false) }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEditing(true) }
      return
    }
    const t = e.target
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) && !selectMode) return
    if (selectMode) e.preventDefault()
    post({ type: 'key', phase: 'down', key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey })
  }, true)

  document.addEventListener('keyup', (e) => {
    if (editing) return
    post({ type: 'key', phase: 'up', key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey })
  }, true)

  document.addEventListener('focusout', (e) => {
    if (editing && e.target === editing.el) finishEditing(true)
  }, true)

  // Clicking outside the canvas takes the focus from the iframe WITHOUT firing focusout on
  // the element; without this the edition (and the gray highlight) stayed stuck.
  window.addEventListener('blur', () => finishEditing(true))

  // The artboard is a frame of the canvas: the wheel navigates the CANVAS (like in Figma),
  // it does not scroll the document inside.
  window.addEventListener('wheel', (e) => {
    if (!selectMode) return
    e.preventDefault()
    post({ type: 'wheel', dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, x: e.clientX, y: e.clientY })
  }, { passive: false, capture: true })

  window.addEventListener('scroll', sendRects, true)
  window.addEventListener('resize', sendRects)

  window.addEventListener('message', (e) => {
    if (e.source !== parent) return
    const msg = e.data
    if (!msg || msg.source !== SOURCE) return
    if (msg.type === 'mode') {
      selectMode = Boolean(msg.select)
      playMode = Boolean(msg.play)
      document.documentElement.classList.toggle('__orbit-select', selectMode)
      if (!selectMode) {
        if (drag) endDrag(false)
        finishEditing(true)
        hovered = null
        group = []
      }
      syncDots()
      return
    }
    if (msg.type === 'tree') {
      if (msg.want === false) { treeWanted = false; return }
      treeWanted = true
      sendTree()
      return
    }
    if (msg.type === 'blur') { finishEditing(true); return }
    if (msg.type === 'select') {
      selected = byPath(msg.path)
      if (selected === document.body) selected = null
      // The panel sends the whole group (the multiple selection of the Layers
      // list); only the SIBLINGS of the selected item enter — the rest is ignored.
      const members = []
      const list = Array.isArray(msg.group) ? msg.group : []
      for (const path of list) {
        const el = byPath(path)
        if (!el || el === selected || el.nodeType !== 1) continue
        if (!selected || el.parentElement !== selected.parentElement) continue
        members.push(el)
      }
      members.sort(domOrder)
      group = selected && selected.nodeType === 1 ? [selected].concat(members) : []
      sendInfo()
      sendRects()
      return
    }
    // The eye of the Layers list: marks (or unmarks) the element as hidden in the live
    // DOM. Only a view state — the panel never writes it to the source.
    if (msg.type === 'hide') {
      const el = byPath(msg.path)
      if (!el || el.nodeType !== 1 || el === document.body) return
      const next = typeof msg.hidden === 'boolean' ? msg.hidden : !el.hasAttribute('data-orbit-hidden')
      if (next) el.setAttribute('data-orbit-hidden', '')
      else el.removeAttribute('data-orbit-hidden')
      if (next && selected && (selected === el || el.contains(selected))) {
        selected = null
        group = []
        post({ type: 'select', path: null, info: null, shift: false, group: [] })
      }
      sendTree()
      sendRects()
      return
    }
    if (msg.type === 'hover') {
      hovered = msg.path ? byPath(msg.path) : null
      sendRects()
      return
    }
    // The Layers list sent a structural change: it is applied to the live
    // DOM (the panel writes the source right after) so that the canvas does not
    // lag behind until the next reload.
    if (msg.type === 'move') {
      const moving = byPath(msg.path)
      const parent = byPath(msg.parent)
      if (!moving || !parent || moving === parent || moving.contains(parent)) return
      if (moving.parentElement === parent) return
      const kids = parent.children
      const index = Number.isInteger(msg.index) ? Math.max(0, Math.min(kids.length, msg.index)) : kids.length
      parent.insertBefore(moving, kids[index] ?? null)
      selected = moving
      group = [moving]
      post({ type: 'select', path: pathOf(moving), info: infoOf(moving), shift: false, group: groupPaths() })
      sendTree()
      sendRects()
      return
    }
    if (msg.type === 'reorder') {
      const parent = byPath(msg.parent)
      if (!parent || !Array.isArray(msg.order)) return
      applyOrder(parent, msg.order)
      post({ type: 'select', path: pathOf(selected), info: infoFor(selected), shift: false, group: groupPaths() })
      sendTree()
      sendRects()
      return
    }
    if (msg.type === 'remove') {
      const list = Array.isArray(msg.paths) ? msg.paths : []
      const els = []
      for (const path of list) {
        const el = byPath(path)
        if (el) els.push(el)
      }
      if (els.length === 0) return
      // From the last to the first: that way the path of the ones still left does not
      // change in the middle of the removal.
      for (const el of els.reverse()) el.remove()
      selected = null
      group = []
      post({ type: 'select', path: null, info: null, shift: false, group: [] })
      sendTree()
      sendRects()
      return
    }
    // "Wrap": the selected elements become children of a new div, which
    // enters in the place of the first of them. The panel wrote the SAME plan to the
    // source — here it is only the same change, live.
    if (msg.type === 'wrap') {
      const parent = byPath(msg.parent)
      const list = Array.isArray(msg.children) ? msg.children : []
      if (!parent || list.length < 2) return
      const kids = []
      for (const path of list) {
        const el = byPath(path)
        if (el && el.nodeType === 1 && el.parentElement === parent) kids.push(el)
      }
      if (kids.length < 2) return
      const wrapper = document.createElement('div')
      wrapper.setAttribute('style', typeof msg.style === 'string' ? msg.style : '')
      parent.insertBefore(wrapper, parent.children[msg.index] ?? null)
      for (const el of kids) wrapper.appendChild(el)
      selected = wrapper
      group = [wrapper]
      post({ type: 'select', path: pathOf(wrapper), info: infoFor(wrapper), shift: false, group: groupPaths() })
      sendTree()
      sendRects()
      return
    }
    const el = byPath(msg.path)
    if (!el) return
    // Loose text has no style and no attribute: the parent has them (that is where
    // the text inherits from).
    const styleTarget = el.nodeType === 3 ? el.parentElement : el
    if (msg.type === 'style') {
      if (!styleTarget) return
      if (msg.value) styleTarget.style.setProperty(msg.prop, msg.value)
      else styleTarget.style.removeProperty(msg.prop)
      if (!styleTarget.getAttribute('style')) styleTarget.removeAttribute('style')
    } else if (msg.type === 'attr') {
      if (!styleTarget) return
      if (msg.value) styleTarget.setAttribute(msg.name, msg.value)
      else styleTarget.removeAttribute(msg.name)
    } else if (msg.type === 'text') {
      if (el.nodeType === 3) el.data = msg.value
      else el.textContent = msg.value
    }
    // The message may come from ANOTHER member of the group: changing style does not change the
    // selection (the panel keeps showing the primary one).
    if (!selected || selected === el) selected = el
    sendInfo()
    sendRects()
    sendTree()
  })

  const links = () => {
    const seen = new Set()
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || ''
      if (href && !LINK_SKIP.test(href)) seen.add(href)
      if (seen.size >= 50) break
    }
    return Array.from(seen)
  }

  const ready = () => {
    const doc = document.documentElement
    // The tree does NOT come along: building it is expensive (up to 1500 nodes, see MAX_NODES) and
    // only the Layers use it — the panel asks for the 'tree' message when it is in
    // view, and only then it is built (see design-tab.tsx).
    post({ type: 'ready', width: doc.scrollWidth, height: doc.scrollHeight, links: links() })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready)
  else ready()
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(sendRects)
})()`

/**
 * Runtime version, derived from the source itself: it only changes when the source changes. It goes in the
 * URL so the iframe can reuse the script (and the already compiled code) between
 * remounts — the `immutable` of Cache-Control in design-store.ts is only safe
 * because the version changes along with the content.
 */
const DESIGN_RUNTIME_VERSION = (() => {
  let hash = 0
  for (let i = 0; i < DESIGN_RUNTIME.length; i += 1) hash = (Math.imul(hash, 31) + DESIGN_RUNTIME.charCodeAt(i)) | 0
  return (hash >>> 0).toString(36)
})()

/**
 * Puts the bridge as the first script of the <head> (idempotent) and, right after it, the
 * `@font-face` of the Orbit font library.
 *
 * The installed font applies to EVERY artboard without the agent pasting CSS: the
 * `font-family` by name resolves, like a system font. The block comes before
 * the artboard's own CSS (which can still override it), and the `@font-face` is only
 * downloaded when the family is used — declaring the library's 20 fonts does not
 * cost any network.
 */
export function injectDesignRuntime(html: string, fontCss = ''): string {
  if (html.includes(RUNTIME_MARK)) return html
  const fontTag = fontCss.trim() ? `<style data-orbit-fonts>${fontCss}</style>` : ''
  const tag = `<script ${RUNTIME_MARK} src="${DESIGN_RUNTIME_PATH}?v=${DESIGN_RUNTIME_VERSION}"></script>${fontTag}`
  const head = /<head[^>]*>/i.exec(html)
  if (head) return `${html.slice(0, head.index + head[0].length)}${tag}${html.slice(head.index + head[0].length)}`
  const htmlTag = /<html[^>]*>/i.exec(html)
  if (htmlTag) return `${html.slice(0, htmlTag.index + htmlTag[0].length)}<head>${tag}</head>${html.slice(htmlTag.index + htmlTag[0].length)}`
  return tag + html
}
