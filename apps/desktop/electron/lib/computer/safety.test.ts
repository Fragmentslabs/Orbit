import { describe, expect, it } from 'vitest'
import { approvalKey, assertTargetAllowed, hostOf, isDeniedApp, isDeniedQuery } from './safety'
import type { AppInfo } from './types'

const app = (over: Partial<AppInfo>): AppInfo => ({ pid: 42, bundleId: 'com.apple.TextEdit', name: 'TextEdit', active: true, hidden: false, ...over })

describe('denylist', () => {
  it('password vaults and system settings, by bundle and by name', () => {
    expect(isDeniedApp(app({ bundleId: 'com.1password.1password', name: '1Password' }))).toBe(true)
    expect(isDeniedApp(app({ bundleId: 'com.apple.systempreferences', name: 'System Settings' }))).toBe(true)
    expect(isDeniedApp(app({ bundleId: null, name: 'Ajustes do Sistema' }))).toBe(true)
    expect(isDeniedApp(app({}))).toBe(false)
  })

  it('the free text from the model is also blocked before resolving the app', () => {
    expect(isDeniedQuery('com.bitwarden.desktop')).toBe(true)
    expect(isDeniedQuery('Keychain Access')).toBe(true)
    expect(isDeniedQuery('Safari')).toBe(false)
  })

  it('refuses Orbit itself and denied apps', () => {
    expect(() => assertTargetAllowed(app({ pid: 7 }), 7)).toThrow(/its own window/)
    expect(() => assertTargetAllowed(app({ bundleId: 'com.apple.keychainaccess', name: 'Keychain Access' }), 1)).toThrow(/denylist/)
    expect(() => assertTargetAllowed(app({}), 1)).not.toThrow()
  })
})

describe('approvalKey', () => {
  it('a browser approves by site; other apps, by app', () => {
    expect(approvalKey('com.apple.Safari', 'https://banco.com.br/conta')).toBe('cu:app:com.apple.Safari@banco.com.br')
    expect(approvalKey('com.apple.Safari', null)).toBe('cu:app:com.apple.Safari')
    expect(approvalKey('com.apple.TextEdit', 'https://x.com')).toBe('cu:app:com.apple.TextEdit')
  })

  it('an invalid URL does not become a host', () => {
    expect(hostOf('not a url')).toBeNull()
    expect(hostOf('about:blank')).toBeNull()
  })
})

describe('Windows', () => {
  const win = (over: Partial<AppInfo>): AppInfo => app({ bundleId: 'notepad.exe', exe: 'notepad.exe', name: 'Bloco de Notas', ...over })

  it('denylist by exe, package family and name', () => {
    expect(isDeniedApp(win({ bundleId: 'Consent.exe', exe: 'Consent.exe', name: 'consent' }))).toBe(true)
    expect(isDeniedApp(win({ bundleId: 'KeePassXC.exe', exe: 'KeePassXC.exe', name: 'KeePassXC' }))).toBe(true)
    expect(isDeniedApp(win({ bundleId: 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel', exe: 'SystemSettings.exe', name: 'Configurações' }))).toBe(true)
    expect(isDeniedApp(win({ bundleId: 'Microsoft.SecHealthUI_8wekyb3d8bbwe!SecHealthUI', exe: 'SecHealthUI.exe', name: 'Segurança do Windows' }))).toBe(true)
    expect(isDeniedApp(win({}))).toBe(false)
    expect(isDeniedQuery('systemsettings')).toBe(true)
    expect(isDeniedQuery('Windows Security')).toBe(true)
    expect(isDeniedQuery('notepad')).toBe(false)
  })

  it('an elevated app is refused with the reason', () => {
    expect(() => assertTargetAllowed(win({ elevated: true }), 1)).toThrow(/administrator/)
  })

  it('a browser by exe approves by site, in any case', () => {
    expect(approvalKey('chrome.exe', 'https://banco.com.br/x')).toBe('cu:app:chrome.exe@banco.com.br')
    expect(approvalKey('MSEDGE.EXE', 'https://a.com')).toBe('cu:app:MSEDGE.EXE@a.com')
    expect(approvalKey('notepad.exe', 'https://a.com')).toBe('cu:app:notepad.exe')
  })
})
