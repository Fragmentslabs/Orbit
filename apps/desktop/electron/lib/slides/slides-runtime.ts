/**
 * Runtime de navegação dos decks de slides — o ÚNICO lugar onde o palco vive.
 *
 * O deck é UM arquivo HTML (`index.html` com um `<section class="slide">` por
 * slide) e não tem JavaScript próprio. Quem monta o palco, escala o 16:9 e
 * obedece ao teclado é este script, servido pelo scheme `orbit-slides://` como
 * primeiro script do `<head>`.
 *
 * Por que um runtime injetado, e não o deck cuidando de si: assim o deck é
 * CONTEÚDO (o agente escreve um HTML e pronto, como um artifact), enquanto
 * navegação, escala, miniaturas, notas e impressão são do app — a mesma
 * separação que o motion faz entre composição e player. Um deck escrito à mão
 * abre igual, e um deck antigo ganha os recursos novos sem ser reescrito.
 *
 * Como o script é o PRIMEIRO do <head>, ele roda antes de o <body> existir:
 * tudo o que toca no documento acontece dentro de `start()`, chamado no
 * DOMContentLoaded (a mesma cautela do design-runtime). Sem isso o deck
 * encontraria zero slides e o palco nasceria vazio.
 *
 * O iframe roda em `sandbox="allow-scripts"` SEM `allow-same-origin` (origem
 * opaca): o painel não alcança o DOM do deck. A conversa é por postMessage com
 * `source: "orbit-slides"`:
 *
 *   deck → painel: ready (total, tamanho, títulos e notas), change (índice),
 *                  error, request-fullscreen
 *   painel → deck: go(index), next, prev
 *
 * O texto é uma string de propósito: ele roda NA página, não no main. As funções
 * puras de parsing do deck (slides-deck.ts) aplicam as MESMAS regras de título e
 * nota, e os testes as cobrem.
 */

/** Marca das mensagens da ponte (host ⇄ iframe). */
export const SLIDES_SOURCE = 'orbit-slides'

/** Caminho reservado que serve o script do runtime pela pasta do deck. */
export const SLIDES_RUNTIME_PATH = '/__orbit_slides_runtime.js'

const RUNTIME_MARK = 'data-orbit-slides-runtime'

/** Palco padrão de um slide (16:9). O deck pode declarar outro no <meta>. */
export const SLIDES_WIDTH = 1280
export const SLIDES_HEIGHT = 720

/**
 * O script do runtime. Sem template literals lá dentro de propósito: o arquivo
 * inteiro é uma string, e `$` + `{` no meio dela quebraria a montagem.
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
    // O tamanho do palco pode vir do próprio deck: <meta name="orbit-slides"
    // content="width=1920,height=1080">. Sem meta, 1280x720 (16:9).
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
      // Só os slides de TOPO do deck: um .slide dentro de outro (uma capa que
      // repete o padrão) não vira uma parada da apresentação.
      if (el.closest('.orbit-slides-stage')) continue
      sections.push(el)
    }

    if (sections.length === 0) {
      post({ type: 'error', message: 'no elements with class "slide" in the deck' })
      return
    }

    // ------------------------------------------------------------ estrutura
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

    // Impressão/PDF: todos os slides empilhados, um por página, sem escala e
    // sem interface — é o mesmo documento, lido de cima para baixo.
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
        // A quebra forçada depois do ÚLTIMO slide gera uma página em branco no
        // fim do PDF: o Chromium respeita o break-after mesmo quando não há
        // mais nada para paginar.
        '.orbit-slides-stage>.orbit-slide:last-child{break-after:auto;page-break-after:auto}',
      ].join('\\n')
      document.head.appendChild(printStyle)
    }

    for (let i = 0; i < sections.length; i++) {
      const el = sections[i]
      el.classList.add('orbit-slide')
      // O deck pode desenhar o próprio número com [data-index] (o tema da casa
      // usa isto no canto do slide).
      el.setAttribute('data-index', String(i + 1))
      stage.appendChild(el)
    }

    // --------------------------------------------------------------- estado
    let index = 0

    const text = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : '')

    const titleOf = (el, i) => {
      const explicit = el.getAttribute('data-title')
      if (explicit && explicit.trim()) return explicit.trim()
      const heading = el.querySelector('h1, h2, h3')
      return text(heading) || 'Slide ' + (i + 1)
    }

    // Notas: <aside class="notes"> vale pelo TEXTO; data-notes preenchido vale
    // pelo VALOR do atributo (a mesma regra de slides-deck.ts, no main).
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
      // translate ANTES do scale: o palco pode ser MAIOR que a janela (um
      // painel estreito), e um item maior que o container não fica centralizado
      // por grid/flex — ele vaza para a direita. Ancorado em 50%/50% com
      // translate(-50%,-50%) o centro do slide é o centro do palco, sempre.
      stage.style.transform = 'translate(-50%, -50%) scale(' + scale + ')'
    }

    // -------------------------------------------------------------- eventos
    window.addEventListener('resize', fit)
    // O palco vive dentro de um iframe cujo tamanho é decidido pelo painel:
    // nem toda mudança de layout chega como evento "resize" na janela do
    // iframe (um painel que abre uma barra lateral, por exemplo). O observer
    // garante que a escala acompanha o tamanho REAL do palco.
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
      // Um campo dentro do slide continua sendo um campo: setas e espaço são dele.
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
        // Tela cheia é da JANELA do app, não do iframe: o host decide.
        event.preventDefault()
        post({ type: 'request-fullscreen' })
      }
    })

    // Clique avança (apresentar é clicar), menos em cima de algo clicável — um
    // link ou botão dentro do slide pertence ao slide.
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

  // O script é o primeiro do <head>: o documento ainda está sendo lido.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()`

/**
 * Põe o runtime como primeiro script do `<head>` (idempotente). Sem `<head>`,
 * cria um; sem `<html>`, o script vai na frente do documento.
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
