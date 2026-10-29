import type { PieceKind, PieceRef } from '@orbit/shared'
import type { ComponentType } from 'react'

import { DesignViewer } from './design'
import { MotionViewer } from './motion'
import { SlidesViewer } from './slides'

/**
 * O contrato entre a casca (`PieceViewer`) e cada tipo.
 *
 * Cada viewer recebe a peça já endereçada e ocupa o corpo da tela cheia — sem
 * cabeçalho, sem moldura: quem desenha a moldura é a casca, uma vez só, para os
 * três tipos ficarem idênticos.
 */
export interface PieceViewerProps {
  piece: PieceRef
}

/**
 * Um arquivo por tipo, e nada compartilhado entre eles: é o que permite os três
 * serem escritos em paralelo sem um pisar no outro.
 */
export const VIEWERS: Record<PieceKind, ComponentType<PieceViewerProps>> = {
  motion: MotionViewer,
  design: DesignViewer,
  slides: SlidesViewer,
}
