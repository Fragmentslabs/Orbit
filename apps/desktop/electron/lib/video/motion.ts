import { BrowserWindow, type WebContents } from 'electron'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { probeMedia, runFfmpeg } from './ffmpeg'
import { motionAudioPlan } from './motion-audio'
import { motionVideoAudioTracks, type MotionVideoFact } from './motion-video-audio'
import { lintMotionComposition } from './motion-lint-run'
import {
  assertFrameBytes,
  bandCount,
  concatFfmpegArgs,
  concatList,
  isAlphaFormat,
  isPlainAudioMix,
  motionAudioFfmpegArgs,
  motionAudioMixFfmpegArgs,
  motionFfmpegArgs,
  motionFormatFor,
  splitBands,
  unpremultiplyBgra,
  type MotionFormat,
} from './motion-render-args'
import { capturePageReliably } from './capture'
import { MOTION_SPEC } from './motion-runtime'
import type { MotionTransitionInfo } from './motion-transitions'

/**
 * Motion a partir de HTML: o Orbit já é um Chromium, então uma composição
 * HTML/CSS/GSAP vira vídeo aqui mesmo — sem baixar Chrome headless, sem
 * Remotion (que é source-available e pago para empresas) e sem rede.
 *
 * Determinístico: o tempo NÃO corre sozinho. Para cada quadro o runtime pausa
 * tudo e posiciona no instante t, espera o paint e captura. Assim um quadro
 * lento não vira salto no vídeo, e renderizar duas vezes dá o mesmo arquivo (no
 * caminho sequencial, `bands: 1`; ver a nota sobre faixas paralelas abaixo). O
 * que a composição pode usar para ser "seekável":
 *   - `window.orbitMotion = { seek(t) }` (t em segundos; pode devolver Promise)
 *     — o caminho explícito, para canvas/three.js/qualquer coisa;
 *   - `window.orbitTimeline` (uma timeline GSAP) ou, sem ela, a timeline
 *     global do GSAP;
 *   - animações CSS e Web Animations (document.getAnimations());
 *   - <video> da página (currentTime + espera do "seeked").
 * O que NÃO é seekável (requestAnimationFrame com relógio próprio, setTimeout)
 * sai congelado — a skill de vídeo explica isso ao agente.
 *
 * Duas decisões de desempenho, cada uma com sua armadilha:
 *
 *  1. A composição é carregada pelo scheme `orbit-motion://` — o MESMO caminho
 *     do preview — e não por `file://`. O protocolo injeta o runtime como
 *     PRIMEIRO script do `<head>`, então `delayRender()` chamado no parse é
 *     capturado aqui igual ao preview; com o runtime injetado DEPOIS do load
 *     (o caminho antigo) essa composição funcionava no preview e saía em branco
 *     no render.
 *  2. O quadro vai para o ffmpeg CRU (`nativeImage.toBitmap()`, BGRA), sem PNG:
 *     um encode no Chromium e um decode no ffmpeg por quadro a menos. Os
 *     cuidados (tamanho constante, HiDPI, alfa pré-multiplicado) estão em
 *     motion-render-args.ts, onde são puros e testados.
 *
 * FAIXAS PARALELAS: [0, N) é dividido em K faixas, cada uma numa janela
 * offscreen própria, e os segmentos são concatenados com `-c copy` (o mesmo do
 * render de EDL). Isso NÃO promete saída byte-idêntica à sequencial: cada faixa
 * começa o próprio GOP, então os keyframes caem em pontos diferentes. O
 * caminho sequencial (`bands: 1`) é o determinístico de sempre.
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
  /** Formato do encoder. Sem ele, sai da extensão do arquivo + transparência. */
  format?: MotionFormat
  /** Id de uma composição JÁ registrada (é o que o IPC passa): não registra de novo. */
  id?: string
  /** Pasta de trabalho e sessão que registram a composição (ver motion-store). */
  root?: string
  sessionId?: string
  /**
   * Faixas paralelas. `1` é o caminho sequencial, quadro a quadro — o
   * determinístico. Sem ele: min(4, max(1, núcleos/2)).
   */
  bands?: number
  /** Chamado a cada quadro CAPTURADO (não na ordem: é a contagem que subiu). */
  onProgress?: (frame: number, total: number) => void
  signal?: AbortSignal
  /**
   * Áudio da peça, muxado numa passada FINAL — a captura pega quadros, não som.
   * Sem ele, a pasta da composição é consultada pelo nome convencional
   * (`audio.mp3`, `audio.wav`…): é isso que faz o botão Render da aba e a tool
   * chegarem ao mesmo arquivo. O comprimento é o da composição.
   */
  audio?: string
}

