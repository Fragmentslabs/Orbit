import { describe, expect, it } from 'vitest'
import { OPEN_CONTEXT_TTL_MS, overlayOpenContext, overlayOpenContextLine, setOverlayOpenContext } from './open-context'

describe('contexto de abertura do overlay', () => {
  const noted = { app: 'Mail', bundleId: 'com.apple.mail', pid: 42, windowTitle: 'Fatura de outubro', at: 1_000 }

  it('o título da janela vai marcado como dado da tela', () => {
    const line = overlayOpenContextLine(noted)!
    expect(line).toContain('the user was in Mail (com.apple.mail)')
    expect(line).toContain('<screen_content untrusted="true">Fatura de outubro</screen_content>')
  })

  it('vence: depois do prazo, o app anotado já não é onde a pessoa está', () => {
    setOverlayOpenContext(noted)
    expect(overlayOpenContext(noted.at + 1_000)).toEqual(noted)
    expect(overlayOpenContext(noted.at + OPEN_CONTEXT_TTL_MS + 1)).toBeNull()
    setOverlayOpenContext(null)
  })

  it('sem janela anotada, não há linha', () => {
    expect(overlayOpenContextLine(null)).toBeNull()
    expect(overlayOpenContextLine({ ...noted, windowTitle: null })).not.toContain('screen_content')
  })
})
