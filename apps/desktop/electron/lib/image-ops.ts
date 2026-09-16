import sharp from 'sharp'
import type { OverlayOptions, Sharp } from 'sharp'

/**
 * Edição de imagens sem modelo de geração.
 *
 * Tudo aqui é processamento de pixel — redimensionar, recortar, ajustar tom,
 * comprimir, recortar fundo. Nada inventa conteúdo, e é justamente por isso
 * que serve para o trabalho corriqueiro: o resultado é previsível, é rápido, e
 * a foto que entra é a mesma que sai.
 *
 * Módulo puro de bytes (sem Electron, sem IO), para ser testável — mesma
 * separação do pdf-ops.ts.
 */

/** Tetos de sanidade: um pedido errado não pode virar um GB de RAM. */
const MAX_PIXELS = 50_000_000
const MAX_DIMENSION = 20_000

export interface ImageInfo {
  format: string
  width: number
  height: number
  channels: number
  hasAlpha: boolean
  sizeBytes: number
  /**
   * Cor predominante em #rrggbb — palpite de fundo, não medição: o sharp a
   * tira de um histograma binado, então o que volta é o centro do bin e pode
   * diferir alguns pontos da cor que está lá.
   */
  dominant: string
}

export async function imageInfo(source: Buffer): Promise<ImageInfo> {
  const meta = await sharp(source).metadata()
  const stats = await sharp(source).stats()
  return {
    format: meta.format ?? 'desconhecido',
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    channels: meta.channels ?? 0,
    hasAlpha: meta.hasAlpha ?? false,
    sizeBytes: source.length,
    dominant: toHex(stats.dominant),
  }
}

function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const part = (v: number) => Math.round(v).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/** `#rgb`, `#rrggbb` ou `rgb(r,g,b)` → canais. Erro explícito no resto: uma cor
 *  que o modelo escreveu errado não pode virar preto silenciosamente. */
export function parseColor(value: string): { r: number; g: number; b: number } {
  const text = value.trim().toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text)
  if (short) {
    return {
      r: parseInt(short[1] + short[1], 16),
      g: parseInt(short[2] + short[2], 16),
      b: parseInt(short[3] + short[3], 16),
    }
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(text)
  if (long) {
    return { r: parseInt(long[1], 16), g: parseInt(long[2], 16), b: parseInt(long[3], 16) }
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(text)
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) }
  }
  throw new Error(`Cor inválida: "${value}". Use #rrggbb, #rgb ou rgb(r,g,b).`)
}

export interface RemoveBackgroundOptions {
  /** Cor do fundo. Ausente = adivinhada pelas quinas da imagem. */
  color?: string
  /**
   * 0-100, ou 'auto' (padrão): quanto o pixel pode se afastar da cor de fundo e
   * ainda ser fundo. O 'auto' mede o espalhamento da moldura da própria
   * imagem, que é o único lugar onde essa resposta existe.
   */
  tolerance?: number | 'auto'
  /** Tira a cor do fundo que ficou na borda do assunto. Ligado por padrão. */
  despill?: boolean
  /** Raio de suavização da borda recortada, em pixels. 0 = corte duro. */
  feather?: number
}

export interface RemoveBackgroundResult {
  png: Buffer
  /** Cor tratada como fundo — o que o usuário precisa ver quando errou o alvo. */
  color: string
  /** Fração da imagem que virou transparente, 0–1. */
  removed: number
  /** Limiar ΔE usado — o número que o 'auto' escolheu, para quem precisar
   *  repetir o recorte mais apertado ou mais folgado a partir dele. */
  limit: number
}

/**
 * Cor em CIELAB, que é onde a comparação de fundo faz sentido.
 *
 * Em RGB, "distância" mistura brilho com cor. Numa tela verde iluminada isso
 * é fatal: o fundo de uma foto real varia de (100,164,77) na quina a
 * (124,201,115) no meio — uma distância RGB de 56 — enquanto do verde até a
 * pele são 92. A variação DO PRÓPRIO FUNDO ocupa mais da metade do caminho
 * até o assunto, e nenhum limiar separa os dois.
 *
 * Em LAB essa variação é quase toda de luminosidade (L), e a cor (a,b) fica
 * praticamente parada. Medindo com L pesando pouco, a mesma foto dá 4,7-7,5
 * dentro do fundo contra 47,9-60,9 no assunto: sete vezes de margem.
 *
 * É a razão de todo chroma key comparar COR e não BRILHO — o refletor que
 * clareia um canto da tela não a torna menos verde.
 */
