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

/**
 * Windows: exe (minúsculo) e família de pacote (AUMID sem o "!App"). Cofres de
 * senha, Segurança do Windows, Configurações, o UAC (`consent.exe`), o diálogo
 * de credenciais e a tela de bloqueio. O UAC e a tela de bloqueio rodam no
 * desktop seguro e nem seriam alcançáveis — ficam aqui como segunda trava.
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
  // Windows: o id do app é o exe.
  'chrome.exe',
  'msedge.exe',
  'brave.exe',
  'vivaldi.exe',
  'opera.exe',
  'firefox.exe',
  'arc.exe',
  'chromium.exe',
])

/** O id é de navegador? (no Windows o exe chega com qualquer caixa) */
export function isBrowserId(id: string): boolean {
  return BROWSER_BUNDLES.has(id) || BROWSER_BUNDLES.has(id.toLowerCase())
}

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

/** Versão por texto livre (o `app` que o modelo mandou), usada antes de resolver o app. */
export function isDeniedQuery(query: string): boolean {
  const q = query.trim()
  if (DENIED_BUNDLES.has(q) || deniedWindowsId(q)) return true
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
  // O UIPI descarta a entrada vinda de um processo comum para um app elevado:
  // a ação "funcionaria" sem efeito nenhum. Melhor recusar com o motivo.
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

/** Chave de aprovação do gate: por app, e por site quando o app é navegador. */
export function approvalKey(bundleOrName: string, url?: string | null): string {
  const host = isBrowserId(bundleOrName) ? hostOf(url) : null
  return host ? `cu:app:${bundleOrName}@${host}` : `cu:app:${bundleOrName}`
}
