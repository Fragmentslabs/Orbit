import type { AppPreferences } from '@orbit/shared'
import { useConnectionStore } from './connection-store'
import { useModelModePrefs, type ActiveModeDefaults } from './model-mode-prefs'
import { usePermissionPrefs } from './permission-prefs'
import { useSettingsStore } from './settings-store'

/**
 * Preferências do app espelhadas com o desktop: defaults de modo por tipo de
 * chat, modo de permissão e criação automática de pastas.
 *
 * O desktop é a fonte da verdade (elas vivem no localStorage do renderer). Na
 * conexão o celular puxa o snapshot e adota — antes ele nascia com os defaults
 * próprios, ignorando o que estava configurado no desktop. Depois disso a
 * ligação é nos dois sentidos: mudança daqui vai por `prefs:set` e volta pelo
 * `prefs:change`, que também chega quando a mudança foi feita no desktop.
 *
 * Vive fora dos stores para não criar ciclo de import (mesma razão do
 * mode-sync).
 */

// Último snapshot conhecido — evita eco: aplicar o que veio do desktop dispara
// os subscribes locais, e sem isto o push devolveria o mesmo valor para lá.
let ultimo = ''

function snapshot(): AppPreferences {
  const modes = useModelModePrefs.getState()
  return {
    chatModes: modes.chatActiveModes,
    codeModes: modes.codeActiveModes,
    permissionMode: usePermissionPrefs.getState().mode,
    autoCreateFolders: useSettingsStore.getState().autoCreateFolders,
  }
}

// Só passa a empurrar depois de adotar o snapshot do desktop: um push antes
// disso mandaria as prefs locais do celular por cima das de lá logo no primeiro
// pareamento — o contrário do que se espera.
let inscrito = false

function inscrever(): void {
  if (inscrito) return
  inscrito = true
  useModelModePrefs.subscribe(pushAppPreferences)
  usePermissionPrefs.subscribe(pushAppPreferences)
  // Este store muda por muita coisa (catálogo, modelos); o push compara o
  // snapshot serializado, então só sai da máquina quando uma das prefs muda.
  useSettingsStore.subscribe(pushAppPreferences)
}

function aplicar(prefs: AppPreferences): void {
  if (!prefs || typeof prefs !== 'object') return
  ultimo = JSON.stringify(prefs)

  const modes = useModelModePrefs.getState()
  for (const [key, value] of Object.entries(prefs.chatModes ?? {})) {
    const k = key as keyof ActiveModeDefaults
    if (modes.chatActiveModes[k] !== value) modes.setChatActiveMode(k, value as boolean)
  }
  for (const [key, value] of Object.entries(prefs.codeModes ?? {})) {
    const k = key as keyof ActiveModeDefaults
    if (modes.codeActiveModes[k] !== value) modes.setCodeActiveMode(k, value as boolean)
  }
  if (prefs.permissionMode && prefs.permissionMode !== usePermissionPrefs.getState().mode) {
    usePermissionPrefs.getState().setMode(prefs.permissionMode)
  }
  if (
    typeof prefs.autoCreateFolders === 'boolean' &&
    prefs.autoCreateFolders !== useSettingsStore.getState().autoCreateFolders
  ) {
    void useSettingsStore.getState().setAutoCreateFolders(prefs.autoCreateFolders)
  }

  inscrever()
}

/** Mudança feita aqui → desktop, que aplica e devolve a todos os companions. */
export function pushAppPreferences(): void {
  const prefs = snapshot()
  const serialized = JSON.stringify(prefs)
  if (serialized === ultimo) return
  ultimo = serialized
  const { wsClient } = useConnectionStore.getState()
  void wsClient.send({ type: 'prefs:set', prefs }).catch(() => {})
}

/** Snapshot do desktop na conexão — as prefs de lá mandam. */
export async function hydrateAppPreferences(): Promise<void> {
  const { wsClient } = useConnectionStore.getState()
  try {
    const res = await wsClient.send({ type: 'prefs:get' })
    // null = o desktop ainda não publicou (renderer subindo); o 'prefs:change'
    // chega logo em seguida e resolve.
    if (res.ok && res.data) aplicar(res.data as AppPreferences)
  } catch {
    // Offline: segue com o que está guardado no aparelho.
  }
}

/** Evento do desktop (mudou lá, ou noutro aparelho pareado). */
export function applyAppPreferences(prefs: AppPreferences): void {
  aplicar(prefs)
}