const SRGB_TO_LINEAR = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const v = i / 255
  SRGB_TO_LINEAR[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

export function labOf(r: number, g: number, b: number): [number, number, number] {
  const R = SRGB_TO_LINEAR[r]
  const G = SRGB_TO_LINEAR[g]
  const B = SRGB_TO_LINEAR[b]
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/**
 * Peso da luminosidade na distância.
 *
 * Zero seria o chroma key clássico, mas aí preto e branco viram "a mesma cor"
 * de qualquer fundo cinza. Um quarto mantém a diferença de brilho audível sem
 * deixar o gradiente do refletor decidir o recorte.
 */
const LIGHTNESS_WEIGHT = 0.25

/** A escala 0-100 da tolerância, em ΔE. 100 cobre cores completamente
 *  diferentes; a faixa útil de um fundo liso fica entre 10 e 30. */
const TOLERANCE_TO_DELTA_E = 0.6

/**
 * Recorta o fundo por preenchimento a partir das BORDAS.
 *
 * A diferença para um chroma key simples está aí: o chroma key apaga toda cor
 * parecida, onde quer que ela esteja, e abre buracos no meio do assunto — a
 * camisa branca da pessoa some junto com a parede branca. Espalhar a partir da
 * borda só alcança o que está LIGADO ao fundo, então o branco cercado por
 * assunto continua opaco.
 *
 * O que isto faz bem: fundo liso ou quase liso — foto de produto, retrato de
 * estúdio, logotipo, captura de tela. O que não faz: separar cabelo de uma
 * cena movimentada, que é exatamente onde um modelo de segmentação entra. O
 * `removed` devolvido serve para reconhecer o segundo caso sem precisar olhar.
 */
export async function removeBackground(
  source: Buffer,
  options: RemoveBackgroundOptions = {},
): Promise<RemoveBackgroundResult> {
  const { data, info } = await sharp(source)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height } = info
  if (width * height > MAX_PIXELS) {
    throw new Error(
      `Imagem grande demais para recortar o fundo (${width}x${height}). Redimensione antes.`,
    )
  }

  const background = options.color ? parseColor(options.color) : sampleBorder(data, width, height)
  const backgroundLab = labOf(background.r, background.g, background.b)

  // Distância de cada pixel até o fundo, calculada de uma vez. O
  // preenchimento visita o mesmo pixel várias vezes (uma por vizinho), e
  // converter para LAB dentro do laço refaria a mesma raiz cúbica sem motivo.
  const distance = new Float32Array(width * height)
  for (let i = 0; i < distance.length; i++) {
    const at = i * 4
    const [l, a, b] = labOf(data[at], data[at + 1], data[at + 2])
    const dl = l - backgroundLab[0]
    const da = a - backgroundLab[1]
    const db = b - backgroundLab[2]
    distance[i] = Math.sqrt(LIGHTNESS_WEIGHT * dl * dl + da * da + db * db)
  }

  const limit =
    options.tolerance === undefined || options.tolerance === 'auto'
      ? autoLimit(distance, width, height)
      : Math.min(100, Math.max(0, options.tolerance)) * TOLERANCE_TO_DELTA_E

  // Fila explícita, e não recursão: uma imagem de alguns megapixels de fundo
  // liso estouraria a pilha de chamadas na primeira foto de verdade.
  const seen = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let head = 0
  let tail = 0

  const matches = (index: number): boolean => distance[index] <= limit

  const push = (index: number) => {
    if (seen[index]) return
    seen[index] = 1
    if (matches(index)) queue[tail++] = index
  }

  for (let x = 0; x < width; x++) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    push(y * width)
    push(y * width + width - 1)
  }

  let removed = 0
  while (head < tail) {
    const index = queue[head++]
    data[index * 4 + 3] = 0
    removed++
    const x = index % width
    const y = (index / width) | 0
    if (x > 0) push(index - 1)
    if (x < width - 1) push(index + 1)
    if (y > 0) push(index - width)
    if (y < height - 1) push(index + width)
  }

  // Descontamina ANTES de suavizar: o vazamento mora nos pixels que ainda são
  // opacos, e depois do feather parte deles já virou transição.
  if (options.despill !== false) despill(data, width, height, background)

  const feather = Math.min(20, Math.max(0, options.feather ?? 0))
  if (feather > 0) await softenAlpha(data, width, height, feather)

  const png = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer()
  return { png, color: toHex(background), removed: removed / (width * height), limit }
}

