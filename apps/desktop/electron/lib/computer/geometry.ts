import { ComputerError, type Frame } from './types'

/**
 * Espaços de coordenada do Computer Use no macOS:
 *  - pontos globais: o espaço do AX, do CGWindowList e dos eventos (origem no
 *    topo esquerdo do monitor principal; monitores à esquerda/acima ficam
 *    negativos);
 *  - pixels do screenshot: o que o modelo vê, já reduzido ao lado máximo.
 * Entre os dois só existe a razão de escala da janela — a conversão DIP↔px do
 * Windows não entra aqui.
 */

export interface ShotGeometry {
  /** Frame da janela em pontos globais */
  frame: Frame
  /** Tamanho do espaço de coordenadas mostrado ao modelo */
  width: number
  height: number
}

/** Tamanho que cabe em `maxEdge` mantendo a proporção (nunca amplia). */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width: Math.round(width), height: Math.round(height) }
  const ratio = maxEdge / longest
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }
}

/**
 * O espaço de coordenadas de uma janela: o tamanho que o screenshot dela tem
 * (pontos × escala do monitor, reduzido ao lado máximo). É o MESMO com ou sem
 * screenshot na observação — antes, sem screenshot, x/y viravam pontos da
 * janela, e o agente que repetia "os mesmos passos" de uma observação com
 * imagem errava pela metade num monitor Retina (visto na Fase 0: o arrasto
 * caiu abaixo da linha de texto e não selecionou nada).
 */
export function windowSpace(frame: Frame, scale: number, maxEdge: number): ShotGeometry {
  const size = fitWithin(frame[2] * scale, frame[3] * scale, maxEdge)
  return { frame, width: size.width, height: size.height }
}

/** Ponto do screenshot → ponto global. Fora da imagem é erro, não um clique em outro app. */
export function shotToGlobal(g: ShotGeometry, x: number, y: number): [number, number] {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > g.width || y > g.height) {
    throw new ComputerError(
      'badRequest',
      `Point (${x}, ${y}) is outside the screenshot (${g.width}×${g.height}). Coordinates are pixels of the LAST cu_observe screenshot of this window.`,
    )
  }
  const [fx, fy, fw, fh] = g.frame
  return [round2(fx + (x * fw) / g.width), round2(fy + (y * fh) / g.height)]
}

/** Frame global → retângulo no espaço do screenshot (para a árvore apontar onde o elemento está na imagem). */
export function globalToShot(g: ShotGeometry, frame: Frame): Frame {
  const [fx, fy, fw, fh] = g.frame
  const sx = g.width / fw
  const sy = g.height / fh
  return [Math.round((frame[0] - fx) * sx), Math.round((frame[1] - fy) * sy), Math.round(frame[2] * sx), Math.round(frame[3] * sy)]
}

export function frameCenter(frame: Frame): [number, number] {
  return [round2(frame[0] + frame[2] / 2), round2(frame[1] + frame[3] / 2)]
}

/** O elemento aparece na janela? (frame zerado ou fora dela = rolado para fora/oculto) */
export function visibleIn(window: Frame, frame: Frame): boolean {
  if (frame[2] <= 0 || frame[3] <= 0) return false
  return frame[0] < window[0] + window[2] && frame[0] + frame[2] > window[0] && frame[1] < window[1] + window[3] && frame[1] + frame[3] > window[1]
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
