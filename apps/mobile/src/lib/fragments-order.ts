import type { FragmentPhoneEntry } from '@orbit/shared'

/**
 * The list as the phone shows it: filtered by what was typed, with the pinned ones first. Each group keeps the
 * desktop's order (newest first). The pin is one flag shared with the desktop's gallery, and carries no mark:
 * pinned ones are simply on top.
 */
export function orderFragments(entries: readonly FragmentPhoneEntry[], query: string): FragmentPhoneEntry[] {
  const q = query.trim().toLowerCase()
  const list = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries
  return [...list.filter((e) => e.pinned), ...list.filter((e) => !e.pinned)]
}
