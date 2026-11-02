import { describe, expect, it } from 'vitest'
import { isFetchableAttachmentUrl } from './attachment-url'

describe('isFetchableAttachmentUrl', () => {
  it('refuses an empty url, which would resolve to the running page', () => {
    expect(isFetchableAttachmentUrl('')).toBe(false)
    expect(isFetchableAttachmentUrl(undefined)).toBe(false)
    expect(isFetchableAttachmentUrl('anexo.txt')).toBe(false)
  })
  it('accepts urls that carry or point at the bytes', () => {
    expect(isFetchableAttachmentUrl('data:text/plain;base64,aGk=')).toBe(true)
    expect(isFetchableAttachmentUrl('blob:file:///abc')).toBe(true)
    expect(isFetchableAttachmentUrl('https://x.test/a.pdf')).toBe(true)
  })
})
