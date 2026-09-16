import sharp from 'sharp'
import { labOf } from './image-ops'

/**
 * Vetorização: imagem raster → SVG com caminhos de verdade.
 *
 * Escrito aqui, e não trazido de biblioteca, por licença: o potrace — a
 * referência do assunto — é GPL-2.0, e o Orbit é distribuído sob Business
 * Source License. Linkar um contra o outro obrigaria a abrir o app inteiro.
 *
 * O caminho é em três passos, e o primeiro é o que torna os outros dois
 * simples: o sharp QUANTIZA a imagem num punhado de cores chapadas, e a partir
 * daí "achar a forma" deixa de ser análise de imagem e vira geometria sobre
 * uma máscara binária.
 *
 *   quantizar → contornar cada cor → simplificar
 *
 * O que isto faz bem: logo, ícone, desenho de linha, silhueta — coisas feitas
 * de regiões chapadas. O que NÃO faz: fotografia. Ali cada gradiente vira
 * dezenas de faixas e o resultado sai maior que o original e feio. O relatório
 * devolvido existe para reconhecer esse caso sem precisar abrir o arquivo.
 *
 * Módulo puro de bytes (sem Electron, sem IO), para ser testável.
 */

/** Acima disto o traçado gera caminho demais para ser útil — e a imagem é
 *  reduzida antes, o que também suaviza o serrilhado da quantização. */
const MAX_SIDE = 1000

/**
 * Abaixo deste ΔE duas cores são a mesma cor para quem olha.
 *
 * O limiar de "diferença perceptível" anda por 2,3; aqui ele é um pouco mais
 * folgado porque o objetivo não é fidelidade de cor, é achar FORMA — e duas
 * cores que ninguém distingue nunca deveriam virar dois contornos.
 */
const IDENTICAL_DELTA_E = 6

/**
 * Quão perto da linha entre duas cores a mistura precisa cair.
 *
 * Uma transição real entre dois tons é, por construção, a média deles — então
 * ela pousa quase exatamente em cima do segmento que os liga em LAB. Uma cor
 * de verdade do desenho não tem motivo nenhum para cair ali.
 */
const BLEND_LINE_DISTANCE = 12

export interface VectorizeOptions {
  /**
   * Quantas cores manter, ou 'auto' (padrão). Poucas = desenho mais limpo;
   * muitas = mais fiel — e é uma escolha que depende da imagem, não de quem
   * chama: um arquivo castigado precisa de menos cores justamente porque as
   * que ele tem a mais são ruído.
   */
  colors?: number | 'auto'
  /** Ignora manchas menores que isto, em pixels. Tira a sujeira da
   *  quantização sem comer detalhe de verdade. */
  minArea?: number
  /** Tolerância da simplificação, em pixels. Maior = menos pontos, contorno
   *  mais reto. */
  tolerance?: number
  /** Não desenha a cor de fundo (a que ocupa as bordas): é o que entrega um
   *  ícone recortado em vez de um retângulo colorido. */
  dropBackground?: boolean
}

export interface VectorizeResult {
  svg: string
  /** Quantas cores foram usadas de fato — o número que o 'auto' escolheu. */
  usedColors: number
  width: number
  height: number
  /** Cores desenhadas, da maior área para a menor. */
  colors: string[]
  paths: number
  points: number
  /**
   * Leitura honesta do resultado. Uma foto vetorizada "funciona" — produz um
   * SVG válido — e é lixo: milhares de caminhos, arquivo maior que a origem.
   * Quem chamou precisa saber disso sem abrir o arquivo.
   */
  warnings: string[]
}

type Point = [number, number]

/** Contornos de uma máscara binária, em coordenadas de ARESTA do pixel.
 *
 * Cada pixel aceso contribui com as arestas que fazem fronteira com apagado,
 * orientadas de modo que o interior fique sempre do mesmo lado. Isso faz o
 * contorno externo e o de um buraco saírem com sentidos opostos — que é
 * exatamente o que o `fill-rule` do SVG usa para vazar o meio de um anel sem
 * ninguém precisar dizer qual contorno é buraco.
 */
