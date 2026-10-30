import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  attributionLine,
  isPublicDomain,
  matchesLicense,
  openverseLicenseName,
  parseCommons,
  parseOpenverse,
  plainText,
  restrictsUse,
} from './providers'

// REAL responses from both APIs, recorded: they are how one notices when a
// provider changes the format.
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))

describe('parseCommons (real response)', () => {
  const results = parseCommons(fixture('commons.json'))

  it('brings the images with id, clean title, size and resized file', () => {
    expect(results).toHaveLength(3)
    const [first] = results
    expect(first.id).toMatch(/^wc:\d+$/)
    expect(first.provider).toBe('commons')
    expect(first.title).toMatch(/^Lion \(Panthera leo\)/)
    expect(first.title).not.toMatch(/^File:|\.jpg$/)
    expect(first.width).toBe(3040)
    expect(first.downloadUrl).toMatch(/^https:\/\/upload\.wikimedia\.org|^https:\/\/thumb\.wikimedia\.org/)
    // The original stays as an alternative when the resized one fails.
    expect(first.fallbackUrl).toMatch(/^https:\/\/upload\.wikimedia\.org/)
  })

  it('the credit comes complete: author in plain text, license, link and the ready line', () => {
    const { credit } = results[0]
    expect(credit.license).toBe('CC BY-SA 4.0')
    expect(credit.licenseUrl).toBe('https://creativecommons.org/licenses/by-sa/4.0')
    expect(credit.creator).not.toMatch(/[<>]/)
    expect(credit.creator?.length).toBeGreaterThan(2)
    expect(credit.sourceUrl).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/)
    expect(credit.attribution).toContain(`"${credit.title}"`)
    expect(credit.attribution).toContain('licensed under CC BY-SA 4.0')
    expect(credit.attribution).toContain(credit.sourceUrl)
  })

  it('ignores what is not a raster image, has no license or is incomplete', () => {
    const base = fixture('commons.json')
    const page = Object.values(base.query.pages)[0] as { imageinfo: Array<{ mime: string; extmetadata: Record<string, unknown> }> }
    const svg = structuredClone(base)
    ;(Object.values(svg.query.pages)[0] as typeof page).imageinfo[0].mime = 'image/svg+xml'
    expect(parseCommons(svg)).toHaveLength(2)
    const noLicense = structuredClone(base)
    ;(Object.values(noLicense.query.pages)[0] as typeof page).imageinfo[0].extmetadata = {}
    expect(parseCommons(noLicense)).toHaveLength(2)
    expect(parseCommons(null)).toEqual([])
    expect(parseCommons({ query: {} })).toEqual([])
  })
})

describe('parseOpenverse (real response)', () => {
  const results = parseOpenverse(fixture('openverse.json'))

  it('brings id, origin, readable license and the credit', () => {
    expect(results).toHaveLength(3)
    expect(results[0]).toMatchObject({ provider: 'openverse', origin: 'flickr', title: 'lion' })
    expect(results[0].id).toMatch(/^ov:[0-9a-f-]{36}$/)
    expect(results[0].credit.license).toBe('CC0 1.0')
    expect(results[0].credit.creator).toBe('Mathias Appel')
    expect(results[0].credit.attribution).toContain('marked CC0 1.0')
    expect(results[0].fallbackUrl).toMatch(/api\.openverse\.org\/v1\/images\/.+\/thumb\/$/)
  })

  it('a license that restricts use shows up as such (the search then filters it)', () => {
    const restricted = results.find((r) => r.credit.license.includes('NC'))
    expect(restricted?.credit.license).toBe('CC BY-NC-ND 2.0')
  })

  it('an empty or broken response breaks nothing', () => {
    expect(parseOpenverse({ results: [] })).toEqual([])
    expect(parseOpenverse({})).toEqual([])
    expect(parseOpenverse({ results: [{ id: 'x' }] })).toEqual([])
  })
})

describe('licenses', () => {
  it('Openverse names', () => {
    expect(openverseLicenseName('by-sa', '4.0')).toBe('CC BY-SA 4.0')
    expect(openverseLicenseName('cc0', '1.0')).toBe('CC0 1.0')
    expect(openverseLicenseName('pdm', undefined)).toBe('Public Domain Mark 1.0')
    expect(openverseLicenseName(undefined, '1.0')).toBe('')
  })

  it('the filter: commercial excludes NC and ND; public domain only CC0/PD; any accepts everything', () => {
    expect(matchesLicense('CC BY 4.0', 'commercial')).toBe(true)
    expect(matchesLicense('CC BY-SA 3.0', 'commercial')).toBe(true)
    expect(matchesLicense('CC BY-NC 2.0', 'commercial')).toBe(false)
    expect(matchesLicense('CC BY-NC-ND 2.0', 'commercial')).toBe(false)
    expect(matchesLicense('CC BY-ND 2.0', 'commercial')).toBe(false)
    expect(matchesLicense('CC0 1.0', 'public-domain')).toBe(true)
    expect(matchesLicense('Public domain', 'public-domain')).toBe(true)
    expect(matchesLicense('CC BY 4.0', 'public-domain')).toBe(false)
    expect(matchesLicense('CC BY-NC 2.0', 'any')).toBe(true)
    expect(isPublicDomain('Public Domain Mark 1.0')).toBe(true)
    expect(restrictsUse('CC BY-SA 4.0')).toBe(false)
  })
})

describe('text and credit', () => {
  it('plainText tira tags e entidades', () => {
    expect(plainText('<bdi><a href="x">Jane &amp; Co</a></bdi> ')).toBe('Jane & Co')
    expect(plainText(undefined)).toBe('')
  })

  it('the credit line: title, author, license and source; public domain is "marked"', () => {
    expect(attributionLine({ title: 'Lion', creator: 'Ana', license: 'CC BY 4.0', licenseUrl: 'https://x/by', sourceUrl: 'https://src' })).toBe(
      '"Lion" by Ana, licensed under CC BY 4.0 (https://x/by). Source: https://src',
    )
    expect(attributionLine({ license: 'CC0 1.0', sourceUrl: 'https://src' })).toBe('Image, marked CC0 1.0. Source: https://src')
  })
})
