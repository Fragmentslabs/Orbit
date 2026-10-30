import { ComputerError, type AppInfo } from './types'

/**
 * Security policy of Computer Use. What is here is a hard block: not even the
 * full-permission mode releases it. The rest (approval per app) belongs to the
 * permission gate — see assessComputer in permission/rules.ts.
 */

/** Password vaults, system settings and security prompts. */
const DENIED_BUNDLES = new Set([
  'com.1password.1password',
  'com.agilebits.onepassword7',
  'com.agilebits.onepassword-osx',
  'com.bitwarden.desktop',
  'com.lastpass.LastPass',
  'com.dashlane.Dashlane',
  'com.dashlane.dashlanephonefinal',
  'com.apple.keychainaccess',
  'com.apple.Passwords',
  'com.apple.systempreferences',
  'com.apple.Settings',
  'com.apple.SecurityAgent',
  'com.apple.LocalAuthentication.UIAgent',
  'com.apple.coreservices.UIAgent',
])

/**
 * Windows: exe (lowercase) and package family (AUMID without the "!App"). Password
 * vaults, Windows Security, Settings, the UAC (`consent.exe`), the credentials dialog
 * and the lock screen. The UAC and the lock screen run on the secure desktop and would
 * not even be reachable — they stay here as a second lock.
 */
const DENIED_WIN_EXES = new Set([
  '1password.exe',
  'bitwarden.exe',
  'lastpass.exe',
  'dashlane.exe',
  'keepass.exe',
  'keepassxc.exe',
  'enpass.exe',
  'nordpass.exe',
  'securityhealthui.exe',
  'sechealthui.exe',
  'securityhealthhost.exe',
  'systemsettings.exe',
  'systemsettingsadminflows.exe',
  'useraccountcontrolsettings.exe',
  'consent.exe',
  'credentialuibroker.exe',
  'logonui.exe',
  'lockapp.exe',
  'control.exe',
])

const DENIED_WIN_PACKAGES = [
  'microsoft.sechealthui_',
  'windows.immersivecontrolpanel_',
  'microsoft.windows.secureassessmentbrowser_',
  'agilebits.1password',
]

/** Names the model may send instead of the bundle id. */
const DENIED_NAMES = [
  /1password/i,
  /bitwarden/i,
  /lastpass/i,
  /dashlane/i,
  /keychain/i,
  /^passwords?$/i,
  /^senhas$/i,
  /system (settings|preferences)/i,
  /ajustes do sistema/i,
  /prefer[eê]ncias do sistema/i,
  /keepass/i,
  /windows security/i,
  /seguran[cç]a do windows/i,
  /windows defender/i,
  /^(windows )?settings$/i,
  /^configura[cç][oõ]es( do windows)?$/i,
  /credential manager/i,
  /gerenciador de credenciais/i,
  /user account control/i,
  /controle de conta de usu[aá]rio/i,
  /^control panel$/i,
  /^painel de controle$/i,
]

/**
 * Browsers: the approval holds per site, not for the whole app — approving "Safari"
 * once cannot release the bank open in the other tab.
 */
export const BROWSER_BUNDLES = new Set([
  'com.apple.Safari',
  'com.apple.SafariTechnologyPreview',
  'com.google.Chrome',
  'com.google.Chrome.canary',
  'com.brave.Browser',
  'com.microsoft.edgemac',
  'company.thebrowser.Browser',
  'org.mozilla.firefox',
  'com.operasoftware.Opera',
  'com.vivaldi.Vivaldi',
  // Windows: the app id is the exe.
  'chrome.exe',
  'msedge.exe',
  'brave.exe',
  'vivaldi.exe',
  'opera.exe',
  'firefox.exe',
  'arc.exe',
  'chromium.exe',
])

/** Is the id a browser's? (on Windows the exe arrives in any case) */
export function isBrowserId(id: string): boolean {
  return BROWSER_BUNDLES.has(id) || BROWSER_BUNDLES.has(id.toLowerCase())
}

/**
 * Chromium browsers: besides AXManualAccessibility (Electron), only they receive
 * AXEnhancedUserInterface — in a native app the flag messes with window animation.
 */
export const CHROMIUM_BROWSERS = new Set([
  'com.google.Chrome',
  'com.google.Chrome.canary',
  'org.chromium.Chromium',
  'com.brave.Browser',
  'com.microsoft.edgemac',
  'company.thebrowser.Browser',
  'com.operasoftware.Opera',
  'com.vivaldi.Vivaldi',
])

function deniedWindowsId(id: string): boolean {
  const lower = id.trim().toLowerCase()
  if (DENIED_WIN_EXES.has(lower) || DENIED_WIN_EXES.has(`${lower}.exe`)) return true
  return DENIED_WIN_PACKAGES.some((prefix) => lower.startsWith(prefix))
}

export function isDeniedApp(app: { bundleId: string | null; name: string; exe?: string }): boolean {
  if (app.bundleId && (DENIED_BUNDLES.has(app.bundleId) || deniedWindowsId(app.bundleId))) return true
  if (app.exe && deniedWindowsId(app.exe)) return true
  return DENIED_NAMES.some((re) => re.test(app.name))
}

/** Version by free text (the `app` the model sent), used before resolving the app. */
export function isDeniedQuery(query: string): boolean {
  const q = query.trim()
  if (DENIED_BUNDLES.has(q) || deniedWindowsId(q)) return true
  return DENIED_NAMES.some((re) => re.test(q))
}

/** Refuses the target: denied app or Orbit itself (for it there are the other tools). */
export function assertTargetAllowed(app: AppInfo, ownPid: number = process.pid): void {
  if (app.pid === ownPid) {
    throw new ComputerError('blocked', 'Orbit cannot control its own window — use Orbit\'s own tools for that.')
  }
  if (isDeniedApp(app)) {
    throw new ComputerError(
      'blocked',
      `${app.name} is on the safety denylist (password managers, system settings and security prompts). Ask the user to do this themselves.`,
    )
  }
  // UIPI discards input coming from a common process to an elevated app:
  // the action would "work" with no effect at all. Better to refuse with the reason.
  if (app.elevated) {
    throw new ComputerError(
      'elevated',
      `${app.name} is running as administrator, and Windows blocks a normal app (Orbit) from controlling it. Ask the user to do this step themselves, or to run ${app.name} without administrator rights.`,
    )
  }
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.host || null
  } catch {
    return null
  }
}

/** Gate approval key: per app, and per site when the app is a browser. */
export function approvalKey(bundleOrName: string, url?: string | null): string {
  const host = isBrowserId(bundleOrName) ? hostOf(url) : null
  return host ? `cu:app:${bundleOrName}@${host}` : `cu:app:${bundleOrName}`
}
