/**
 * How the agent's write lands in the buffer open in the panel.
 *
 * The agent does not type: it calls `write` (whole file) or `edit`
 * (stretch replacement) and saves all at once. The renderer already receives those
 * calls through the chat's `part` event, with the input — so the change can be applied
 * INSIDE the open document instead of reloading over it.
 *
 * The difference matters: reloading throws away the cursor, selection, scroll, undo
 * history and any unsaved draft. Applying it as a point change
 * preserves all of that, and it is what makes the agent edit look like it happens
 * there, instead of the file blinking.
 *
 * `edit` still brings an advantage `write` does not have: it states the INTENT
 * (replace this with that), not just the final bytes. With the intent it is possible to
 * merge safely even if the person touched ANOTHER part of the
 * file — and to know, precisely, when it is not possible.
 */

export type AgentWrite =
  | { kind: 'edit'; oldString: string; newString: string; replaceAll?: boolean }
  | { kind: 'write'; content: string }

export interface DocChange {
  from: number
  to: number
  insert: string
}

export type MergePlan =
  /** It can be applied without ambiguity. */
  | { kind: 'apply'; changes: DocChange[] }
  /** The buffer is already the way the agent wants it (or the agent changed nothing). */
  | { kind: 'noop' }
  /**
   * The stretch the agent expected no longer exists in the buffer, or exists in
   * several places. Applying would be guessing — the person decides.
   */
  | { kind: 'conflict'; reason: 'not-found' | 'ambiguous' }

function occurrences(doc: string, needle: string): number[] {
  if (!needle) return []
  const found: number[] = []
  let at = doc.indexOf(needle)
  while (at >= 0) {
    found.push(at)
    at = doc.indexOf(needle, at + needle.length)
  }
  return found
}

/**
 * The smallest change that turns `doc` into `next`: trims the common prefix and
 * suffix and replaces only the middle.
 *
 * It is not a real diff — two changes far apart from each other become one
 * big middle that covers both. But the agent's normal case is a single
 * region, and then what is left is exactly it: the cursor of whoever is reading the rest
 * of the file does not move.
 */
export function minimalChange(doc: string, next: string): DocChange | null {
  if (doc === next) return null
  const max = Math.min(doc.length, next.length)
  let start = 0
  while (start < max && doc[start] === next[start]) start++
  let endDoc = doc.length
  let endNext = next.length
  while (endDoc > start && endNext > start && doc[endDoc - 1] === next[endNext - 1]) {
    endDoc--
    endNext--
  }
  return { from: start, to: endDoc, insert: next.slice(start, endNext) }
}

/** What to do with the agent's write, given the current buffer content. */
export function planMerge(doc: string, write: AgentWrite): MergePlan {
  if (write.kind === 'write') {
    const change = minimalChange(doc, write.content)
    return change ? { kind: 'apply', changes: [change] } : { kind: 'noop' }
  }

  const { oldString, newString, replaceAll } = write
  if (oldString === newString) return { kind: 'noop' }
  const at = occurrences(doc, oldString)
  if (at.length === 0) {
    // Either the person edited exactly that stretch, or the file was already
    // different from what the agent read. In both cases, there is no guessing.
    return { kind: 'conflict', reason: 'not-found' }
  }
  if (at.length > 1 && !replaceAll) {
    // The agent counted on a unique stretch. If there are several now, the buffer
    // diverged from what it read and applying to the first would be a guess.
    return { kind: 'conflict', reason: 'ambiguous' }
  }
  const targets = replaceAll ? at : [at[0]]
  return {
    kind: 'apply',
    changes: targets.map((from) => ({ from, to: from + oldString.length, insert: newString })),
  }
}

/** The write described by an agent tool call, or null if it is not one. */
export function agentWriteFromTool(
  tool: string,
  input: Record<string, unknown> | undefined,
): { filePath: string; write: AgentWrite } | null {
  if (!input || typeof input.filePath !== 'string') return null
  if (tool === 'write' && typeof input.content === 'string') {
    return { filePath: input.filePath, write: { kind: 'write', content: input.content } }
  }
  if (tool === 'edit' && typeof input.oldString === 'string' && typeof input.newString === 'string') {
    return {
      filePath: input.filePath,
      write: {
        kind: 'edit',
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll === true,
      },
    }
  }
  return null
}
