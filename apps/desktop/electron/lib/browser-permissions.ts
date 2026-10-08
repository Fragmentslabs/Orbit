import {
  BrowserWindow,
  desktopCapturer,
  dialog,
  session,
  shell,
  systemPreferences,
  type WebContents,
} from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { dataDir } from './storage'
import { t, type MainMessageKey } from './i18n'

/**
 * Permissões de site no navegador integrado (partition do painel e da engine
 * oculta de scripts): câmera, microfone, localização, notificações, leitura da
 * área de transferência e compartilhamento de tela.
 *
 * Sem handler o Electron aprovava tudo em silêncio — e mesmo assim câmera e
 * microfone falhavam, porque o macOS nunca era consultado. Aqui cada site pede
 * como num navegador: um diálogo "Permitir / Bloquear" com "lembrar para este
 * site", e só depois do "sim" o macOS é consultado (o prompt do sistema
 * aparece uma vez para o app inteiro).
 *
 * Decisões lembradas ficam em orbit-data/browser-permissions.json, por origem;
 * as não lembradas valem até o app fechar. "Limpar dados do navegador" apaga as
 * duas.
 */

type Kind = 'camera' | 'microphone' | 'geolocation' | 'notifications' | 'clipboard-read' | 'midi-sysex'
type Decision = 'allow' | 'deny'

const KIND_LABEL: Record<Kind, MainMessageKey> = {
  camera: 'browserPerm.camera',
  microphone: 'browserPerm.microphone',
  geolocation: 'browserPerm.geolocation',
  notifications: 'browserPerm.notifications',
  'clipboard-read': 'browserPerm.clipboard',
  'midi-sysex': 'browserPerm.midi',
}

function storeFile(): string {
  return path.join(dataDir(), 'browser-permissions.json')
}

let remembered: Record<string, Partial<Record<Kind, Decision>>> | null = null
/** Decisões sem "lembrar": valem até o app fechar. */
const sessionDecisions = new Map<string, Decision>()
/** Um diálogo por origem+tipos de cada vez — a página pode pedir em rajada. */
const pending = new Map<string, Promise<boolean>>()

async function loadRemembered(): Promise<Record<string, Partial<Record<Kind, Decision>>>> {
  if (remembered) return remembered
  try {
    remembered = JSON.parse(await fsp.readFile(storeFile(), 'utf8'))
  } catch {
    remembered = {}
  }
  return remembered!
}

async function persist(): Promise<void> {
  if (!remembered) return
  await fsp.mkdir(path.dirname(storeFile()), { recursive: true })
  await fsp.writeFile(storeFile(), JSON.stringify(remembered, null, 2), 'utf8')
}

function decisionFor(origin: string, kind: Kind): Decision | undefined {
  return remembered?.[origin]?.[kind] ?? sessionDecisions.get(`${origin}|${kind}`)
}

/** Tipos geridos aqui; null = fora do escopo (segue o padrão do Electron). */
function kindsForRequest(permission: string, details: { mediaTypes?: ('video' | 'audio')[] }): Kind[] | null {
  switch (permission) {
    case 'media': {
      const types = details.mediaTypes?.length ? details.mediaTypes : (['video', 'audio'] as const)
      return types.map((m) => (m === 'video' ? 'camera' : 'microphone'))
    }
    case 'geolocation':
      return ['geolocation']
    case 'notifications':
      return ['notifications']
    case 'clipboard-read':
      return ['clipboard-read']
    case 'midiSysex':
      return ['midi-sysex']
    default:
      return null
  }
}

function originOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.origin === 'null' ? null : parsed.origin
  } catch {
    return null
  }
}

/** Janela visível onde ancorar o diálogo (o guest do painel vive no host). */
function parentWindow(wc: WebContents | null): BrowserWindow | undefined {
  const host = wc?.hostWebContents ?? wc
  const win = host ? BrowserWindow.fromWebContents(host) : null
  if (win && !win.isDestroyed() && win.isVisible()) return win
  const focused = BrowserWindow.getFocusedWindow()
  return focused && focused.isVisible() ? focused : undefined
}

async function showDialog(win: BrowserWindow | undefined, options: Electron.MessageBoxOptions) {
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
}

/**
 * macOS: câmera e microfone também precisam do "sim" do sistema para o app.
 * Pergunta na primeira vez; se já foi negado, oferece abrir os Ajustes.
 */
