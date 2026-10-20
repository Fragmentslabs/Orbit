/**
 * A ponte que roda DENTRO de cada artboard (servida pelo scheme orbit-design://
 * e injetada como primeiro script do <head>) — é o que torna o canvas
 * selecionável e editável sem um modelo paralelo ao HTML.
 *
 * O artboard roda num iframe sandbox SEM allow-same-origin: o painel não
 * alcança o DOM dele. Então quem lê e mexe no DOM é esta ponte, e os dois
 * conversam por postMessage com `source: "orbit-design"`:
 *
 *   artboard → painel: ready (com os links para outras telas), tree, hover,
 *                      select, info, rects, wheel, key, textEdited, navigate
 *                      (link clicado no modo apresentação)
 *   painel → artboard: mode, select, hover, style, attr, text, tree
 *
 * O ENDEREÇO de um elemento é o caminho de índices de filhos-elemento a partir
 * do <body> (`[1, 0, 2]`) — o mesmo que o painel usa para achar o elemento no
 * FONTE (DOMParser) e gravar a edição no arquivo. É por isso que a ponte vive no
 * <head> e nunca põe nada no <body>: o contorno da seleção é desenhado pelo
 * painel, por cima do iframe, e não aqui dentro.
 */

/** Caminho reservado em que o scheme serve a ponte. */
export const DESIGN_RUNTIME_PATH = '/__orbit_design_runtime.js'

const RUNTIME_MARK = 'data-orbit-design-runtime'

