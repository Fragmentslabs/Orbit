import type { ChatMessage } from '@shared/chat'
import type { ToolFamily } from './catalog'
import { CORE_SET, MAX_TOOLS_PER_FAMILY } from './catalog'

/**
 * Active set DERIVED from the history — never mutated.
 *
 * It comes from scanning `messages` on every step for tool calls. Two
 * consequences that justify the design:
 * - **No orphan history**: the set never shrinks for no reason — if it
 *   went back to the core on every step, the history would carry calls to tools
 *   that are no longer declared, and an OpenAI-compatible provider may reject that.
 * - **Immune to retry, provider rotation and compaction**: there is no state to
 *   lose, only the history to read again.
 *
 * The model history does NOT carry the tool parts of previous turns (see
 * `toModelMessages`), so the persistence across turns comes from the chat history
 * itself: `priorToolCalls` turns its ToolParts into the same shape.
 */

/** Resolves a `query` inside a family to tool names — the same search the bridge answers with. */
export type QueryResolver = (family: ToolFamily, query: string) => string[]

/** What a call activates: whole families and loose names. */
interface Activation {
  families: string[]
  names: string[]
}

/** Small family loads whole; a large one only through the names it was asked for. */
function isWhole(family: ToolFamily): boolean {
  return family.tools.length <= MAX_TOOLS_PER_FAMILY
}

/**
 * What a `tools_load` call activates. It mirrors what the bridge ANSWERED: a large
 * family refused without a query activates nothing, and a query activates only
 * what the search found — otherwise the refusal in the text would be a lie and
 * the 80 tools of a server would go to the request anyway.
 */
function readLoadCall(
  input: Record<string, unknown>,
  families: readonly ToolFamily[],
  resolveQuery?: QueryResolver,
): Activation {
  const activation: Activation = { families: [], names: [] }
  const id =
    typeof input.family === 'string' ? input.family : typeof input.server === 'string' ? `mcp:${input.server}` : undefined
  const family = id ? families.find((f) => f.id === id) : undefined
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (family && !family.unavailable) {
    if (query) activation.names.push(...(resolveQuery?.(family, query) ?? []))
    else if (isWhole(family)) activation.families.push(family.id)
  }
  // `tools: [...]` — the name itself always; the family whole only when it is small.
  if (Array.isArray(input.tools)) {
    for (const raw of input.tools) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      const name = raw.trim()
      activation.names.push(name)
      const owner = families.find((f) => f.tools.includes(name))
      if (owner && isWhole(owner)) activation.families.push(owner.id)
    }
  }
  return activation
}

/**
 * The ToolParts of the chat history as tool-call parts, in one message — what
 * `deriveActive` reads to keep the families of the previous turns active.
 *
 * `history` is already the window the model sees (after the last summary): a
 * family used before the compaction leaves with it, which is the point.
 */
export function priorToolCalls(history: readonly ChatMessage[]): { role: 'assistant'; content: unknown[] }[] {
  const content: unknown[] = []
  for (const message of history) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts) {
      if (part.type !== 'tool') continue
      content.push({ type: 'tool-call', toolName: part.tool, input: part.input ?? {} })
    }
  }
  return content.length > 0 ? [{ role: 'assistant', content }] : []
}

function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
}

