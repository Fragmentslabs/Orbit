import type { ToolFamily } from './catalog'
import { CORE_SET } from './catalog'

/**
 * Active set DERIVED from the history — never mutated.
 *
 * It comes from scanning `messages` on every step for calls to `tools_load`. Two
 * consequences that justify the design:
 * - **Persistence across turns for free**: the family loaded in turn N
 *   stays active in N+1, until compaction removes the call from the history.
 * - **No orphan history**: the set never shrinks for no reason — if it
 *   went back to the core on every turn, the history would carry calls to tools
 *   that are no longer declared, and an OpenAI-compatible provider may reject that.
 */

/** A `tools_load` call found in the history. */
interface LoadedCall {
  families: string[]
  names: string[]
  /** Message index — used for the order and for the cap's LRU. */
  at: number
}

/** What the model asked to load, read from a `tools_load` call. */
function readLoadedCall(part: Record<string, unknown>, families: readonly ToolFamily[]): LoadedCall | null {
  if (part.type !== 'tool-call' || part.toolName !== 'tools_load') return null
  // The SDK used to use `args` and today uses `input`; accepting both costs nothing and
  // survives a replay of old history.
  const input = (part.input ?? part.args) as Record<string, unknown> | undefined
  if (!input) return null

  const target: string[] = []
  if (typeof input.family === 'string') target.push(input.family)
  if (typeof input.server === 'string') target.push(`mcp:${input.server}`)
  // `tools: [...]` — each name is resolved to the family that contains it.
  const names: string[] = []
  if (Array.isArray(input.tools)) {
    for (const raw of input.tools) {
      if (typeof raw !== 'string') continue
      const name = raw.trim()
      if (!name) continue
      names.push(name)
      const family = families.find((f) => f.tools.includes(name))
      if (family) target.push(family.id)
    }
  }
  if (target.length === 0 && names.length === 0) return null
  return { families: [...new Set(target)], names, at: -1 }
}

/**
 * Families cited in the text — deterministic self-activation, zero tokens.
 *
 * Two forms of citation, and the criterion that separates the two:
 * - `@mcp:<server>`: explicit, unambiguous.
 * - **tool name**: only counts for names with `_` and 5+ characters. A bare "git"
 *   is an everyday word ("do a git pull"); `git_status` is the tool. Without that
 *   filter, half the messages would activate a family by accident, which is worse
 *   than not activating: it pays context and dilutes the core.
 */
export function familiesMentionedInText(
  text: string,
  families: readonly ToolFamily[] = [],
): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/@mcp:([\w.-]+)/gi)) found.add(`mcp:${match[1]}`)
  if (families.length === 0) return [...found]

  const normalized = text.toLowerCase()
  for (const family of families) {
    if (family.unavailable || found.has(family.id)) continue
    for (const name of family.tools) {
      if (CORE_SET.has(name) || name.length < 5 || !name.includes('_')) continue
      if (normalized.includes(name.toLowerCase())) {
        found.add(family.id)
        break
      }
    }
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
 * - `auto` are families activated by context (e.g. `@mcp:x` in the message).
 * - Cap: the set grows monotonically; when it overflows, the first to go is the family
 *   **without recent use** (LRU by the calls of the retained history), not the
 *   oldest loaded — a worker that loaded `documents` in turn 2 and used it until
 *   turn 9 should not be dropped before `motion`, loaded in 7 and never called.
 */
export function deriveActive(
  messages: readonly unknown[],
  families: readonly ToolFamily[],
  existing: ReadonlySet<string>,
  options: { auto?: readonly string[]; cap?: number } = {},
): ActiveSet {
  const cap = options.cap ?? 120
  const byId = new Map(families.map((f) => [f.id, f]))
  const loadedFamilies: string[] = []
  const looseNames = new Set<string>()
  const lastUse = new Map<string, number>()
  const familyByName = new Map<string, string>()
  for (const family of families) for (const name of family.tools) familyByName.set(name, family.id)

  messages.forEach((message, index) => {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      // Use of any tool pushes its family's LRU.
      if (p.type === 'tool-call' && typeof p.toolName === 'string') {
        const family = familyByName.get(p.toolName)
        if (family) lastUse.set(family, index)
      }
      const call = readLoadedCall(p, families)
      if (!call) continue
      call.at = index
      for (const id of call.families) if (!loadedFamilies.includes(id)) loadedFamilies.push(id)
      for (const name of call.names) looseNames.add(name)
    }
  })

  const wanted = [...new Set([...loadedFamilies, ...(options.auto ?? [])])].filter((id) => byId.has(id))
  const dropped: string[] = []
  const keep = new Set(wanted)
  // Cap: drops the least used ones (never used first), the more recent ones after.
  let total = keep.size
  if (total > cap) {
    const ordered = [...wanted].sort(
      (a, b) => (lastUse.get(a) ?? -1) - (lastUse.get(b) ?? -1),
    )
    for (const id of ordered) {
      if (total <= cap) break
      keep.delete(id)
      dropped.push(id)
      total--
    }
  }

  const names = new Set<string>()
  for (const name of CORE_SET) if (existing.has(name)) names.add(name)
  for (const id of keep) {
    const family = byId.get(id)
    if (!family || family.unavailable) continue
    for (const name of family.tools) if (existing.has(name)) names.add(name)
  }
  for (const name of looseNames) if (existing.has(name)) names.add(name)

  return { names: [...names], families: keep, dropped }
}
