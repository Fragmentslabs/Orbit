import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { vectorizeImage } from './vectorize'
import { svgInfo } from './svg-ops'

/**
 * Vetorizar "funciona" com muita facilidade: qualquer coisa que devolva um
 * `<svg>` válido passa por sucesso. O que decide se prestou é o desenho
 * continuar o mesmo — então o teste central aqui RASTERIZA O RESULTADO DE
 * VOLTA e compara com a origem, pixel a pixel.
 */

async function solid(width: number, height: number, color: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()
}

/** Fração de pixels que diferem entre duas imagens do mesmo tamanho. */
async function difference(a: Buffer, b: Buffer): Promise<number> {
  const [ra, rb] = await Promise.all([
    sharp(a).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ])
  let diff = 0
  const total = ra.info.width * ra.info.height
  for (let i = 0; i < total; i++) {
    const at = i * ra.info.channels
    const d =
      Math.abs(ra.data[at] - rb.data[at]) +
      Math.abs(ra.data[at + 1] - rb.data[at + 1]) +
      Math.abs(ra.data[at + 2] - rb.data[at + 2])
    if (d > 90) diff++
  }
  return diff / total
}

/** Quadrado vermelho sobre branco — o caso de logo chapado. */
async function marca(): Promise<Buffer> {
  return sharp({ create: { width: 120, height: 120, channels: 3, background: '#ffffff' } })
    .composite([{ input: await solid(60, 60, '#c81e1e'), top: 30, left: 30 }])
    .png()
    .toBuffer()
}

