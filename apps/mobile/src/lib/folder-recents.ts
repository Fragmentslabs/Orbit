import { Storage } from '~/lib/storage'

const RECENT_FOLDERS_KEY = 'orbit_recent_folders'
const MAX_RECENT = 6

/** Folders picked on this device, most recent first — the shortcuts of the folder browser. */
export async function loadRecentFolders(): Promise<string[]> {
  try {
    const raw = await Storage.getItem(RECENT_FOLDERS_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

export async function saveRecentFolder(path: string): Promise<void> {
  const current = await loadRecentFolders()
  const next = [path, ...current.filter((p) => p !== path)].slice(0, MAX_RECENT)
  await Storage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(next))
}
