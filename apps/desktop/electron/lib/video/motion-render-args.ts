import path from 'node:path'
import {
  DEFAULT_DUCK,
  automationFilter,
  duckFilter,
  hasMasterFx,
  hasTrackFx,
  masterFilters,
  toneFilters,
  type DuckSettings,
  type MasterFx,
  type TrackFx,
} from './motion-audio-fx'

/**
 * A parte PURA do render de motion: os argumentos do ffmpeg, a desmultiplicação
 * do alfa e a divisão do trabalho em faixas. Fica separada de motion.ts (que abre
 * janela, captura e conversa com o Electron) para poder ser testada sem nenhuma
 * janela — é onde moram as decisões que, erradas, só apareceriam num vídeo torto.
 *
 * O caminho de pixels mudou de PNG para rawvideo (o bitmap BGRA cru que o
 * nativeImage já tem): um PNG por quadro custava um encode no Chromium e um
 * decode no ffmpeg, por quadro. Em troca, o rawvideo impõe duas regras:
 *
 *  1. o tamanho do quadro tem que ser CONSTANTE — daí a sondagem de um quadro
 *     em motion.ts antes de subir o ffmpeg (a captura pode vir na escala da
 *     tela, HiDPI) e a conferência de bytes por quadro;
 *  2. o alfa do Chromium é PRÉ-MULTIPLICADO e tem que virar cor reta ANTES da
 *     conversão de formato — depois de virar yuva444p10le/yuva420p não dá mais
 *     para recuperar. Quem faz isso é `unpremultiplyBgra`, aqui embaixo (e não um
 *     filtro do ffmpeg: ver a nota na função).
 */

/** Formatos de saída. `-alpha` = o contêiner leva alfa de verdade. */
export type MotionFormat = 'mp4' | 'webm' | 'mov-alpha' | 'webm-alpha'

/**
 * Nome que o IPC `motion:render` aceita. Contrato congelado com a aba do painel
 * (ver src/lib/ipc.ts): `mp4`, `mov-alpha` e `webm-alpha`. Os nomes antigos
 * (`mov`, `webm`) continuam sendo aceitos por normalizeMotionFormat.
 */
export type MotionFormatInput = MotionFormat | 'mov'

/** Teto de faixas paralelas: mais que isso não acelera e multiplica janelas. */
export const MAX_MOTION_BANDS = 4

/** Extensão do arquivo de saída de cada formato. */
export function motionFormatExt(format: MotionFormat): string {
  if (format === 'mov-alpha') return '.mov'
  if (format === 'webm' || format === 'webm-alpha') return '.webm'
  return '.mp4'
}

/** O contêiner leva alfa? (só ProRes 4444 e VP9 com alfa). */
export function isAlphaFormat(format: MotionFormat): boolean {
  return format === 'mov-alpha' || format === 'webm-alpha'
}

/** Formato de pixel com alfa do encoder (null quando não há alfa). */
export function alphaPixelFormat(format: MotionFormat): string | null {
  if (format === 'mov-alpha') return 'yuva444p10le'
  if (format === 'webm-alpha') return 'yuva420p'
  return null
}

/**
 * Formato a partir do NOME do arquivo de saída e da transparência — o caminho da
 * tool `motion_render`, que só recebe `output` + `transparent`. Puro.
 * `.mov` sem transparência continua saindo em H.264, como antes.
 */
export function motionFormatFor(output: string, transparent: boolean): MotionFormat {
  const ext = path.extname(output).toLowerCase()
  if (transparent) {
    if (ext === '.mov') return 'mov-alpha'
    if (ext === '.webm') return 'webm-alpha'
    throw new Error('transparent output needs a .mov (ProRes 4444) or .webm (VP9) file name')
  }
  return ext === '.webm' ? 'webm' : 'mp4'
}

/**
 * Normaliza o `format` que chega por fora (IPC, aba). Sem formato, mp4. Os nomes
 * antigos seguem valendo: `mov` sempre foi ProRes 4444 (com alfa) e `webm` sem
 * transparência era VP9 sem alfa.
 */
export function normalizeMotionFormat(raw: string | undefined, transparent = false): MotionFormat {
  switch (raw) {
    case undefined:
    case '':
    case 'mp4':
      return 'mp4'
    case 'mov':
    case 'mov-alpha':
      return 'mov-alpha'
    case 'webm':
      return transparent ? 'webm-alpha' : 'webm'
    case 'webm-alpha':
      return 'webm-alpha'
    default:
      throw new Error(`unsupported motion format: ${raw}`)
  }
}

