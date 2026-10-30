import { describe, expect, it } from 'vitest'
import { underscoreBlankWarning } from './markdown-blanks'

/**
 * The case came from a school test: "**Date:** ____/____/______" reached the screen
 * as "Date: //______". The warning exists for the model to fix it by itself in the
 * following call, so it cannot shout on a document that is correct —
 * a false warning teaches you to ignore the warning.
 */

describe('underscoreBlankWarning', () => {
  it('warns about the date field that becomes "//"', () => {
    const warning = underscoreBlankWarning('**Name:** ______\n\n**Date:** ____/____/______')
    expect(warning).toContain('line 3')
    expect(warning).toContain('update_document')
  })

  it('stays silent about a lone field, which is rendered whole', () => {
    expect(underscoreBlankWarning('**Escola:** ____________________')).toBeNull()
  })

  it('stays silent about the gap at the end of the account', () => {
    expect(underscoreBlankWarning('a) 245 + 138 = ______\n\nb) 356 + 274 = ______')).toBeNull()
  })

  it('stays silent about real bold', () => {
    // __like this__ is also two groups on the same line, but with TEXT in between:
    // it is bold asked for on purpose, not a broken field.
    expect(underscoreBlankWarning('This is __really__ bold, and __this__ too.')).toBeNull()
  })

  it('catches a phone and an ID number for the same reason', () => {
    expect(underscoreBlankWarning('Telefone: (__)_____-____')).toContain('line 1')
    expect(underscoreBlankWarning('CPF: ___.___.___-__')).toContain('line 1')
  })

  it('stays silent when the groups are separated by a space', () => {
    expect(underscoreBlankWarning('**Data:** ____ / ____ / ______')).toBeNull()
  })

  it('lists the lines when there are several', () => {
    const warning = underscoreBlankWarning('Date: __/__/__\nx\nTax ID: ___.___.___-__')
    expect(warning).toContain('lines 1, 3')
  })
})
