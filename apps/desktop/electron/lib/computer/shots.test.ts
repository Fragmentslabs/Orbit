import { describe, expect, it } from 'vitest'
import { forgetShots, markerFor, rememberShot, rememberTarget, shotView } from './shots'
import type { ShotGeometry } from './geometry'

/**
 * A miniatura do painel: só o último screenshot por conversa, em memória, com
 * o alvo da última ação convertido para o espaço da imagem.
 */

const geometry: ShotGeometry = { frame: [100, 50, 1000, 800], width: 1280, height: 1024 }
const shot = (at: number) => ({ data: Buffer.from('img'), mediaType: 'image/webp', geometry, app: 'TextEdit', at })

describe('markerFor', () => {
  it('frame global → retângulo na imagem', () => {
    expect(markerFor(geometry, { frame: [1000, 750, 80, 30] })).toMatchObject({ x: 1152, y: 896, w: 102, h: 38 })
  })

  it('ponto vira retângulo de tamanho 0', () => {
    expect(markerFor(geometry, { point: [600, 450] })).toMatchObject({ x: 640, y: 512, w: 0, h: 0 })
  })

  it('alvo fora da janela não tem marcador', () => {
    expect(markerFor(geometry, { point: [5000, 5000] })).toBeNull()
  })
})

describe('último screenshot', () => {
  it('guarda só o mais recente, e o alvo da ação vale para o screenshot seguinte', () => {
    rememberShot('s1', shot(1))
    rememberTarget('s1', { point: [600, 450] }, 'left_click')
    rememberShot('s1', shot(2))
    const view = shotView('s1')
    expect(view?.at).toBe(2)
    expect(view?.dataUrl.startsWith('data:image/webp;base64,')).toBe(true)
    expect(view?.marker).toMatchObject({ x: 640, y: 512, label: 'left_click' })
  })

  it('conversas não se misturam e o fim do controle limpa a memória', () => {
    rememberShot('s2', shot(3))
    expect(shotView('s3')).toBeNull()
    forgetShots('s2')
    expect(shotView('s2')).toBeNull()
  })
})
