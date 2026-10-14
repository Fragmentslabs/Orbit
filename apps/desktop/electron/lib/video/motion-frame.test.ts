import { describe, expect, it, vi } from 'vitest'

// O módulo abre uma janela para capturar (é do main) e registra a composição no
// motion-store, que toca `app`/`protocol`. Nenhum teste daqui abre janela: só as
// partes puras e a montagem da folha (canvas, sem Electron) são exercitadas.
vi.mock('electron', async () => {
  const nodePath = await import('node:path')
  const nodeOs = await import('node:os')
  return {
    app: { getPath: () => nodePath.join(nodeOs.tmpdir(), `orbit-motion-frame-test-${process.pid}`) },
    BrowserWindow: { getAllWindows: () => [] },
    protocol: { handle: () => {} },
  }
})

const { MAX_FRAME_TIMES, frameLabel, framesFromTimes, renderFrameSheet, sheetCell, sheetColumns, sheetFileName, sheetLayout } =
  await import('./motion-frame')

/** Um "quadro" falso: qualquer PNG serve, a folha só desenha. */
async function shot(): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const canvas = createCanvas(320, 180)
  const g = canvas.getContext('2d')
  g.fillStyle = '#204060'
  g.fillRect(0, 0, 320, 180)
  return canvas.toBuffer('image/png')
}

describe('conversão tempo → quadro', () => {
  it('converte segundos no fps da composição, para o quadro mais próximo', () => {
    expect(framesFromTimes([0.5, 1, 2.4], { fps: 30 })).toEqual([15, 30, 72])
    expect(framesFromTimes([0.5, 1], { fps: 60 })).toEqual([30, 60])
    expect(framesFromTimes([1 / 30], { fps: 30 })).toEqual([1])
    // O caso do guia: palavra dita em 2,4 s num overlay a 30 fps = quadro 72.
    expect(framesFromTimes([2.4], { fps: 30 })[0]).toBe(72)
  })

  it('arredonda para o quadro mais próximo e preserva a ordem pedida', () => {
    // 2,41 s a 30 fps cai no quadro 72 (2,40 s) — o rótulo mostra o tempo PEDIDO.
    expect(framesFromTimes([2.41], { fps: 30 })).toEqual([72])
    expect(frameLabel(2410, 72)).toBe('2.41s · f72')
    expect(framesFromTimes([2, 0.5, 2], { fps: 30 })).toEqual([60, 15, 60])
  })

  it('prende o fim do clipe no último quadro', () => {
    // 4 s a 30 fps = 120 quadros (0…119): o fim exato é o ÚLTIMO quadro.
    expect(framesFromTimes([4], { fps: 30, durationInFrames: 120 })).toEqual([119])
    expect(framesFromTimes([3.999], { fps: 30, durationInFrames: 120 })).toEqual([119])
    // Um clipe de um quadro só: instante válido nenhum escapa dele (o máximo são
    // 1/30 s, e o quadro 1 que ele arredondaria é preso no último, o 0).
    expect(framesFromTimes([0.02], { fps: 30, durationInFrames: 1 })).toEqual([0])
    expect(() => framesFromTimes([1], { fps: 30, durationInFrames: 1 })).toThrow(/past the end/)
  })
})

