import { describe, expect, it } from 'vitest'
import { modelFileParts, type FilePart, type MessagePart } from '@shared/chat'

/**
 * What of an attachment reaches THE MODEL.
 *
 * The rule is a single one: the model receives the text that represents the attachment (the document's
 * opening excerpt, the image/audio/video note) and only receives the BYTES
 * when it really needs to look at them — native vision, and only in the turn in which the attachment
 * arrived. Without this, the photo pasted in the conversation's first turn was resent
 * in all the following ones, forever.
 */

const chip = (): FilePart => ({
  id: 'f1',
  type: 'file',
  mime: 'image/webp',
  filename: 'photo.webp',
  url: 'data:image/webp;base64,AAAA',
  chip: true,
})

const image = (turnOnly?: boolean): FilePart => ({
  id: 'f2',
  type: 'file',
  mime: 'image/png',
  filename: 'photo.png',
  url: 'data:image/png;base64,AAAA',
  ...(turnOnly ? { turnOnly: true } : {}),
})

const text = (): MessagePart => ({ id: 'p1', type: 'text', text: 'hi', state: 'done' })

describe('attachments that go to the model', () => {
  it('a chip never goes: its content is already in the sibling TextPart', () => {
    expect(modelFileParts([chip(), text()], true)).toEqual([])
    // Not even in the current turn: a chip is UI decoration in any turn.
    expect(modelFileParts([chip()], true)).toEqual([])
  })

  it('a regular attachment goes on every turn (the case of a file the model needs to see)', () => {
    const part = { ...image(), chip: undefined, turnOnly: undefined } as FilePart
    expect(modelFileParts([part], false)).toHaveLength(1)
    expect(modelFileParts([part], true)).toHaveLength(1)
  })

  it('turnOnly goes on the turn it arrived and stops going after that', () => {
    const parts = [image(true), text()]
    const inTurn = modelFileParts(parts, true)
    expect(inTurn).toHaveLength(1)
    expect(inTurn[0].id).toBe('f2')
    // In the following ones, only the text (the reference line) remains.
    expect(modelFileParts(parts, false)).toEqual([])
  })

  it('an empty url is also left out (chips stored before the flag existed)', () => {
    const oldOne: FilePart = { ...image(), chip: undefined, url: '' }
    expect(modelFileParts([oldOne], true)).toEqual([])
  })
})
