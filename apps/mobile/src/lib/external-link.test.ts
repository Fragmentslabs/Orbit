import { describe, expect, it, vi } from 'vitest'

const openURL = vi.fn(async (_url: string) => {})
vi.mock('react-native', () => ({ Linking: { openURL: (u: string) => openURL(u) } }))

import { isExternalUrl, openExternal } from './external-link'

describe('external links', () => {
  it('lets only page, mail and phone links out', () => {
    expect(isExternalUrl('https://example.com/a?b=1')).toBe(true)
    expect(isExternalUrl('http://example.com')).toBe(true)
    expect(isExternalUrl('mailto:a@b.co')).toBe(true)
    expect(isExternalUrl('tel:+5511999999999')).toBe(true)
    expect(isExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isExternalUrl('#orbit-source/doc1')).toBe(false)
    expect(isExternalUrl('/relative')).toBe(false)
  })

  it('opens an allowed link in the system and refuses the rest', async () => {
    openURL.mockClear()
    expect(await openExternal(' https://example.com ')).toBe(true)
    expect(openURL).toHaveBeenCalledWith('https://example.com')
    expect(await openExternal('javascript:alert(1)')).toBe(false)
    expect(openURL).toHaveBeenCalledTimes(1)
  })

  it('reports a link the system could not open', async () => {
    openURL.mockRejectedValueOnce(new Error('no handler'))
    expect(await openExternal('https://example.com')).toBe(false)
  })
})
