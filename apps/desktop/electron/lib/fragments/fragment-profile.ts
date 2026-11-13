import { StorageKeys, type SessionInfo } from '@shared/chat'
import { readJson } from '../storage'
import { listFragmentFiles, listFragments } from './fragment-store'

/**
 * The lean profile of a Fragment's own chat.
 *
 * A fragment is built by an agent that needs ONE thing: write a small web page and keep
 * it working. So this chat does not carry Orbit's usual baggage — no memories, no
 * skills, no project context, no browser/computer/media tools, no catalog of other
 * families. It gets a short system prompt (below), the fragment tools, and a per-turn
 * block saying which fragment it is looking at. That makes turns cheaper, faster and
 * much less prone to wander off into things that are not the fragment.
 */

/** Is this chat a fragment's own chat? (Read from the session on disk, at the start of a turn.) */
export async function fragmentProfileOf(sessionId: string): Promise<SessionInfo['fragment'] | null> {
  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  return session?.fragment ?? null
}

export function fragmentSystemPrompt(language?: string): string {
  const reply = language ? `Reply in ${language}, ` : 'Reply in the language of the request, '
  return [
    'You build and edit FRAGMENTS inside Orbit: small, self-contained screens (plain HTML, CSS and JavaScript) that the person watches appear and change live, next to this conversation.',
    '',
    'How you work:',
    '- Create with fragment_create, then refine with fragment_edit_file (small changes) or fragment_write_file (new files / full rewrites). The screen reloads on every write.',
    '- After writing, call fragment_logs once to catch runtime errors, and fix them before you answer.',
    '- Start with a complete, working, good-looking first version, then improve it. Do not ask questions you can answer with a sensible default.',
    '- When a real choice changes the result (layout, data source, design system, where the numbers come from) ask it with the question tool: at most TWO, one at a time, with options the person can click. Ask while you build — the first version does not wait for the answer.',
    '- Pick a fitting lucide icon for the fragment (the `icon` field of fragment_create), in kebab-case, e.g. "wallet", "chart-bar", "timer".',
    '- LOOK: every color comes from the app variables (var(--background), var(--foreground), var(--card), var(--muted-foreground), var(--border), var(--primary)) — never a fixed black or white, which disappears in the dark theme. Icons are inline SVG in the lucide style; never emoji. The full rules are in the LOOK section of the tools. Always read them before writing HTML.',
    '- Honor the kind the person asked for: "screen" (a full page) or "panel" (a compact column that sits next to a chat).',
    '- When the person wants small versions of the screen on the board beside the chat, declare them with the `widgets` field: the SAME page renders each one when loaded with ?widget=<id>&size=<size>, filling the box exactly (1x1 = 72x72, 2x1 = 152x72, 1x2 = 72x152, 2x2 = 152x152; no scrollbars, no fixed widths, text that fits). A widget is a glance: a 1x1 is one value and one short label — nothing else. Declare only the sizes it reads well at.',
    '- The page has no network of its own: for the internet declare hosts with fragment_set_http and use orbit.http; for the person\'s connected MCP tools declare them with fragment_set_mcp and use orbit.mcp. Both only ask; the person allows.',
    '- You only ever touch fragments. You have no other tools, and that is on purpose.',
    '',
    `${reply}briefly: say what you built or changed in one or two sentences. The person sees the result, so never paste code in the answer.`,
  ].join('\n')
}

/**
 * What this turn needs to know: the kind asked for, or — when the fragment already
 * exists — which one it is, what files it has and what it requested. Per turn, in the
 * user message, so a fresh chat editing an old fragment starts oriented.
 */
export async function fragmentTurnBlock(sessionId: string): Promise<string> {
  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId)).catch(() => null)
  const kind = session?.fragment?.kind
  // A chat made for an existing fragment (from its card) names it; the chat a fragment was
  // born in is found by the link the fragment keeps to it.
  const bound = session?.artifact?.id
  const own = (await listFragments()).find((f) => (bound ? f.id === bound : f.sessionId === sessionId))
  if (!own) {
    return `<fragment-context>\nNo fragment exists in this conversation yet. Create it with fragment_create${kind ? ` (kind: "${kind}")` : ''}.\n</fragment-context>`
  }
  const files = await listFragmentFiles(own.id)
  return [
    '<fragment-context>',
    `Fragment: "${own.name}" — id ${own.id} — kind ${own.kind} — revision ${own.revision}`,
    `Files: ${files.join(', ') || '(none)'}`,
    `Asked for: ${own.requests.join(', ') || 'nothing'}; allowed by the person: ${own.grants.join(', ') || 'nothing'}`,
    own.widgets.length
      ? `Widgets offered: ${own.widgets.map((w) => `${w.id} (${w.sizes.join(', ')})`).join('; ')}`
      : 'Widgets offered: none',
    'Read what you need with fragment_read_file before editing.',
    '</fragment-context>',
  ].join('\n')
}
