import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '../asset-lock'

/**
 * The index of a design canvas: `canvas.json` at the root of the registered folder.
 *
 * Mirrors the `canvas.json` of Anthropic's "Design" artifact (see the conversation
 * that motivated this): a JSON index holding only the LAYOUT — position and size of
 * each artboard on the infinite canvas — and each artboard is a separate
 * self-contained HTML file. No per-element geometry here: the content of each
 * artboard is real HTML/CSS (flex/grid), resolved by the browser itself — which is
 * what avoids a parallel model (tree + synchronization) and keeps AI generation
 * cheap (see the discussion that motivated this feature).
 */

export interface DesignBoard {
  title?: string
  x: number
  y: number
  w: number
  h: number
}

export interface DesignCanvas {
  v: 1
  title?: string
  /** One artboard per key, the name of the .html file inside the same folder. */
  boards: Record<string, DesignBoard>
  /** The same keys of `boards`, back to front (stacking). */
  order: string[]
}

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.html?$/
const SAFE_STYLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.css$/

/** Valid artboard file name: flat, ends in .html/.htm, no path. */
export function isSafeBoardFile(file: string): boolean {
  return SAFE_FILE.test(file)
}

/**
 * Name of the canvas' shared style sheet (e.g. "base.css"): flat, ends in .css,
 * no path. The scheme serves any file of the folder, so a
 * <link rel="stylesheet" href="base.css"> inside the artboard resolves.
 */
export function isSafeStyleFile(file: string): boolean {
  return SAFE_STYLE.test(file)
}

function validate(value: unknown): DesignCanvas {
  const raw = value as Partial<DesignCanvas> | null
  if (!raw || typeof raw !== 'object' || typeof raw.boards !== 'object' || raw.boards === null || !Array.isArray(raw.order)) {
    throw new Error('canvas.json malformado (esperado {boards, order})')
  }
  return {
    v: 1,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    boards: raw.boards as Record<string, DesignBoard>,
    order: raw.order.filter((f): f is string => typeof f === 'string'),
  }
}

export async function readDesignCanvas(folder: string): Promise<DesignCanvas> {
  const raw = await fsp.readFile(path.join(folder, 'canvas.json'), 'utf8')
  return validate(JSON.parse(raw))
}

export async function writeDesignCanvas(folder: string, canvas: DesignCanvas): Promise<void> {
  await fsp.mkdir(folder, { recursive: true })
  await writeFileAtomic(path.join(folder, 'canvas.json'), JSON.stringify(canvas, null, 2))
}
