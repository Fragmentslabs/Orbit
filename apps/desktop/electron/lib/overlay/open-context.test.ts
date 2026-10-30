import { describe, expect, it } from 'vitest'
import { OPEN_CONTEXT_TTL_MS, overlayOpenContext, overlayOpenContextLine, setOverlayOpenContext } from './open-context'

describe('overlay opening context', () => {
  const noted = { app: 'Mail', bundleId: 'com.apple.mail', pid: 42, windowTitle: 'Fatura de outubro', at: 1_000 }

  it('the window title goes marked as screen data', () => {
    const line = overlayOpenContextLine(noted)!
    expect(line).toContain('the user was in Mail (com.apple.mail)')
    expect(line).toContain('<screen_content untrusted="true">Fatura de outubro</screen_content>')
  })

  it('wins: past the deadline, the noted app is no longer where the person is', () => {
    setOverlayOpenContext(noted)
    expect(overlayOpenContext(noted.at + 1_000)).toEqual(noted)
    expect(overlayOpenContext(noted.at + OPEN_CONTEXT_TTL_MS + 1)).toBeNull()
    setOverlayOpenContext(null)
  })

  it('with no noted window, there is no line', () => {
    expect(overlayOpenContextLine(null)).toBeNull()
    expect(overlayOpenContextLine({ ...noted, windowTitle: null })).not.toContain('screen_content')
  })
})
