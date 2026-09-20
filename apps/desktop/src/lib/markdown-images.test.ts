import { describe, expect, it } from 'vitest'

import {
  isExternalSrc,
  markdownImageSources,
  withResolvedImages,
} from './markdown-images'

/**
 * A pré-visualização de .md mostrava "Image not available" em todo documento
 * com figura: o caminho relativo resolvia contra a origem do app, não contra a
 * pasta do arquivo. Achar o que perguntar e trocar depois é o que estes testes
 * protegem — errar aqui quebra a figura de novo, e em silêncio.
 */
describe('markdownImageSources', () => {
  it('acha as três formas que aparecem em documentação', () => {
    const md = [
      '![tela](./imagens/producao.png)',
      '![com titulo](../docs/fluxo.png "Fluxo")',
      '![com espaco](<pasta com espaco/x.png>)',
      '<img src="assets/logo.svg" width="40">',
    ].join('\n\n')

    expect(markdownImageSources(md).sort()).toEqual([
      '../docs/fluxo.png',
      './imagens/producao.png',
      'assets/logo.svg',
      'pasta com espaco/x.png',
    ])
  })

  it('o título não entra no caminho', () => {
    expect(markdownImageSources('![a](img/x.png "Uma legenda")')).toEqual(['img/x.png'])
  })

  it('não repete o mesmo caminho', () => {
    expect(markdownImageSources('![a](img/x.png)\n\n![b](img/x.png)')).toEqual(['img/x.png'])
  })

  it('deixa quem o renderer já carrega sozinho', () => {
    const md = [
      '![remota](https://exemplo.com/a.png)',
      '![embutida](data:image/png;base64,AAAA)',
      '![galeria](orbit-media://img_1.png)',
      '![sem protocolo](//cdn.exemplo.com/b.png)',
    ].join('\n\n')

    expect(markdownImageSources(md)).toEqual([])
  })

  it('não confunde link com figura', () => {
    expect(markdownImageSources('[não é imagem](./doc.md)')).toEqual([])
  })
})

describe('isExternalSrc', () => {
  it('separa endereço de caminho', () => {
    expect(isExternalSrc('https://a/b.png')).toBe(true)
    expect(isExternalSrc('data:image/png;base64,AA')).toBe(true)
    expect(isExternalSrc('orbit-artifact://x.png')).toBe(true)
    expect(isExternalSrc('./a/b.png')).toBe(false)
    expect(isExternalSrc('../a/b.png')).toBe(false)
    expect(isExternalSrc('a/b.png')).toBe(false)
  })
})

describe('withResolvedImages', () => {
  it('troca o caminho pelo data URL, preservando o resto da linha', () => {
    const out = withResolvedImages('![tela](./imagens/x.png "Legenda")', {
      './imagens/x.png': 'data:image/png;base64,AA',
    })

    expect(out).toBe('![tela](data:image/png;base64,AA "Legenda")')
  })

  it('troca no caminho com espaço, sem desfazer os <>', () => {
    const out = withResolvedImages('![a](<pasta com espaco/x.png>)', {
      'pasta com espaco/x.png': 'data:image/png;base64,AA',
    })

    expect(out).toBe('![a](<data:image/png;base64,AA>)')
  })

  it('troca também no <img>', () => {
    const out = withResolvedImages('<img src="assets/logo.svg" width="40">', {
      'assets/logo.svg': 'data:image/svg+xml;base64,BB',
    })

    expect(out).toBe('<img src="data:image/svg+xml;base64,BB" width="40">')
  })

  it('figura que não resolveu fica como estava — é assim que se vê que falta', () => {
    const out = withResolvedImages('![existe](a.png)\n\n![sumiu](b.png)', {
      'a.png': 'data:image/png;base64,AA',
    })

    expect(out).toContain('![existe](data:image/png;base64,AA)')
    expect(out).toContain('![sumiu](b.png)')
  })

  it('sem nada resolvido, devolve o texto intacto', () => {
    const md = '![a](x.png)'

    expect(withResolvedImages(md, {})).toBe(md)
  })
})