async function ensureSystemAccess(kinds: Kind[], wc: WebContents | null): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  for (const kind of kinds) {
    if (kind !== 'camera' && kind !== 'microphone') continue
    const status = systemPreferences.getMediaAccessStatus(kind)
    if (status === 'granted') continue
    if (status === 'not-determined') {
      if (await systemPreferences.askForMediaAccess(kind)) continue
      return false
    }
    const label = await t(KIND_LABEL[kind])
    const { response } = await showDialog(parentWindow(wc), {
      type: 'warning',
      message: await t('browserPerm.systemDenied.title', { what: label }),
      detail: await t('browserPerm.systemDenied.detail', { what: label }),
      buttons: [await t('browserPerm.systemDenied.open'), await t('browserPerm.cancel')],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) {
      const pane = kind === 'camera' ? 'Privacy_Camera' : 'Privacy_Microphone'
      void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
    }
    return false
  }
  return true
}

async function ask(origin: string, kinds: Kind[], wc: WebContents | null): Promise<boolean> {
  await loadRemembered()
  if (kinds.some((k) => decisionFor(origin, k) === 'deny')) return false
  const missing = kinds.filter((k) => decisionFor(origin, k) !== 'allow')
  if (missing.length > 0) {
    const labels = await Promise.all(missing.map((k) => t(KIND_LABEL[k])))
    const site = new URL(origin).host || origin
    const { response, checkboxChecked } = await showDialog(parentWindow(wc), {
      type: 'question',
      message: await t('browserPerm.title', { site }),
      detail: await t('browserPerm.detail', { what: labels.join(', ') }),
      buttons: [await t('browserPerm.allow'), await t('browserPerm.block')],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: await t('browserPerm.remember'),
      checkboxChecked: true,
    })
    const decision: Decision = response === 0 ? 'allow' : 'deny'
    for (const kind of missing) {
      if (checkboxChecked) {
        remembered![origin] = { ...remembered![origin], [kind]: decision }
      } else {
        sessionDecisions.set(`${origin}|${kind}`, decision)
      }
    }
    if (checkboxChecked) await persist().catch(() => {})
    if (decision === 'deny') return false
  }
  return ensureSystemAccess(kinds, wc)
}

function decide(origin: string, kinds: Kind[], wc: WebContents | null): Promise<boolean> {
  const key = `${origin}|${[...kinds].sort().join(',')}`
  const inFlight = pending.get(key)
  if (inFlight) return inFlight
  const promise = ask(origin, kinds, wc)
    .catch(() => false)
    .finally(() => pending.delete(key))
  pending.set(key, promise)
  return promise
}

/** Liga os handlers na sessão do navegador integrado. Chamar depois do app ready. */
export function setupBrowserPermissions(partition: string): void {
  const ses = session.fromPartition(partition)
  void loadRemembered()

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const kinds = kindsForRequest(permission, details as { mediaTypes?: ('video' | 'audio')[] })
    if (!kinds) {
      callback(true)
      return
    }
    const origin = originOf(details.requestingUrl ?? wc?.getURL())
    if (!origin) {
      callback(false)
      return
    }
    void decide(origin, kinds, wc).then(callback)
  })

  // Consultas síncronas (navigator.permissions.query, rótulos do
  // enumerateDevices): só "concedido" quando já há um "sim" registrado.
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const mediaType = (details as { mediaType?: 'video' | 'audio' | 'unknown' }).mediaType
    const kinds =
      permission === 'media'
        ? mediaType === 'video'
          ? (['camera'] as Kind[])
          : mediaType === 'audio'
            ? (['microphone'] as Kind[])
            : (['camera', 'microphone'] as Kind[])
        : kindsForRequest(permission, {})
    if (!kinds) return true
    const origin = originOf(requestingOrigin)
    if (!origin) return false
    return permission === 'media'
      ? kinds.some((k) => decisionFor(origin, k) === 'allow')
      : kinds.every((k) => decisionFor(origin, k) === 'allow')
  })

  // getDisplayMedia: no macOS 15+ o seletor do próprio sistema assume (e já
  // pede a permissão de gravação de tela); nos demais, confirma e compartilha
  // a tela principal.
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      void (async () => {
        const origin = originOf(request.securityOrigin ?? request.frame?.url)
        const site = origin ? new URL(origin).host || origin : '?'
        const { response } = await showDialog(parentWindow(null), {
          type: 'question',
          message: await t('browserPerm.screen.title', { site }),
          detail: await t('browserPerm.screen.detail'),
          buttons: [await t('browserPerm.allow'), await t('browserPerm.block')],
          defaultId: 0,
          cancelId: 1,
        })
        if (response !== 0) return callback({})
        const [screen] = await desktopCapturer.getSources({ types: ['screen'] })
        if (!screen) return callback({})
        callback({ video: screen, ...(process.platform === 'win32' ? { audio: 'loopback' as const } : {}) })
      })().catch(() => callback({}))
    },
    { useSystemPicker: true },
  )
}

/** "Limpar dados do navegador" também esquece as permissões dadas aos sites. */
export async function clearBrowserPermissions(): Promise<void> {
  remembered = {}
  sessionDecisions.clear()
  await fsp.rm(storeFile(), { force: true })
}
