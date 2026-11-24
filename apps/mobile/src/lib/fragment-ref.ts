import type { ToolPart } from '@orbit/shared'

/** `frag-<slug>-<hex>`: what `fragment_create` returns and the other fragment tools take. */
const FRAGMENT_ID = /\bfrag-[a-z0-9]+(?:-[a-z0-9]+)*\b/

/**
 * The fragment a tool part is about. `fragment_create` carries it only in its RESULT (the tool
 * answers `{ fragmentId, message }`, serialized); the others take it as input. Pure.
 */
export function fragmentIdOfPart(part: Pick<ToolPart, 'input' | 'output'>): string | null {
  const fromInput = part.input?.fragmentId
  if (typeof fromInput === 'string' && FRAGMENT_ID.test(fromInput)) return fromInput
  const found = part.output ? FRAGMENT_ID.exec(part.output) : null
  return found ? found[0] : null
}
