import { describe, expect, it } from 'vitest'
import { approvalKey, assertTargetAllowed, hostOf, isDeniedApp, isDeniedQuery } from './safety'
import type { AppInfo } from './types'

const app = (over: Partial<AppInfo>): AppInfo => ({ pid: 42, bundleId: 'com.apple.TextEdit', name: 'TextEdit', active: true, hidden: false, ...over })

describe('denylist', () => {
  it('cofres de senha e ajustes do sistema, por bundle e por nome', () => {
    expect(isDeniedApp(app({ bundleId: 'com.1password.1password', name: '1Password' }))).toBe(true)
    expect(isDeniedApp(app({ bundleId: 'com.apple.systempreferences', name: 'System Settings' }))).toBe(true)
    expect(isDeniedApp(app({ bundleId: null, name: 'Ajustes do Sistema' }))).toBe(true)
    expect(isDeniedApp(app({}))).toBe(false)
  })

  it('o texto livre do modelo também é barrado antes de resolver o app', () => {
    expect(isDeniedQuery('com.bitwarden.desktop')).toBe(true)
    expect(isDeniedQuery('Keychain Access')).toBe(true)
    expect(isDeniedQuery('Safari')).toBe(false)
  })

  it('recusa o próprio Orbit e apps negados', () => {
    expect(() => assertTargetAllowed(app({ pid: 7 }), 7)).toThrow(/its own window/)
    expect(() => assertTargetAllowed(app({ bundleId: 'com.apple.keychainaccess', name: 'Keychain Access' }), 1)).toThrow(/denylist/)
    expect(() => assertTargetAllowed(app({}), 1)).not.toThrow()
  })
})

describe('approvalKey', () => {
  it('navegador aprova por site; outros apps, pelo app', () => {
    expect(approvalKey('com.apple.Safari', 'https://banco.com.br/conta')).toBe('cu:app:com.apple.Safari@banco.com.br')
    expect(approvalKey('com.apple.Safari', null)).toBe('cu:app:com.apple.Safari')
    expect(approvalKey('com.apple.TextEdit', 'https://x.com')).toBe('cu:app:com.apple.TextEdit')
  })

  it('URL inválida não vira host', () => {
    expect(hostOf('not a url')).toBeNull()
    expect(hostOf('about:blank')).toBeNull()
  })
})
