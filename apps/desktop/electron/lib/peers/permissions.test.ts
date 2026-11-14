import { describe, expect, it } from 'vitest'
import { TOOLS_REQUEST_TYPES } from '@shared/tools-remote'
import { classifyDesktopRequest, desktopMayRequest, isDesktopOnlyRequest } from './permissions'

const grants = (over: Partial<{ control: boolean; send: boolean; files: boolean }> = {}) => ({ control: false, send: false, files: false, ...over })

describe('the Tools screen requests', () => {
  it('are control-only, desktop-only requests', () => {
    for (const type of TOOLS_REQUEST_TYPES) {
      expect(classifyDesktopRequest(type)).toBe('control')
      expect(isDesktopOnlyRequest(type)).toBe(true)
      expect(desktopMayRequest(type, grants({ control: true }))).toBe(true)
      expect(desktopMayRequest(type, grants({ send: true, files: true }))).toBe(false)
      expect(desktopMayRequest(type, grants())).toBe(false)
    }
  })

  it('do not leak into the phone path or widen the other classes', () => {
    expect(isDesktopOnlyRequest('memory:list')).toBe(false)
    expect(isDesktopOnlyRequest('tools:select')).toBe(false)
    expect(classifyDesktopRequest('messages:get')).toBe('view')
  })
})
