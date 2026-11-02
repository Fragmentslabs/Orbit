import { describe, expect, it } from 'vitest'
import { GUIDE_FIRST, hasReadGuide, markGuideRead } from './guide-gate'

describe('guide gate', () => {
  it('remembers a topic per conversation', () => {
    expect(hasReadGuide('chat-a', 'motion')).toBe(false)
    markGuideRead('chat-a', 'motion')
    expect(hasReadGuide('chat-a', 'motion')).toBe(true)
    expect(hasReadGuide('chat-a', 'motion-craft')).toBe(false)
    expect(hasReadGuide('chat-b', 'motion')).toBe(false)
  })

  it('tells the agent exactly what to do, and that nothing was written', () => {
    expect(GUIDE_FIRST).toContain('video_guide("motion")')
    expect(GUIDE_FIRST).toContain('video_guide("motion-craft")')
    expect(GUIDE_FIRST).toContain('Nothing was written')
  })
})
