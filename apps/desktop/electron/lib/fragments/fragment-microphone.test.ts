import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FragmentPermissionAskEvent } from '@shared/fragments'

/**
 * The microphone of a fragment: the capability, the same notice every other capability uses
 * (no separate window) and the media gate Chromium knocks on before any recording starts.
 */

const userData = path.join(os.tmpdir(), `orbit-fragment-mic-test-${process.pid}`)

/** The handlers the gate installs on the session, kept so the test can knock on them. */
const handlers = vi.hoisted(() => ({
  request: null as null | ((wc: unknown, permission: string, callback: (granted: boolean) => void, details: unknown) => void),
  check: null as null | ((wc: unknown, permission: string, origin: string, details: unknown) => boolean),
}))

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
  session: {
    defaultSession: {
      setPermissionRequestHandler: (fn: typeof handlers.request) => {
        handlers.request = fn
      },
      setPermissionCheckHandler: (fn: typeof handlers.check) => {
        handlers.check = fn
      },
    },
  },
}))
vi.mock('../media', () => ({ injectArtifactChrome: (html: string) => html }))
vi.mock('../providers', () => ({ resolveModel: async () => ({}) }))
vi.mock('../reasoning', () => ({ buildProviderOptions: async () => ({}) }))
// macOS asks the SYSTEM once, after the person's yes; that dialog is not what is under test.
vi.mock('../browser-permissions', () => ({ ensureMicrophoneAccess: async () => true }))

let store: typeof import('./fragment-store')
let bridge: typeof import('./fragment-bridge')
let permissions: typeof import('./fragment-permissions')

beforeAll(async () => {
  store = await import('./fragment-store')
  bridge = await import('./fragment-bridge')
  permissions = await import('./fragment-permissions')
  permissions.setupFragmentPermissions()
})
afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

/** Watches for the notice going up over the fragment (the ask the person clicks). */
function watchAsks(): FragmentPermissionAskEvent[] {
  const seen: FragmentPermissionAskEvent[] = []
  store.fragmentEvents.removeAllListeners('permission-ask')
  store.fragmentEvents.on('permission-ask', (event: FragmentPermissionAskEvent) => seen.push(event))
  return seen
}

function askForRecording(fragmentId: string): Promise<boolean> {
  return new Promise((resolve) => {
    handlers.request?.(
      null,
      'media',
      resolve,
      { requestingUrl: `orbit-fragment://${fragmentId}/index.html`, mediaTypes: ['audio'] },
    )
  })
}

describe('the microphone capability', () => {
  it('starts not requested, is declared by the first attempt and granted only by the person', async () => {
    const manifest = await store.createFragment({ name: 'Recorder', html: '<p>x</p>' })
    const before = await bridge.handleFragmentCall({
      fragmentId: manifest.id,
      method: 'permissions.state',
      params: { capability: 'microphone' },
    })
    expect(before).toEqual({ ok: true, value: 'not_requested' })

    const seen = watchAsks()
    const asked = await bridge.handleFragmentCall({
      fragmentId: manifest.id,
      method: 'permissions.request',
      params: { capability: 'microphone' },
    })
    expect(asked).toEqual({ ok: true, value: 'denied' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ fragmentId: manifest.id, capability: 'microphone' })

    // The attempt declares it as asked-and-off; the notice is what the person clicks.
    const declared = await store.getFragment(manifest.id)
    expect(declared?.requests).toContain('microphone')
    expect(declared?.grants).not.toContain('microphone')

    // The click on the notice is the grant (the UI's fragment:grant path).
    await store.setGrant(manifest.id, 'microphone', true)
    const granted = await bridge.handleFragmentCall({
      fragmentId: manifest.id,
      method: 'permissions.state',
      params: { capability: 'microphone' },
    })
    expect(granted).toEqual({ ok: true, value: 'granted' })
  })

  it('does not put a second notice up once the grant exists', async () => {
    const manifest = await store.createFragment({ name: 'Allowed', html: '<p>x</p>' })
    await store.setRequested(manifest.id, 'microphone', true)
    await store.setGrant(manifest.id, 'microphone', true)
    const seen = watchAsks()
    const result = await bridge.handleFragmentCall({
      fragmentId: manifest.id,
      method: 'permissions.request',
      params: { capability: 'microphone' },
    })
    expect(result).toEqual({ ok: true, value: 'granted' })
    expect(seen).toHaveLength(0)
  })
})

describe('the media gate', () => {
  it('refuses the call and puts the notice up, then lets it through after the person allows', async () => {
    const manifest = await store.createFragment({ name: 'Gate', html: '<p>x</p>' })
    const seen = watchAsks()
    expect(await askForRecording(manifest.id)).toBe(false)
    expect(seen).toHaveLength(1)
    expect(seen[0].capability).toBe('microphone')
    const declared = await store.getFragment(manifest.id)
    expect(declared?.requests).toContain('microphone')
    expect(declared?.grants).not.toContain('microphone')

    await store.setGrant(manifest.id, 'microphone', true)
    expect(await askForRecording(manifest.id)).toBe(true)
  })

  it('refuses the camera and never asks about it', async () => {
    const manifest = await store.createFragment({ name: 'Camera', html: '<p>x</p>' })
    const seen = watchAsks()
    const allowed = await new Promise<boolean>((resolve) => {
      handlers.request?.(null, 'media', resolve, {
        requestingUrl: `orbit-fragment://${manifest.id}/index.html`,
        mediaTypes: ['video'],
      })
    })
    expect(allowed).toBe(false)
    expect(seen).toHaveLength(0)
  })

  it('leaves the app own microphone alone (dictation, the overlay)', async () => {
    const allowed = await new Promise<boolean>((resolve) => {
      handlers.request?.(null, 'media', resolve, { requestingUrl: 'http://localhost:5173/index.html', mediaTypes: ['audio'] })
    })
    expect(allowed).toBe(true)
  })

  it('answers the synchronous check from the grant, never the camera', async () => {
    const manifest = await store.createFragment({ name: 'Check', html: '<p>x</p>' })
    const origin = `orbit-fragment://${manifest.id}/`
    expect(handlers.check?.(null, 'media', origin, { mediaType: 'audio' })).toBe(false)
    expect(handlers.check?.(null, 'media', origin, { mediaType: 'video' })).toBe(false)

    await store.setRequested(manifest.id, 'microphone', true)
    await store.setGrant(manifest.id, 'microphone', true)
    store.fragmentEvents.emit('updated', { fragmentId: manifest.id, revision: 0 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(handlers.check?.(null, 'media', origin, { mediaType: 'audio' })).toBe(true)
    expect(handlers.check?.(null, 'media', origin, { mediaType: 'video' })).toBe(false)

    // Revoking in the details drops the shortcut too (the manifest change is announced).
    await store.setGrant(manifest.id, 'microphone', false)
    store.fragmentEvents.emit('updated', { fragmentId: manifest.id, revision: 0 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(handlers.check?.(null, 'media', origin, { mediaType: 'audio' })).toBe(false)
  })
})