function contours(mask: Uint8Array, width: number, height: number): Point[][] {
  const on = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1

  // Aresta dirigida: chave do ponto inicial → pontos finais possíveis.
  const edges = new Map<string, Point[]>()
  const key = (p: Point) => `${p[0]},${p[1]}`
  const add = (from: Point, to: Point) => {
    const k = key(from)
    const list = edges.get(k)
    if (list) list.push(to)
    else edges.set(k, [to])
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!on(x, y)) continue
      if (!on(x, y - 1)) add([x, y], [x + 1, y])
      if (!on(x + 1, y)) add([x + 1, y], [x + 1, y + 1])
      if (!on(x, y + 1)) add([x + 1, y + 1], [x, y + 1])
      if (!on(x - 1, y)) add([x, y + 1], [x, y])
    }
  }

  const loops: Point[][] = []
  while (edges.size > 0) {
    const first = edges.keys().next().value as string
    const start: Point = first.split(',').map(Number) as Point
    const loop: Point[] = [start]
    let current = start

    for (;;) {
      const list = edges.get(key(current))
      if (!list || list.length === 0) break
      // Num vértice onde dois cantos se tocam na diagonal há duas saídas. A
      // primeira registrada mantém as duas regiões separadas em vez de
      // costurá-las num contorno só que passa pelo vazio.
      const next = list.shift() as Point
      if (list.length === 0) edges.delete(key(current))
      current = next
      if (current[0] === start[0] && current[1] === start[1]) break
      loop.push(current)
    }
    if (loop.length >= 4) loops.push(loop)
  }
  return loops
}

/** Área com sinal — o sinal diz o sentido, e o módulo filtra mancha pequena. */
function signedArea(loop: Point[]): number {
  let sum = 0
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i]
    const [x2, y2] = loop[(i + 1) % loop.length]
    sum += x1 * y2 - x2 * y1
  }
  return sum / 2
}

/**
 * Douglas–Peucker: joga fora os pontos que não mudam o desenho.
 *
 * O contorno sai do pixel, então uma borda reta de 200px vira 200 pontos
 * idênticos em linha. Sem isto o SVG seria maior que o PNG e não teria ganho
 * nenhum — é este passo que transforma escada em segmento.
 */
function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3 || tolerance <= 0) return points

  const distance = (p: Point, a: Point, b: Point): number => {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)
    const cx = a[0] + Math.max(0, Math.min(1, t)) * dx
    const cy = a[1] + Math.max(0, Math.min(1, t)) * dy
    return Math.hypot(p[0] - cx, p[1] - cy)
  }

  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]

  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number]
    let worst = 0
    let index = -1
    for (let i = first + 1; i < last; i++) {
      const d = distance(points[i], points[first], points[last])
      if (d > worst) {
        worst = d
        index = i
      }
    }
    if (index >= 0 && worst > tolerance) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }
  return points.filter((_, i) => keep[i] === 1)
}