/**
 * Cor de fundo pela MOLDURA inteira, não pelas quatro quinas.
 *
 * Quatro pixels são pouca amostra: numa foto em que o assunto encosta na
 * borda, duas quinas já podem cair em cima dele. A moldura inteira dilui isso,
 * e a mediana por canal descarta o que for assunto em vez de fazer média com
 * ele — uma cor que não existe na imagem seria o pior palpite possível.
 */
function sampleBorder(data: Buffer, width: number, height: number) {
  const r: number[] = []
  const g: number[] = []
  const b: number[] = []
  const take = (index: number) => {
    const at = index * 4
    r.push(data[at])
    g.push(data[at + 1])
    b.push(data[at + 2])
  }
  for (let x = 0; x < width; x++) {
    take(x)
    take((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    take(y * width)
    take(y * width + width - 1)
  }
  const median = (values: number[]) => {
    values.sort((a, z) => a - z)
    return values[values.length >> 1]
  }
  return { r: median(r), g: median(g), b: median(b) }
}

/**
 * Tolerância medida na própria imagem, em vez de adivinhada.
 *
 * Quem chama não tem como saber o número certo: ele depende de quão uniforme é
 * o fundo daquela foto. A moldura, por outro lado, é quase toda fundo — então o
 * espalhamento dela É a resposta. Toma-se um percentil alto (não o máximo, que
 * seria o pedaço de assunto encostado na borda) e abre-se uma folga.
 *
 * Errar para o lado apertado é o lado seguro: sobra fundo, que se vê na hora e
 * se corrige repetindo com tolerância maior. Errar para o lado folgado come o
 * assunto, e isso não tem volta.
 */
const AUTO_PERCENTILE = 0.8
const AUTO_MARGIN = 2.5
const AUTO_FLOOR = 8
const AUTO_CEILING = 34

function autoLimit(distance: Float32Array, width: number, height: number): number {
  const border: number[] = []
  for (let x = 0; x < width; x++) {
    border.push(distance[x], distance[(height - 1) * width + x])
  }
  for (let y = 0; y < height; y++) {
    border.push(distance[y * width], distance[y * width + width - 1])
  }
  border.sort((a, b) => a - b)
  const spread = border[Math.floor(border.length * AUTO_PERCENTILE)]
  return Math.min(AUTO_CEILING, Math.max(AUTO_FLOOR, spread * AUTO_MARGIN))
}

/**
 * Tira a cor do fundo que ficou grudada na borda do assunto.
 *
 * Um recorte perfeito ainda deixa halo: os pixels da transição são uma MISTURA
 * de assunto e fundo, então ao lado de uma tela verde o contorno da pessoa fica
 * esverdeado. É o que faz um recorte parecer recortado.
 *
 * A correção é a clássica do chroma key: no canal que domina a cor do fundo, o
 * pixel não pode passar da média dos outros dois. Aplicada SÓ perto do corte —
 * uma gravata verde no meio do peito não é vazamento, e limitar a imagem
 * inteira a apagaria.
 */
const DESPILL_RADIUS = 2

function despill(
  data: Buffer,
  width: number,
  height: number,
  background: { r: number; g: number; b: number },
) {
  const channels = [background.r, background.g, background.b]
  const dominant = channels.indexOf(Math.max(...channels))
  // Fundo cinza ou branco não tem canal dominante de verdade: não há matiz
  // para vazar, e "corrigir" só tiraria cor de quem tem.
  const rival = (Math.max(...channels) - Math.min(...channels)) / 255
  if (rival < 0.08) return

  let ring: number[] = []
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3] === 0) continue
    const x = i % width
    const y = (i / width) | 0
    const touches =
      (x > 0 && data[(i - 1) * 4 + 3] === 0) ||
      (x < width - 1 && data[(i + 1) * 4 + 3] === 0) ||
      (y > 0 && data[(i - width) * 4 + 3] === 0) ||
      (y < height - 1 && data[(i + width) * 4 + 3] === 0)
    if (touches) ring.push(i)
  }

  const treated = new Uint8Array(width * height)
  for (let step = 0; step < DESPILL_RADIUS && ring.length > 0; step++) {
    const next: number[] = []
    for (const i of ring) {
      if (treated[i]) continue
      treated[i] = 1
      const at = i * 4
      const others = [0, 1, 2].filter((c) => c !== dominant)
      const cap = (data[at + others[0]] + data[at + others[1]]) / 2
      if (data[at + dominant] > cap) data[at + dominant] = Math.round(cap)
      const x = i % width
      const y = (i / width) | 0
      if (x > 0) next.push(i - 1)
      if (x < width - 1) next.push(i + 1)
      if (y > 0) next.push(i - width)
      if (y < height - 1) next.push(i + width)
    }
    ring = next.filter((i) => !treated[i] && data[i * 4 + 3] !== 0)
  }
}

