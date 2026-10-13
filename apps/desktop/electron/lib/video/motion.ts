import { BrowserWindow } from 'electron'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { runFfmpeg } from './ffmpeg'

/**
 * Motion a partir de HTML: o Orbit já é um Chromium, então uma composição
 * HTML/CSS/GSAP vira vídeo aqui mesmo — sem baixar Chrome headless, sem
 * Remotion (que é source-available e pago para empresas) e sem rede.
 *
 * Determinístico: o tempo NÃO corre sozinho. Para cada quadro o renderer
 * pausa tudo e posiciona no instante t, espera o paint e captura. Assim um
 * quadro lento não vira salto no vídeo, e renderizar duas vezes dá o mesmo
 * arquivo. O que a composição pode usar para ser "seekável":
 *   - `window.orbitMotion = { seek(t) }` (t em segundos; pode devolver Promise)
 *     — o caminho explícito, para canvas/three.js/qualquer coisa;
 *   - `window.orbitTimeline` (uma timeline GSAP) ou, sem ela, a timeline
 *     global do GSAP;
 *   - animações CSS e Web Animations (document.getAnimations());
 *   - <video> da página (currentTime + espera do "seeked").
 * O que NÃO é seekável (requestAnimationFrame com relógio próprio, setTimeout)
 * sai congelado — a skill de vídeo explica isso ao agente.
 */

export interface MotionSpec {
  width?: number
  height?: number
  fps?: number
  duration?: number
}

export interface MotionOptions extends MotionSpec {
  file: string
  output: string
  /** Fundo transparente: .mov (ProRes 4444) ou .webm (VP9 com alfa). */
  transparent?: boolean
  signal?: AbortSignal
}

export interface MotionResult {
  output: string
  width: number
  height: number
  fps: number
  duration: number
  frames: number
  warnings: string[]
}

const MAX_SECONDS = 180

/** `<meta name="orbit-motion" content="width=1920,height=1080,fps=30,duration=6">` → spec (puro). */
export function parseMotionMeta(content: string | null | undefined): MotionSpec {
  const spec: MotionSpec = {}
  for (const pair of (content ?? '').split(/[,;]/)) {
    const [k, v] = pair.split('=').map((s) => s.trim())
    const num = Number(v)
    if (!Number.isFinite(num) || num <= 0) continue
    if (k === 'width' || k === 'height' || k === 'fps' || k === 'duration') spec[k] = num
  }
  return spec
}

/** Encoder por formato de saída; alfa só onde o contêiner leva. */
export function motionEncoder(output: string, transparent: boolean): string[] {
  const ext = path.extname(output).toLowerCase()
  if (transparent && ext === '.mov') return ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le']
  if (transparent && ext === '.webm') return ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '28', '-row-mt', '1']
  if (transparent) throw new Error('transparent output needs a .mov (ProRes 4444) or .webm (VP9) file name')
  if (ext === '.webm') return ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', '30', '-row-mt', '1']
  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
}

// Roda NA PÁGINA. Mantido como string: é o contrato de seek descrito acima.
const PAGE_HELPERS = `
(() => {
  if (window.__orbitMotionReady) return
  window.__orbitMotionReady = true
  const g = window.gsap
  let gsapBase = 0
  if (!window.orbitMotion?.seek && g) {
    g.ticker.lagSmoothing(0)
    if (window.orbitTimeline) window.orbitTimeline.pause()
    else {
      const kids = g.globalTimeline.getChildren(false, true, true)
      gsapBase = kids.length ? Math.min(...kids.map((k) => k.startTime())) : 0
      g.globalTimeline.pause()
    }
  }
  const videos = () => [...document.querySelectorAll('video')]
  for (const v of videos()) { v.muted = true; v.pause() }
  window.__orbitSeek = async (t) => {
    if (window.orbitMotion?.seek) await window.orbitMotion.seek(t)
    else if (g) {
      if (window.orbitTimeline) window.orbitTimeline.seek(t, false)
      else g.globalTimeline.seek(gsapBase + t, false)
    }
    for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = t * 1000 } catch {} }
    await Promise.all(videos().map((v) => new Promise((res) => {
      const target = v.duration ? (v.loop ? t % v.duration : Math.min(t, v.duration - 0.001)) : t
      if (Math.abs(v.currentTime - target) < 0.001) return res()
      v.addEventListener('seeked', res, { once: true })
      v.currentTime = target
      setTimeout(res, 2000)
    })))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  }
})()
`

