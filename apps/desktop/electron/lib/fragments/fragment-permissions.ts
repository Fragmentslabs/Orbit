import { session, type WebContents } from 'electron'
import { FRAGMENT_SCHEME, isFragmentId, type FragmentManifest } from '@shared/fragments'
import { getFragment, listFragments, fragmentEvents } from './fragment-store'
import { announceAsk } from './fragment-ask'
import { ensureMicrophoneAccess } from '../browser-permissions'

/**
 * The microphone of a fragment.
 *
 * A fragment page records like any site — `navigator.mediaDevices.getUserMedia({ audio })` —
 * and Chromium hands the decision to Orbit, which is the only one that can ask the person.
 * The gate here is the same capability the rest of the app uses: `microphone` requested and
 * granted in the manifest. Without the grant the call is refused and the ask goes up above
 * the fragment — the same notice AI, MCP and notifications use, no separate window — so the
 * person clicks Allow there and the page tries again. Only then macOS is asked once for the
 * whole app.
 *
 * The camera never passes: a fragment has no business with it, and no capability exists for it.
 */

/** The fragment id of an `orbit-fragment://<id>/…` URL or origin, or null for any other. */
function fragmentIdOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(`${FRAGMENT_SCHEME}://`)) return null
  try {
    const id = new URL(value).hostname
    return isFragmentId(id) ? id : null
  } catch {
    return null
  }
}

/** Audio only: a request that also wants the camera belongs to no fragment. */
function asksOnlyForAudio(details: { mediaTypes?: ('video' | 'audio')[] }): boolean {
  const types = details.mediaTypes ?? []
  return types.length === 0 || (types.includes('audio') && !types.includes('video'))
}

/**
 * Fragments allowed to record, kept in memory because the permission CHECK is synchronous.
 * It is only ever a shortcut: the request path re-reads the manifest before saying yes,
 * and every manifest change refreshes it.
 */
const recording = new Set<string>()

function syncGrant(manifest: FragmentManifest): void {
  if (manifest.grants.includes('microphone')) recording.add(manifest.id)
  else recording.delete(manifest.id)
}

/** Connects the handlers to the session the app window lives in. Call after the app is ready. */
export function setupFragmentPermissions(): void {
  const ses = session.defaultSession

  // What is already allowed, before any page asks (a restart must not look like a denial).
  void listFragments().then((all) => all.forEach(syncGrant)).catch(() => {})
  fragmentEvents.on('updated', (event: { fragmentId: string }) => {
    void getFragment(event.fragmentId).then((manifest) => manifest && syncGrant(manifest)).catch(() => {})
  })

  ses.setPermissionRequestHandler((wc: WebContents, permission, callback, details) => {
    // Everything that is not media keeps the behavior the app already had (Electron's
    // default: granted). Only the fragment's microphone is decided here.
    if (permission !== 'media') {
      callback(true)
      return
    }
    const request = details as { requestingUrl?: string; mediaTypes?: ('video' | 'audio')[] }
    const fragmentId = fragmentIdOf(request.requestingUrl)
    // Not a fragment: the app's own microphone (dictation, the overlay's voice) is untouched.
    if (!fragmentId) {
      callback(true)
      return
    }
    if (!asksOnlyForAudio(request)) {
      callback(false)
      return
    }
    void (async () => {
      const manifest = await getFragment(fragmentId)
      if (!manifest) return callback(false)
      if (!manifest.grants.includes('microphone')) {
        // No dialog: the notice above the fragment (the same as AI, MCP and notifications).
        await announceAsk(fragmentId, 'microphone')
        return callback(false)
      }
      recording.add(fragmentId)
      // macOS: the app's own access, asked once for the whole app (like a site in the browser).
      if (!(await ensureMicrophoneAccess(wc))) {
        recording.delete(fragmentId)
        return callback(false)
      }
      callback(true)
    })().catch(() => callback(false))
  })

  // Synchronous queries (navigator.permissions.query, device labels) answer from the cache;
  // a "false" here is not a refusal — it is what makes Chromium ask the handler above.
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    if (permission !== 'media') return true
    const check = details as { requestingUrl?: string; mediaType?: 'video' | 'audio' | 'unknown' }
    const fragmentId = fragmentIdOf(check.requestingUrl) ?? fragmentIdOf(requestingOrigin)
    if (!fragmentId) return true
    if (check.mediaType === 'video') return false
    return recording.has(fragmentId)
  })
}