/** Argumentos do encoder por formato (os mesmos parâmetros de antes do rawvideo). */
export function motionEncoderArgs(format: MotionFormat): string[] {
  if (format === 'mov-alpha') return ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le']
  if (format === 'webm-alpha') {
    return ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '28', '-row-mt', '1']
  }
  if (format === 'webm') return ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', '30', '-row-mt', '1']
  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
}

/**
 * Entrada rawvideo: um quadro BGRA por leitura do stdin, sem cabeçalho. O `-s`
 * é obrigatório e é o que obriga o tamanho do quadro a ser constante.
 */
export function rawVideoInputArgs(width: number, height: number, fps: number): string[] {
  return ['-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0']
}

export interface RawVideoFilterOptions {
  /** Tamanho FINAL do vídeo — o mesmo de antes do rawvideo. */
  width: number
  height: number
  /** Tamanho do quadro que a janela devolve (pode vir na escala da tela). */
  captureWidth: number
  captureHeight: number
  format: MotionFormat
}

/**
 * Filtros do quadro cru, na ordem que importa:
 *
 *  1. `scale` só quando a captura vem maior (HiDPI) — o vídeo tem que sair no
 *     mesmo tamanho de antes;
 *  2. `format=` no modo transparente, para o alfa chegar inteiro ao encoder.
 *
 * Não há filtro de desmultiplicação: ela já aconteceu em `unpremultiplyBgra`,
 * sobre o buffer, ANTES desta conversão de formato (ver a nota na função).
 */
export function rawVideoFilters(o: RawVideoFilterOptions): string[] {
  const filters: string[] = []
  if (o.captureWidth !== o.width || o.captureHeight !== o.height) {
    filters.push(`scale=${o.width}:${o.height}:flags=lanczos`)
  }
  if (isAlphaFormat(o.format)) {
    const pix = alphaPixelFormat(o.format)
    if (pix) filters.push(`format=${pix}`)
  }
  return filters
}

export interface MotionFfmpegSpec extends RawVideoFilterOptions {
  fps: number
  output: string
}

/**
 * Argumentos COMPLETOS do ffmpeg de um segmento (uma faixa): o stdin é o
 * rawvideo e a saída já sai no encoder final. Puro — é o que os testes travam.
 */
export function motionFfmpegArgs(spec: MotionFfmpegSpec): string[] {
  const filters = rawVideoFilters(spec)
  return [
    '-v', 'error',
    ...rawVideoInputArgs(spec.captureWidth, spec.captureHeight, spec.fps),
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    ...motionEncoderArgs(spec.format),
    '-r', String(spec.fps),
    spec.output,
  ]
}

/** Bytes de um quadro BGRA — o tamanho CONSTANTE que o rawvideo exige. */
export function expectedFrameBytes(width: number, height: number): number {
  return width * height * 4
}

/**
 * O rawvideo não tem cabeçalho de tamanho: um quadro com bytes a mais ou a menos
 * desalinha todo o resto do stream e o vídeo sai como lixo colorido, sem erro
 * nenhum. Por isso o render confere TODO quadro e para aqui, com o tamanho que
 * veio e o que era esperado.
 */
export function assertFrameBytes(bufferLength: number, width: number, height: number, frame: number): void {
  const expected = expectedFrameBytes(width, height)
  if (bufferLength === expected) return
  throw new Error(
    `motion: frame ${frame} came with ${bufferLength} bytes, expected ${width}x${height}x4 = ${expected} ` +
      '(the capture changed size mid-render — rawvideo needs a constant frame size)',
  )
}

/** `255 * 256 / alfa`, arredondado: dividir por pixel vira multiplicar e deslocar. */
const UNPREMULTIPLY = (() => {
  const table = new Uint16Array(256)
  for (let alpha = 1; alpha < 256; alpha++) table[alpha] = Math.round((255 * 256) / alpha)
  return table
})()

/** valor * 255 / alfa, arredondado e preso em 255 (cor maior que o alfa sairia do byte). */
function straight(value: number, factor: number): number {
  // +128 antes do deslocamento é o arredondamento para o inteiro mais próximo.
  const scaled = (value * factor + 128) >> 8
  return scaled > 255 ? 255 : scaled
}