describe('validação dos instantes', () => {
  it('recusa lista vazia, acima do teto, zero, negativo e não-número', () => {
    expect(() => framesFromTimes([], { fps: 30 })).toThrow(/at least one instant/)
    const tooMany = Array.from({ length: MAX_FRAME_TIMES + 1 }, (_, i) => (i + 1) / 30)
    expect(() => framesFromTimes(tooMany, { fps: 30 })).toThrow(new RegExp(`at most ${MAX_FRAME_TIMES}`))
    expect(() => framesFromTimes([0], { fps: 30 })).toThrow(/invalid instant/)
    expect(() => framesFromTimes([-1], { fps: 30 })).toThrow(/invalid instant/)
    expect(() => framesFromTimes([Number.NaN], { fps: 30 })).toThrow(/invalid instant/)
    expect(() => framesFromTimes([Number.POSITIVE_INFINITY], { fps: 30 })).toThrow(/invalid instant/)
    // O teto em si é aceito.
    expect(framesFromTimes(tooMany.slice(0, MAX_FRAME_TIMES), { fps: 30 })).toHaveLength(MAX_FRAME_TIMES)
  })

  it('recusa instante além do fim da composição, citando o máximo', () => {
    expect(() => framesFromTimes([4.5], { fps: 30, durationInFrames: 120 })).toThrow(/past the end of the composition \(4\.00s max/)
    // Dentro do clipe passa; sem duração conhecida, nada é recusado por tempo.
    expect(framesFromTimes([3.5], { fps: 30, durationInFrames: 120 })).toEqual([105])
    expect(framesFromTimes([100], { fps: 30 })).toEqual([3000])
  })

  it('recusa fps inválido', () => {
    expect(() => framesFromTimes([1], { fps: 0 })).toThrow(/invalid fps/)
    expect(() => framesFromTimes([1], { fps: Number.NaN })).toThrow(/invalid fps/)
  })
})

describe('geometria da folha', () => {
  it('escolhe as colunas pela quantidade de instantes', () => {
    expect(sheetColumns(1)).toBe(1)
    expect(sheetColumns(2)).toBe(2)
    expect(sheetColumns(4)).toBe(2)
    expect(sheetColumns(5)).toBe(4)
    expect(sheetColumns(MAX_FRAME_TIMES)).toBe(4)
  })

  it('cabe na largura e cresce com as linhas', () => {
    const one = sheetLayout({ count: 1, width: 1600, aspect: 16 / 9 })
    const two = sheetLayout({ count: 2, width: 1600, aspect: 16 / 9 })
    const five = sheetLayout({ count: 5, width: 1600, aspect: 16 / 9 })
    expect(one.columns).toBe(1)
    expect(two.rows).toBe(1)
    expect(five.rows).toBe(2)
    // Mesma largura de folha: a célula encolhe quando entra mais uma coluna, e
    // a folha fica mais alta quando entra mais uma linha.
    expect(one.cellWidth).toBeGreaterThan(two.cellWidth)
    expect(two.height).toBeLessThan(five.height)
    // Sem largura declarada, a folha tem a largura padrão do video_timeline.
    expect(sheetLayout({ count: 2 }).width).toBe(1600)
    // Aspecto inválido cai no 16:9.
    expect(sheetLayout({ count: 1, aspect: 0 }).cellHeight).toBeCloseTo(sheetLayout({ count: 1, aspect: 16 / 9 }).cellHeight, 5)
    // Contagem degenerada não gera folha de zero células.
    expect(sheetLayout({ count: 0 }).rows).toBe(1)
    expect(sheetLayout({ count: 0 }).columns).toBe(1)
  })

  it('põe cada célula dentro da folha, sem sobreposição', () => {
    const geometry = sheetLayout({ count: 5, width: 1600, aspect: 16 / 9 })
    const cells = Array.from({ length: 5 }, (_, i) => sheetCell(geometry, i))
    for (const cell of cells) {
      expect(cell.x).toBeGreaterThanOrEqual(geometry.pad)
      expect(cell.x + cell.width).toBeLessThanOrEqual(geometry.width - geometry.pad + 1)
      expect(cell.y).toBeGreaterThanOrEqual(geometry.pad + geometry.header - 1)
      expect(cell.y + cell.height).toBeLessThanOrEqual(geometry.height - geometry.pad + 1)
    }
    // A segunda coluna fica à direita da primeira; a segunda linha, abaixo.
    expect(cells[1].x).toBeGreaterThan(cells[0].x + cells[0].width)
    expect(cells[4].y).toBeGreaterThan(cells[0].y + cells[0].height)
    // Os quatro primeiros instantes dividem a linha de cima.
    expect(cells[3].y).toBe(cells[0].y)
  })

  it('arruma o teto de instantes em duas linhas de quatro', () => {
    const geometry = sheetLayout({ count: MAX_FRAME_TIMES, width: 1600, aspect: 16 / 9 })
    expect(geometry.columns).toBe(4)
    expect(geometry.rows).toBe(2)
    const cells = Array.from({ length: MAX_FRAME_TIMES }, (_, i) => sheetCell(geometry, i))
    // A quinta célula abre a linha de baixo, alinhada com a primeira.
    expect(cells[4].y).toBeGreaterThan(cells[3].y)
    expect(cells[4].x).toBe(cells[0].x)
    // Nenhuma célula escapa da folha.
    for (const cell of cells) {
      expect(cell.x + cell.width).toBeLessThanOrEqual(geometry.width)
      expect(cell.y + cell.height).toBeLessThanOrEqual(geometry.height)
    }
  })

  it('nomeia a folha a partir da pasta da composição', () => {
    expect(sheetFileName('title')).toBe('title.webp')
    expect(sheetFileName('lower third')).toBe('lower-third.webp')
    expect(sheetFileName('')).toBe('motion.webp')
    expect(sheetFileName('../../etc')).toBe('etc.webp')
    // Separadores repetidos viram um só, e nada começa/termina em ponto ou hífen.
    expect(sheetFileName('aaa   bbb')).toBe('aaa-bbb.webp')
    expect(sheetFileName('..')).toBe('motion.webp')
    expect(sheetFileName('shot.')).toBe('shot.webp')
  })

  it('rotula a célula com o tempo e o quadro', () => {
    expect(frameLabel(2400, 72)).toBe('2.40s · f72')
    expect(frameLabel(500, 15)).toBe('0.50s · f15')
  })
})

describe('montagem da folha (canvas, sem Electron)', () => {
  it('desenha um webp com o tamanho da grade', async () => {
    const png = await shot()
    const shots = [
      { png, timeMs: 0, frame: 0 },
      { png, timeMs: 1200, frame: 36 },
      { png, timeMs: 2400, frame: 72 },
    ]
    const image = await renderFrameSheet({ title: 'title', fps: 30, durationInFrames: 120, shots })
    expect(image.subarray(0, 4).toString()).toBe('RIFF')
    expect(image.subarray(8, 12).toString()).toBe('WEBP')
    const { loadImage } = await import('@napi-rs/canvas')
    const decoded = await loadImage(image)
    const geometry = sheetLayout({ count: shots.length, aspect: 320 / 180 })
    expect(decoded.width).toBe(geometry.width)
    expect(decoded.height).toBe(geometry.height)
  })

  it('uma única célula ocupa a folha inteira', async () => {
    const png = await shot()
    const image = await renderFrameSheet({ title: 'title', fps: 30, shots: [{ png, timeMs: 1000, frame: 30 }] })
    const { loadImage } = await import('@napi-rs/canvas')
    const decoded = await loadImage(image)
    const geometry = sheetLayout({ count: 1, aspect: 320 / 180 })
    expect(decoded.width).toBe(geometry.width)
    expect(decoded.height).toBe(geometry.height)
  })

  it('sem quadro nenhum, é erro (nunca uma folha vazia)', async () => {
    await expect(renderFrameSheet({ title: 'title', fps: 30, shots: [] })).rejects.toThrow(/no frames/)
  })
})
