import type { ToolFamily } from './catalog'

/**
 * Guides of the families already active when the turn starts, as a block for the
 * turn's message.
 *
 * `tools_load` hands the guide over when the family is loaded, but tool results are
 * not resent in later turns (see `toModelMessages`), and a family activated by a tag
 * in the message never went through `tools_load` at all. Either way the tools are
 * declared and the guide is not — so it rides here. In the message, not in the
 * system prompt: the active set changes between turns, and the system prompt is the
 * conversation's cache prefix.
 */
export function activeFamilyGuides(families: readonly ToolFamily[], active: ReadonlySet<string>): string {
  const withGuide = families.filter((f) => active.has(f.id) && f.manual && !f.unavailable)
  if (withGuide.length === 0) return ''
  return [
    'GUIDES OF THE ACTIVE TOOL FAMILIES — already loaded in this conversation; follow them whenever you use these tools:',
    ...withGuide.map((f) => `### ${f.label}\n${f.manual}`),
  ].join('\n\n')
}