/**
 * Desmultiplica o alfa NO LUGAR: BGRA pré-multiplicado (o que o `toBitmap` do
 * Chromium entrega) vira cor reta, que é o que o encoder espera.
 *
 * Por que aqui e não num filtro do ffmpeg: o `unpremultiply` do build que o app
 * leva junto (ffmpeg 9.0.2) não dá conta disto. Ele tem DUAS entradas ("UnPre
 * Multiply first stream with first plane of second stream") e com `-vf
 * unpremultiply` o ffmpeg recusa o grafo — "Simple filtergraph '(null)' was
 * expected to have exactly 1 input and 1 output. However, it had 2 input(s)".
 * A variante de uma entrada (`unpremultiply=inplace=1`) roda, mas não muda nada
 * (medido com (100,50,25,128): sai (99,50,26,129), o mesmo quadro), e o grafo de
 * duas entradas com `alphaextract` devolve a imagem em CINZA. Fazer a conta aqui
 * é determinístico, não depende da build do ffmpeg e acontece antes da conversão
 * de formato — que é o que importa, porque depois de virar yuva444p10le/yuva420p
 * o alfa já não é recuperável.
 *
 * Custo: só nos pixels SEMI-transparentes (opacos e vazios saem na hora) e só no
 * caminho com alfa — o caminho opaco tem fundo preto sólido e chega com alfa 255.
 */
export function unpremultiplyBgra(buffer: Buffer): void {
  for (let i = 0; i + 3 < buffer.length; i += 4) {
    const alpha = buffer[i + 3]
    if (alpha === 255 || alpha === 0) continue
    const factor = UNPREMULTIPLY[alpha]
    buffer[i] = straight(buffer[i], factor)
    buffer[i + 1] = straight(buffer[i + 1], factor)
    buffer[i + 2] = straight(buffer[i + 2], factor)
  }
}

/**
 * Quantas faixas paralelas: `bands` explícito quando vem (1 = o caminho
 * sequencial, determinístico), senão min(4, max(1, núcleos/2)).
 */
export function bandCount(requested: number | undefined, cores: number): number {
  if (requested !== undefined && Number.isFinite(requested)) {
    return Math.min(MAX_MOTION_BANDS, Math.max(1, Math.floor(requested)))
  }
  const auto = Number.isFinite(cores) ? Math.floor(cores / 2) : 1
  return Math.min(MAX_MOTION_BANDS, Math.max(1, auto))
}

/**
 * Divide [0, total) em faixas contíguas e equilibradas, na ordem — `[start, end)`,
 * em QUADROS inteiros: cada faixa busca só os quadros dela (nada é buscado duas
 * vezes) e a concatenação sai na ordem certa. Nunca devolve faixa vazia.
 */
export function splitBands(total: number, bands: number): Array<{ start: number; end: number }> {
  const frames = Math.max(1, Math.floor(total))
  const count = Math.min(Math.max(1, Math.floor(bands)), frames)
  const out: Array<{ start: number; end: number }> = []
  let start = 0
  for (let i = 0; i < count; i++) {
    const size = Math.floor(frames / count) + (i < frames % count ? 1 : 0)
    out.push({ start, end: start + size })
    start += size
  }
  return out
}

export interface ConcatSpec {
  /** Lista do concat demuxer (nomes relativos ao cwd do ffmpeg). */
  listFile: string
  output: string
  format: MotionFormat
}

/** Conteúdo do `list.txt` do concat demuxer: um `file '...'` por segmento. */
export function concatList(names: string[]): string {
  return names.map((name) => `file '${name}'`).join('\n')
}

/**
 * Junta os segmentos das faixas SEM segunda perda (`-c copy`), como o render de
 * EDL. Os segmentos já saíram no encoder final, então aqui é só remux — o
 * `+faststart` volta para o mp4.
 *
 * Não promete saída byte-idêntica à do caminho sequencial: cada faixa começa o
 * próprio GOP, então os keyframes caem em pontos diferentes.
 */
export function concatFfmpegArgs(spec: ConcatSpec): string[] {
  return [
    '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', spec.listFile,
    '-c', 'copy',
    ...(spec.format === 'mp4' ? ['-movflags', '+faststart'] : []),
    spec.output,
  ]
}

// -------------------------------------------------------------------- áudio

/**
 * Áudio da peça. O capture pega QUADROS, não som (a janela é offscreen e o
 * ffmpeg recebe rawvideo no stdin), então a trilha entra numa passada final,
 * depois do vídeo montado — sem re-encodar imagem (`-c:v copy`).
 *
 * Sem caminho explícito, vale o nome convencional dentro da pasta da composição:
 * áudio, como as imagens e as fontes, é conteúdo da peça e mora junto dela.
 */
export const MOTION_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac']

/** É áudio pelo nome do arquivo? Puro. */
export function isMotionAudioFile(file: string): boolean {
  return MOTION_AUDIO_EXTENSIONS.includes(path.extname(file).toLowerCase())
}

/**
 * Codec do áudio pelo CONTÊINER — não é escolha estética: é o que cada um
 * aceita. aac no mp4/mov (ProRes 4444 inclusive), Opus no webm.
 */
