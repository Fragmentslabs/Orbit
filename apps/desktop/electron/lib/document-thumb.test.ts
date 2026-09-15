import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { pageThumb, textThumb, THUMB_HEIGHT, THUMB_WIDTH } from './document-thumb'

/**
 * A miniatura é enfeite, então o que estes testes protegem não é a aparência —
 * é que ela nunca derrube a lista de fontes e nunca saia em branco fingindo
 * ser uma capa.
 */

/**
 * Pixels com tinta no MIOLO da folha — a moldura fica de fora.
 *
 * Mede assim, e não "pixels escuros", porque a capa tem dois desenhos
 * possíveis: o texto (escuro) quando a fonte resolve e as barras (cinza claro)
 * quando não resolve. Contar só o escuro daria a folha por vazia numa máquina
 * sem fonte instalada, que é um ambiente legítimo e não uma falha.
 */
async function inkPixels(webp: Buffer): Promise<number> {
  const margin = 3
  const { data } = await sharp(webp)
    .extract({
      left: margin,
      top: margin,
      width: THUMB_WIDTH - margin * 2,
      height: THUMB_HEIGHT - margin * 2,
    })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let ink = 0
  for (let i = 0; i < data.length; i++) if (data[i] < 240) ink++
  return ink
}

describe('textThumb', () => {
  it('desenha uma folha no tamanho combinado', async () => {
    const thumb = await textThumb('Contrato de prestação de serviços\nCláusula quarta — do prazo')
    expect(thumb).not.toBeNull()
    const meta = await sharp(thumb!).metadata()
    expect(meta.format).toBe('webp')
    expect(meta.width).toBe(THUMB_WIDTH)
    expect(meta.height).toBe(THUMB_HEIGHT)
  })

  it('a folha sai com conteúdo, e não limpa', async () => {
    const thumb = await textThumb('Primeira linha do documento\nSegunda linha do documento')
    // A moldura está fora da conta, então qualquer tinta aqui é conteúdo.
    expect(await inkPixels(thumb!)).toBeGreaterThan(100)
  })

  it('dois textos diferentes geram capas diferentes — é o ponto de existir', async () => {
    const a = await textThumb('Ata da reunião de 12 de março, pauta e encaminhamentos')
    const b = await textThumb('Lista de compras: café, açúcar, farinha')
    expect(Buffer.compare(a!, b!)).not.toBe(0)
  })

  it('texto vazio ou só espaços não vira capa (a linha fica com o ícone)', async () => {
    expect(await textThumb('')).toBeNull()
    expect(await textThumb('   \n\n  \t ')).toBeNull()
  })

  it('caractere de marcação no texto não quebra o SVG', async () => {
    // Um `<` solto invalidaria o XML e o sharp recusaria a imagem inteira.
    const thumb = await textThumb('if (a < b && c > d) { return "x" }\nsegunda linha')
    expect(thumb).not.toBeNull()
    expect(await inkPixels(thumb!)).toBeGreaterThan(100)
  })

  it('linha muito longa não vaza da folha', async () => {
    // Se a linha não fosse cortada, o SVG renderizaria texto fora do quadro —
    // o tamanho continua o mesmo, então o que se verifica é que não falhou.
    const thumb = await textThumb('x'.repeat(4000))
    const meta = await sharp(thumb!).metadata()
    expect(meta.width).toBe(THUMB_WIDTH)
  })

  it('documento com espaçamento duplo aproveita a folha toda', async () => {
    // Linhas em branco puladas: senão metade da capa seria vazio.
    const espacado = Array.from({ length: 12 }, (_, i) => `linha ${i}\n`).join('\n')
    const compacto = Array.from({ length: 12 }, (_, i) => `linha ${i}`).join('\n')
    expect(await inkPixels((await textThumb(espacado))!)).toBe(
      await inkPixels((await textThumb(compacto))!),
    )
  })
})

describe('pageThumb', () => {
  it('encaixa a página no quadro sem recortar o topo', async () => {
    // Página "alta" com uma faixa preta no topo: com `cover` ela seria cortada.
    const page = await sharp({
      create: { width: 600, height: 900, channels: 3, background: '#ffffff' },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 600, height: 60, channels: 3, background: '#000000' },
          })
            .png()
            .toBuffer(),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer()

    const thumb = await pageThumb(page)
    const meta = await sharp(thumb!).metadata()
    expect(meta.width).toBe(THUMB_WIDTH)
    expect(meta.height).toBe(THUMB_HEIGHT)
    expect(await inkPixels(thumb!)).toBeGreaterThan(400)
  })

  it('bytes que não são imagem devolvem null em vez de estourar', async () => {
    expect(await pageThumb(Buffer.from('nem de longe um png'))).toBeNull()
  })
})