const PAGE_SPEC = `
(() => {
  const meta = document.querySelector('meta[name="orbit-motion"]')?.getAttribute('content') ?? null
  const m = window.orbitMotion ?? {}
  const pick = (k) => (typeof m[k] === 'number' ? m[k] : undefined)
  const failedFonts = [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family)
  const tl = window.orbitTimeline ?? null
  return {
    meta,
    width: pick('width'), height: pick('height'), fps: pick('fps'),
    duration: pick('duration') ?? (tl && typeof tl.duration === 'function' ? tl.duration() : undefined),
    failedFonts,
  }
})()
`

export async function renderMotion(opts: MotionOptions): Promise<MotionResult> {
  const warnings: string[] = []
  const win = new BrowserWindow({
    show: false,
    width: opts.width ?? 1920,
    height: opts.height ?? 1080,
    useContentSize: true,
    frame: false,
    transparent: Boolean(opts.transparent),
    backgroundColor: opts.transparent ? '#00000000' : '#000000',
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // A composição é uma página de vídeo, não um navegador: nada de sair dela.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const onAbort = () => {
    if (!win.isDestroyed()) win.destroy()
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    await win.loadURL(pathToFileURL(opts.file).href)
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true)
    const page = (await win.webContents.executeJavaScript(PAGE_SPEC, true)) as {
      meta: string | null
      width?: number
      height?: number
      fps?: number
      duration?: number
      failedFonts: string[]
    }
    const meta = parseMotionMeta(page.meta)
    const width = Math.round(opts.width ?? page.width ?? meta.width ?? 1920)
    const height = Math.round(opts.height ?? page.height ?? meta.height ?? 1080)
    const fps = opts.fps ?? page.fps ?? meta.fps ?? 30
    const duration = opts.duration ?? page.duration ?? meta.duration
    if (!duration) {
      throw new Error(
        'unknown duration: pass `duration`, or declare <meta name="orbit-motion" content="duration=…">, window.orbitMotion.duration or window.orbitTimeline',
      )
    }
    if (duration > MAX_SECONDS) throw new Error(`duration ${duration}s is above the ${MAX_SECONDS}s limit for one composition`)
    if (page.failedFonts.length) {
      warnings.push(`fonts failed to load (the text fell back to another font): ${[...new Set(page.failedFonts)].join(', ')}`)
    }
    win.setContentSize(width, height)
    await win.webContents.executeJavaScript(PAGE_HELPERS, true)

    const frames = Math.max(1, Math.round(duration * fps))
    const input = new PassThrough()
    const encoding = runFfmpeg(
      [
        '-v', 'error',
        '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', 'pipe:0',
        // A captura pode vir no fator de escala da tela (HiDPI): normaliza.
        '-vf', `scale=${width}:${height}:flags=lanczos`,
        ...motionEncoder(opts.output, Boolean(opts.transparent)),
        '-r', String(fps),
        opts.output,
      ],
      { stdin: input, signal: opts.signal },
    )
    // Se o ffmpeg cair no meio, para de capturar.
    let failed: unknown = null
    encoding.catch((err) => {
      failed = err
    })
    for (let i = 0; i < frames; i++) {
      if (failed) break
      if (opts.signal?.aborted) throw new Error('cancelled')
      await win.webContents.executeJavaScript(`window.__orbitSeek(${i / fps})`, true)
      const image = await win.webContents.capturePage()
      const png = image.toPNG()
      if (!input.write(png)) await new Promise<void>((r) => input.once('drain', () => r()))
    }
    input.end()
    await encoding
    return { output: opts.output, width, height, fps, duration, frames, warnings }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    if (!win.isDestroyed()) win.destroy()
  }
}