export function motionAudioCodec(format: MotionFormat): string[] {
  if (format === 'webm' || format === 'webm-alpha') return ['-c:a', 'libopus', '-b:a', '128k']
  return ['-c:a', 'aac', '-b:a', '192k']
}

export interface MotionAudioSpec {
  /** Vídeo JÁ montado (o segmento único, ou a concatenação das faixas). */
  video: string
  audio: string
  output: string
  /** Duração da composição, em segundos: é ela que manda no comprimento. */
  duration: number
  format: MotionFormat
}

/**
 * Passada final: junta o áudio ao vídeo e SÓ ela escreve o arquivo pedido. A
 * imagem não é tocada (`-c:v copy`), só o som é codificado.
 *
 * O `-t` fixa o comprimento na duração da peça, e é a decisão que importa:
 *  - áudio mais LONGO que a peça é cortado no fim dela (nunca estica o vídeo);
 *  - áudio mais CURTO deixa a cauda em silêncio;
 *  - `-shortest`, que é o reflexo comum, faria o contrário do primeiro caso:
 *    um áudio curto encurtaria o VÍDEO, e a peça terminaria antes do desenho.
 * O `-t` nunca come o último quadro: o último pacote está em `(total-1)/fps`,
 * sempre mais de um quadro antes da duração declarada.
 */
export function motionAudioFfmpegArgs(spec: MotionAudioSpec): string[] {
  return [
    '-v', 'error',
    '-i', spec.video,
    '-i', spec.audio,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    ...motionAudioCodec(spec.format),
    '-t', spec.duration.toFixed(3),
    ...(spec.format === 'mp4' ? ['-movflags', '+faststart'] : []),
    spec.output,
  ]
}

/** Uma faixa já resolvida, pronta para virar filtro (caminhos absolutos). */
export interface MotionAudioEvent {
  file: string
  /** Segundo da peça em que entra. */
  start: number
  /** Segundo em que sai; ausente = até o fim do arquivo. */
  end?: number
  gainDb: number
  fadeIn: number
  fadeOut: number
  /** Cama que abaixa sob as outras faixas. */
  duck: boolean
  /** Como ela abaixa; ausente = os números de sempre (DEFAULT_DUCK). */
  duckSettings?: DuckSettings
  /** Timbre, dinâmica e curva de volume; ausente = faixa como está. */
  fx?: TrackFx
}

export interface MotionAudioMixSpec {
  /** Vídeo JÁ montado (o segmento único, ou a concatenação das faixas). */
  video: string
  output: string
  duration: number
  format: MotionFormat
  events: MotionAudioEvent[]
  /** Acabamento da mixagem inteira (teto de pico, volume de entrega). */
  master?: MasterFx | null
}

/**
 * O caso simples — uma faixa, a peça inteira, sem processamento — tem caminho
 * próprio (`motionAudioFfmpegArgs`): um `-i` a mais, sem grafo de filtros. Vale
 * manter os dois porque o grafo só se paga quando há o que misturar.
 */
export function isPlainAudioEvent(event: MotionAudioEvent): boolean {
  return (
    event.start === 0 &&
    event.end === undefined &&
    event.gainDb === 0 &&
    event.fadeIn === 0 &&
    event.fadeOut === 0 &&
    !event.duck &&
    !hasTrackFx(event.fx)
  )
}

/**
 * O caminho simples só serve quando NADA mexe no som: nem a faixa (isPlainAudioEvent),
 * nem o acabamento da mixagem. Um teto de pico numa faixa única ainda precisa do grafo.
 */
export function isPlainAudioMix(events: MotionAudioEvent[], master?: MasterFx | null): boolean {
  return events.length === 1 && isPlainAudioEvent(events[0]) && !hasMasterFx(master)
}

/**
 * A passada final quando há MIXAGEM: cada faixa é recortada, ganha nível e rampas,
 * é posta no instante dela (`adelay`) e as camas (`duck: true`) abaixam sozinhas
 * sob as faixas de frente (`sidechaincompress`) antes da soma.
 *
 * Dois detalhes que decidem o resultado:
 *
 *  - `normalize=0` no `amix` é obrigatório. Por padrão o `amix` DIVIDE pelo número
 *    de entradas, e a narração sairia mais baixa só porque existe música — o nível
 *    que o manifest pede é o nível que sai;
 *  - `duration` do `amix` fica no padrão (`longest`), e NÃO no `duration=first` do
 *    render de EDL: lá a voz é a primeira entrada e manda no comprimento, aqui a
 *    primeira faixa pode ser um efeito de meio segundo, e o mix não pode acabar
 *    com ele. Quem manda no comprimento continua sendo o `-t` da peça.
 *
 * O gatilho do duck é a soma das faixas de frente: a cama abaixa quando QUALQUER
 * voz ou efeito está tocando, que é o que se espera de "música de fundo".
 */