function toHex(r: number, g: number, b: number): string {
  const part = (v: number) => v.toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/**
 * Acima deste giro, o vértice é um CANTO de verdade e fica anguloso.
 *
 * Sem esta distinção o arredondamento trataria tudo igual e um quadrado viraria
 * uma bolha. Com ela, a curva de um círculo suaviza e o canto de um retângulo
 * permanece canto.
 */
const CORNER_ANGLE = Math.PI / 3

/**
 * Do polígono para a curva.
 *
 * O contorno sai da grade de pixels, então mesmo simplificado ele é uma
 * sequência de retas — e num círculo isso aparece como facetas assim que a
 * pessoa amplia, que é justamente o que ela foi buscar ao vetorizar.
 *
 * A suavização é a clássica por pontos médios: a curva passa pelo meio de cada
 * aresta e usa o vértice como controle. Ela não acrescenta nenhum ponto — o
 * mesmo arquivo, com curva no lugar de faceta — e só entra onde o giro é
 * suave; canto fechado continua reto.
 */
function pathData(loops: Point[][]): string {
  const round = (n: number) => Math.round(n * 10) / 10
  const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

  return loops
    .map((loop) => {
      const n = loop.length
      if (n < 3) return ''

      const corner = loop.map((p, i) => {
        const prev = loop[(i - 1 + n) % n]
        const next = loop[(i + 1) % n]
        const a = Math.atan2(p[1] - prev[1], p[0] - prev[0])
        const b = Math.atan2(next[1] - p[1], next[0] - p[0])
        let turn = Math.abs(b - a)
        if (turn > Math.PI) turn = 2 * Math.PI - turn
        return turn > CORNER_ANGLE
      })

      const start = corner[0] ? loop[0] : mid(loop[n - 1], loop[0])
      let d = `M${round(start[0])} ${round(start[1])}`

      for (let i = 0; i < n; i++) {
        const p = loop[(i + 1) % n]
        if (corner[(i + 1) % n]) {
          d += `L${round(p[0])} ${round(p[1])}`
        } else {
          const end = mid(p, loop[(i + 2) % n])
          d += `Q${round(p[0])} ${round(p[1])} ${round(end[0])} ${round(end[1])}`
        }
      }
      return `${d}Z`
    })
    .filter(Boolean)
    .join('')
}

/**
 * `c` está na transição entre `a` e `b`?
 *
 * Projeta a cor no segmento que liga as outras duas em LAB. É mistura quando
 * cai PERTO da linha e no MEIO dela — perto de uma ponta significa que é só
 * uma variação daquela cor, e isso o passo anterior já resolve.
 */
function betweenness(
  c: [number, number, number],
  a: [number, number, number],
  b: [number, number, number],
): boolean {
  const abx = b[0] - a[0]
  const aby = b[1] - a[1]
  const abz = b[2] - a[2]
  const len = abx * abx + aby * aby + abz * abz
  if (len === 0) return false
  const t = ((c[0] - a[0]) * abx + (c[1] - a[1]) * aby + (c[2] - a[2]) * abz) / len
  if (t < 0.2 || t > 0.8) return false
  const px = a[0] + t * abx
  const py = a[1] + t * aby
  const pz = a[2] + t * abz
  return Math.hypot(c[0] - px, c[1] - py, c[2] - pz) < BLEND_LINE_DISTANCE
}

/**
 * Reduz a paleta ao número REALMENTE pedido, em espaço perceptual.
 *
 * Existe por dois motivos que se somam. O primeiro é que o quantizador do
 * libvips salta em potências de dois: pedir 8 devolve 16, e o parâmetro
 * mentiria. O segundo é o que aparece na tela — uma imagem borrada (um
 * desenho pequeno que foi ampliado, um JPEG castigado) tem bordas de cor
 * intermediária, e o quantizador as promove a cores próprias. Cada uma vira
 * uma camada de contorno FANTASMA ao lado do traço real, e o desenho sai com
 * halo.
 *
 * A redução absorve sempre a cor de MENOR área na sua vizinha mais próxima em
 * LAB. Uma faixa de transição é, por definição, fina e pouco numerosa, então
 * ela desaparece dentro da cor de verdade de onde saiu — enquanto as cores
 * dominantes do desenho, que têm área, sobrevivem.
 */
function mergeColors(
  data: Buffer,
  channels: number,
  pixels: number,
  target: number,
): Map<string, string> {
  const count = new Map<string, number>()
  for (let i = 0; i < pixels; i++) {
    const at = i * channels
    const hex = toHex(data[at], data[at + 1], data[at + 2])
    count.set(hex, (count.get(hex) ?? 0) + 1)
  }

  const lab = new Map<string, [number, number, number]>()
  for (const hex of count.keys()) {
    lab.set(hex, labOf(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)))
  }

  // Todo mundo começa apontando para si; absorver é reescrever o destino.
  const remap = new Map<string, string>()
  for (const hex of count.keys()) remap.set(hex, hex)
  const vivos = new Map(count)

  const distancia = (a: string, b: string) => {
    const x = lab.get(a) as [number, number, number]
    const y = lab.get(b) as [number, number, number]
    return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
  }
  const absorve = (menor: string, destino: string) => {
    vivos.set(destino, (vivos.get(destino) as number) + (vivos.get(menor) as number))
    vivos.delete(menor)
    for (const [de, para] of remap) {
      if (para === menor) remap.set(de, destino)
    }
  }

  // Primeiro passo, e é o que mais importa num arquivo castigado: funde o que
  // é INDISTINGUÍVEL ao olho, sem olhar tamanho. Um JPEG maltratado entrega o
  // mesmo creme em cinco versões separadas por menos de um ΔE de nada, e todas
  // elas são grandes — sobreviveriam a uma fusão por área e consumiriam o
  // orçamento de cores inteiro, deixando o desenho de verdade sem vaga.
  for (;;) {
    let a = ''
    let b = ''
    let melhor = IDENTICAL_DELTA_E
    const cores = [...vivos.keys()]
    for (let i = 0; i < cores.length; i++) {
      for (let j = i + 1; j < cores.length; j++) {
        const d = distancia(cores[i], cores[j])
        if (d < melhor) {
          melhor = d
          a = cores[i]
          b = cores[j]
        }
      }
    }
    if (!a) break
    // A menor é absorvida pela maior: quem tem área define a cor final.
    const menor = (vivos.get(a) as number) <= (vivos.get(b) as number) ? a : b
    absorve(menor, menor === a ? b : a)
  }

  // Segundo passo: some com a tinta de BORDA — a mistura que a transição entre
  // dois tons cria e que desenha um contorno fantasma ao lado de cada traço.
  //
  // O que a identifica não é ser pequena, é ficar ENTRE duas outras cores. A
  // distinção importa: um acento legítimo (o ponto vermelho de uma marca) é
  // pequeno também, e um limiar de área o apagaria junto. Já uma mistura entre
  // o azul-marinho do traço e o creme do fundo cai, por construção, em cima do
  // segmento que liga os dois — e nenhuma cor de verdade do desenho cai ali.
  for (;;) {
    let alvo = ''
    let destino = ''
    const cores = [...vivos.keys()]
    for (const c of cores) {
      const area = vivos.get(c) as number
      for (const a of cores) {
        for (const b of cores) {
          if (a === c || b === c || a === b) continue
          // Só é mistura se as duas pontas pesarem mais que ela.
          if ((vivos.get(a) as number) <= area || (vivos.get(b) as number) <= area) continue
          const posicao = betweenness(lab.get(c)!, lab.get(a)!, lab.get(b)!)
          if (!posicao) continue
          alvo = c
          destino = distancia(c, a) <= distancia(c, b) ? a : b
          break
        }
        if (alvo) break
      }
      if (alvo) break
    }
    if (!alvo || vivos.size <= 2) break
    absorve(alvo, destino)
  }

  while (vivos.size > target) {
    // A menor área é a próxima a ser absorvida.
    let menor = ''
    let menorN = Infinity
    for (const [hex, n] of vivos) {
      if (n < menorN) {
        menorN = n
        menor = hex
      }
    }

    let destino = ''
    let melhor = Infinity
    const a = lab.get(menor) as [number, number, number]
    for (const hex of vivos.keys()) {
      if (hex === menor) continue
      const b = lab.get(hex) as [number, number, number]
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
      if (d < melhor) {
        melhor = d
        destino = hex
      }
    }
    if (!destino) break
    absorve(menor, destino)
  }
  return remap
}