/** Whole-word (or whole-phrase) match of a tag in already-folded text. */
function hasTag(folded: string, tag: string): boolean {
  const words = fold(tag)
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (words.length === 0 || !words[0]) return false
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${words.join('\\s+')}(?![\\p{L}\\p{N}])`, 'u')
  return re.test(folded)
}

/**
 * Families cited in the text — deterministic self-activation, zero tokens.
 *
 * Three forms of citation, and the criterion that separates them:
 * - `@mcp:<server>`: explicit, unambiguous.
 * - **tool name**: only counts for names with `_` and 5+ characters. A bare "git"
 *   is an everyday word ("do a git pull"); `git_status` is the tool. Without that
 *   filter, half the messages would activate a family by accident, which is worse
 *   than not activating: it pays context and dilutes the core.
 * - **family tag** (`ToolFamily.tags`, curated pt+en): whole word, case and accents
 *   folded on both sides. No length rule — `pdf` is short and specific; what protects is
 *   the curation and the corpus test, not the size.
 */
export function familiesMentionedInText(
  text: string,
  families: readonly ToolFamily[] = [],
): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/@mcp:([\w.-]+)/gi)) found.add(`mcp:${match[1]}`)
  if (families.length === 0) return [...found]

  const normalized = text.toLowerCase()
  const folded = fold(text)
  for (const family of families) {
    if (family.unavailable || found.has(family.id)) continue
    for (const name of family.tools) {
      if (CORE_SET.has(name) || name.length < 5 || !name.includes('_')) continue
      if (normalized.includes(name.toLowerCase())) {
        found.add(family.id)
        break
      }
    }
    if (found.has(family.id)) continue
    if (family.tags?.some((tag) => hasTag(folded, tag))) found.add(family.id)
  }
  return [...found]
}

export interface ActiveSet {
  /** Tool names to send in `activeTools`. */
  names: string[]
  /** Loaded families (for the map's ACTIVE marker). */
  families: Set<string>
  /** Families that fell to the cap — the prompt warns about it. */
  dropped: string[]
}

/**
 * Derives the active set from the whole history.
 *
 * - It always includes the core that EXISTS in this turn (the nominal core has tools
 *   the chat does not assemble — `read`, `bash` —, and declaring a nonexistent tool in
 *   `activeTools` breaks the request).
 * - A family becomes active by `tools_load` **or by use**: a tool called in a
 *   previous turn keeps its family, and so does one called while inactive (the
 *   SDK parses against the whole ToolSet, so that call runs).
 * - `auto` are families activated by context (e.g. `@mcp:x` in the message).
 * - `cap` counts TOOLS — it is the provider's ceiling on the request. When the set
 *   overflows, the first to go is the family **without recent use** (LRU by the
 *   calls of the retained history), not the oldest loaded — a worker that loaded
 *   `documents` in turn 2 and used it until turn 9 should not be dropped before
 *   `motion`, loaded in 7 and never called. The core never leaves.
 */
export function deriveActive(
  messages: readonly unknown[],
  families: readonly ToolFamily[],
  existing: ReadonlySet<string>,
  options: { auto?: readonly string[]; cap?: number; resolveQuery?: QueryResolver } = {},
): ActiveSet {
  const byId = new Map(families.map((f) => [f.id, f]))
  const familyByName = new Map<string, ToolFamily>()
  for (const family of families) for (const name of family.tools) familyByName.set(name, family)
  const wanted: string[] = []
  const looseNames = new Set<string>()
  const lastUse = new Map<string, number>()
  const want = (id: string) => {
    if (byId.has(id) && !wanted.includes(id)) wanted.push(id)
  }

  messages.forEach((message, index) => {
    if (!message || typeof message !== 'object') return
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      if (p.type !== 'tool-call' || typeof p.toolName !== 'string') continue
      if (p.toolName === 'tools_load') {
        // The SDK used to use `args` and today uses `input`; accepting both costs
        // nothing and survives a replay of old history.
        const input = (p.input ?? p.args) as Record<string, unknown> | undefined
        if (!input || typeof input !== 'object') continue
        const activation = readLoadCall(input, families, options.resolveQuery)
        for (const id of activation.families) want(id)
        for (const name of activation.names) looseNames.add(name)
        continue
      }
      // Use of any tool activates its family (or the name, in a large one) and
      // pushes the family's LRU.
      const family = familyByName.get(p.toolName)
      if (!family) continue
      lastUse.set(family.id, index)
      if (isWhole(family)) want(family.id)
      else looseNames.add(p.toolName)
    }
  })
  // What the user's message cites is the most recent intent there is.
  for (const id of options.auto ?? []) {
    want(id)
    if (byId.has(id)) lastUse.set(id, messages.length)
  }

  const keep = new Set(wanted.filter((id) => !byId.get(id)?.unavailable))
  const collect = () => {
    const names = new Set<string>()
    for (const name of CORE_SET) if (existing.has(name)) names.add(name)
    for (const id of keep) for (const name of byId.get(id)!.tools) if (existing.has(name)) names.add(name)
    for (const name of looseNames) {
      if (!existing.has(name)) continue
      // A loose name whose family was dropped by the cap leaves with it.
      const owner = familyByName.get(name)
      if (owner && dropped.includes(owner.id)) continue
      names.add(name)
    }
    return names
  }

  const dropped: string[] = []
  let names = collect()
  if (options.cap && names.size > options.cap) {
    // Never used first (in load order), then from the least recently used.
    const ordered = [...keep, ...[...looseNames].map((n) => familyByName.get(n)?.id).filter((id): id is string => !!id)]
      .filter((id, i, all) => all.indexOf(id) === i)
      .sort((a, b) => (lastUse.get(a) ?? -1) - (lastUse.get(b) ?? -1))
    for (const id of ordered) {
      if (names.size <= options.cap) break
      keep.delete(id)
      dropped.push(id)
      names = collect()
    }
  }

  return { names: [...names], families: keep, dropped }
}
