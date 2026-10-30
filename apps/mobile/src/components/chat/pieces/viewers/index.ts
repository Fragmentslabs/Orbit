import type { PieceKind, PieceRef } from '@orbit/shared'
import type { ComponentType } from 'react'

import { DesignViewer } from './design'
import { MotionViewer } from './motion'
import { SlidesViewer } from './slides'

/**
 * The contract between the shell (`PieceViewer`) and each type.
 *
 * Each viewer receives the piece already addressed and fills the body of the full screen — without
 * header, without frame: whoever draws the frame is the shell, once only, so the
 * three types come out identical.
 */
export interface PieceViewerProps {
  piece: PieceRef
}

/**
 * One file per type, and nothing shared between them: that is what allows the three
 * to be written in parallel without one stepping on the other.
 */
export const VIEWERS: Record<PieceKind, ComponentType<PieceViewerProps>> = {
  motion: MotionViewer,
  design: DesignViewer,
  slides: SlidesViewer,
}