/**
 * Tempos do render, em milissegundos por quadro (média dos quadros capturados).
 * Contrato congelado com a tool `motion_render`, que imprime estes nomes.
 */
export interface MotionMetrics {
  /** Quadros renderizados. */
  frames: number
  /** Tempo de parede do render inteiro — com K faixas é menor que frames × msPerFrame. */
  totalMs: number
  /** Custo médio de UM quadro (a soma dos três baldes), independente de K. */
  msPerFrame: number
  /** Média do seek + paint (window.orbitMotion.seek, que espera o quadro sair). */
  seekPaint: number
  /** Média do capturePage + toBitmap + a desmultiplicação do alfa. */
  capture: number
  /** Média da escrita no stdin do ffmpeg (encode + IO, com a contrapressão). */
  encodeWrite: number
}

export interface MotionResult {
  output: string
  /** Áudio muxado (explícito ou o da pasta da composição); ausente quando mudo. */
  audio?: string
  width: number
  height: number
  fps: number
  duration: number
  frames: number
  metrics: MotionMetrics
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

/** Foto do estado da composição publicada pelo runtime (ver MOTION_SPEC). */
interface MotionPageSpec {
  meta: string | null
  width?: number
  height?: number
  fps?: number
  duration?: number
  durationInFrames?: number
  failedFonts: string[]
  transitions?: MotionTransitionInfo[]
  videos?: MotionVideoFact[]
}

interface CapturedFrame {
  buffer: Buffer
  width: number
  height: number
}

/** Baldes por quadro, somados entre as faixas. */
interface Counters {
  done: number
  seekPaint: number
  capture: number
  encodeWrite: number
}

/**
 * O registro das composições (motion-store) importa ESTE módulo para o render
 * por IPC; importá-lo de volta no topo fecharia um ciclo de módulos. A
 * importação dinâmica resolve no primeiro render e o módulo fica em cache — não
 * custa nada por quadro.
 */
async function motionRegistry() {
  return import('./motion-store')
}

/** Milissegundos com duas casas: o número vai direto para o relatório da tool. */
function ms(value: number): number {
  return Math.round(value * 100) / 100
}

function createRenderWindow(width: number, height: number, transparent: boolean): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    frame: false,
    transparent,
    backgroundColor: transparent ? '#00000000' : '#000000',
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // SEM `partition` de propósito: o handler do scheme `orbit-motion://` está
      // registrado na sessão default (protocol.handle em motion-store) e uma
      // partition própria NÃO herda esse handle — a composição responderia 404
      // e o quadro sairia em branco. As faixas também compartilham a sessão.
    },
  })
  // A composição é uma página de vídeo, não um navegador: nada de sair dela.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return win
}

/**
 * Carrega a composição pelo scheme — o runtime já entrou como PRIMEIRO script do
 * `<head>`. Se ele não estiver lá (a entrada respondeu 404, o runtime não
 * rodou), a foto da página vem nula e é aqui que a gente para, em vez de
 * capturar quadros em branco.
 */
async function loadComposition(win: BrowserWindow, url: string): Promise<MotionPageSpec> {
  await win.loadURL(url)
  // Depois das fontes: os failedFonts do runtime são lidos logo abaixo e o
  // handler dele rodou antes deste await.
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true)
  const page = (await win.webContents.executeJavaScript(MOTION_SPEC, true)) as MotionPageSpec | null
  if (!page) throw new Error(`motion runtime did not load in the render window (${url})`)
  return page
}

/** Seek num quadro: o runtime espera o paint (double rAF) antes de resolver. */
async function seekFrame(contents: WebContents, frame: number, counters?: Counters): Promise<void> {
  const started = performance.now()
  await contents.executeJavaScript(`window.orbitMotion.seek(${frame})`, true)
  if (counters) counters.seekPaint += performance.now() - started
}

/**
 * O bitmap cru da janela (BGRA, pré-multiplicado) — sem passar por PNG. No
 * caminho com alfa ele sai daqui com a cor reta (unpremultiplyBgra).
 */