/** As propriedades que o painel de propriedades lê e edita (kebab-case). */
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

  // No modo edição o artboard é uma superfície de seleção, não um documento
  // para ler: nada de cursor de texto nem de seleção nativa por arraste. A
  // exceção é o texto em edição (contenteditable), onde o cursor de texto é o
  // esperado. Assim o primeiro clique seleciona e arrasta em vez de "prometer"
  // edição de texto.
  const surface = document.createElement('style')
  surface.textContent =
    'html.__orbit-select, html.__orbit-select * { cursor: default !important; user-select: none !important; -webkit-user-select: none !important }' +
    'html.__orbit-select [contenteditable="true"], html.__orbit-select [contenteditable="true"] * { cursor: text !important; user-select: text !important; -webkit-user-select: text !important }' +
    'html.__orbit-select [contenteditable="true"] { outline: none !important }' +
    'html.__orbit-select [data-orbit-ui] { cursor: grab !important }' +
    'html.__orbit-drag, html.__orbit-drag * { cursor: grabbing !important }'
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

  const post = (message) => {
    try { parent.postMessage(Object.assign({ source: SOURCE }, message), '*') } catch (_) {}
  }

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
        // Nó de TEXTO: só no último lugar do caminho.
        if (i !== path.length - 1 || !node) return null
        const child = node.childNodes[-index - 1]
        return child && child.nodeType === 3 ? child : null
      }
      node = node && node.children[index]
      if (!node) return null
    }
    return node
  }

  /** O caminho de um nó de TEXTO solto: o do pai + o índice do nó, negativo. */
  const pathOfText = (node) => {
    const parent = node.parentElement
    if (!parent) return null
    const base = pathOf(parent)
    if (!base) return null
    const index = Array.prototype.indexOf.call(parent.childNodes, node)
    if (index < 0) return null
    return base.concat(-(index + 1))
  }

  /** O caminho de qualquer alvo: elemento ou nó de texto. */
  const pathOfNode = (node) => (node && node.nodeType === 3 ? pathOfText(node) : pathOf(node))

  const rectOf = (el) => {
    if (!el) return null
    if (el.nodeType === 3) {
      // Texto solto: o retângulo é o do TRECHO (a Range do conteúdo).
      const range = document.createRange()
      range.selectNodeContents(el)
      const r = range.getBoundingClientRect()
      if (!r || (!r.width && !r.height)) return null
      return { x: r.left, y: r.top, w: r.width, h: r.height }
    }
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  }

  // Os "dots" da seleção múltipla (como no Figma): UM CÍRCULO por item
  // selecionado, no MEIO dele. Cada círculo é o punho daquele item: arrastar
  // por ele reordena o grupo entre si (os itens que NÃO foram selecionados
  // ficam onde estão). Quem arrasta o item em si é que pode levá-lo para fora
  // do pai.
  //
  // Vivem em <html>, e não no <body>, para não virarem mais filhos na
  // árvore/paths.
  //
  // O estilo é TODO com !important: o CSS do artboard (que o agente escreve)
  // pode ter regra genérica de div/button e deformar o círculo — largura,
  // padding, transform. Aqui o círculo é redondo sempre.
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
      // Arraste restrito: só a ordem entre os selecionados.
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

  /** Os paths de todos os membros (vazio quando não há seleção). */
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
      children: [],
    }
    if (kind === 'svg') return node
    // Filhos na ORDEM do DOM, misturando elementos e TEXTO SOLTO (o texto que
    // não está dentro de nenhum elemento). Sem isso o texto some da lista de
    // Camadas e não dá para pegar — e é texto de verdade na tela.
    // Num elemento que SÓ tem texto, o elemento já é a camada: o texto de
    // dentro dele não vira uma segunda camada.
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
      // Texto solto: não tem tag nem estilo próprio — o estilo vem do pai
      // (é herdado), e é lá que a edição age.
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
   * A info do selecionado, com o que DIFERE no grupo marcado como "Mixed" —
   * é o que o painel mostra quando há mais de um elemento selecionado.
   *
   * A comparação é do valor EFETIVO (o computado): dois elementos que
   * ficaram iguais de verdade não são "mistos", mesmo que um deles tenha a
   * propriedade no style e o outro herde.
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
    // Os valores dos outros, lidos uma vez só.
    const othersValues = others.map(values)
    const mixed = []
    // Com mais de um selecionado, o valor em comum passa a ser o VALOR do
    // campo (e não um placeholder apagado): é o que os selecionados têm em
    // comum, e o que o usuário vê. O que difere fica sem valor e mostra "Misto".
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
    // O texto também é propriedade: se um tem um texto e o outro outro, é
    // "misto" (e o que o usuário digitar vale para todos).
    const mixedText = info.text !== null && others.some((other) => (other.textContent || '') !== (el.textContent || ''))
    return { ...info, inline, attrs, mixed, mixedAttrs, mixedText }
  }

  const sendRects = () => {
    const extras = []
    for (const el of group) if (el !== selected) extras.push(rectOf(el))
    post({ type: 'rects', selected: rectOf(selected), hover: rectOf(hovered), group: extras })
    syncDots()
  }

  /** O alvo de um clique: o elemento, mas um <svg> inteiro vale como um. */
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

  /** O nó de texto solto sob o ponteiro (o navegador sabe dizer). */
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
   * O alvo do ponteiro: o elemento — ou o TEXTO SOLTO dentro dele, que é uma
   * camada própria (sem tag e sem estilo: só conteúdo). Num elemento que é só
   * texto, o elemento já é a camada.
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
    // Sem limpar o range, o realce fica preso na tela — cinza, porque o
    // documento perdeu o foco ao clicar fora do canvas.
    const selection = window.getSelection()
    if (selection) selection.removeAllRanges()
    sendInfo()
    sendRects()
  }

  /** Põe o foco no texto em edição (o cursor é o do duplo clique nativo). */
  const focusEditing = () => {
    if (!editing) return
    try { window.focus() } catch (_) {}
    editing.el.focus()
  }

  /** Entra em edição do texto do elemento (duplo clique). Devolve se começou. */
  const startEditing = (el) => {
    if (!el || el === document.body || kindOf(el) !== 'text') return false
    if (editing && editing.el === el) return false
    if (editing) finishEditing(true)
    selected = el
    group = [el]
    editing = { el, html: el.innerHTML }
    el.setAttribute('contenteditable', 'true')
    // A caixa da seleção (desenhada no painel) tem que ACOMPANHAR o texto: a
    // cada tecla (input) e a cada mudança de tamanho mandamos o retângulo de
    // novo. Sem isto a borda do painel ficava parada enquanto o texto crescia.
    if (typeof ResizeObserver !== 'undefined') {
      editingResize = new ResizeObserver(sendRects)
      editingResize.observe(el)
    }
    focusEditing()
    // Fallback: se o mousedown nativo não tiver dado foco ao iframe, o painel
    // o foca (ver 'focus'). Não mexemos na seleção aqui — quem posiciona o
    // cursor é o duplo clique nativo, para digitar de primeira.
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
    // Com Shift, o hover mostra o item do MESMO NÍVEL da seleção — o mesmo
    // que o Shift+clique viraria. Passar por um texto fundo não acende a
    // caixa dele: acende a do cartão, que é o que entraria no grupo.
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

  // Digitar pode quebrar linha e mudar a altura: o retângulo da seleção no
  // painel acompanha em tempo real (o ResizeObserver cobre o resto).
  document.addEventListener('input', (e) => {
    if (editing && editing.el.contains(e.target)) sendRects()
  }, true)

  // Clique duplo no MESMO elemento entra em edição. O ponto crítico: no duplo
  // NÃO cancelamos o pointerdown — assim o mousedown nativo acontece, e é ele
  // que dá foco ao iframe e coloca o cursor. Cancelá-lo deixava o foco no
  // painel, e só um clique posterior (já em edição) o trazia.
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
        // A edição já está ativa, mas o gesto ainda pode virar arraste: quem
        // decide é o limiar no pointermove (arrastar desfaz a edição).
        pendingDown = { el: node, x: e.clientX, y: e.clientY }
        return
      }
      // Ainda pode virar um arraste: o limiar é medido no pointermove.
      if (node) pendingDown = { el: node, x: e.clientX, y: e.clientY }
    }
    if (freeClick) return
    e.preventDefault()
    e.stopPropagation()
  }
  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'submit', 'auxclick']) {
    document.addEventListener(type, swallow, true)
  }

  // ------------------------------------------------------------- arrastar
  // Reordenar irmãos como no Figma: o elemento original fica no fluxo (apagado,
  // como placeholder), um clone segue o ponteiro, e quando o clone cruza o
  // centro de um irmão o DOM é reordenado NA HORA e os irmãos deslizam (FLIP
  // com a Web Animations API, 160ms). No fim, a ordem vira uma mensagem para o
  // painel reescrever o fonte. Saindo do pai, o arraste vira um MOVE: as guias
  // (moldura do contêiner + linha de inserção) mostram onde ele cai, e o alvo
  // é o contêiner no mesmo nível do pai.
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

  /** Ordem de documento: quem vem antes na árvore. */
  const domOrder = (a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1)

  /** Nós injetados pela ponte (fantasma, guias e o dot) não são conteúdo. */
  const isInjected = (node) =>
    node.nodeType === 1 && (node.hasAttribute('data-orbit-drag') || node.hasAttribute('data-orbit-guide') || node.hasAttribute('data-orbit-ui'))

  /** Filhos "de verdade" de um pai: as guias e o fantasma do arraste não contam. */
  const realChildren = (parent) => Array.prototype.filter.call(parent.children, (child) => !isInjected(child))

  /** Aplica uma ordem (slot → índice original) preservando os nós de texto. */
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
   * Sobe o elemento até a PROFUNDIDADE pedida — o mesmo nível da seleção.
   * É o que o Shift+clique usa: o grupo é sempre um conjunto de irmãos, e
   * nunca uma mistura de níveis (nem uma coisa funda da árvore).
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

  /** A caixa de conteúdo (sem borda/padding): onde moldura e linha são desenhadas. */
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

  /** Volta os irmãos à ordem original (identidade) — cancelar, ou mirar fora do pai. */
  const restoreSiblings = (d) => {
    if (d.order.every((value, i) => value === i)) return false
    applyOrder(d.parent, d.siblings.map((_, i) => i))
    d.order = d.order.map((_, i) => i)
    d.index = d.originIndex
    return true
  }

  /**
   * Para onde o arraste cai quando o ponteiro sai do pai: o contêiner do alvo
   * fica no MESMO NÍVEL do pai (a altura na árvore), como no Figma — arrastar
   * entre colunas cai na outra coluna; sobre um cartão, no nível dos cartões.
   * Sobre o próprio pai (ou um irmão) não há alvo: é o reordenar ao vivo.
   */
  const crossTarget = (x, y) => {
    // Arraste pelo dot: ele não oferece saída do pai — só a reordenação entre
    // os filhos de onde o grupo está.
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
   * Começa um arraste. "restricted" é o arraste pelo CÍRCULO: ele reordena o
   * grupo entre si (e só entre si — os irmãos que não foram selecionados
   * ficam onde estão) e não oferece saída do pai. "reorderGroup" é o conjunto
   * reordenado; sem ele, o arraste normal mexe em todos os irmãos.
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
      // O círculo não mexe na seleção: o grupo continua como está, e o
      // reordenado é ele (o conjunto dos selecionados).
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
    // O fantasma é um wrapper no FIM do <body> (não desloca nenhum caminho)
    // com um clone absoluto por membro, e recebe a tipografia COMPUTADA de cada
    // original — sem isto ele não herdava a fonte/cor que vinham dos avós e
    // caía na fonte do navegador (serifa).
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
    // No arraste restrito (pelo círculo), o conjunto reordenado é o grupo
    // selecionado; suas POSIÇÕES no pai são as vagas que elas ocupam.
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
      // Arraste pelo círculo: só reordena o grupo entre si.
      restricted: Boolean(restricted),
      reorderMembers,
      reorderIndexes,
      // A ordem atual dos selecionados (índices dentro de reorderMembers).
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
      // Arraste pelo círculo: o item arrastado muda de lugar ENTRE OS
      // SELECIONADOS. Os irmãos que não foram selecionados ficam onde
      // estão — só as vagas dos selecionados é que se trocam.
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
      // Fora do pai: desfaz a ordem ao vivo (o fonte ainda é a referência dos
      // caminhos no drop) e mostra as guias de onde o bloco cai.
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
    // Os membros viram um bloco contíguo na posição "index" entre os demais
    // irmãos: a ordem nova é os "outros" até ali, o bloco, e o resto.
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
      // Desfaz no DOM como o fonte faz: os elementos voltam à ordem original,
      // cada um no "slot" onde o nó de texto vizinho estava (o arraste nunca
      // mexe nos nós de texto).
      restoreSiblings(d)
    } else if (target) {
      // Soltar em outro pai: a ordem ao vivo volta ao original para os CAMINHOS
      // baterem com o fonte, os membros mudam de lugar na tela e o painel
      // reescreve. O bloco entra na ordem do DOM, cada um antes da MESMA
      // referência.
      restoreSiblings(d)
      const parentPath = pathOf(target.parent)
      const fromPaths = d.members.map((el) => pathOf(el))
      if (parentPath && fromPaths.every((path) => path)) {
        const kids = realChildren(target.parent)
        const reference = kids[target.index] || null
        for (const el of d.members) target.parent.insertBefore(el, reference)
        // "Pouso": cada membro parte da posição do seu clone no fantasma e
        // encaixa no destino.
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
    // Duplo clique no texto já entrou em edição no pointerdown; se o gesto
    // virou arraste, a edição cai (o duplo clique "de verdade" não se move).
    // Em outro elemento, o texto em edição é confirmado antes de arrastar.
    if (editing) finishEditing(editing.el !== p.el)
    // Com mais de um selecionado, arrastar QUALQUER PARTE de um membro leva o
    // grupo inteiro junto (e é por ali que o grupo pode sair do pai). Clicar
    // (sem arrastar) continua Selecting o elemento sob o ponteiro.
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
    // O clique que fecha um arraste nunca chega ao usuário. O sinal só cai no
    // próximo pointerdown — assim o dblclick que o sucede (o navegador pode
    // dispará-lo mesmo depois de um arraste curto) também é ignorado.
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
      // O artboard é uma tela de um protótipo: o link relativo vira "ir para
      // essa tela" — quem decide qual é (e se existe) é o painel.
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
      // O Shift trabalha no MESMO NÍVEL da seleção: o alvo sobe até a
      // profundidade do selecionado, para o grupo não virar uma mistura de
      // níveis (e para não sugerir coisas fundas da árvore).
      const level = pathOfNode(selected)
      if (level) node = snapLevel(node, level.length)
    }
    if (!node) {
      selected = null
      group = []
    } else if (node.nodeType === 3) {
      // Texto solto: entra na seleção sozinho — texto não forma grupo.
      selected = node
      group = []
    } else if (e.shiftKey && selected && selected !== node && selected.parentElement === node.parentElement) {
      // Shift alterna irmãos no grupo (como no Figma): clicar num membro o
      // tira, clicar num irmão o põe — o último clicado vira o selecionado.
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

  document.addEventListener('dblclick', (e) => {
    if (!selectMode) return
    if (e.target && e.target.closest && e.target.closest('[data-orbit-ui]')) return
    // Um dblclick depois de um arraste (curto, ainda na mesma vizinhança) não
    // pode virar edição.
    if (suppressClick) return
    // Sem preventDefault: a seleção de palavra nativa do duplo clique é o
    // cursor que o usuário espera. A edição normalmente já começou no
    // pointerdown; aqui é só o fallback.
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

  // Clicar fora do canvas tira o foco do iframe SEM disparar focusout no
  // elemento; sem isto a edição (e o realce cinza) ficava presa.
  window.addEventListener('blur', () => finishEditing(true))

  // O artboard é um quadro do canvas: a roda navega o CANVAS (como no Figma),
  // não rola o documento por dentro.
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
    if (msg.type === 'tree') { post({ type: 'tree', tree: tree() }); return }
    if (msg.type === 'blur') { finishEditing(true); return }
    if (msg.type === 'select') {
      selected = byPath(msg.path)
      if (selected === document.body) selected = null
      // O painel manda o grupo inteiro (a seleção múltipla da lista de
      // Camadas); só entram os IRMÃOS do selecionado — o resto é ignorado.
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
    if (msg.type === 'hover') {
      hovered = msg.path ? byPath(msg.path) : null
      sendRects()
      return
    }
    // A lista de Camadas mandou uma mudança de estrutura: ela é aplicada no
    // DOM ao vivo (o painel grava o fonte logo em seguida) para o canvas não
    // ficar para trás até o próximo reload.
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
      post({ type: 'tree', tree: tree() })
      sendRects()
      return
    }
    if (msg.type === 'reorder') {
      const parent = byPath(msg.parent)
      if (!parent || !Array.isArray(msg.order)) return
      applyOrder(parent, msg.order)
      post({ type: 'select', path: pathOf(selected), info: infoFor(selected), shift: false, group: groupPaths() })
      post({ type: 'tree', tree: tree() })
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
      // Do último para o primeiro: assim o caminho dos que ainda restam não
      // muda no meio da remoção.
      for (const el of els.reverse()) el.remove()
      selected = null
      group = []
      post({ type: 'select', path: null, info: null, shift: false, group: [] })
      post({ type: 'tree', tree: tree() })
      sendRects()
      return
    }
    // "Envolver": os elementos selecionados viram filhos de um div novo, que
    // entra no lugar do primeiro deles. O painel gravou o MESMO plano no
    // fonte — aqui é só a mesma mudança, ao vivo.
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
      post({ type: 'tree', tree: tree() })
      sendRects()
      return
    }
    const el = byPath(msg.path)
    if (!el) return
    // Texto solto não tem estilo nem atributo: quem os tem é o pai (é de lá
    // que o texto herda).
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
    // A mensagem pode ser de OUTRO membro do grupo: mudar estilo não muda a
    // seleção (o painel continua mostrando o primário).
    if (!selected || selected === el) selected = el
    sendInfo()
    sendRects()
    post({ type: 'tree', tree: tree() })
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
    post({ type: 'ready', tree: tree(), width: doc.scrollWidth, height: doc.scrollHeight, links: links() })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready)
  else ready()
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(sendRects)
})()`

/** Põe a ponte como primeiro script do <head> (idempotente). */
export function injectDesignRuntime(html: string): string {
  if (html.includes(RUNTIME_MARK)) return html
  const tag = `<script ${RUNTIME_MARK} src="${DESIGN_RUNTIME_PATH}"></script>`
  const head = /<head[^>]*>/i.exec(html)
  if (head) return `${html.slice(0, head.index + head[0].length)}${tag}${html.slice(head.index + head[0].length)}`
  const htmlTag = /<html[^>]*>/i.exec(html)
  if (htmlTag) return `${html.slice(0, htmlTag.index + htmlTag[0].length)}<head>${tag}</head>${html.slice(htmlTag.index + htmlTag[0].length)}`
  return tag + html
}
