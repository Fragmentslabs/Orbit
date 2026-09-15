import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { editImage, imageInfo, parseColor, removeBackground } from './image-ops'

/** Um retângulo de cor sólida. */
async function solid(width: number, height: number, color: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()
}

/**
 * Assunto vermelho centrado num fundo da cor pedida — o caso que o recorte de
 * fundo existe para resolver.
 */
async function subjectOnBackground(background: string, subject = '#c81e1e'): Promise<Buffer> {
  return sharp({ create: { width: 60, height: 60, channels: 3, background } })
    .composite([{ input: await solid(20, 20, subject), top: 20, left: 20 }])
    .png()
    .toBuffer()
}

/** Alfa de um pixel — 0 é recortado, 255 é opaco. */
async function alphaAt(png: Buffer, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return data[(y * info.width + x) * 4 + 3]
}

describe('parseColor', () => {
  it('aceita as três formas usadas na prática', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseColor('#1e40AF')).toEqual({ r: 30, g: 64, b: 175 })
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30 })
  })

  it('recusa o que não entende em vez de virar preto calado', () => {
    // Um erro silencioso aqui pintaria a imagem de preto e pareceria um bug
    // da edição, não da cor que o modelo escreveu.
    expect(() => parseColor('azul')).toThrow(/Cor inválida/)
    expect(() => parseColor('#12345')).toThrow(/Cor inválida/)
  })
})