/**
 * Borra SÓ o canal alfa, para a borda do recorte não ficar serrilhada.
 *
 * O corte por tolerância é binário: ou o pixel é fundo ou não é. Numa foto,
 * a transição real ocupa um ou dois pixels misturados, e o corte duro deixa
 * neles um contorno da cor do fundo antigo. Suavizar o alfa dissolve esse
 * contorno sem tocar nas cores do assunto.
 */
async function softenAlpha(data: Buffer, width: number, height: number, radius: number) {
  const alpha = Buffer.allocUnsafe(width * height)
  for (let i = 0; i < width * height; i++) alpha[i] = data[i * 4 + 3]
  // O blur sobre um raw de 1 canal DEVOLVE 3. Ler o resultado como se fosse um
  // canal só avança um terço do necessário a cada pixel: o alfa sai comprimido
  // na horizontal e listrado, que foi o artefato de faixas no primeiro recorte
  // que este código produziu. Por isso o passo vem do que o sharp relata, e não
  // do que foi pedido.
  const { data: blurred, info } = await sharp(alpha, { raw: { width, height, channels: 1 } })
    .blur(radius)
    .raw()
    .toBuffer({ resolveWithObject: true })
  const stride = info.channels
  for (let i = 0; i < width * height; i++) data[i * 4 + 3] = blurred[i * stride]
}

/**
 * Texto escrito sobre a imagem.
 *
 * A dificuldade de escrever numa FOTO não é desenhar a letra — é ela continuar
 * legível sobre um fundo que muda de claro para escuro no meio da palavra.
 * Por isso o padrão é branco com contorno escuro, que é o que se lê tanto no
 * céu quanto na sombra, e existe a faixa atrás para quando nem isso basta.
 */
export interface TextOverlay {
  content: string
  /** Onde ancorar. O modelo não sabe as dimensões da foto; isto evita que
   *  precise saber. */
  position?:
    | 'top-left'
    | 'top'
    | 'top-right'
    | 'left'
    | 'center'
    | 'right'
    | 'bottom-left'
    | 'bottom'
    | 'bottom-right'
  /** Posição exata em pixels, quando a âncora não serve. Sobrepõe `position`. */
  x?: number
  y?: number
  /** Altura da fonte em pixels. Ausente = proporcional à imagem, que é o que
   *  mantém a legenda com o mesmo peso num thumbnail e num pôster. */
  size?: number
  color?: string
  /** Contorno. `null` desliga — só faz sentido sobre fundo garantidamente liso. */
  outline?: string | null
  /** Faixa atrás do texto, para foto muito ruidosa. */
  background?: string
  backgroundOpacity?: number
  font?: string
  align?: 'left' | 'center' | 'right'
  /** Largura máxima antes de quebrar a linha. Ausente = 90% da imagem. */
  maxWidth?: number
  opacity?: number
}

export interface ImageEdit {
  resize?: {
    width?: number
    height?: number
    fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'
    /** Deixa crescer além do tamanho original. Por padrão não — ampliar um
     *  arquivo pequeno só produz borrão maior. */
    enlarge?: boolean
    /** Cor de preenchimento quando `contain` sobra espaço. */
    background?: string
  }
  crop?: { left: number; top: number; width: number; height: number }
  /** Corta a moldura de cor uniforme em volta (digitalização, print com barra). */
  trim?: { threshold?: number }
  rotate?: number
  flip?: boolean
  flop?: boolean
  removeBackground?: RemoveBackgroundOptions
  grayscale?: boolean
  negate?: boolean
  /** 1 = neutro. 1.2 clareia 20%, 0.8 escurece 20%. */
  brightness?: number
  /** 1 = neutro, 0 = cinza, >1 satura. */
  saturation?: number
  /** Giro da roda de cores, em graus. */
  hue?: number
  /** 1 = neutro. Aplicado em volta do cinza médio. */
  contrast?: number
  gamma?: number
  /** Estica o histograma para usar toda a faixa — salva foto lavada. */
  normalize?: boolean
  blur?: number
  sharpen?: boolean
  tint?: string
  /** Achata a transparência sobre esta cor (obrigatório ao virar JPEG). */
  flatten?: string
  /** Texto escrito por cima. Aplicado depois do tamanho e da cor: a legenda é
   *  anotação, não faz parte da foto que está sendo ajustada. */
  text?: TextOverlay[]
  format?: 'png' | 'jpeg' | 'webp'
  /** 1–100. Ignorado no PNG, que é sem perdas. */
  quality?: number
  /** Teto de bytes: reduz qualidade e, se preciso, dimensões, até caber. */
  maxBytes?: number
}