/**
 * Traça buscando o número de cores que o DESENHO pede.
 *
 * Mais cores não é mais fidelidade quando o arquivo é ruim: numa ilustração
 * pequena que foi ampliada, as cores extras são a mistura das bordas, e cada
 * uma vira um contorno fantasma ao lado do traço. O resultado fica maior,
 * mais lento e pior.
 *
 * Como isso depende da imagem e não de quem pede, o padrão TENTA e mede: se o
 * traçado sai pesado para o tamanho da tela, repete com menos cores. No máximo
 * três tentativas — a busca não pode custar mais que o trabalho.
 */
export async function vectorizeImage(
  source: Buffer,
  options: VectorizeOptions = {},
): Promise<VectorizeResult> {
  if (options.colors === undefined || options.colors === 'auto') {
    let melhor: VectorizeResult | null = null
    for (const colors of [6, 4, 3]) {
      const tentativa = await traceOnce(source, { ...options, colors })
      melhor = tentativa
      // Orçamento por área: um desenho limpo cabe folgado, e é o excesso que
      // denuncia que as cores a mais viraram borda em vez de forma.
      if (tentativa.points <= (tentativa.width * tentativa.height) / 150) break
    }
    return melhor as VectorizeResult
  }
  return traceOnce(source, options)
}

