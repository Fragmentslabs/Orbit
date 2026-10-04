import { DEFAULT_APP_SETTINGS, normalizeAppSettings, type AppSettings } from '@shared/app-settings'
import type { SendMessageInput } from '@shared/chat'
import { readJson, writeJson } from './storage'

/**
 * Cópia no main das configurações gerais (a fonte da verdade é o renderer —
 * ver app-settings.ts no shared). Fica em disco porque parte delas vale antes
 * de qualquer janela abrir: a limpeza de cookies do navegador e o arquivamento
 * automático rodam na inicialização.
 */

const STORAGE_KEY = 'app-settings'

let current: AppSettings = DEFAULT_APP_SETTINGS
const listeners = new Set<(next: AppSettings, prev: AppSettings) => void>()

export function getAppSettings(): AppSettings {
  return current
}

/** Lê a cópia do disco. Chamado uma vez na inicialização, antes de usar as configurações. */
export async function loadAppSettings(): Promise<AppSettings> {
  current = normalizeAppSettings(await readJson<unknown>(STORAGE_KEY))
  return current
}

/** Aplica o que o renderer enviou; grava e avisa só quando algo mudou. */
export async function setAppSettings(raw: unknown): Promise<void> {
  const next = normalizeAppSettings(raw)
  if (JSON.stringify(next) === JSON.stringify(current)) return
  const prev = current
  current = next
  await writeJson(STORAGE_KEY, next)
  for (const listener of listeners) listener(next, prev)
}

/**
 * O agente pode usar o navegador do painel neste turno? Com as ferramentas de
 * navegador desligadas, só quando o usuário abriu o navegador e pediu pelo
 * chat dele, em tela cheia — em qualquer outro caso, nem com o navegador
 * aberto à vista.
 */
export function agentMayUseBrowser(input: SendMessageInput): boolean {
  return current.browser.agentTools || input.options.fromBrowser === true
}

export function onAppSettingsChange(listener: (next: AppSettings, prev: AppSettings) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
