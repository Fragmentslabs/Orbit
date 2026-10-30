/**
 * Memory citation in the answer: `#orbit-memory/mem_xxx`.
 *
 * It lives in shared because both renderers need to read the SAME format: the
 * desktop turns the id into a chip with a panel tab, the mobile into a sheet with the
 * summary — and a format that diverged between them would produce a link that opens
 * nothing on one of the two, without warning. The presentation part stays on each side.
 */

export const MEMORY_HREF = /^#orbit-memory\/(mem_[a-z0-9]+)$/i

export function parseMemoryHref(href: string): string | null {
  const match = MEMORY_HREF.exec(href.trim())
  return match ? match[1] : null
}

/**
 * Memory id inside RAW text — tool output, not Markdown.
 *
 * `memory_search` and `memory_save` list the memories as `#mem_xxx`, and in a
 * tool card that id says nothing. Here there is nothing to protect (neither
 * fence nor assembled link): only the id. The `#` is consumed along with it so that a
 * stray `#` does not remain in front of the chip.
 */
const RAW_MEMORY_ID = /(#?mem_[a-z0-9]{6,})\b/gi
const RAW_MEMORY_ID_EXACT = /^#?(mem_[a-z0-9]{6,})$/i

/** Snippet of raw text: either an ordinary sequence, or an id already isolated. */
export type MemoryIdPart = string | { memoryId: string }

/**
 * Splits raw text into the snippets between memory ids, with the ids isolated so
 * that the renderer swaps each one for the chip. It exists separately from the components for
 * the same reason as the rest of the file: it can be tested without UI.
 */
export function splitMemoryIds(text: string): MemoryIdPart[] {
  return (
    text
      .split(RAW_MEMORY_ID)
      // The split creates empty strings at the ends when the text starts/ends on an id.
      .filter((part) => part !== '')
      .map((part) => {
        const match = RAW_MEMORY_ID_EXACT.exec(part)
        return match ? { memoryId: match[1] } : part
      })
  )
}
