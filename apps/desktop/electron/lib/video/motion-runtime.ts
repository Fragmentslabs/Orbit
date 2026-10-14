/**
 * Runtime de seek das composições de motion — o ÚNICO lugar onde o contrato de
 * busca vive, compartilhado por dois caminhos:
 *
 *  1. o RENDER (motion.ts), que carrega a composição numa janela offscreen e
 *     injeta este script por executeJavaScript;
 *  2. o PREVIEW (aba do painel), que serve a pasta da composição por
 *     `orbit-motion://` e injeta o script como PRIMEIRO script do `<head>`
 *     (`/__orbit-runtime.js`), conversando com o host por postMessage.
 *
 * Unidade de tempo é QUADRO INTEIRO: `window.orbitMotion.seek(frame)` recebe um
 * inteiro e converte internamente para segundos (`t = frame / fps`). Quadro
 * inteiro elimina a deriva de float do `frame / fps` acumulado e permite partir
 * uma faixa em quadros exatos (o mesmo motivo pelo qual o Remotion trabalha em
 * frames).
 *
 * O texto é uma string de propósito: ele roda NA página, não no main. A cópia
 * aqui é a fonte da verdade — o render e o protocolo servem exatamente este
 * script. As MESMAS regras da ponte valem nas funções puras de parsing abaixo,
 * que os testes cobrem e que o host usa para validar o que chega.
 */

/** Fps do app — a composição pode declarar outro, mas este é o padrão. */
export const MOTION_FPS = 30

/** Versão do contrato; a composição lê em window.orbitMotion.version. */
export const MOTION_RUNTIME_VERSION = 1

/** Marca das mensagens da ponte (host ⇄ iframe). */
export const MOTION_SOURCE = 'orbit-motion'

/** Caminho reservado que serve o script do runtime pela pasta da composição. */
export const MOTION_RUNTIME_PATH = '/__orbit-runtime.js'

/**
 * O script do runtime. Preserva o que já funcionava no render antigo (timeline
 * global do GSAP, document.getAnimations(), document.fonts.ready, o double rAF,
 * o seek de <video> e o cuidado com HiDPI) e acrescenta o contrato em quadros,
 * delayRender/continueRender, a ponte postMessage e o modo play.
 */