export interface EditResult {
  bytes: Buffer
  format: string
  width: number
  height: number
  /** Preenchido quando houve removeBackground — a cor tratada como fundo. */
  backgroundColor?: string
  /** Fração recortada, quando houve removeBackground. */
  backgroundRemoved?: number
  /** Limiar usado no recorte, na escala 0-100 da tolerância. É o ponto de
   *  partida para corrigir: sem ele, ajustar seria adivinhar de novo. */
  backgroundLimit?: number
  /** Passos que o maxBytes precisou dar; vazio quando coube de primeira. */
  compression?: string
}

const DEFAULT_FONT = 'Segoe UI, DejaVu Sans, Liberation Sans, Helvetica, Arial, sans-serif'
/** Altura da fonte como fração do lado menor — mantém o mesmo peso visual numa
 *  miniatura e num pôster. */
const TEXT_SIZE_RATIO = 0.07
const LINE_HEIGHT = 1.22
/** Espessura do contorno em relação à fonte. */
const OUTLINE_RATIO = 0.16

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Largura real de uma linha, renderizando e medindo.
 *
 * Não dá para estimar: no mesmo corpo de 40px, dez "M" ocupam 353px e dez "i"
 * ocupam 93 — quase quatro vezes de diferença. Uma constante média faz a
 * legenda com muitas maiúsculas vazar para fora da foto, que é o erro que
 * ninguém perdoa numa imagem entregue pronta.
 */
async function measureText(text: string, size: number, font: string): Promise<number> {
  if (!text.trim()) return 0
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(
    64,
    Math.ceil(text.length * size),
  )}" height="${Math.ceil(size * 2)}"><text x="0" y="${Math.ceil(
    size * 1.4,
  )}" font-family="${font}" font-size="${size}" fill="#000">${escapeXml(text)}</text></svg>`
  try {
    const { info } = await sharp(Buffer.from(svg))
      .png()
      .trim()
      .toBuffer({ resolveWithObject: true })
    return info.width
  } catch {
    // Nada desenhado (só espaços, ou nenhuma fonte instalada): o trim não acha
    // o que recortar e reclama. Zero é a resposta honesta.
    return 0
  }
}

/**
 * Quebra o texto em linhas que cabem na largura.
 *
 * Mede a frase inteira UMA vez para calibrar a largura média de caractere
 * daquele texto específico, e só então quebra. É o meio-termo entre estimar
 * com uma constante (erra por quatro) e medir cada tentativa (uma renderização
 * por palavra): a mistura de letras de uma legenda é estável ao longo dela,
 * então o valor calibrado nela vale para as suas próprias linhas.
 */
async function wrapText(
  content: string,
  size: number,
  font: string,
  maxWidth: number,
): Promise<string[]> {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (!flat) return []

  const measured = await measureText(flat, size, font)
  const perChar = measured > 0 ? measured / flat.length : size * 0.5
  const limit = Math.max(1, Math.floor(maxWidth / perChar))

  const lines: string[] = []
  for (const paragraph of content.split('\n')) {
    const trimmed = paragraph.replace(/\s+/g, ' ').trim()
    if (!trimmed) {
      // Linha em branco escrita de propósito é espaçamento pedido pelo autor.
      lines.push('')
      continue
    }
    let current = ''
    for (const word of trimmed.split(' ')) {
      const candidate = current ? `${current} ${word}` : word
      if (candidate.length <= limit || !current) current = candidate
      else {
        lines.push(current)
        current = word
      }
    }
    if (current) lines.push(current)
  }
  return lines
}

