import { ComputerError, type AppInfo } from './types'

/**
 * Política de segurança do Computer Use. O que está aqui é bloqueio duro: nem
 * o modo de permissão total libera. O resto (aprovação por app) é do gate de
 * permissões — ver assessComputer em permission/rules.ts.
 */

/** Cofres de senha, ajustes do sistema e prompts de segurança. */
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

/** Nomes que o modelo pode mandar no lugar do bundle id. */
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
]

/**
 * Navegadores: a aprovação vale por site, não pelo app inteiro — aprovar
 * "Safari" uma vez não pode liberar o banco aberto na outra aba.
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
])

/**
 * Navegadores Chromium: além do AXManualAccessibility (Electron), só eles
 * recebem AXEnhancedUserInterface — em app nativo a flag mexe em animação de
 * janela.
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

export function isDeniedApp(app: { bundleId: string | null; name: string }): boolean {
  if (app.bundleId && DENIED_BUNDLES.has(app.bundleId)) return true
  return DENIED_NAMES.some((re) => re.test(app.name))
}

/** Versão por texto livre (o `app` que o modelo mandou), usada antes de resolver o app. */
export function isDeniedQuery(query: string): boolean {
  const q = query.trim()
  if (DENIED_BUNDLES.has(q)) return true
  return DENIED_NAMES.some((re) => re.test(q))
}

/** Recusa o alvo: app negado ou o próprio Orbit (para ele existem as outras tools). */
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

/** Chave de aprovação do gate: por app, e por site quando o app é navegador. */
export function approvalKey(bundleOrName: string, url?: string | null): string {
  const host = BROWSER_BUNDLES.has(bundleOrName) ? hostOf(url) : null
  return host ? `cu:app:${bundleOrName}@${host}` : `cu:app:${bundleOrName}`
}
