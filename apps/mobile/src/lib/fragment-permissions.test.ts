import { describe, expect, it } from 'vitest'
import type { FragmentPhoneEntry } from '@orbit/shared'
import { capabilityRows, describeAccess, pendingCapability } from './fragment-permissions'

const entry = (over: Partial<FragmentPhoneEntry> = {}): FragmentPhoneEntry => ({
  id: 'frag-a-1',
  name: 'A',
  icon: 'app-window',
  pinned: false,
  revision: 1,
  updatedAt: 0,
  requests: [],
  grants: [],
  hosts: [],
  mcp: [],
  untrusted: false,
  url: 'http://h/',
  ...over,
})

describe('pendingCapability', () => {
  it('asks for one capability at a time, in the desktop order, and only what was asked for', () => {
    expect(pendingCapability(entry())).toBeNull()
    expect(pendingCapability(entry({ requests: ['notify', 'ai'] }))).toBe('ai')
    expect(pendingCapability(entry({ requests: ['notify', 'ai'], grants: ['ai'] }))).toBe('notify')
    expect(pendingCapability(entry({ requests: ['ai'], grants: ['ai'] }))).toBeNull()
  })

  it('never asks for the microphone on the phone', () => {
    expect(pendingCapability(entry({ requests: ['microphone'] }))).toBeNull()
    expect(pendingCapability(entry({ requests: ['microphone', 'http'] }))).toBe('http')
  })
})

describe('describeAccess', () => {
  it('names the hosts and the MCP tools the person would allow', () => {
    const e = entry({ hosts: ['api.a.com', 'b.org'], mcp: [{ server: 'notion', tools: ['search', 'read'] }] })
    expect(describeAccess(e, 'http')).toBe('api.a.com, b.org')
    expect(describeAccess(e, 'mcp')).toBe('notion (search, read)')
    expect(describeAccess(e, 'ai')).toBe('')
  })
})

describe('capabilityRows', () => {
  it('lists what was asked, locks an unreviewed import and leaves the microphone to the desktop', () => {
    const rows = capabilityRows(entry({ requests: ['ai', 'microphone', 'http'], grants: ['ai'], hosts: ['x.com'], untrusted: true }))
    expect(rows.map((r) => r.capability)).toEqual(['ai', 'http', 'microphone'])
    expect(rows[0]).toMatchObject({ granted: true, locked: false })
    expect(rows[1]).toMatchObject({ granted: false, locked: true, access: 'x.com' })
    expect(rows[2]).toMatchObject({ desktopOnly: true })
    expect(capabilityRows(entry())).toEqual([])
  })
})