/**
 * Escreve os textos sobre a imagem.
 *
 * Desenha em SVG e compõe, porque é o que dá contorno de verdade
 * (`paint-order`) — e o contorno é o que faz a legenda sobreviver a uma foto
 * que vai do céu claro à sombra escura dentro da mesma palavra. Escrever em
 * branco puro funciona até a primeira imagem de fundo claro.
 */
async function drawText(image: Buffer, overlays: TextOverlay[]): Promise<Buffer> {
  const meta = await sharp(image).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  if (!width || !height) return image

  const layers: OverlayOptions[] = []

  for (const overlay of overlays) {
    if (!overlay.content?.trim()) continue
    const font = overlay.font ? `${overlay.font}, ${DEFAULT_FONT}` : DEFAULT_FONT
    const size = Math.max(8, Math.round(overlay.size ?? Math.min(width, height) * TEXT_SIZE_RATIO))
    const margin = Math.round(size * 0.6)
    const maxWidth = Math.max(size, Math.min(overlay.maxWidth ?? Math.round(width * 0.9), width - margin * 2))

    const lines = await wrapText(overlay.content, size, font, maxWidth)
    if (lines.length === 0) continue

    // Confere a linha mais longa de verdade e encolhe se ainda assim passou: a
    // calibragem é boa, não é exata, e vazar da foto não é aceitável.
    const widths = await Promise.all(lines.map((line) => measureText(line, size, font)))
    const widest = Math.max(1, ...widths)
    const scale = widest > maxWidth ? maxWidth / widest : 1
    const finalSize = Math.max(8, Math.floor(size * scale))
    const lineHeight = Math.round(finalSize * LINE_HEIGHT)
    const blockWidth = Math.ceil(widest * scale)
    const blockHeight = lineHeight * lines.length

    const position = overlay.position ?? 'bottom'
    const left = position.includes('left')
      ? margin
      : position.includes('right')
        ? width - blockWidth - margin
        : Math.round((width - blockWidth) / 2)
    const top = position.startsWith('top')
      ? margin
      : position.startsWith('bottom')
        ? height - blockHeight - margin
        : Math.round((height - blockHeight) / 2)

    const align =
      overlay.align ??
      (position.includes('left') ? 'left' : position.includes('right') ? 'right' : 'center')
    const textX = align === 'left' ? 0 : align === 'right' ? blockWidth : blockWidth / 2
    const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle'

    const color = overlay.color ?? '#ffffff'
    const outline = overlay.outline === null ? null : (overlay.outline ?? '#000000')
    const strokeWidth = Math.max(1, Math.round(finalSize * OUTLINE_RATIO))
    // O contorno cresce para os DOIS lados da letra, então metade dele fica
    // fora do bloco medido. Sem esta folga a borda sai cortada.
    const pad = strokeWidth + 2

    const band = overlay.background
      ? `<rect x="0" y="0" width="${blockWidth + pad * 2}" height="${
          blockHeight + pad * 2
        }" rx="${Math.round(finalSize * 0.2)}" fill="${overlay.background}" fill-opacity="${
          overlay.backgroundOpacity ?? 0.55
        }"/>`
      : ''

    const rows = lines
      .map((line, i) => {
        const y = pad + Math.round(lineHeight * (i + 0.8))
        const stroke = outline
          ? ` stroke="${outline}" stroke-width="${strokeWidth}" paint-order="stroke fill" stroke-linejoin="round"`
          : ''
        return `<text x="${pad + textX}" y="${y}" text-anchor="${anchor}" font-family="${font}" font-size="${finalSize}" font-weight="600" fill="${color}"${stroke}>${escapeXml(
          line,
        )}</text>`
      })
      .join('')

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${blockWidth + pad * 2}" height="${
      blockHeight + pad * 2
    }">${band}<g opacity="${overlay.opacity ?? 1}">${rows}</g></svg>`

    layers.push({
      input: Buffer.from(svg),
      // Preso dentro da imagem: uma âncora pedida fora dela poria o texto onde
      // ninguém o veria, e o composite recusa deslocamento negativo.
      left: Math.max(0, Math.min(width - 1, (overlay.x ?? left) - pad)),
      top: Math.max(0, Math.min(height - 1, (overlay.y ?? top) - pad)),
    })
  }

  if (layers.length === 0) return image
  return sharp(image).composite(layers).png().toBuffer()
}

