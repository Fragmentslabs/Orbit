import { globalToShot, type ShotGeometry } from './geometry'
import type { Frame } from './types'

/**
 * Último screenshot de cada conversa, em memória, com o ponto da última ação —
 * é o que a miniatura do painel de ações mostra. Os screenshots do Computer Use
 * NÃO vão para a galeria: com uma observação por ação (read_back), uma tarefa
 * curta já gravaria dezenas de arquivos na aba de mídia. O modelo recebe a
 * imagem pelo toModelOutput; a pessoa vê só a mais recente, aqui.
 */

export interface ShotTarget {
  /** Frame global do elemento (clique por índice) */
  frame?: Frame
  /** Ponto global (clique por x/y, rolagem) */
  point?: [number, number]
}

interface LastShot {
  data: Buffer
  mediaType: string
  geometry: ShotGeometry
  app: string
  at: number
  /** Em pontos globais: vale para o screenshot seguinte da mesma janela também */
  target: (ShotTarget & { label: string; at: number }) | null
}

export interface ShotView {
  dataUrl: string
  width: number
  height: number
  app: string
  at: number
  /** Retângulo no espaço do screenshot (ponto = tamanho 0) */
  marker: { x: number; y: number; w: number; h: number; label: string } | null
}

const shots = new Map<string, LastShot>()

/** Guarda o screenshot novo; o alvo da última ação continua (é a mesma janela, depois da ação). */
export function rememberShot(sessionId: string, shot: Omit<LastShot, 'target'>): void {
  const previous = shots.get(sessionId)
  shots.set(sessionId, { ...shot, target: previous?.target ?? null })
}

export function rememberTarget(sessionId: string, target: ShotTarget, label: string): void {
  const shot = shots.get(sessionId)
  if (shot) shot.target = { ...target, label, at: Date.now() }
}

export function forgetShots(sessionId: string): void {
  shots.delete(sessionId)
}

/** O marcador no espaço da imagem — fora dela (janela mudou, elemento rolado), sem marcador. */
export function markerFor(geometry: ShotGeometry, target: ShotTarget): ShotView['marker'] {
  const frame: Frame | null = target.frame ?? (target.point ? [target.point[0], target.point[1], 0, 0] : null)
  if (!frame) return null
  const [x, y, w, h] = globalToShot(geometry, frame)
  if (x + w < 0 || y + h < 0 || x > geometry.width || y > geometry.height) return null
  return { x, y, w, h, label: '' }
}

export function shotView(sessionId: string): ShotView | null {
  const shot = shots.get(sessionId)
  if (!shot) return null
  const marker = shot.target ? markerFor(shot.geometry, shot.target) : null
  return {
    dataUrl: `data:${shot.mediaType};base64,${shot.data.toString('base64')}`,
    width: shot.geometry.width,
    height: shot.geometry.height,
    app: shot.app,
    at: shot.at,
    marker: marker && shot.target ? { ...marker, label: shot.target.label } : null,
  }
}
