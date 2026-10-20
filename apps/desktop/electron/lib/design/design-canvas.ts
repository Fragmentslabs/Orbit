import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '../asset-lock'

/**
 * O índice de um canvas de design: `canvas.json` na raiz da pasta registrada.
 *
 * Espelha o `canvas.json` do appifact "Design" da Anthropic (ver a conversa que
 * motivou isto): um índice JSON só com o ARRANJO — posição e tamanho de cada
 * artboard no canvas infinito — e cada artboard é um arquivo HTML autocontido à
 * parte. Nada de geometria por elemento aqui: o conteúdo de cada artboard é
 * HTML/CSS de verdade (flex/grid), resolvido pelo próprio navegador — é o que
 * evita um modelo paralelo (árvore + sincronização) e mantém a geração por IA
 * barata (ver a discussão que motivou este recurso).
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
  /** Um artboard por chave, o nome do arquivo .html dentro da mesma pasta. */
  boards: Record<string, DesignBoard>
  /** As mesmas chaves de `boards`, de trás para frente (empilhamento). */
  order: string[]
}

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.html?$/

/** Nome de arquivo de artboard válido: plano, termina em .html/.htm, sem path. */
export function isSafeBoardFile(file: string): boolean {
  return SAFE_FILE.test(file)
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