describe('imageInfo', () => {
  it('relata formato, tamanho e cor predominante', async () => {
    const info = await imageInfo(await solid(40, 25, '#2563eb'))
    expect(info.format).toBe('png')
    expect(info.width).toBe(40)
    expect(info.height).toBe(25)
    // Aproximada de propósito: o dominant do sharp sai de um histograma
    // binado, então devolve o centro do bin e não a cor exata. Serve como
    // palpite de fundo, que é para o que ele é usado — não como medição.
    expect(info.dominant).toMatch(/^#[0-9a-f]{6}$/)
    const { r, g, b } = parseColor(info.dominant)
    expect(Math.abs(r - 0x25)).toBeLessThan(16)
    expect(Math.abs(g - 0x63)).toBeLessThan(16)
    expect(Math.abs(b - 0xeb)).toBeLessThan(16)
  })
})

describe('removeBackground', () => {
  it('adivinha o fundo pelas quinas e recorta só ele', async () => {
    const result = await removeBackground(await subjectOnBackground('#ffffff'))
    expect(result.color).toBe('#ffffff')
    expect(await alphaAt(result.png, 1, 1)).toBe(0) // quina: fundo
    expect(await alphaAt(result.png, 30, 30)).toBe(255) // centro: assunto
    // 60x60 com um assunto de 20x20 — sobram ~89% de fundo.
    expect(result.removed).toBeGreaterThan(0.85)
    expect(result.removed).toBeLessThan(0.93)
  })

  it('NÃO abre buraco no assunto da mesma cor do fundo', async () => {
    // O caso que separa espalhar-pela-borda de chroma key: um quadrado branco
    // dentro do assunto. O chroma key apagaria os dois brancos.
    const image = await sharp({ create: { width: 60, height: 60, channels: 3, background: '#ffffff' } })
      .composite([
        { input: await solid(30, 30, '#c81e1e'), top: 15, left: 15 },
        { input: await solid(8, 8, '#ffffff'), top: 26, left: 26 },
      ])
      .png()
      .toBuffer()

    const result = await removeBackground(image)
    expect(await alphaAt(result.png, 1, 1)).toBe(0) // fundo externo: foi
    expect(await alphaAt(result.png, 30, 30)).toBe(255) // branco interno: ficou
  })

  it('aceita a cor do fundo explícita', async () => {
    const result = await removeBackground(await subjectOnBackground('#00ff00'), {
      color: '#00ff00',
    })
    expect(result.color).toBe('#00ff00')
    expect(await alphaAt(result.png, 1, 1)).toBe(0)
  })

  it('tolerância zero não recorta um fundo que não bate exatamente', async () => {
    const result = await removeBackground(await subjectOnBackground('#ffffff'), {
      color: '#000000',
      tolerance: 0,
    })
    expect(result.removed).toBe(0)
    expect(await alphaAt(result.png, 1, 1)).toBe(255)
  })

  it('a tolerância alcança um fundo levemente irregular', async () => {
    // Fundo quase branco, como sai de uma digitalização.
    const ruidoso = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#f4f4f5' } })
      .composite([{ input: await solid(10, 10, '#111111'), top: 15, left: 15 }])
      .png()
      .toBuffer()
    const justo = await removeBackground(ruidoso, { color: '#ffffff', tolerance: 1 })
    const folgado = await removeBackground(ruidoso, { color: '#ffffff', tolerance: 10 })
    expect(justo.removed).toBe(0)
    expect(folgado.removed).toBeGreaterThan(0.9)
  })

  it('separa pelo MATIZ, e não pelo brilho: tela verde iluminada não come a pele', async () => {
    // O caso que quebrou de verdade. Uma tela verde real é iluminada de um
    // lado: o fundo varia de (100,164,77) a (124,201,115), que em RGB fica a
    // mais da metade do caminho até um tom de pele — nenhum limiar separa os
    // dois. Em LAB a variação é quase toda de luminosidade, e a margem volta.
    const gradiente = Buffer.alloc(80 * 80 * 3)
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 80; x++) {
        const at = (y * 80 + x) * 3
        const t = x / 79
        gradiente[at] = Math.round(100 + t * 24)
        gradiente[at + 1] = Math.round(164 + t * 37)
        gradiente[at + 2] = Math.round(77 + t * 38)
      }
    }
    const pele = await sharp({
      create: { width: 30, height: 30, channels: 3, background: '#c69473' },
    })
      .png()
      .toBuffer()
    const cena = await sharp(gradiente, { raw: { width: 80, height: 80, channels: 3 } })
      .composite([{ input: pele, top: 25, left: 25 }])
      .png()
      .toBuffer()

    const result = await removeBackground(cena)
    expect(await alphaAt(result.png, 2, 40)).toBe(0) // fundo escuro: foi
    expect(await alphaAt(result.png, 77, 40)).toBe(0) // fundo claro: também
    expect(await alphaAt(result.png, 40, 40)).toBe(255) // pele: ficou
  })

  it('a tolerância automática sai do espalhamento da própria moldura', async () => {
    // Quem chama não tem como saber o número certo — ele depende da foto.
    const liso = await removeBackground(await subjectOnBackground('#ffffff'))
    const irregular = await sharp({
      create: { width: 60, height: 60, channels: 3, background: '#cfe8cf' },
    })
      .composite([
        { input: await solid(20, 20, '#c81e1e'), top: 20, left: 20 },
        // Mancha na moldura: o fundo não é uniforme, e o automático precisa
        // abrir mais do que abriria num fundo liso.
        { input: await solid(60, 4, '#a8d0a8'), top: 0, left: 0 },
      ])
      .png()
      .toBuffer()
    const medido = await removeBackground(irregular)

    expect(medido.limit).toBeGreaterThan(liso.limit)
    expect(await alphaAt(medido.png, 1, 1)).toBe(0)
    expect(await alphaAt(medido.png, 30, 30)).toBe(255)
  })

  it('despill tira o verde que fica grudado na borda do assunto', async () => {
    // Uma borda real é MISTURA de assunto e fundo, então ao lado de uma tela
    // verde o contorno sai esverdeado. É o que faz um recorte parecer recortado.
    const cinza = await sharp({
      create: { width: 60, height: 60, channels: 3, background: '#00c000' },
    })
      .composite([
        { input: await solid(24, 24, '#8a8a8a'), top: 18, left: 18 },
        // A moldura de mistura em volta do assunto.
        { input: await solid(28, 2, '#4a9a4a'), top: 16, left: 16 },
      ])
      .png()
      .toBuffer()

    const esverdeados = async (png: Buffer) => {
      const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      let n = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue
        if (data[i + 1] > data[i] + 18 && data[i + 1] > data[i + 2] + 18) n++
      }
      return n
    }

    const sem = await removeBackground(cinza, { despill: false })
    const com = await removeBackground(cinza)
    expect(await esverdeados(com.png)).toBeLessThan(await esverdeados(sem.png))
  })

  it('despill não apaga a cor de um fundo neutro', async () => {
    // Fundo branco ou cinza não tem matiz para vazar. "Corrigir" ali só tiraria
    // cor de quem legitimamente a tem.
    const out = await removeBackground(await subjectOnBackground('#ffffff', '#1e9e1e'))
    const { data } = await sharp(out.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const at = (30 * 60 + 30) * 4
    expect(data[at + 1]).toBeGreaterThan(data[at] + 18) // o verde do assunto ficou
  })

  it('feather suaviza a borda em vez de deixá-la serrilhada', async () => {
    const duro = await removeBackground(await subjectOnBackground('#ffffff'))
    const suave = await removeBackground(await subjectOnBackground('#ffffff'), { feather: 2 })
    // O corte duro só tem 0 e 255; o suavizado cria valores no meio.
    const alfas = async (png: Buffer) => {
      const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      let parciais = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0 && data[i] < 255) parciais++
      return parciais
    }
    expect(await alfas(duro.png)).toBe(0)
    expect(await alfas(suave.png)).toBeGreaterThan(0)
  })

  it('feather NÃO desloca nem lista o alfa', async () => {
    // Regressão de um bug real: o blur sobre um raw de 1 canal devolve 3, e ler
    // o resultado como 1 canal avança um terço do necessário por pixel. O alfa
    // saía comprimido na horizontal e em faixas — o assunto virava listras, e a
    // imagem parecia um defeito de renderização em vez de um recorte errado.
    const duro = await removeBackground(await subjectOnBackground('#ffffff'))
    const suave = await removeBackground(await subjectOnBackground('#ffffff'), { feather: 1 })

    // O miolo do assunto continua opaco: um deslocamento o perfuraria.
    expect(await alphaAt(suave.png, 30, 30)).toBe(255)
    // E a quina continua recortada.
    expect(await alphaAt(suave.png, 1, 1)).toBe(0)

    // Suavizar muda a BORDA, não a área: as duas versões cobrem quase o mesmo.
    const opacos = async (png: Buffer) => {
      const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      let n = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 128) n++
      return n
    }
    const a = await opacos(duro.png)
    const b = await opacos(suave.png)
    expect(Math.abs(a - b)).toBeLessThan(a * 0.2)
  })
})

