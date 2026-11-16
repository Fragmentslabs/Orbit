import { describe, expect, it } from 'vitest'
import { canPublishRepo, isValidRepoName, shouldOfferInit, suggestRepoName } from './init-project'

const base = { directory: '/w/app', sessions: [], initialized: false, dismissed: [] as string[] }

describe('shouldOfferInit', () => {
  it('offers for a folder the desktop says is not initialized', () => {
    expect(shouldOfferInit(base)).toBe(true)
  })
  it('stays quiet while the status is unknown, initialized or running', () => {
    expect(shouldOfferInit({ ...base, initialized: undefined })).toBe(false)
    expect(shouldOfferInit({ ...base, initialized: true })).toBe(false)
    expect(shouldOfferInit({ ...base, running: true })).toBe(false)
  })
  it('stays quiet when dismissed or when another chat already works there', () => {
    expect(shouldOfferInit({ ...base, dismissed: ['/w/app/'] })).toBe(false)
    expect(shouldOfferInit({ ...base, sessions: [{ id: 'x', directory: '/w/app' }] })).toBe(false)
    // The chat showing the card does not count against itself.
    expect(shouldOfferInit({ ...base, currentSessionId: 'x', sessions: [{ id: 'x', directory: '/w/app' }] })).toBe(true)
  })
})

describe('repo helpers', () => {
  it('suggests a valid name from the folder', () => {
    expect(suggestRepoName('/w/My App/')).toBe('My-App')
  })
  it('validates like the desktop', () => {
    expect(isValidRepoName('ok-name_1.x')).toBe(true)
    for (const bad of ['', '.', '..', 'a b', 'a/b', 'x'.repeat(101)]) expect(isValidRepoName(bad)).toBe(false)
  })
  it('publishes only a repo with commits and no remote', () => {
    const info = { directory: '/x', exists: true, isRepo: true, hasCommits: true, remoteUrl: null, branch: 'main' }
    expect(canPublishRepo(info)).toBe(true)
    expect(canPublishRepo({ ...info, remoteUrl: 'u' })).toBe(false)
    expect(canPublishRepo({ ...info, hasCommits: false })).toBe(false)
    expect(canPublishRepo(null)).toBe(false)
  })
})
