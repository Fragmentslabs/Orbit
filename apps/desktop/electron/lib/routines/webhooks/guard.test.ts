import { describe, expect, it } from 'vitest'
import { WEBHOOK_MAX_PAYLOAD_CHARS } from '@shared/routines'
import { buildPayload, deriveToken, RateLimiter, sha256Hex, signBody, tokenFromPath, verifySignature } from './guard'

const key = Buffer.alloc(32, 7)

describe('tokens', () => {
  it('derives a stable url-safe token per routine and epoch', () => {
    const token = deriveToken(key, 'rout_a', 1)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(deriveToken(key, 'rout_a', 1)).toBe(token)
    expect(deriveToken(key, 'rout_a', 2)).not.toBe(token)
    expect(deriveToken(key, 'rout_b', 1)).not.toBe(token)
    expect(deriveToken(Buffer.alloc(32, 8), 'rout_a', 1)).not.toBe(token)
  })
  it('reads the token only from a well-formed path', () => {
    const token = deriveToken(key, 'rout_a', 1)
    expect(tokenFromPath(`/hooks/${token}`)).toBe(token)
    expect(tokenFromPath(`/hooks/${token}?x=1`)).toBe(token)
    expect(tokenFromPath(`/other/${token}`)).toBeNull()
    expect(tokenFromPath(`/hooks/${token}/extra`)).toBeNull()
    expect(tokenFromPath('/hooks/short')).toBeNull()
    expect(tokenFromPath('/hooks/../etc/passwd')).toBeNull()
  })
  it('hashes tokens so equal tokens give equal hashes', () => {
    expect(sha256Hex('a')).toBe(sha256Hex('a'))
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'))
  })
})

describe('verifySignature', () => {
  const body = Buffer.from('{"a":1}')
  const good = signBody('s3cret', body)
  it('accepts a valid signature in either header, with or without the prefix', () => {
    expect(verifySignature('s3cret', body, { 'x-hub-signature-256': `sha256=${good}` })).toBe(true)
    expect(verifySignature('s3cret', body, { 'x-orbit-signature': good.toUpperCase() })).toBe(true)
  })
  it('refuses a missing, wrong or truncated signature and a changed body', () => {
    expect(verifySignature('s3cret', body, {})).toBe(false)
    expect(verifySignature('other', body, { 'x-orbit-signature': good })).toBe(false)
    expect(verifySignature('s3cret', body, { 'x-orbit-signature': good.slice(0, 20) })).toBe(false)
    expect(verifySignature('s3cret', Buffer.from('{"a":2}'), { 'x-orbit-signature': good })).toBe(false)
  })
})

describe('RateLimiter', () => {
  it('lets `limit` hits through per window and then refuses until the window slides', () => {
    const limiter = new RateLimiter(2, 1000)
    expect(limiter.hit('k', 0)).toBe(true)
    expect(limiter.hit('k', 100)).toBe(true)
    expect(limiter.hit('k', 200)).toBe(false)
    expect(limiter.hit('other', 200)).toBe(true)
    expect(limiter.hit('k', 1001)).toBe(true)
  })
})

describe('buildPayload', () => {
  it('keeps the parsed JSON body and only safe headers', () => {
    const payload = JSON.parse(
      buildPayload(Buffer.from('{"action":"opened"}'), { 'content-type': 'application/json', authorization: 'Bearer x', cookie: 'a=b', 'x-github-event': 'issues' }, 0),
    )
    expect(payload.body).toEqual({ action: 'opened' })
    expect(payload.headers).toEqual({ 'content-type': 'application/json', 'x-github-event': 'issues' })
    expect(payload.receivedAt).toBe('1970-01-01T00:00:00.000Z')
  })
  it('keeps non-JSON and invalid JSON as text', () => {
    expect(JSON.parse(buildPayload(Buffer.from('hello'), { 'content-type': 'text/plain' }, 0)).body).toBe('hello')
    expect(JSON.parse(buildPayload(Buffer.from('{oops'), { 'content-type': 'application/json' }, 0)).body).toBe('{oops')
  })
  it('bounds a big body and says it was cut, still as valid JSON', () => {
    const text = buildPayload(Buffer.from(JSON.stringify({ blob: 'x'.repeat(40_000) })), { 'content-type': 'application/json' }, 0)
    expect(text.length).toBeLessThanOrEqual(WEBHOOK_MAX_PAYLOAD_CHARS)
    expect(JSON.parse(text).truncated).toBe(true)
  })
})