export function motionAudioMixFfmpegArgs(spec: MotionAudioMixSpec): string[] {
  const graph: string[] = []
  const labels = spec.events.map((event, index) => {
    const out = `t${index}`
    const chain: string[] = []
    // Comprimento do trecho na linha do tempo da PRÓPRIA faixa: com `end`, é o
    // recorte; sem ele, o que resta da peça depois do `start` — é onde a rampa de
    // saída tem que começar.
    const length = event.end === undefined ? spec.duration - event.start : event.end - event.start
    if (event.end !== undefined) chain.push(`atrim=end=${Math.max(0, length).toFixed(3)}`)
    // Timbre e dinâmica antes do nível: o compressor reage ao sinal como a faixa
    // é, e o ganho (e as rampas) vêm por cima do resultado.
    if (event.fx) chain.push(...toneFilters(event.fx))
    if (event.gainDb !== 0) chain.push(`volume=${event.gainDb.toFixed(2)}dB`)
    if (event.fadeIn > 0) chain.push(`afade=in:st=0:d=${event.fadeIn.toFixed(3)}`)
    if (event.fadeOut > 0) {
      chain.push(`afade=out:st=${Math.max(0, length - event.fadeOut).toFixed(3)}:d=${event.fadeOut.toFixed(3)}`)
    }
    // `all=1` cobre mono e estéreo sem precisar saber quantos canais o arquivo tem.
    if (event.start > 0) chain.push(`adelay=${Math.round(event.start * 1000)}:all=1`)
    // A curva de volume depois do atraso: ali o `t` do filtro já é o tempo da
    // PEÇA, que é a régua em que o manifest escreve os pontos.
    const curve = event.fx ? automationFilter(event.fx.automation) : null
    if (curve) chain.push(curve)
    // Cadeia vazia (faixa crua: nada a recortar, nenhum nível, nenhuma rampa)
    // precisa de um filtro mesmo assim — `[1:a][t0]` sem filtro entre os rótulos é
    // grafo inválido, e o ffmpeg responde "No such filter: ''". `anull` é a
    // passagem direta.
    graph.push(`[${index + 1}:a]${(chain.length ? chain : ['anull']).join(',')}[${out}]`)
    return out
  })

  const front = spec.events.flatMap((event, index) => (event.duck ? [] : [labels[index]]))
  const bed = spec.events.flatMap((event, index) => (event.duck ? [labels[index]] : []))
  const sum = (inputs: string[], out: string): void => {
    graph.push(`[${inputs.join('][')}]amix=inputs=${inputs.length}:normalize=0:dropout_transition=0[${out}]`)
  }

  let output = labels[0]
  if (labels.length === 1) {
    // Uma faixa só: a cadeia dela já é a saída, não há o que somar.
  } else if (front.length === 0 || bed.length === 0) {
    // Sem as duas famílias não há duck a fazer: é a soma de todas.
    output = 'mix'
    sum(labels, output)
  } else {
    // A frente aciona o duck: uma cópia dela vai para a soma, outra para o gatilho.
    // Mesma montagem e mesmos parâmetros do render de EDL (render.ts:246).
    sum(front, 'front')
    graph.push('[front]asplit=2[frontmix][frontsc]')
    sum(bed, 'bed')
    // Os números do duck vêm da primeira cama que os personalizou (todas as camas
    // são somadas ANTES de passar pelo gatilho, então há um duck só).
    const settings = spec.events.find((event) => event.duck && event.duckSettings)?.duckSettings ?? DEFAULT_DUCK
    graph.push(`[bed][frontsc]${duckFilter(settings)}[bedducked]`)
    output = 'mix'
    sum(['bedducked', 'frontmix'], output)
  }

  const finish = masterFilters(spec.master)
  if (finish.length > 0) {
    graph.push(`[${output}]${finish.join(',')}[master]`)
    output = 'master'
  }

  return [
    '-v', 'error',
    '-i', spec.video,
    ...spec.events.flatMap((event) => ['-i', event.file]),
    '-filter_complex', graph.join(';'),
    '-map', '0:v:0',
    '-map', `[${output}]`,
    '-c:v', 'copy',
    ...motionAudioCodec(spec.format),
    '-t', spec.duration.toFixed(3),
    ...(spec.format === 'mp4' ? ['-movflags', '+faststart'] : []),
    spec.output,
  ]
}