describe('editImage', () => {
  it('redimensiona respeitando a proporção', async () => {
    const out = await editImage(await solid(400, 200, '#334155'), { resize: { width: 100 } })
    expect(out.width).toBe(100)
    expect(out.height).toBe(50)
  })

  it('não amplia por padrão — ampliar só produz borrão maior', async () => {
    const out = await editImage(await solid(50, 50, '#334155'), { resize: { width: 500 } })
    expect(out.width).toBe(50)
    const forcado = await editImage(await solid(50, 50, '#334155'), {
      resize: { width: 500, enlarge: true },
    })
    expect(forcado.width).toBe(500)
  })

  it('recorta pelo retângulo pedido', async () => {
    const out = await editImage(await solid(100, 100, '#334155'), {
      crop: { left: 10, top: 20, width: 30, height: 40 },
    })
    expect(out.width).toBe(30)
    expect(out.height).toBe(40)
  })

  it('recorte fora da imagem explica o que está errado', async () => {
    await expect(
      editImage(await solid(50, 50, '#334155'), {
        crop: { left: 40, top: 0, width: 30, height: 10 },
      }),
    ).rejects.toThrow(/sai da imagem, que tem 50x50/)
  })

  it('trim tira a moldura uniforme', async () => {
    const comMoldura = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#ffffff' },
    })
      .composite([{ input: await solid(40, 30, '#c81e1e'), top: 35, left: 30 }])
      .png()
      .toBuffer()
    const out = await editImage(comMoldura, { trim: {} })
    expect(out.width).toBe(40)
    expect(out.height).toBe(30)
  })

  it('gira e espelha', async () => {
    const out = await editImage(await solid(60, 20, '#334155'), { rotate: 90 })
    expect(out.width).toBe(20)
    expect(out.height).toBe(60)
  })

  it('dessatura até o cinza', async () => {
    const out = await editImage(await solid(20, 20, '#c81e1e'), { saturation: 0 })
    const { r, g, b } = (await sharp(out.bytes).stats()).dominant
    expect(Math.abs(r - g)).toBeLessThan(6)
    expect(Math.abs(g - b)).toBeLessThan(6)
  })

  it('clareia e escurece pelo brightness', async () => {
    const base = await solid(20, 20, '#808080')
    const claro = await editImage(base, { brightness: 1.5 })
    const escuro = await editImage(base, { brightness: 0.5 })
    expect((await sharp(claro.bytes).stats()).dominant.r).toBeGreaterThan(128)
    expect((await sharp(escuro.bytes).stats()).dominant.r).toBeLessThan(128)
  })

  it('contraste gira em torno do cinza médio, não do preto', async () => {
    // Um cinza médio é o ponto fixo: mais contraste não pode clareá-lo.
    const out = await editImage(await solid(20, 20, '#808080'), { contrast: 2 })
    expect((await sharp(out.bytes).stats()).dominant.r).toBeGreaterThan(118)
    expect((await sharp(out.bytes).stats()).dominant.r).toBeLessThan(138)
  })

  it('converte de formato', async () => {
    const out = await editImage(await solid(30, 30, '#334155'), { format: 'jpeg', quality: 70 })
    expect(out.format).toBe('jpeg')
  })

  it('maxBytes reduz até caber e conta o que fez', async () => {
    // Ruído comprime mal: é o que força a busca a descer os degraus.
    const ruido = Buffer.alloc(600 * 600 * 3)
    for (let i = 0; i < ruido.length; i++) ruido[i] = Math.floor(Math.random() * 256)
    const fonte = await sharp(ruido, { raw: { width: 600, height: 600, channels: 3 } })
      .png()
      .toBuffer()

    const out = await editImage(fonte, { format: 'jpeg', maxBytes: 20_000 })
    expect(out.bytes.length).toBeLessThanOrEqual(20_000)
    expect(out.compression).toBeTruthy()
  })

  it('maxBytes folgado não mexe na qualidade', async () => {
    const out = await editImage(await solid(40, 40, '#334155'), {
      format: 'jpeg',
      maxBytes: 5_000_000,
    })
    expect(out.compression).toBeUndefined()
  })

  it('recortar o fundo sem pedir formato entrega PNG, para não perder o alfa', async () => {
    const out = await editImage(await subjectOnBackground('#ffffff'), { removeBackground: {} })
    expect(out.format).toBe('png')
    expect(out.backgroundColor).toBe('#ffffff')
    expect(out.backgroundRemoved).toBeGreaterThan(0.8)
  })

  it('recorta o fundo e redimensiona na mesma passada', async () => {
    const out = await editImage(await subjectOnBackground('#ffffff'), {
      removeBackground: {},
      resize: { width: 30 },
    })
    expect(out.width).toBe(30)
    expect(await alphaAt(out.bytes, 1, 1)).toBe(0)
  })

  it('flatten achata a transparência sobre a cor pedida', async () => {
    const semFundo = await editImage(await subjectOnBackground('#ffffff'), { removeBackground: {} })
    const achatado = await editImage(semFundo.bytes, { flatten: '#000000', format: 'jpeg' })
    expect(await alphaAt(achatado.bytes, 1, 1)).toBe(255)
    const { data } = await sharp(achatado.bytes).raw().toBuffer({ resolveWithObject: true })
    expect(data[0]).toBeLessThan(20) // a quina virou preta
  })
})
