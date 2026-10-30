import { describe, expect, it } from 'vitest'

import { imageVisionGuidance } from './prompts'

/**
 * The three branches of "can the agent look at the image?".
 *
 * What is at stake is not wording: it is the agent promising what it cannot (saying
 * it will check the photo when it has no way to) or asking for what it already has (suggesting
 * turning Vision on to someone who has it on). Both mistakes are visible
 * to the user and destroy trust in the following answer.
 */

const MODEL_SEES = true
const MODEL_BLIND = false
const VISION_ON = true
const VISION_OFF = false

describe('imageVisionGuidance', () => {
  it('text model with Vision on: tells it to look with describe_image', () => {
    const text = imageVisionGuidance(MODEL_BLIND, VISION_ON)
    expect(text).toContain('describe_image')
    expect(text).toContain('Vision mode is ON')
    // It cannot ask to turn on what is already on.
    expect(text).not.toMatch(/turning on Vision mode|Vision mode is off/)
  })

  it('text model without Vision: warns the user instead of faking precision', () => {
    const text = imageVisionGuidance(MODEL_BLIND, VISION_OFF)
    expect(text).toContain('Vision mode is off')
    expect(text).toContain('turning on Vision mode')
    // And it cannot tell you to call a tool that does not exist in this configuration.
    expect(text).not.toContain('describe_image')
  })

  it('a model that can see: does not suggest turning Vision on nor tells it to look at what it already saw', () => {
    const text = imageVisionGuidance(MODEL_SEES, VISION_OFF)
    expect(text).toContain('CURRENT message')
    expect(text).not.toContain('turning on Vision mode')
    expect(text).not.toContain('describe_image')
  })

  it('a model that sees WITH Vision on: also reaches the gallery image', () => {
    // The gallery image is not in anyone's context — not even a vision
    // model's. With Vision on there is a path; without it, there is none.
    const withVision = imageVisionGuidance(MODEL_SEES, VISION_ON)
    const withoutVision = imageVisionGuidance(MODEL_SEES, VISION_OFF)
    expect(withVision).toContain('describe_image')
    expect(withoutVision).toContain('ask the user to attach it')
  })

  it('all branches clear what does NOT need eyes', () => {
    // Half of the operations measure the image itself. A warning that discouraged
    // everything would make the agent hesitate to resize a photo.
    for (const [model, vision] of [
      [MODEL_SEES, VISION_ON],
      [MODEL_SEES, VISION_OFF],
      [MODEL_BLIND, VISION_ON],
      [MODEL_BLIND, VISION_OFF],
    ]) {
      const text = imageVisionGuidance(model, vision)
      // It checks the CLAIM, not the wording: what cannot be missing in any branch
      // is saying that these operations measure the image on their own.
      expect(text).toContain('Resizing')
      expect(text).toContain('removing a background')
      expect(text).toContain('measure the image themselves')
    }
  })

  it('all branches name what depends on WHERE things are', () => {
    for (const [model, vision] of [
      [MODEL_SEES, VISION_ON],
      [MODEL_SEES, VISION_OFF],
      [MODEL_BLIND, VISION_ON],
      [MODEL_BLIND, VISION_OFF],
    ]) {
      expect(imageVisionGuidance(model, vision)).toContain('WHERE things are')
    }
  })
})