async function captureBitmap(
  contents: WebContents,
  counters?: Counters,
  alpha = false,
  expected?: { width: number; height: number },
): Promise<CapturedFrame> {
  const started = performance.now()
  let image = await capturePageReliably(contents)
  // Numa tela com escala fracionária (125%, 150%) cada janela arredonda o
  // tamanho da captura do seu jeito — 1603×902 numa faixa, 1602×903 na outra —
  // e o rawvideo exige o MESMO tamanho em todo quadro. O que vier fora do
  // tamanho sondado é trazido para ele (o scale do ffmpeg leva ao tamanho final).
  if (expected) {
    const got = image.getSize()
    if (got.width !== expected.width || got.height !== expected.height) {
      image = image.resize({ width: expected.width, height: expected.height, quality: 'best' })
    }
  }
  const size = image.getSize()
  const buffer = image.toBitmap()
  // O alfa do Chromium vem PRÉ-multiplicado: virar cor reta AQUI é o "antes da
  // conversão de formato" — ver unpremultiplyBgra (o filtro do ffmpeg não dá conta).
  if (alpha) unpremultiplyBgra(buffer)
  if (counters) counters.capture += performance.now() - started
  return { buffer, width: size.width, height: size.height }
}

interface BandOptions {
  win: BrowserWindow
  /** Faixa de quadros, `[start, end)`. */
  start: number
  end: number
  total: number
  /** Arquivo desta faixa (é o próprio output quando há uma faixa só). */
  target: string
  width: number
  height: number
  fps: number
  format: MotionFormat
  /** Tamanho do quadro cru, fixado na sondagem — o `-s` do stdin. */
  captureWidth: number
  captureHeight: number
  /** Quadro 0 já capturado na sondagem: a primeira faixa não captura de novo. */
  probe?: CapturedFrame
  counters: Counters
  onProgress?: (frame: number, total: number) => void
  signal?: AbortSignal
}

/** Uma faixa: uma janela offscreen, um ffmpeg, um segmento. */
async function renderBand(o: BandOptions): Promise<void> {
  const input = new PassThrough()
  const encoding = runFfmpeg(
    motionFfmpegArgs({
      width: o.width,
      height: o.height,
      captureWidth: o.captureWidth,
      captureHeight: o.captureHeight,
      fps: o.fps,
      format: o.format,
      output: o.target,
    }),
    { stdin: input, signal: o.signal },
  )
  // Se o ffmpeg cair no meio, para de capturar.
  let failed: unknown = null
  encoding.catch((err) => {
    failed = err
  })
  try {
    for (let frame = o.start; frame < o.end; frame++) {
      if (failed) break
      if (o.signal?.aborted) throw new Error('cancelled')
      let captured: CapturedFrame
      if (o.probe && frame === o.start) {
        // O quadro 0 veio da sondagem (que já fez o seek e a captura dele):
        // reaproveitado, ele não custa um segundo seek.
        captured = o.probe
      } else {
        await seekFrame(o.win.webContents, frame, o.counters)
        captured = await captureBitmap(o.win.webContents, o.counters, isAlphaFormat(o.format), {
          width: o.captureWidth,
          height: o.captureHeight,
        })
      }
      // Um quadro de tamanho diferente desalinharia o stdin inteiro em silêncio.
      assertFrameBytes(captured.buffer.length, o.captureWidth, o.captureHeight, frame)
      const started = performance.now()
      if (!input.write(captured.buffer)) await new Promise<void>((r) => input.once('drain', () => r()))
      o.counters.encodeWrite += performance.now() - started
      o.counters.done++
      o.onProgress?.(o.counters.done, o.total)
    }
    input.end()
    await encoding
  } catch (err) {
    input.destroy()
    throw err
  }
}