/**
 * Aplica as operações pedidas, nesta ordem fixa:
 *
 *   orientação EXIF → recorte → moldura → giro/espelho → fundo → tamanho →
 *   cor → texto → achatamento → codificação
 *
 * A ordem não é arbitrária. A orientação do EXIF vem primeiro porque as
 * coordenadas do recorte são as da imagem como a pessoa a vê, não como os
 * bytes estão guardados. O fundo sai antes de redimensionar porque reduzir
 * primeiro mistura assunto e fundo na borda e estraga o recorte. E a cor vem
 * depois do tamanho só porque é mais barato ajustar menos pixels.
 */
export async function editImage(source: Buffer, edit: ImageEdit): Promise<EditResult> {
  let working = source
  let backgroundColor: string | undefined
  let backgroundRemoved: number | undefined
  let backgroundLimit: number | undefined

  // A etapa de geometria materializa um PNG intermediário para não perder a
  // transparência no caminho. Numa foto de 12MP isso é caro, então ela só roda
  // quando há de fato o que fazer — um simples "reduza esta imagem" não paga.
  const needsGeometry = Boolean(
    edit.crop || edit.trim || edit.rotate || edit.flip || edit.flop,
  )

  if (edit.removeBackground) {
    const cut = await removeBackground(
      needsGeometry ? await applyGeometry(source, edit) : source,
      edit.removeBackground,
    )
    working = cut.png
    backgroundColor = cut.color
    backgroundRemoved = cut.removed
    backgroundLimit = cut.limit / TOLERANCE_TO_DELTA_E
  } else if (needsGeometry) {
    working = await applyGeometry(source, edit)
  }

  let pipeline = sharp(working)
  // Quando nada acima tocou nos pixels, a orientação do EXIF ainda não foi
  // aplicada — e sem ela a foto de celular sai deitada.
  if (!needsGeometry && !edit.removeBackground) pipeline = pipeline.rotate()

  if (edit.resize && (edit.resize.width || edit.resize.height)) {
    const { width, height, fit, enlarge, background } = edit.resize
    if ((width ?? 0) > MAX_DIMENSION || (height ?? 0) > MAX_DIMENSION) {
      throw new Error(`Tamanho pedido acima do limite de ${MAX_DIMENSION}px.`)
    }
    pipeline = pipeline.resize({
      width: width || undefined,
      height: height || undefined,
      fit: fit ?? 'inside',
      withoutEnlargement: !enlarge,
      background: background ? { ...parseColor(background), alpha: 1 } : undefined,
    })
  }

  pipeline = applyColor(pipeline, edit)

  // Texto por último entre os pixels: a legenda é anotação, não faz parte da
  // foto. Escrevê-la antes do resize a deixaria borrada junto com a imagem, e
  // antes do preto e branco a pintaria de cinza junto.
  if (edit.text && edit.text.length > 0) {
    pipeline = sharp(await drawText(await pipeline.toBuffer(), edit.text))
  }

  if (edit.flatten) pipeline = pipeline.flatten({ background: parseColor(edit.flatten) })

  return encode(pipeline, edit, { backgroundColor, backgroundRemoved, backgroundLimit })
}

/** Orientação, recorte, moldura e giro — tudo que mexe na grade de pixels. */
async function applyGeometry(source: Buffer, edit: ImageEdit): Promise<Buffer> {
  let pipeline = sharp(source).rotate()

  if (edit.crop) {
    const { left, top, width, height } = edit.crop
    if (width <= 0 || height <= 0) throw new Error('O recorte precisa de largura e altura positivas.')
    // O extract do sharp recusa um retângulo que passe da borda; o erro dele
    // fala de "bad extract area", que não diz ao modelo o que corrigir.
    const meta = await sharp(source).rotate().metadata()
    const limitX = meta.width ?? 0
    const limitY = meta.height ?? 0
    if (left < 0 || top < 0 || left + width > limitX || top + height > limitY) {
      throw new Error(
        `O recorte (${left},${top} ${width}x${height}) sai da imagem, que tem ${limitX}x${limitY}.`,
      )
    }
    pipeline = pipeline.extract({ left, top, width, height })
  }

  if (edit.trim) pipeline = pipeline.trim({ threshold: edit.trim.threshold ?? 10 })
  if (edit.rotate) pipeline = pipeline.rotate(edit.rotate, { background: '#00000000' })
  if (edit.flip) pipeline = pipeline.flip()
  if (edit.flop) pipeline = pipeline.flop()

  // Materializa em PNG para não perder a transparência entre as etapas.
  return pipeline.png().toBuffer()
}

