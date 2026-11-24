import type { FragmentCallResult } from '@orbit/shared'
import { FRAGMENT_PHONE_HOST_FILE } from '@orbit/shared'

/**
 * The phone's side of a fragment's `window.orbit`. The fragment runs in a web view inside a small
 * host page (served by the desktop); its calls come out as messages, the app sends them to the
 * desktop's broker over the socket, and the answer goes back in with `injectJavaScript`. Pure, so
 * what crosses the boundary is tested: the page is model-written code, never trusted.
 */

export type FragmentWebMessage =
  | { type: 'call'; id: number; method: string; params?: unknown }
  | { type: 'ready' }
  | { type: 'log'; level: string; message: string }

/** A call that is not worth answering: the page is looping or sending a payload no fragment needs. */
const MAX_MESSAGE_CHARS = 512 * 1024
const MAX_METHOD_CHARS = 40

export function parseFragmentMessage(raw: string): FragmentWebMessage | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_CHARS) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const m = data as Record<string, unknown>
  if (m.type === 'ready') return { type: 'ready' }
  if (m.type === 'log') {
    return typeof m.message === 'string' ? { type: 'log', level: typeof m.level === 'string' ? m.level : 'log', message: m.message } : null
  }
  if (m.type === 'call') {
    if (typeof m.id !== 'number' || !Number.isInteger(m.id) || m.id < 0) return null
    if (typeof m.method !== 'string' || m.method.length === 0 || m.method.length > MAX_METHOD_CHARS) return null
    return { type: 'call', id: m.id, method: m.method, params: m.params }
  }
  return null
}

/** The JS that hands an answer to the host page, which gives it to the fragment. */
export function replyScript(id: number, result: FragmentCallResult): string {
  const payload = result.ok ? { id, ok: true, value: result.value } : { id, ok: false, error: result.error }
  // U+2028/2029 are valid in JSON and not in a JS string literal of older engines: escaped.
  const json = JSON.stringify(payload ?? null).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return `window.__orbitReply(${json});true;`
}

export function themeScript(theme: 'dark' | 'light'): string {
  return `window.__orbitTheme('${theme}');true;`
}

/** The address of the host page: the fragment's signed folder, the reserved file, the app's theme. */
export function fragmentHostUrl(entryUrl: string, theme: 'dark' | 'light'): string {
  const folder = entryUrl.endsWith('/') ? entryUrl : `${entryUrl}/`
  return `${folder}${FRAGMENT_PHONE_HOST_FILE}?theme=${theme}`
}

/**
 * A thumbnail in the list is the real page, running, but a card must never spend tokens, write data or
 * reach the network just by being on screen (the desktop's gallery makes the same promise). It may
 * READ what the fragment stored — that is what makes a dashboard look like itself — and nothing else.
 */
const PREVIEW_METHODS: ReadonlySet<string> = new Set(['store.get', 'store.keys'])

export function previewAllows(method: string): boolean {
  return PREVIEW_METHODS.has(method)
}

export function previewRefusal(): FragmentCallResult {
  return { ok: false, error: { code: 'preview', message: 'This is a read-only preview.' } }
}

/** An answer for a call that never reached the desktop (offline, socket closed). */
export function offlineResult(message: string): FragmentCallResult {
  return { ok: false, error: { code: 'offline', message } }
}
