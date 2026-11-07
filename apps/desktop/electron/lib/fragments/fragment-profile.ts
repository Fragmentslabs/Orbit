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
    '- Pick a fitting lucide icon for the fragment (the `icon` field of fragment_create), in kebab-case, e.g. "wallet", "chart-bar", "timer".',
    '- Honor the kind the person asked for: "screen" (a full page), "panel" (a compact column that sits next to a chat) or "widget" (a small glanceable card).',
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
    'Read what you need with fragment_read_file before editing.',
    '</fragment-context>',
  ].join('\n')
}
