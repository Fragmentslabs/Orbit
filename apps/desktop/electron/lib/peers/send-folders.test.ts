import { describe, expect, it } from 'vitest'
import { cleanDirectories } from './send-folders'

describe('cleanDirectories', () => {
  it('keeps an absolute folder and its absolute extras', () => {
    expect(cleanDirectories({ directory: '/work/app', extraDirectories: ['/work/lib'] })).toEqual({
      directory: '/work/app',
      extraDirectories: ['/work/lib'],
    })
  })

  it('drops relative, empty and non-string folders', () => {
    expect(cleanDirectories({ directory: 'app' })).toEqual({})
    expect(cleanDirectories({ directory: '' })).toEqual({})
    expect(cleanDirectories({ directory: '/work/app', extraDirectories: ['rel', '', 7 as unknown as string] })).toEqual({ directory: '/work/app' })
  })

  it('ignores extras without a main folder and caps how many it keeps', () => {
    expect(cleanDirectories({ extraDirectories: ['/a'] })).toEqual({})
    const many = Array.from({ length: 20 }, (_, i) => `/x/${i}`)
    expect(cleanDirectories({ directory: '/m', extraDirectories: many }).extraDirectories).toHaveLength(8)
  })
})
