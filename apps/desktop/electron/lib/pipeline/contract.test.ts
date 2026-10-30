import { describe, expect, it } from 'vitest'
import { extractNote } from './contract'

describe('extractNote', () => {
  it('reads the ```note block the phase prompt asks for', () => {
    expect(extractNote('Done.\n\n```note\nChanged a.ts\n```')).toBe('Changed a.ts')
  })

  it('still reads ```anotacao, the tag from before the English rename', () => {
    expect(extractNote('```anotacao\nAlterei a.ts\n```')).toBe('Alterei a.ts')
  })

  it('no block, or an empty one, is no note', () => {
    expect(extractNote('I changed a.ts')).toBeUndefined()
    expect(extractNote('```note\n   \n```')).toBeUndefined()
  })
})
