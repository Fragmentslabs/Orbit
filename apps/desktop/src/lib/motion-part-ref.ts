import type { ToolPart } from "@shared/chat"

/**
 * De onde o card da composição reabre a peça.
 *
 * O agente endereça a composição de DOIS jeitos, e o card tem de entender os
 * dois: no modo CÓDIGO ela é uma pasta do projeto e a tool recebe `path`
 * (motion_preview); no modo CHAT ela mora no armazenamento do Orbit, uma pasta
 * por conversa, e a tool recebe `name` (motion_write / motion_edit).
 *
 * O segundo caso é o que faltava: sem caminho nenhum no `input` o card devolvia
 * null, e a composição criada no chat não tinha card na conversa.
 */
export interface MotionPartRef {
  /** Composição da pasta do projeto: o caminho que o agente passou à tool. */
  path?: string
  /** Composição da conversa: o nome (já normalizado) que a tool relata. */
  name?: string
  /** Título do card: o nome da peça quando há um, senão o fim do caminho. */
  label: string
  /** Formato medido pela tool ("1920×1080 · 38s"), quando o relatório traz. */
  format?: string
}

/** O nome da peça no relatório da tool: `Motion "<nome>" …`. */
export function motionNameInReport(output: string | undefined): string | null {
  return output?.match(/Motion "([^"]+)"/)?.[1] ?? null
}

/**
 * O formato medido, lido do mesmo relatório (`… loads fine: 1920x1080, 1140
 * frames at 30 fps (38.00 s).`). É o que o card mostra no lugar onde o de
 * documento mostra o tipo — medido pela tool, não adivinhado pelo renderer.
 */
export function motionFormatInReport(output: string | undefined): string | null {
  const match = output?.match(/loads fine:\s*(\d+)x(\d+),\s*\d+\s*frames at\s*([\d.]+)\s*fps\s*\(([\d.]+)\s*s\)/)
  if (!match) return null
  return `${match[1]}×${match[2]} · ${Number(match[4])}s`
}

/** Último segmento do caminho, sem depender do path do node no renderer. */
function lastSegment(value: string): string {
  const segments = value.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? value
}

/**
 * A referência que o card usa para reabrir — ou null quando a tool não deixou
 * nem caminho nem nome para seguir (aí não há card: um botão que não abre nada
 * é pior do que card nenhum).
 */
export function motionRefOf(part: ToolPart): MotionPartRef | null {
  const input = part.input ?? {}
  const reported = motionNameInReport(part.output)
  const format = motionFormatInReport(part.output) ?? undefined
  // Caminho primeiro: quando ele existe, é o endereço mais preciso da peça.
  for (const key of ["path", "target", "file"]) {
    const value = input[key]
    if (typeof value === "string" && value) {
      return { path: value, label: reported ?? lastSegment(value), format }
    }
  }
  // Sem caminho, a peça é da CONVERSA — o nome é o que a tool relatou (já
  // normalizado para o slug que dá nome à pasta).
  if (reported) return { name: reported, label: reported, format }
  return null
}