export const MOTION_RUNTIME = `(() => {
  if (window.__orbitMotionReady) return
  window.__orbitMotionReady = true

  const FPS = ${MOTION_FPS}
  const VERSION = ${MOTION_RUNTIME_VERSION}
  const SOURCE = '${MOTION_SOURCE}'
  // Um delayRender() que ninguém fecha NÃO pode pendurar o seek para sempre:
  // estoura em erro (a composição tem um bug e o host precisa saber).
  const HANDLE_TIMEOUT_MS = 10000

  // --------------------------------------------------------------- estado
  const declared = {}          // números que a COMPOSIÇÃO declarou
  const resolved = { width: 1920, height: 1080, fps: FPS, duration: undefined, durationInFrames: undefined }
  let failedFonts = []
  let customSeek = null        // seek próprio da composição (canvas/three.js)
  let currentFrame = 0

  // A composição pode ter declarado window.orbitMotion = { … } ANTES do runtime
  // (é o caso do render, que injeta o script depois do load). Guarda os números
  // e um seek próprio; o resto da API é anexado no MESMO objeto para não
  // invalidar a referência que a página já tem.
  const seed = window.orbitMotion && typeof window.orbitMotion === 'object' ? window.orbitMotion : null
  if (seed) {
    for (const k of ['width', 'height', 'fps', 'duration', 'durationInFrames']) {
      const v = seed[k]
      if (typeof v === 'number' && isFinite(v) && v > 0) declared[k] = v
    }
    if (typeof seed.seek === 'function') customSeek = seed.seek
  }
  const api = seed || {}

  // --------------------------------------------------------------- spec
  function metaContent() {
    const el = document.querySelector('meta[name="orbit-motion"]')
    return el ? el.getAttribute('content') : null
  }
  function readMeta() {
    const out = {}
    const raw = metaContent()
    if (!raw) return out
    for (const pair of String(raw).split(/[,;]/)) {
      const at = pair.indexOf('=')
      if (at < 0) continue
      const key = pair.slice(0, at).trim()
      const num = Number(pair.slice(at + 1).trim())
      if (!isFinite(num) || num <= 0) continue
      if (key === 'width' || key === 'height' || key === 'fps' || key === 'duration') out[key] = num
    }
    return out
  }
  function timelineDuration() {
    const tl = window.orbitTimeline
    return tl && typeof tl.duration === 'function' ? tl.duration() : undefined
  }
  // Precedência preservada do render antigo: o que a composição declarou vence a
  // <meta>, que vence o default. O comprimento NÃO tem default — sem ele o
  // render tem que falhar em vez de chutar tamanho.
  //
  // O comprimento pode ser declarado em QUADROS (durationInFrames, o contrato
  // novo) ou em segundos (duration / timeline / meta). Quadros é canônico e
  // manda: em segundos, converte-se UMA vez com o fps resolvido.
  function refresh() {
    const meta = readMeta()
    const fps = declared.fps || meta.fps || FPS
    const declaredFrames = declared.durationInFrames ? Math.max(1, Math.round(declared.durationInFrames)) : 0
    const seconds = declaredFrames ? declaredFrames / fps : declared.duration || timelineDuration() || meta.duration
    resolved.fps = fps
    resolved.width = declared.width || meta.width || 1920
    resolved.height = declared.height || meta.height || 1080
    resolved.duration = seconds
    resolved.durationInFrames = seconds ? Math.max(1, Math.round(seconds * fps)) : undefined
    return resolved
  }

  // --------------------------------------------------------- ponte postMessage
  function post(type, payload) {
    const parent = window.parent
    if (!parent || parent === window) return   // topo (janela do render): ninguém para ouvir
    try {
      const message = Object.assign({ source: SOURCE, type: type }, payload || {})
      parent.postMessage(message, '*')
    } catch (err) { /* host já foi embora */ }
  }
  function reportError(err) {
    post('error', {
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : undefined,
    })
  }

  // --------------------------------------------------- delayRender/continueRender
  // A composição abre um handle antes de carregar algo assíncrono (fonte, imagem,
  // fetch) e fecha quando termina; o seek espera os handles abertos.
  const openHandles = new Set()
  let handleSeq = 1
  let waiters = []
  function flushWaiters() {
    const list = waiters
    waiters = []
    for (const fn of list) fn()
  }
  function delayRender() {
    const handle = handleSeq++
    openHandles.add(handle)
    return handle
  }
  function continueRender(handle) {
    if (openHandles.delete(handle) && openHandles.size === 0) flushWaiters()
  }
  function waitForHandles() {
    if (openHandles.size === 0) return Promise.resolve()
    return new Promise(function (resolve, reject) {
      let timer = 0
      function waiter() {
        clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(function () {
        const at = waiters.indexOf(waiter)
        if (at >= 0) waiters.splice(at, 1)
        reject(new Error('orbit-motion: a delayRender() handle was not released within ' + HANDLE_TIMEOUT_MS + 'ms'))
      }, HANDLE_TIMEOUT_MS)
      waiters.push(waiter)
    })
  }

  // --------------------------------------------------------------- seek
  // O GSAP é lido do window a cada uso (não capturado aqui): no preview o
  // runtime é o primeiro script do head e o gsap.min.js da composição carrega
  // DEPOIS — capturar agora daria undefined e a timeline nunca seria buscada.
  let gsapReady = false
  let gsapBase = 0
  function prepareGsap() {
    if (gsapReady || customSeek) return
    const g = window.gsap
    if (!g) return
    gsapReady = true
    g.ticker.lagSmoothing(0)
    if (window.orbitTimeline) window.orbitTimeline.pause()
    else {
      const kids = g.globalTimeline.getChildren(false, true, true)
      gsapBase = kids.length ? Math.min.apply(null, kids.map(function (k) { return k.startTime() })) : 0
      g.globalTimeline.pause()
    }
  }
  function videos() {
    return Array.prototype.slice.call(document.querySelectorAll('video'))
  }
  for (const v of videos()) { v.muted = true; v.pause() }
  // Pausa o GSAP já na entrada (como o render antigo fazia): a composição não
  // pode andar sozinha antes do primeiro seek.
  prepareGsap()

  function nextFrame() {
    return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r) }) })
  }

  async function applyFrame(frame) {
    currentFrame = frame
    const t = frame / resolved.fps
    if (customSeek) await customSeek(frame)
    else {
      prepareGsap()
      const g = window.gsap
      if (g) {
        if (window.orbitTimeline) window.orbitTimeline.seek(t, false)
        else g.globalTimeline.seek(gsapBase + t, false)
      }
    }
    for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = t * 1000 } catch (err) {} }
    await Promise.all(videos().map(function (v) {
      return new Promise(function (res) {
        const target = v.duration ? (v.loop ? t % v.duration : Math.min(t, v.duration - 0.001)) : t
        if (Math.abs(v.currentTime - target) < 0.001) return res()
        v.addEventListener('seeked', res, { once: true })
        v.currentTime = target
        setTimeout(res, 2000)
      })
    }))
    await nextFrame()
  }

  // latest-wins: um seek que chega enquanto outro roda SUBSTITUI o anterior (que
  // é descartado, nunca enfileirado). No modo play o rAF pede um quadro por vez e
  // a máquina nunca acumula seeks sobrepostos.
  let queued = null
  let running = false
  function pump() {
    if (running) return
    running = true
    ;(async function () {
      try {
        while (queued) {
          const job = queued
          queued = null
          try {
            await waitForHandles()
            // Um pedido mais novo chegou enquanto este esperava (delayRender,
            // fonte, rAF): este é velho e sai sem aplicar nada.
            if (queued) { job.resolve(); continue }
            await applyFrame(job.f)
            job.resolve()
          } catch (err) {
            reportError(err)
            job.reject(err)
          }
        }
      } finally {
        running = false
      }
    })()
  }
  function seekFrame(frame) {
    const f = Math.max(0, Math.round(Number(frame) || 0))
    return new Promise(function (resolve, reject) {
      if (queued) queued.resolve()   // requisição velha: sai sem fazer nada
      queued = { f: f, resolve: resolve, reject: reject }
      pump()
    })
  }

  // --------------------------------------------------------------- play
  let playing = false
  let loopOn = false
  let rafId = 0
  let playBase = 0
  let playBaseFrame = 0
  function play() {
    if (playing) return
    playing = true
    playBase = performance.now()
    playBaseFrame = currentFrame
    function tick() {
      if (!playing) return
      const elapsed = (performance.now() - playBase) / 1000
      let frame = playBaseFrame + Math.round(elapsed * resolved.fps)
      const total = resolved.durationInFrames
      if (total && frame >= total) {
        if (loopOn) {
          // Com loop ligado, o play dá a VOLTA. A pergunta tem que ser
          // "frame >= total": com "frame >= total - 1" no outro ramo, o último
          // quadro caía nele primeiro e o play morria ali — com loop ligado.
          playBase = performance.now()
          playBaseFrame = 0
          frame = 0
        } else {
          // Sem loop, para no ÚLTIMO quadro (preso nele, não num quadro que não
          // existe).
          frame = total - 1
          seekFrame(frame).catch(function () {})
          post('time', { frame: frame })
          pause()
          return
        }
      }
      seekFrame(frame).catch(function () {})
      post('time', { frame: frame })
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
  }
  function pause() {
    playing = false
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
  }

  // --------------------------------------------------------------- API
  // window.orbitMotion é o contrato: a composição lê fps/width/height/
  // durationInFrames e usa delayRender/continueRender; o host chama seek(frame).
  // Os números e o seek são ACESSORES: atribuir (a composição declarando o
  // próprio formato ou o próprio seek) cai no lugar certo em vez de apagar a API.
  function defineNumbers() {
    for (const k of ['width', 'height', 'fps', 'duration']) {
      Object.defineProperty(api, k, {
        configurable: true,
        enumerable: true,
        get: function () { return resolved[k] },
        // Declarar o formato DEPOIS do runtime (script da composição) reanuncia
        // o ready, em vez de deixar o host com o valor antigo.
        set: function (v) {
          if (typeof v === 'number' && isFinite(v) && v > 0) declared[k] = v
          announce()
        },
      })
    }
    // durationInFrames aceita atribuição: a composição declara o comprimento em
    // quadros (window.orbitMotion = { durationInFrames: 120 }) e o valor vira o
    // canônico da resolução.
    Object.defineProperty(api, 'durationInFrames', {
      configurable: true,
      enumerable: true,
      get: function () { return resolved.durationInFrames },
      set: function (v) {
        if (typeof v === 'number' && isFinite(v) && v > 0) declared.durationInFrames = v
        announce()
      },
    })
    Object.defineProperty(api, 'failedFonts', {
      configurable: true,
      enumerable: true,
      get: function () { return failedFonts },
    })
    Object.defineProperty(api, 'seek', {
      configurable: true,
      enumerable: true,
      get: function () { return seekFrame },
      set: function (fn) { if (typeof fn === 'function') customSeek = fn },
    })
    Object.defineProperty(api, 'version', { value: VERSION, writable: true, enumerable: true, configurable: true })
    api.delayRender = delayRender
    api.continueRender = continueRender
  }
  try {
    defineNumbers()
    Object.defineProperty(window, 'orbitMotion', {
      configurable: true,
      enumerable: true,
      get: function () { return api },
      // Atribuir window.orbitMotion = { duration: 4 } (declaração antiga) faz
      // MERGE na API em vez de trocar o objeto — senão delayRender/seek sumiriam.
      set: function (value) {
        if (!value || typeof value !== 'object' || value === api) return
        for (const k of Object.keys(value)) {
          if (k === 'seek') { if (typeof value.seek === 'function') customSeek = value.seek; continue }
          try { api[k] = value[k] } catch (err) {}
        }
        announce()
      },
    })
  } catch (err) {
    // Já existe um window.orbitMotion não-configurável: segue com o que deu.
  }

  // Foto do estado para o host do RENDER (que lê por executeJavaScript, sem
  // ponte). Mesmos nomes do antigo PAGE_SPEC para o render manter a precedência.
  window.__orbitMotionSpec = function () {
    return {
      meta: metaContent(),
      width: resolved.width,
      height: resolved.height,
      fps: resolved.fps,
      duration: resolved.duration,
      durationInFrames: resolved.durationInFrames,
      failedFonts: failedFonts.slice(),
      devicePixelRatio: window.devicePixelRatio || 1,
    }
  }

  // ------------------------------------------------------------- camadas
  // Quem aparece e some ao longo do tempo: varre os quadros SEM pintar (só
  // estilo e layout, que o getBoundingClientRect força) e devolve, por
  // elemento, os intervalos em que ele está visível — o que a aba desenha como
  // faixas de entrada e saída. Roda na janela offscreen do main, nunca no
  // preview: a varredura mexe no playhead. A escolha de QUAIS elementos viram
  // camada é do host (motion-layers.ts), que conhece só este retrato cru.
  const SKIP_TAGS = /^(SCRIPT|STYLE|LINK|META|TEMPLATE|NOSCRIPT|BR|HEAD|TITLE)$/
  function layerLabel(el) {
    const named = el.getAttribute('data-layer')
    if (named) return named
    if (el.id) return '#' + el.id
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim()
    if (text) return text.length > 32 ? text.slice(0, 31) + '…' : text
    const cls = (el.getAttribute('class') || '').trim().split(/\\s+/)[0]
    return cls ? '.' + cls : el.tagName.toLowerCase()
  }
  function layerCandidates() {
    const out = []
    function walk(el, parent, depth) {
      for (const child of Array.prototype.slice.call(el.children)) {
        if (out.length >= 400) return
        if (SKIP_TAGS.test(child.tagName)) continue
        const index = out.length
        out.push({ el: child, parent: parent })
        if (depth < 6) walk(child, index, depth + 1)
      }
    }
    if (document.body) walk(document.body, -1, 0)
    return out
  }
  function isShown(el, vw, vh) {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false
    const r = el.getBoundingClientRect()
    if (r.width * r.height < 4) return false
    return r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh
  }
  // O mesmo caminho do applyFrame, sem <video> e sem esperar o paint: a
  // varredura só lê estilo e geometria.
  async function seekForProbe(frame) {
    currentFrame = frame
    const t = frame / resolved.fps
    if (customSeek) await customSeek(frame)
    else {
      prepareGsap()
      const g = window.gsap
      if (g) {
        if (window.orbitTimeline) window.orbitTimeline.seek(t, false)
        else g.globalTimeline.seek(gsapBase + t, false)
      }
    }
    for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = t * 1000 } catch (err) {} }
  }
  window.__orbitMotionLayers = async function (maxSamples) {
    refresh()
    const total = resolved.durationInFrames
    if (!total) return { durationInFrames: 0, step: 1, layers: [] }
    await waitForHandles()
    const back = currentFrame
    const step = Math.max(1, Math.ceil(total / (maxSamples || 900)))
    const items = layerCandidates()
    const vw = resolved.width
    const vh = resolved.height
    const spans = items.map(function () { return [] })
    const open = items.map(function () { return -1 })
    let last = 0
    for (let f = 0; f < total; f += step) {
      await seekForProbe(f)
      for (let i = 0; i < items.length; i++) {
        const on = isShown(items[i].el, vw, vh)
        if (on && open[i] < 0) open[i] = f
        else if (!on && open[i] >= 0) { spans[i].push([open[i], f - 1]); open[i] = -1 }
      }
      last = f
    }
    for (let i = 0; i < items.length; i++) if (open[i] >= 0) spans[i].push([open[i], total - 1])
    await seekFrame(back).catch(function () {})
    return {
      durationInFrames: total,
      step: step,
      lastSample: last,
      layers: items.map(function (item, i) {
        return {
          name: layerLabel(item.el),
          named: item.el.hasAttribute('data-layer'),
          parent: item.parent,
          spans: spans[i],
        }
      }),
    }
  }

  // --------------------------------------------------------------- boot
  // HiDPI: a captura sai no fator de escala da tela e o host normaliza a imagem
  // (scale= no ffmpeg); aqui só garantimos altura no documento — sem ela a
  // janela offscreen pinta vazio e o quadro sai em branco.
  function syncDocumentHeight() {
    const root = document.documentElement
    if (!root || !resolved.height) return
    if (root.getBoundingClientRect().height === 0) root.style.height = resolved.height + 'px'
  }
  function reportAssets() {
    failedFonts = Array.prototype.slice.call(document.fonts || [])
      .filter(function (f) { return f.status === 'error' })
      .map(function (f) { return f.family })
    post('assets', { failedFonts: failedFonts })
  }
  let readyFrames = 0
  function announce() {
    refresh()
    const frames = resolved.durationInFrames
    // Só (re)anuncia quando o comprimento mudou: a composição pode declarar o
    // formato depois do runtime (script dela, no meio do head) e o host precisa
    // saber; sem mudança, nada é repetido.
    if (!frames || frames === readyFrames) return
    readyFrames = frames
    post('ready', {
      durationInFrames: resolved.durationInFrames,
      width: resolved.width,
      height: resolved.height,
      version: VERSION,
    })
  }
  function boot() {
    syncDocumentHeight()
    announce()
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { reportAssets(); announce() })
  }
  if (document.readyState === 'complete') boot()
  else window.addEventListener('load', boot, { once: true })

  // Comandos do host (preview). Só do parent: a composição é conteúdo não
  // confiável e não manda no playhead de outra página.
  window.addEventListener('message', function (event) {
    if (window.parent !== window && event.source !== window.parent) return
    const cmd = parseCommand(event.data)
    if (!cmd) return
    if (cmd.type === 'seek') seekFrame(cmd.frame).catch(function () {})
    else if (cmd.type === 'play') play()
    else if (cmd.type === 'pause') pause()
    else if (cmd.type === 'loop') loopOn = cmd.on
  })

  // Mesmas regras da função pura parseMotionCommand (motion-runtime.ts) — aqui em
  // JS de página, sem import, porque o runtime não passa pelo bundler.
  function parseCommand(data) {
    if (!data || typeof data !== 'object' || data.source !== SOURCE) return null
    if (data.type === 'seek') return isFinite(data.frame) ? { type: 'seek', frame: Math.max(0, Math.round(data.frame)) } : null
    if (data.type === 'play') return { type: 'play' }
    if (data.type === 'pause') return { type: 'pause' }
    if (data.type === 'loop') return { type: 'loop', on: Boolean(data.on) }
    return null
  }

  refresh()
})()`