async function traceOnce(
  source: Buffer,
  options: VectorizeOptions,
): Promise<VectorizeResult> {
  const colorCount = Math.max(2, Math.min(32, typeof options.colors === 'number' ? options.colors : 6))
  const tolerance = options.tolerance ?? 1
  const warnings: string[] = []

  const meta = await sharp(source).metadata()
  const escala = Math.min(1, MAX_SIDE / Math.max(meta.width ?? 1, meta.height ?? 1))
  if (escala < 1) {
    warnings.push(
      `imagem reduzida para ${Math.round((meta.width ?? 0) * escala)}px antes de traçar — acima disso o resultado vira caminho demais para ser útil`,
    )
  }

  // Quantizar é o passo que torna o resto possível: sem ele, cada pixel de um
  // gradiente seria uma "cor" e cada um viraria a sua própria forma.
  //
  // A paleta pedida ao libvips é GENEROSA de propósito: o quantizador dele
  // salta em potências de dois — pedir 5, 6, 8 ou 12 devolve 16 —, então o
  // número que chega aqui não seria respeitado. Quem reduz ao valor pedido é o
  // mergeColors abaixo, e é ele que também dissolve as faixas de transição que
  // desenham um contorno fantasma ao lado de cada traço.
  const prepared = sharp(source).flatten({ background: '#ffffff' })
  if (escala < 1) prepared.resize({ width: Math.round((meta.width ?? 1) * escala) })
  const quantized = await prepared.png({ palette: true, colours: 64, dither: 0 }).toBuffer()

  const { data, info } = await sharp(quantized).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const minArea = options.minArea ?? Math.max(4, (width * height) / 20_000)

  const remap = mergeColors(data, info.channels, width * height, colorCount)
  const palette = [...new Set(remap.values())]

  // Cada pixel é reatribuído a partir da imagem ORIGINAL, e não da quantizada.
  //
  // A diferença aparece na borda. Um pixel de transição foi rotulado pelo
  // quantizador como uma cor intermediária, e a fusão mandou aquela cor
  // inteira para um dos lados — todos os pixels dela juntos. Decidindo pixel a
  // pixel, cada um vai para o lado de que ele está de fato mais perto, e a
  // fronteira cai onde ela realmente está em vez de deslizar meio traço para
  // um lado.
  const original = await sharp(source)
    .flatten({ background: '#ffffff' })
    .resize({ width, height, fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer()

  const paletteLab = palette.map(
    (hex) =>
      labOf(
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
      ) as [number, number, number],
  )

  const label = new Int32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const at = i * 3
    const [l, a, b] = labOf(original[at], original[at + 1], original[at + 2])
    let melhor = 0
    let menor = Infinity
    for (let k = 0; k < paletteLab.length; k++) {
      const p = paletteLab[k]
      const d = (l - p[0]) ** 2 + (a - p[1]) ** 2 + (b - p[2]) ** 2
      if (d < menor) {
        menor = d
        melhor = k
      }
    }
    label[i] = melhor
  }

  // Ordem de pintura: maior área atrás. Precisa ser decidida ANTES das
  // máscaras, porque cada camada carrega o que vem por cima dela.
  const areaPorCor = new Int32Array(palette.length)
  for (let i = 0; i < width * height; i++) areaPorCor[label[i]]++
  const ordem = palette
    .map((hex, k) => ({ hex, k, area: areaPorCor[k] }))
    .filter((c) => c.area > 0)
    .sort((a, b) => b.area - a.area)

  // Camadas EMPILHADAS: cada uma inclui tudo que será desenhado sobre ela.
  //
  // Traçando só os próprios pixels, duas regiões vizinhas têm a mesma
  // fronteira traçada duas vezes — uma de cada lado — e qualquer divergência
  // entre os dois traçados abre um fio de fundo entre elas. Empilhando, a
  // camada de baixo passa por baixo da de cima e não existe costura para
  // divergir.
  // Posição de cada rótulo na pilha, resolvida uma vez: procurar dentro do
  // laço de pixel seria varrer a paleta inteira por pixel.
  const rankDe = new Int32Array(palette.length).fill(ordem.length)
  ordem.forEach((c, posicao) => {
    rankDe[c.k] = posicao
  })

  const porCor = new Map<string, Uint8Array>()
  for (let posicao = 0; posicao < ordem.length; posicao++) {
    const mask = new Uint8Array(width * height)
    for (let i = 0; i < width * height; i++) {
      if (rankDe[label[i]] >= posicao) mask[i] = 1
    }
    porCor.set(ordem[posicao].hex, mask)
  }

  // A cor que domina a BORDA é o fundo: é ela que se quer descartar para o
  // ícone sair recortado em vez de dentro de um retângulo.
  const borda = new Map<string, number>()
  const conta = (i: number) => {
    const at = i * info.channels
    const hex = toHex(data[at], data[at + 1], data[at + 2])
    borda.set(hex, (borda.get(hex) ?? 0) + 1)
  }
  for (let x = 0; x < width; x++) {
    conta(x)
    conta((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    conta(y * width)
    conta(y * width + width - 1)
  }
  const fundo = [...borda.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]

  const camadas: { hex: string; d: string; area: number; points: number }[] = []
  // Quanto do desenho é mancha pequena demais para virar forma — medido em
  // ÁREA, não em quantidade. A diferença importa: um logo antisserrilhado
  // produz centenas de anéis de um pixel na mistura de cores das bordas, e
  // contar cabeças diria que ele não é arte chapada. Em área essas migalhas
  // são desprezíveis, enquanto numa foto elas SÃO a imagem.
  let areaTotal = 0
  let areaDescartada = 0

  for (const [hex, mask] of porCor) {
    if (options.dropBackground && hex === fundo) continue

    const brutos = contours(mask, width, height).map((loop) => ({ loop, area: signedArea(loop) }))
    const grandes = brutos.filter(({ area }) => Math.abs(area) >= minArea)
    for (const { area } of brutos) areaTotal += Math.abs(area)
    for (const { area } of brutos) {
      if (Math.abs(area) < minArea) areaDescartada += Math.abs(area)
    }

    const loops = grandes
      .map(({ loop }) => simplify(loop, tolerance))
      .filter((loop) => loop.length >= 3)

    if (loops.length === 0) continue
    const area = loops.reduce((sum, loop) => sum + Math.abs(signedArea(loop)), 0)
    camadas.push({
      hex,
      d: pathData(loops),
      area,
      points: loops.reduce((sum, loop) => sum + loop.length, 0),
    })
  }

  // Sem reordenar: a ordem de pintura foi decidida junto com o empilhamento,
  // e cada camada já contém o que vem por cima. Ordenar por área traçada aqui
  // desfaria a pilha — todas as camadas empilhadas são grandes por construção.

  const paths = camadas.length
  const points = camadas.reduce((sum, c) => sum + c.points, 0)
  if (points > 20_000) {
    warnings.push(
      `${points} pontos em ${paths} camadas — isto tem cara de fotografia, e vetorizar fotografia produz arquivo grande e feio. Um raster serve melhor aqui.`,
    )
  }
  // O outro jeito de a origem não prestar: em vez de formas demais, migalha
  // demais. Ruído e gradiente se desfazem em manchas de poucos pixels, e o que
  // sobra é um desenho que não se parece com a imagem.
  const perdido = areaTotal > 0 ? areaDescartada / areaTotal : 0
  if (perdido > 0.3) {
    warnings.push(
      `${Math.round(perdido * 100)}% do desenho se desfez em manchas pequenas demais para virar forma — a imagem não é feita de cores chapadas (fotografia, gradiente, textura). O que saiu não vai se parecer com ela; um raster serve melhor aqui.`,
    )
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    camadas
      .map((c) => `<path fill="${c.hex}" fill-rule="evenodd" d="${c.d}"/>`)
      .join('') +
    '</svg>'

  return {
    svg,
    width,
    height,
    usedColors: colorCount,
    colors: camadas.map((c) => c.hex),
    paths,
    points,
    warnings,
  }
}
