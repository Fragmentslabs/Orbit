import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import { normalizePath } from '~/lib/known-folders'

/**
 * What the person decided about folders ON THE PHONE: a nickname for a folder and the folders
 * removed from the phone's list. It never touches the desktop disk or its chats — "remove" only
 * hides the folder here (it comes back by adding it again).
 */

const KEY = 'orbit_folder_prefs'

interface Persisted {
  aliases: Record<string, string>
  hidden: string[]
}

interface FolderPrefsState extends Persisted {
  hydrated: boolean
  hydrate: () => Promise<void>
  rename: (path: string, name: string) => void
  hide: (path: string) => void
  /** Brings a hidden folder back (adding it again from the desktop). */
  unhide: (path: string) => void
}

function save(state: Persisted) {
  void Storage.setItem(KEY, JSON.stringify({ aliases: state.aliases, hidden: state.hidden })).catch(() => {})
}

export function parsePersisted(raw: string | null): Persisted {
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<Persisted>) : {}
    const aliases: Record<string, string> = {}
    if (parsed.aliases && typeof parsed.aliases === 'object') {
      for (const [k, v] of Object.entries(parsed.aliases)) if (typeof v === 'string' && v.trim()) aliases[k] = v
    }
    const hidden = Array.isArray(parsed.hidden) ? parsed.hidden.filter((h): h is string => typeof h === 'string') : []
    return { aliases, hidden }
  } catch {
    return { aliases: {}, hidden: [] }
  }
}

export const useFolderPrefs = create<FolderPrefsState>((set, get) => ({
  aliases: {},
  hidden: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return
    const raw = await Storage.getItem(KEY).catch(() => null)
    set({ ...parsePersisted(raw), hydrated: true })
  },

  rename: (path, name) => {
    const key = normalizePath(path)
    const aliases = { ...get().aliases }
    if (name.trim()) aliases[key] = name.trim()
    else delete aliases[key]
    set({ aliases })
    save({ aliases, hidden: get().hidden })
  },

  hide: (path) => {
    const key = normalizePath(path)
    const hidden = get().hidden.includes(key) ? get().hidden : [...get().hidden, key]
    set({ hidden })
    save({ aliases: get().aliases, hidden })
  },

  unhide: (path) => {
    const key = normalizePath(path)
    const hidden = get().hidden.filter((h) => h !== key)
    set({ hidden })
    save({ aliases: get().aliases, hidden })
  },
}))
