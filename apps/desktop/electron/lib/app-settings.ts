import { DEFAULT_APP_SETTINGS, normalizeAppSettings, type AppSettings } from '@shared/app-settings'
import type { SendMessageInput } from '@shared/chat'
import { readJson, writeJson } from './storage'

/**
 * Main-process copy of the general settings (the source of truth is the renderer —
 * see app-settings.ts in shared). It stays on disk because part of them counts before
 * any window opens: the browser cookie cleanup and the automatic archiving
 * run at startup.
 */

const STORAGE_KEY = 'app-settings'

let current: AppSettings = DEFAULT_APP_SETTINGS
const listeners = new Set<(next: AppSettings, prev: AppSettings) => void>()

export function getAppSettings(): AppSettings {
  return current
}

/** Reads the copy from disk. Called once at startup, before using the settings. */
export async function loadAppSettings(): Promise<AppSettings> {
  current = normalizeAppSettings(await readJson<unknown>(STORAGE_KEY))
  return current
}

/** Applies what the renderer sent; it writes and notifies only when something changed. */
export async function setAppSettings(raw: unknown): Promise<void> {
  const next = normalizeAppSettings(raw)
  if (JSON.stringify(next) === JSON.stringify(current)) return
  const prev = current
  current = next
  await writeJson(STORAGE_KEY, next)
  for (const listener of listeners) listener(next, prev)
}

/**
 * Can the agent use the panel browser in this turn? With the browser tools
 * off, only when the user opened the browser and asked through its chat, in
 * full screen — in any other case, not even with the browser open in
 * plain sight.
 */
export function agentMayUseBrowser(input: SendMessageInput): boolean {
  return current.browser.agentTools || input.options.fromBrowser === true
}

/**
 * Can the agent control the computer in this turn? It requires both keys: the
 * Preferences switch and the mode on in this conversation. Workers stay
 * out — whoever acts on the user's screen is the session that talks to them.
 * `available` is the platform (macOS outside the App Store), resolved by the caller.
 */
export function agentMayControlComputer(input: SendMessageInput, available: boolean): boolean {
  return available && current.computer.enabled && input.options.computer === true && input.orchestrationRole !== 'worker'
}

export function onAppSettingsChange(listener: (next: AppSettings, prev: AppSettings) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
