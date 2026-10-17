import { BrowserWindow } from 'electron'
import { MOTION_SPEC } from './motion-runtime'
import type { MotionTransitionInfo } from './motion-transitions'

/**
 * As CAMADAS de uma composição de motion: quem entra e sai de cena, e quando.
 *
 * É o que a aba Motion desenha embaixo da régua (uma faixa por camada, do quadro
 * em que ela aparece ao quadro em que some) e o que o motion_preview conta ao
 * agente. Não existe declaração de camadas no contrato — a composição é HTML
 * livre —, então elas são MEDIDAS: o runtime varre os quadros numa janela
 * offscreen e diz, por elemento, quando ele está visível (`__orbitMotionLayers`).
 *
 * Daquele retrato cru, `pickLayers` (puro) escolhe o que vira camada:
 *   - todo elemento com `data-layer` (o nome que a composição deu) entra, mesmo
 *     que fique em cena o tempo todo — foi nomeado para ser citado;
 *   - um elemento sem nome entra só se ENTRA OU SAI de cena (um contêiner que
 *     está sempre lá não diz nada) e só o mais externo deles: as palavras de
 *     uma frase que aparece inteira não viram dez faixas.
 */

export type FrameSpan = [number, number]

/** Que tipo de coisa a camada é (medido no DOM pelo runtime, não declarado). */
export type LayerKind = 'text' | 'image' | 'video' | 'audio' | 'other'

/** O que o runtime devolve por elemento (ordem do documento). */
export interface RawLayer {
  name: string
  named: boolean
  /** Índice do elemento-pai entre os candidatos (-1 = filho do body). */
  parent: number
  spans: FrameSpan[]
  /** Posição na caminhada da página — o endereço do elemento para o realce. */
  index?: number
  kind?: LayerKind
}

export interface MotionLayer {
  name: string
  /** Veio de `data-layer` (nome dado pela composição) ou foi deduzido. */
  named: boolean
  /** Intervalos visíveis, em quadros inteiros, inclusivos. */
  spans: FrameSpan[]
  /**
   * Índice na caminhada da página. O rótulo NÃO identifica um elemento (dois
   * podem se chamar ".caption"), então é por aqui que o preview reencontra o
   * elemento para contorná-lo quando a camada é selecionada na aba.
   */
  index: number
  kind: LayerKind
}

export interface MotionLayers {
  width: number
  height: number
  fps: number
  durationInFrames: number
  layers: MotionLayer[]
  failedFonts: string[]
  /** As transições que a composição registrou (orbitMotion.transition). */
  transitions: MotionTransitionInfo[]
}

/** Teto de faixas: além disso a aba vira ruído (e o texto ao agente também). */
export const MAX_LAYERS = 40

/** Junta intervalos separados por buracos de até `gap` quadros (piscadas de medição). */
export function mergeSpans(spans: FrameSpan[], gap = 1): FrameSpan[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  const out: FrameSpan[] = []
  for (const [start, end] of sorted) {
    const prev = out[out.length - 1]
    if (prev && start - prev[1] <= gap + 1) prev[1] = Math.max(prev[1], end)
    else out.push([start, end])
  }
  return out
}

function sameSpans(a: FrameSpan[], b: FrameSpan[]): boolean {
  return a.length === b.length && a.every((s, i) => s[0] === b[i][0] && s[1] === b[i][1])
}

/** Visível do primeiro ao último quadro, sem interrupção. */
function always(spans: FrameSpan[], total: number): boolean {
  return spans.length === 1 && spans[0][0] <= 0 && spans[0][1] >= total - 1
}

/** Escolhe as camadas a partir do retrato cru do runtime. Puro. */
export function pickLayers(raw: RawLayer[], durationInFrames: number, max = MAX_LAYERS): MotionLayer[] {
  const spans = raw.map((r) => mergeSpans(r.spans))
  const kept = new Array<boolean>(raw.length).fill(false)
  /** O ancestral mais próximo que virou camada (ou -1). */
  const keptAncestor = (index: number): number => {
    let p = raw[index].parent
    while (p >= 0) {
      if (kept[p]) return p
      p = raw[p].parent
    }
    return -1
  }
  const out: MotionLayer[] = []
  /**
   * O endereço do elemento: por onde o preview o reencontra para contorná-lo, e
   * o que ele é. O runtime manda os dois campos e a posição na lista é o mesmo
   * número — os defaults existem para um retrato cru montado à mão (teste) não
   * precisar repeti-los.
   */
  const address = (item: RawLayer, i: number): { index: number; kind: LayerKind } => ({
    index: item.index ?? i,
    kind: item.kind ?? 'other',
  })
  raw.forEach((item, i) => {
    if (spans[i].length === 0) return
    const ancestor = keptAncestor(i)
    if (item.named) {
      kept[i] = true
      out.push({ name: item.name, named: true, spans: spans[i], ...address(item, i) })
      return
    }
    // Sem nome: só quem entra/sai, e só o mais externo. Dentro de uma camada já
    // mostrada que ENTRA E SAI (uma frase), os filhos são partes dela — as
    // palavras de uma frase não viram dez faixas. Dentro de um contêiner nomeado
    // que fica o tempo todo (o "stage"), os filhos são o conteúdo e entram.
    if (always(spans[i], durationInFrames)) return
    if (ancestor >= 0) {
      const parent = raw[ancestor]
      if (!parent.named || !always(spans[ancestor], durationInFrames) || sameSpans(spans[ancestor], spans[i])) return
    }
    kept[i] = true
    out.push({ name: item.name, named: false, spans: spans[i], ...address(item, i) })
  })
  return out.slice(0, max)
}