/**
 * Lido no host do render logo depois de injetar o runtime: devolve a foto do
 * estado da página, ou null se o runtime não chegou a rodar.
 */
export const MOTION_SPEC = `(() => {
  const spec = window.__orbitMotionSpec
  return typeof spec === 'function' ? spec() : null
})()`

/** Comando do host para o iframe (mesmas regras do parseCommand da página). */
export type MotionHostCommand =
  | { type: 'seek'; frame: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'loop'; on: boolean }

/** Mensagem do iframe para o host. */
export type MotionRuntimeMessage =
  | { type: 'ready'; durationInFrames: number; width: number; height: number; version: number }
  | { type: 'time'; frame: number }
  | { type: 'error'; message: string; stack?: string }
  | { type: 'assets'; failedFonts: string[] }

/** Valida um comando host→iframe (mesmas regras do runtime na página). */
export function parseMotionCommand(raw: unknown): MotionHostCommand | null {
  if (!raw || typeof raw !== 'object') return null
  const msg = raw as Record<string, unknown>
  if (msg.source !== MOTION_SOURCE) return null
  if (msg.type === 'seek') {
    return typeof msg.frame === 'number' && Number.isFinite(msg.frame)
      ? { type: 'seek', frame: Math.max(0, Math.round(msg.frame)) }
      : null
  }
  if (msg.type === 'play') return { type: 'play' }
  if (msg.type === 'pause') return { type: 'pause' }
  if (msg.type === 'loop') return { type: 'loop', on: Boolean(msg.on) }
  return null
}