describe('vectorizeImage', () => {
  it('devolve um SVG válido, com viewBox', async () => {
    const out = await vectorizeImage(await marca())
    expect(out.svg).toMatch(/^<svg /)
    const info = svgInfo(out.svg)
    expect(info.viewBox).toBe('0 0 120 120')
    expect(out.paths).toBeGreaterThan(0)
  })

  it('o desenho SOBREVIVE à ida e à volta', async () => {
    // O teste que importa: vetorizar, rasterizar de novo no mesmo tamanho e
    // conferir que é a mesma imagem. Um traçado errado passa em tudo o mais.
    const origem = await marca()
    const out = await vectorizeImage(origem)
    const volta = await sharp(Buffer.from(out.svg)).resize(120, 120).png().toBuffer()
    // Alguma diferença é esperada na borda (o traçado anda pela aresta do
    // pixel), mas o desenho tem que ser o mesmo.
    expect(await difference(origem, volta)).toBeLessThan(0.02)
  })

  it('reconhece as cores que existem no desenho', async () => {
    const out = await vectorizeImage(await marca())
    // O vermelho tem que estar entre as cores traçadas, não uma aproximação
    // distante dele.
    const vermelho = out.colors.find((c) => c.startsWith('#c') || c.startsWith('#b'))
    expect(vermelho).toBeDefined()
  })

  it('VAZA o meio de um anel em vez de tapá-lo', async () => {
    // O caso que separa um traçador certo de um errado: o contorno de dentro
    // tem sentido oposto ao de fora, e é o fill-rule que faz o buraco existir.
    // Sem isso, o anel vira um disco.
    const anel = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } })
      .composite([
        { input: await solid(80, 80, '#000000'), top: 10, left: 10 },
        { input: await solid(40, 40, '#ffffff'), top: 30, left: 30 },
      ])
      .png()
      .toBuffer()

    const out = await vectorizeImage(anel)
    const volta = await sharp(Buffer.from(out.svg)).resize(100, 100).png().toBuffer()
    const { data, info } = await sharp(volta).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const at = (50 * info.width + 50) * info.channels
    // O centro do anel tem que continuar claro.
    expect(data[at]).toBeGreaterThan(200)
  })

  it('dropBackground recorta o fundo em vez de deixar um retângulo', async () => {
    const com = await vectorizeImage(await marca())
    const sem = await vectorizeImage(await marca(), { dropBackground: true })
    expect(sem.paths).toBe(com.paths - 1)
    expect(sem.colors).not.toContain('#ffffff')
  })

  it('escala sem perder nitidez — o ponto de vetorizar', async () => {
    // 120 de origem, 600 de saída: num raster isso seria borrão.
    const out = await vectorizeImage(await marca())
    const grande = await sharp(Buffer.from(out.svg)).resize(600, 600).png().toBuffer()
    const { data, info } = await sharp(grande).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    // A transição do branco para o vermelho acontece em poucos pixels: uma
    // ampliação de raster espalharia isso por dezenas.
    const linha = 300
    let transicao = 0
    for (let x = 1; x < info.width; x++) {
      const a = (linha * info.width + x - 1) * info.channels
      const b = (linha * info.width + x) * info.channels
      if (Math.abs(data[a] - data[b]) > 40) transicao++
    }
    expect(transicao).toBeLessThanOrEqual(4)
  })

  it('simplifica: uma borda reta não vira um ponto por pixel', async () => {
    const out = await vectorizeImage(await marca())
    // Um quadrado tem 4 cantos. Sem simplificação seriam ~240 pontos.
    expect(out.points).toBeLessThan(40)
  })

  it('avisa quando o resultado tem cara de fotografia', async () => {
    // Ruído não tem região chapada nenhuma: é o pior caso, e o relatório
    // precisa dizer isso em vez de entregar calado.
    const ruido = Buffer.alloc(300 * 300 * 3)
    for (let i = 0; i < ruido.length; i++) ruido[i] = Math.floor(Math.random() * 256)
    const foto = await sharp(ruido, { raw: { width: 300, height: 300, channels: 3 } }).png().toBuffer()

    const out = await vectorizeImage(foto, { colors: 16 })
    expect(out.warnings.join(' ')).toMatch(/fotografia/)
  })

  it('NÃO acusa arte antisserrilhada de ser fotografia', async () => {
    // Regressão de um falso positivo real. Um logo com bordas suavizadas ganha
    // uma cor de mistura na quantização, e ela forma anéis de um pixel que se
    // estilhaçam em centenas de manchas. Contando CABEÇAS, o aviso disparava
    // num traçado perfeito; contando ÁREA, essas migalhas são desprezíveis.
    const marcaSuave = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
           <rect width="300" height="300" fill="#ffffff"/>
           <circle cx="150" cy="150" r="110" fill="#1d4ed8"/>
           <circle cx="150" cy="150" r="66" fill="#ffffff"/>
           <circle cx="150" cy="150" r="22" fill="#dc2626"/>
         </svg>`,
      ),
    )
      .png()
      .toBuffer()

    const out = await vectorizeImage(marcaSuave, { colors: 5 })
    expect(out.warnings.join(' ')).not.toMatch(/fotografia|cores chapadas/)
    // E o desenho tem que continuar reconhecível: o miolo vermelho, o anel
    // branco e o azul em volta, cada um no seu lugar.
    const volta = await sharp(Buffer.from(out.svg)).resize(300, 300).png().toBuffer()
    const { data, info } = await sharp(volta).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const cor = (x: number, y: number) => {
      const at = (y * info.width + x) * info.channels
      return [data[at], data[at + 1], data[at + 2]]
    }
    expect(cor(150, 150)[0]).toBeGreaterThan(150) // centro vermelho
    expect(cor(150, 60)[2]).toBeGreaterThan(150) // anel azul no topo
  })

  it('o SVG de um desenho chapado sai MENOR que o raster', async () => {
    // É o ganho concreto de vetorizar arte: menos bytes e escala infinita.
    const origem = await marca()
    const out = await vectorizeImage(origem)
    expect(Buffer.byteLength(out.svg)).toBeLessThan(origem.length)
  })

  it('some com a tinta de borda, e PRESERVA um acento pequeno', async () => {
    // As duas metades da mesma regra, e é por isso que estão no mesmo teste.
    //
    // A mistura entre dois tons (o cinza que nasce entre um traço escuro e um
    // fundo claro) tem que sumir: é ela que desenha o contorno fantasma. Mas
    // ela é PEQUENA, e um acento legítimo de marca também é — se a regra fosse
    // por tamanho, o ponto vermelho morreria junto. O que separa os dois é a
    // mistura cair sobre a linha que liga as duas cores de onde ela saiu.
    const escuro = '#1a2b4a'
    const claro = '#f2f0ea'
    const meio = '#8a8d9a' // a média dos dois: a tinta de borda
    const acento = '#e11d48' // vermelho: fora da linha entre os outros dois

    const cena = await sharp({ create: { width: 200, height: 200, channels: 3, background: claro } })
      .composite([
        { input: await solid(140, 140, escuro), top: 30, left: 30 },
        { input: await solid(120, 120, claro), top: 40, left: 40 },
        // Moldura de mistura acompanhando o traço.
        { input: await solid(140, 3, meio), top: 28, left: 30 },
        { input: await solid(140, 3, meio), top: 170, left: 30 },
        // O acento, pequeno como a mistura.
        { input: await solid(18, 18, acento), top: 90, left: 90 },
      ])
      .png()
      .toBuffer()

    const out = await vectorizeImage(cena, { colors: 4 })
    const proximo = (hex: string, alvo: string, limite = 40) => {
      const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
      return Math.hypot(p(hex, 0) - p(alvo, 0), p(hex, 1) - p(alvo, 1), p(hex, 2) - p(alvo, 2)) < limite
    }
    expect(out.colors.some((c) => proximo(c, acento))).toBe(true)
    expect(out.colors.some((c) => proximo(c, meio, 25))).toBe(false)
  })

  it('escolhe sozinho quantas cores usar, e diz qual escolheu', async () => {
    const out = await vectorizeImage(await marca())
    expect(out.usedColors).toBeGreaterThanOrEqual(3)
    expect(out.usedColors).toBeLessThanOrEqual(6)
    // Pedido explícito continua sendo respeitado ao pé da letra.
    expect((await vectorizeImage(await marca(), { colors: 3 })).usedColors).toBe(3)
  })

  it('imagem grande é reduzida antes, e avisa', async () => {
    const grande = await solid(2400, 1200, '#334155')
    const out = await vectorizeImage(grande)
    expect(out.width).toBeLessThanOrEqual(1000)
    expect(out.warnings.join(' ')).toMatch(/reduzida/)
  })
})