/** "0:01.20" a partir de um quadro — o vocabulário do texto para o agente. */
function clock(frame: number, fps: number): string {
  const s = frame / fps
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`
}

/**
 * Resumo das camadas para o agente (uma linha por camada, com entrada e saída).
 * Só o tempo interessa aqui — o tipo e o endereço são para a aba, não para o
 * texto que o agente lê.
 */
export function describeLayers(layers: Array<Pick<MotionLayer, 'name' | 'named' | 'spans'>>, fps: number): string {
  if (!layers.length) return 'No element enters or leaves the frame (and none has data-layer).'
  return layers
    .map((l) => {
      const spans = l.spans.map(([a, b]) => `${clock(a, fps)}–${clock(b + 1, fps)} (f${a}–f${b})`).join(', ')
      return `- ${l.named ? l.name : `"${l.name}"`}: ${spans}`
    })
    .join('\n')
}

// ------------------------------------------------------------------ medição

const LOAD_TIMEOUT_MS = 20_000

/** Uma medição por composição de cada vez: um save em rajada não abre N janelas. */
const inflight = new Map<string, Promise<MotionLayers>>()

/**
 * Carrega a composição numa janela offscreen pelo MESMO scheme do preview e
 * mede as camadas. Também é o teste de "abre?" do motion_preview: se a página
 * não carrega, o erro sai daqui com o motivo, em vez de a aba ficar girando.
 */
export function measureMotionLayers(id: string, url: string): Promise<MotionLayers> {
  const running = inflight.get(id)
  if (running) return running
  const job = runMeasure(url).finally(() => inflight.delete(id))
  inflight.set(id, job)
  return job
}

async function runMeasure(url: string): Promise<MotionLayers> {
  const win = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    useContentSize: true,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  let pageError: string | null = null
  win.webContents.on('console-message', (event) => {
    const e = event as unknown as { level?: string | number; message?: string }
    if ((e.level === 'error' || e.level === 3) && !pageError && e.message) pageError = e.message
  })
  const timer = setTimeout(() => {
    if (!win.isDestroyed()) win.destroy()
  }, LOAD_TIMEOUT_MS)
  try {
    await win.loadURL(url)
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true)
    const spec = (await win.webContents.executeJavaScript(MOTION_SPEC, true)) as {
      width?: number
      height?: number
      fps?: number
      durationInFrames?: number
      failedFonts?: string[]
      transitions?: MotionTransitionInfo[]
    } | null
    if (!spec) {
      const body = String(await win.webContents.executeJavaScript('document.body ? document.body.innerText.slice(0, 120) : ""', true))
      throw new Error(`the composition did not load${body ? `: ${body.trim()}` : ''}${pageError ? ` (${pageError})` : ''}`)
    }
    if (!spec.durationInFrames) {
      throw new Error(
        `unknown duration: declare <meta name="orbit-motion" content="duration=…"> or window.orbitMotion.durationInFrames${pageError ? ` (page error: ${pageError})` : ''}`,
      )
    }
    const width = Math.round(spec.width ?? 1920)
    const height = Math.round(spec.height ?? 1080)
    // O viewport tem que ser o da composição: "entrou em cena" é estar DENTRO dele.
    win.setContentSize(width, height)
    const raw = (await win.webContents.executeJavaScript('window.__orbitMotionLayers(900)', true)) as {
      durationInFrames: number
      layers: RawLayer[]
    }
    return {
      width,
      height,
      fps: spec.fps ?? 30,
      durationInFrames: spec.durationInFrames,
      layers: pickLayers(raw.layers ?? [], spec.durationInFrames),
      failedFonts: spec.failedFonts ?? [],
      transitions: spec.transitions ?? [],
    }
  } catch (err) {
    if (win.isDestroyed()) throw new Error(`the composition did not finish loading in ${LOAD_TIMEOUT_MS / 1000}s`)
    throw err
  } finally {
    clearTimeout(timer)
    if (!win.isDestroyed()) win.destroy()
  }
}
