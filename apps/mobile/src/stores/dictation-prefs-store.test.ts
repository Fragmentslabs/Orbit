import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = new Map<string, string>()
vi.mock('~/lib/storage', () => ({
  Storage: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value)
    },
  },
}))

import { DEFAULT_DICTATION_MODE, useDictationPrefsStore } from './dictation-prefs-store'

describe('dictation prefs', () => {
  beforeEach(() => {
    storage.clear()
    useDictationPrefsStore.setState({ mode: DEFAULT_DICTATION_MODE, callEnabled: true })
  })

  it('defaults to the phone recognizer', () => {
    expect(DEFAULT_DICTATION_MODE).toBe('native')
    expect(useDictationPrefsStore.getState().mode).toBe('native')
  })

  it('saves the choice and loads it back', async () => {
    await useDictationPrefsStore.getState().setMode('desktop')
    useDictationPrefsStore.setState({ mode: 'native' })
    await useDictationPrefsStore.getState().loadPrefs()
    expect(useDictationPrefsStore.getState().mode).toBe('desktop')
  })

  it('ignores a stored value it does not know', async () => {
    storage.set('orbit_dictation_prefs', JSON.stringify({ mode: 'cloud' }))
    await useDictationPrefsStore.getState().loadPrefs()
    expect(useDictationPrefsStore.getState().mode).toBe('native')
  })

  it('keeps the call switch on by default and saves it next to the mode', async () => {
    expect(useDictationPrefsStore.getState().callEnabled).toBe(true)
    await useDictationPrefsStore.getState().setMode('desktop')
    await useDictationPrefsStore.getState().setCallEnabled(false)
    useDictationPrefsStore.setState({ mode: 'native', callEnabled: true })
    await useDictationPrefsStore.getState().loadPrefs()
    expect(useDictationPrefsStore.getState().callEnabled).toBe(false)
    expect(useDictationPrefsStore.getState().mode).toBe('desktop')
  })
})