export async function renderMotion(opts: MotionOptions): Promise<MotionResult> {
  const startedAt = performance.now()
  const warnings: string[] = []
  const registry = await motionRegistry()
  // O render carrega a composição pelo scheme, e o scheme só serve o que está
  // no registro. A tool só tem o caminho do arquivo: registra aqui e libera no
  // finally. O IPC já passa o id de uma composição registrada.
  let id = opts.id
  let url: string | null = null
  /** Id que ESTE render registrou — e só ele é liberado no fim. */
  let registeredId: string | null = null
  if (id) {
    url = await registry.registeredMotionUrl(id)
  } else {
    const registration = await registry.registerMotion(opts.file, undefined, { root: opts.root, sessionId: opts.sessionId })
    id = registration.id
    url = registration.url
    // A composição já estava registrada (o preview aberto na aba): o id é o
    // MESMO, e liberá-lo no fim derrubava a aba num 404 "not found".
    if (registration.created) registeredId = id
  }
  if (!id || !url) throw new Error(`unknown motion composition: ${opts.id ?? opts.file}`)

  const windows: BrowserWindow[] = []
  const counters: Counters = { done: 0, seekPaint: 0, capture: 0, encodeWrite: 0 }
  let work: string | null = null
  const onAbort = () => {
    for (const win of windows) if (!win.isDestroyed()) win.destroy()
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    // Depois do registro: qualquer erro daqui para baixo passa pelo finally (que
    // libera a composição) — inclusive um formato inválido na tool.
    const format = opts.format ?? motionFormatFor(opts.output, Boolean(opts.transparent))
    const alpha = isAlphaFormat(format)
    const primary = createRenderWindow(opts.width ?? 1920, opts.height ?? 1080, alpha)
    windows.push(primary)
    const page = await loadComposition(primary, url)
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
    primary.setContentSize(width, height)
    // O tempo anda em QUADROS: o fps EFETIVO (que pode ter vindo das opções, e
    // não da página) tem que entrar no runtime, senão o seek converte o quadro
    // com o fps da composição e a animação anda na velocidade errada.
    await primary.webContents.executeJavaScript(`window.orbitMotion.fps = ${fps}`, true)

    const total = Math.max(1, Math.round(duration * fps))
    // SONDAGEM: um quadro ANTES de subir o ffmpeg. O rawvideo exige tamanho
    // constante e a captura pode vir na escala da tela (HiDPI, ou um zoom do
    // documento): é este quadro que fixa o `-s` do stdin e, quando for o caso,
    // o scale que traz o vídeo de volta ao tamanho final.
    await seekFrame(primary.webContents, 0)
    const probe = await captureBitmap(primary.webContents, undefined, alpha)
    const bands = splitBands(total, bandCount(opts.bands, os.cpus().length))
    // Áudio da peça — quem escolhe as faixas é o motion-audio (caminho explícito,
    // o manifest da pasta, ou o nome convencional). A MESMA resolução alimenta as
    // faixas que a aba desenha e toca, então o som do preview e o do arquivo final
    // são necessariamente os mesmos arquivos, nos mesmos instantes.
    const folder = path.dirname(path.resolve(opts.file))
    // O som dos <video> da página entra como faixas: o runtime os silencia, e sem
    // isto a fala de um depoimento sumia do arquivo final.
    const videoTracks = await motionVideoAudioTracks(folder, page.videos)
    const { tracks, master } = await motionAudioPlan(folder, opts.audio, videoTracks)
    // O lint do que dá para ver ANTES de pagar o render: um relógio de parede ou
    // um sorteio fariam o arquivo sair diferente do que o usuário viu na aba.
    // Informação, nunca bloqueio — vai junto dos avisos do resultado.
    const lint = await lintMotionComposition({
      entry: path.resolve(opts.file),
      folder: path.dirname(path.resolve(opts.file)),
      runtime: { fps, durationInFrames: Math.max(1, Math.round(duration * fps)), transitions: page.transitions ?? [] },
      audio: { tracks, master },
    })
    for (const finding of lint) {
      warnings.push(`lint ${finding.severity} ${finding.rule}${finding.line ? ` (line ${finding.line})` : ''}: ${finding.message}${finding.hint ? ` → ${finding.hint}` : ''}`)
    }
    let videoOut = opts.output
    if (bands.length > 1 || tracks.length > 0) {
      // Pasta de trabalho ao lado da saída, limpa no finally — como o render de EDL.
      work = await fsp.mkdtemp(path.join(path.dirname(opts.output), '.motion-'))
      // Com áudio, o vídeo sai primeiro num temporário: quem escreve o arquivo
      // pedido é a passada final, que só então junta e mistura o som.
      if (tracks.length > 0) videoOut = path.join(work, `video${path.extname(opts.output) || '.mp4'}`)
    }
    const segments: string[] = []

    await Promise.all(
      bands.map(async (band, index) => {
        let win = primary
        if (index > 0) {
          // Cada faixa tem a PRÓPRIA janela: a captura de uma não espera a outra.
          win = createRenderWindow(width, height, alpha)
          windows.push(win)
          await loadComposition(win, url)
          win.setContentSize(width, height)
          await win.webContents.executeJavaScript(`window.orbitMotion.fps = ${fps}`, true)
        }
        const name = `band_${String(index).padStart(3, '0')}${path.extname(opts.output) || '.mp4'}`
        segments[index] = name
        await renderBand({
          win,
          start: band.start,
          end: band.end,
          total,
          target: work ? path.join(work, name) : videoOut,
          width,
          height,
          fps,
          format,
          captureWidth: probe.width,
          captureHeight: probe.height,
          probe: index === 0 ? probe : undefined,
          counters,
          onProgress: opts.onProgress,
          signal: opts.signal,
        })
      }),
    )

    if (work) {
      // Concatenação sem segunda perda (`-c copy`), como o render de EDL: os
      // segmentos já saíram com os mesmos parâmetros de encoder.
      await fsp.writeFile(path.join(work, 'list.txt'), concatList(segments))
      await runFfmpeg(concatFfmpegArgs({ listFile: 'list.txt', output: path.resolve(videoOut), format }), {
        cwd: work,
        signal: opts.signal,
      })
    }

    // Áudio: passada FINAL, com o vídeo NÃO re-encodado (`-c:v copy`). O
    // comprimento é o da composição — a faixa que passa do fim é cortada nele, e a
    // que acaba antes deixa o resto para as outras. O que não couber vira AVISO (é
    // o que se lê para saber se a voz coube na peça), nunca erro.
    if (tracks.length > 0) {
      // Cada faixa é medida antes de misturar: só com o número na mão dá para
      // DIZER que uma passou do fim (e foi cortada) ou que acabou antes (e deixou
      // silêncio) — que é o que o agente precisa ler no resultado.
      for (const track of tracks) {
        const probed = await probeMedia(track.file).catch(() => null)
        const secs = probed ? probed.durationMs / 1000 : 0
        if (secs <= 0) continue
        const endsAt = track.end ?? track.start + secs
        if (endsAt > duration + 0.05) {
          warnings.push(
            `audio "${track.name}" ends at ${endsAt.toFixed(2)}s and the piece is ${duration.toFixed(2)}s — it was cut at the end`,
          )
        } else if (track.end === undefined && endsAt < duration - 0.05) {
          warnings.push(
            `audio "${track.name}" ends at ${endsAt.toFixed(2)}s and the piece is ${duration.toFixed(2)}s — the last ${(duration - endsAt).toFixed(2)}s are silent`,
          )
        }
      }
      // O caso simples (uma faixa, a peça inteira, sem processamento) tem caminho
      // próprio: um `-i` a mais, sem grafo de filtros. O grafo só se paga quando
      // há o que misturar.
      const only = tracks.length === 1 ? tracks[0] : null
      const args =
        only && isPlainAudioMix(tracks, master)
          ? motionAudioFfmpegArgs({
              video: videoOut,
              audio: only.file,
              output: path.resolve(opts.output),
              duration,
              format,
            })
          : motionAudioMixFfmpegArgs({
              video: videoOut,
              output: path.resolve(opts.output),
              duration,
              format,
              events: tracks,
              master,
            })
      await runFfmpeg(args, { signal: opts.signal })
    }

    const metrics: MotionMetrics = {
      frames: total,
      totalMs: ms(performance.now() - startedAt),
      seekPaint: ms(counters.seekPaint / total),
      capture: ms(counters.capture / total),
      encodeWrite: ms(counters.encodeWrite / total),
      msPerFrame: ms((counters.seekPaint + counters.capture + counters.encodeWrite) / total),
    }
    return { output: opts.output, width, height, fps, duration, frames: total, metrics, warnings }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    for (const win of windows) if (!win.isDestroyed()) win.destroy()
    if (work) await fsp.rm(work, { recursive: true, force: true }).catch(() => {})
    // Só libera o que ESTE render registrou: o id do IPC é de quem pediu.
    if (registeredId) await registry.unregisterMotion(registeredId).catch(() => {})
  }
}