/** Valida uma mensagem iframe→host (ready/time/error/assets). */
export function parseMotionMessage(raw: unknown): MotionRuntimeMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const msg = raw as Record<string, unknown>
  if (msg.source !== MOTION_SOURCE) return null
  if (msg.type === 'ready') {
    if (typeof msg.durationInFrames !== 'number' || !Number.isFinite(msg.durationInFrames)) return null
    return {
      type: 'ready',
      durationInFrames: Math.max(1, Math.round(msg.durationInFrames)),
      width: typeof msg.width === 'number' ? msg.width : 1920,
      height: typeof msg.height === 'number' ? msg.height : 1080,
      version: typeof msg.version === 'number' ? msg.version : 0,
    }
  }
  if (msg.type === 'time') {
    return typeof msg.frame === 'number' && Number.isFinite(msg.frame)
      ? { type: 'time', frame: Math.max(0, Math.round(msg.frame)) }
      : null
  }
  if (msg.type === 'error') {
    if (typeof msg.message !== 'string') return null
    return { type: 'error', message: msg.message, stack: typeof msg.stack === 'string' ? msg.stack : undefined }
  }
  if (msg.type === 'assets') {
    const fonts = Array.isArray(msg.failedFonts) ? msg.failedFonts.filter((f): f is string => typeof f === 'string') : []
    return { type: 'assets', failedFonts: fonts }
  }
  return null
}