function applyColor(pipeline: Sharp, edit: ImageEdit): Sharp {
  let out = pipeline
  // As chaves entram uma a uma: o modulate recusa `{ brightness: undefined }`
  // com erro de parâmetro, então pedir só saturação quebraria o ajuste inteiro.
  const modulate: { brightness?: number; saturation?: number; hue?: number } = {}
  if (edit.brightness !== undefined) modulate.brightness = edit.brightness
  // Saturação 0 é o pedido legítimo "tire toda a cor", mas o modulate exige um
  // número acima de zero — quem faz isso no sharp é o grayscale.
  if (edit.saturation !== undefined && edit.saturation > 0) modulate.saturation = edit.saturation
  if (edit.hue !== undefined) modulate.hue = edit.hue
  if (Object.keys(modulate).length > 0) out = out.modulate(modulate)
  if (edit.saturation === 0) out = out.grayscale()
  // linear(a, b) faz saída = a*entrada + b. Para girar em torno do cinza médio
  // (e não do preto, que só clarearia tudo), o deslocamento acompanha o ganho.
  if (edit.contrast !== undefined) out = out.linear(edit.contrast, 128 * (1 - edit.contrast))
  if (edit.gamma !== undefined) out = out.gamma(edit.gamma)
  if (edit.grayscale) out = out.grayscale()
  if (edit.negate) out = out.negate({ alpha: false })
  if (edit.normalize) out = out.normalise()
  if (edit.tint) out = out.tint(parseColor(edit.tint))
  if (edit.blur) out = out.blur(edit.blur)
  if (edit.sharpen) out = out.sharpen()
  return out
}

/** Qualidades tentadas ao perseguir um teto de bytes, da melhor para a pior. */
const QUALITY_STEPS = [90, 80, 70, 60, 50, 40, 30]
/** Quantas vezes pode encolher depois de esgotar a qualidade. */
const MAX_SHRINKS = 6

async function encode(
  pipeline: Sharp,
  edit: ImageEdit,
  extra: { backgroundColor?: string; backgroundRemoved?: number; backgroundLimit?: number },
): Promise<EditResult> {
  // PNG quando o fundo saiu e ninguém pediu formato: salvar transparência em
  // JPEG a perderia inteira, sem aviso.
  const format = edit.format ?? (extra.backgroundRemoved !== undefined ? 'png' : undefined)
  const base = await pipeline.toBuffer()

  const write = async (quality: number, scale: number): Promise<Buffer> => {
    let step = sharp(base)
    if (scale < 1) {
      const meta = await sharp(base).metadata()
      step = step.resize({
        width: Math.max(1, Math.round((meta.width ?? 1) * scale)),
        withoutEnlargement: true,
      })
    }
    if (format === 'jpeg') return step.jpeg({ quality }).toBuffer()
    if (format === 'webp') return step.webp({ quality }).toBuffer()
    if (format === 'png') return step.png().toBuffer()
    return step.toBuffer()
  }

  const quality = edit.quality ?? 82
  let bytes = await write(quality, 1)
  let compression: string | undefined

  if (edit.maxBytes && bytes.length > edit.maxBytes) {
    const tried: string[] = [`${format ?? 'original'} q${quality}`]
    // PNG não tem qualidade com perdas: insistir nos passos abaixo só gastaria
    // tempo, então a redução dele é toda por dimensão.
    if (format !== 'png') {
      for (const step of QUALITY_STEPS) {
        if (step >= quality) continue
        bytes = await write(step, 1)
        tried.push(`q${step}`)
        if (bytes.length <= edit.maxBytes) break
      }
    }
    let scale = 1
    for (let i = 0; i < MAX_SHRINKS && bytes.length > edit.maxBytes; i++) {
      scale *= 0.8
      bytes = await write(format === 'png' ? quality : 60, scale)
      tried.push(`${Math.round(scale * 100)}% do tamanho`)
    }
    compression = tried.join(' → ')
  }

  const meta = await sharp(bytes).metadata()
  return {
    bytes,
    format: meta.format ?? 'desconhecido',
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    backgroundColor: extra.backgroundColor,
    backgroundRemoved: extra.backgroundRemoved,
    backgroundLimit: extra.backgroundLimit,
    compression,
  }
}
