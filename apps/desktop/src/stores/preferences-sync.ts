import type { AppPreferences } from "@shared/companion"
import { appPreferencesApi } from "@/src/lib/ipc"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import { usePermissionPrefs } from "@/src/stores/permission-prefs"

/**
 * Preferências do app com os companions: defaults de modo por tipo de chat,
 * modo de permissão e criação automática de pastas.
 *
 * Antes cada app guardava as suas. O `/api/preferences` do companion existia,
 * mas era um armazém paralelo que ninguém no desktop lia — mexer no celular não
 * mudava nada aqui, e o celular nascia com os defaults dele em vez dos do
 * desktop. Aqui é o mesmo desenho do worker-config-sync: o renderer é a fonte
 * da verdade (as prefs vivem no localStorage dele), empurra a cada mudança e
 * aplica o que vier do celular.
 */

function snapshot(): AppPreferences {
  const modes = useModelModePrefs.getState()
  return {
    chatModes: modes.chatActiveModes,
    codeModes: modes.codeActiveModes,
    permissionMode: usePermissionPrefs.getState().mode,
    autoCreateFolders: modes.autoCreateFolders,
  }
}

// Os dois stores mudam por mais coisa do que estas prefs (modelo por modo, por
// exemplo): sem comparar, cada troca viraria um broadcast à toa. Também é o que
// impede o eco — aplicar o que veio do celular gera o mesmo snapshot.
let lastPushed = ""

function push() {
  const prefs = snapshot()
  const serialized = JSON.stringify(prefs)
  if (serialized === lastPushed) return
  lastPushed = serialized
  appPreferencesApi.sync(prefs)
}

function apply(prefs: AppPreferences) {
  if (!prefs || typeof prefs !== "object") return
  // Marca como já enviado ANTES de aplicar: o push disparado pelos subscribes
  // veria exatamente este valor e voltaria para o celular como se fosse novo.
  lastPushed = JSON.stringify(prefs)

  const modes = useModelModePrefs.getState()
  for (const [key, value] of Object.entries(prefs.chatModes ?? {})) {
    if (modes.chatActiveModes[key as keyof typeof modes.chatActiveModes] !== value) {
      modes.setChatActiveMode(key as keyof typeof modes.chatActiveModes, value as boolean)
    }
  }
  for (const [key, value] of Object.entries(prefs.codeModes ?? {})) {
    if (modes.codeActiveModes[key as keyof typeof modes.codeActiveModes] !== value) {
      modes.setCodeActiveMode(key as keyof typeof modes.codeActiveModes, value as boolean)
    }
  }
  if (typeof prefs.autoCreateFolders === "boolean" && prefs.autoCreateFolders !== modes.autoCreateFolders) {
    modes.setAutoCreateFolders(prefs.autoCreateFolders)
  }
  if (prefs.permissionMode && prefs.permissionMode !== usePermissionPrefs.getState().mode) {
    usePermissionPrefs.getState().setMode(prefs.permissionMode)
  }
}

if (typeof window !== "undefined" && window.ipcRenderer) {
  push()
  useModelModePrefs.subscribe(push)
  usePermissionPrefs.subscribe(push)
  appPreferencesApi.onSet(apply)
}