/** Marca do `<script>` injetado, para não duplicar numa composição já servida. */
const RUNTIME_MARK = 'data-orbit-motion-runtime'

/** Tag do runtime para a composição de `id` (o `/__orbit-runtime.js` reservado). */
export function motionRuntimeTag(scheme: string, id: string): string {
  return `<script ${RUNTIME_MARK} src="${scheme}://${id}${MOTION_RUNTIME_PATH}"></script>`
}

/**
 * Injeta o runtime como PRIMEIRO script do `<head>` (o mais cedo possível: a
 * composição roda depois e já conta com a API e com a captura de delayRender).
 * Sem `<head>`, o script é prefixado ao documento — o parser o executa antes de
 * qualquer script da composição de qualquer forma.
 */
export function injectMotionRuntime(html: string, scheme: string, id: string): string {
  if (html.includes(RUNTIME_MARK)) return html
  const tag = motionRuntimeTag(scheme, id)
  const head = /<head[^>]*>/i.exec(html)
  if (head) return `${html.slice(0, head.index + head[0].length)}${tag}${html.slice(head.index + head[0].length)}`
  const htmlTag = /<html[^>]*>/i.exec(html)
  if (htmlTag) return `${html.slice(0, htmlTag.index + htmlTag[0].length)}<head>${tag}</head>${html.slice(htmlTag.index + htmlTag[0].length)}`
  return tag + html
}
