/**
 * Which images of a turn were drafts.
 *
 * A pure function, separated from the chat-engine, because the rule is the subtle part: the
 * first version of it only saw a LADDER — `edit(edit(x))`, each image
 * becoming the next one's input — and let the case that actually
 * happens pass whole, which is the FAN: the agent looks at the result, does not like it, and redoes the
 * same edit from the SAME base with another parameter. No attempt
 * is the parent of the following one, so none looked disposable, and the gallery filled up
 * with four crops of the same original.
 */

export interface DraftSelection {
  /** URLs produced in this turn, in the order they entered the answer. */
  produced: Iterable<string>
  /** Child → base it came from, in the order of the calls. */
  parents: Map<string, string>
  /** What the agent marked as a delivery (keep), and which is never a draft. */
  keep: Set<string>
}

/**
 * Returns the URLs to discard. There are two formats:
 *
 * - RUNG: the image became the input of another image of the same turn. Only the top
 *   of the ladder matters.
 * - ATTEMPT: two or more images came out of the same base in this turn. The
 *   last one stays; the previous ones were the ones that did not work out.
 *
 * The user's attachment does not appear here by construction — it never enters
 * `produced`, which only lists what the turn generated.
 */
export function selectDraftImages({ produced, parents, keep }: DraftSelection): string[] {
  const fromThisTurn = new Set(produced)
  const drafts = new Set<string>()

  for (const base of parents.values()) {
    if (fromThisTurn.has(base)) drafts.add(base)
  }

  const byBase = new Map<string, string[]>()
  for (const [child, base] of parents) {
    const siblings = byBase.get(base) ?? []
    siblings.push(child)
    byBase.set(base, siblings)
  }
  for (const siblings of byBase.values()) {
    for (const url of siblings.slice(0, -1)) drafts.add(url)
  }

  for (const url of keep) drafts.delete(url)
  // It only discards what this turn produced: a base from a previous turn is
  // history already accepted by the user, not a draft of this answer.
  return [...drafts].filter((url) => fromThisTurn.has(url))
}
