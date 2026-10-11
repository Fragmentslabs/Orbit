import { app } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * "Abrir junto com o sistema".
 *
 * Windows e macOS têm o caminho nativo do Electron. No Linux o
 * `setLoginItemSettings` não cria entrada de autostart (o app é lançado pelo
 * desktop environment, não por um registro do sistema), então o caminho é
 * escrever o .desktop em ~/.config/autostart — que é exatamente o que os
 * gerenciadores de sessão leem.
 *
 * Em modo dev o executável é o do Electron e a pasta do app vira argumento:
 * sem isso o login abriria um Electron vazio em vez do Orbit.
 */

const LINUX_DESKTOP_FILE = 'orbit.desktop'

/** Comando que o sistema deve executar para abrir o Orbit, já como lista. */
function launchCommand(): string[] {
  const appRoot = process.env.APP_ROOT
  const needsAppPath = !app.isPackaged && Boolean(appRoot)
  return needsAppPath ? [process.execPath, appRoot as string] : [process.execPath]
}

function autostartFilePath(): string {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configDir, 'autostart', LINUX_DESKTOP_FILE)
}

/** Aspas simples no valor do Exec (o formato .desktop exige escapá-las). */
function quoteDesktopArg(value: string): string {
  return `"${value.replace(/(["\\`$])/g, '\\$1')}"`
}

async function applyLinux(enabled: boolean): Promise<void> {
  const file = autostartFilePath()
  if (!enabled) {
    await fs.rm(file, { force: true })
    return
  }
  const [command, ...args] = launchCommand()
  const exec = [command, ...args].map(quoteDesktopArg).join(' ')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Orbit',
      'Comment=Assistente de código do Orbit',
      `Exec=${exec}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'),
    'utf8',
  )
}

/**
 * Liga/desliga a abertura automática. Devolve o erro em vez de lançar: a
 * preferência é gravada de qualquer jeito (a UI não pode ficar mentindo que
 * salvou), mas quem chamou loga o motivo pelo qual o sistema não obedeceu.
 */
export async function applyLaunchAtLogin(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    if (process.platform === 'linux') {
      await applyLinux(enabled)
      return { ok: true }
    }
    const [command, ...args] = launchCommand()
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: command,
      ...(args.length > 0 ? { args } : {}),
      // Só o macOS entende: abre sem roubar o foco, como um app de bandeja.
      ...(process.platform === 'darwin' ? { openAsHidden: true } : {}),
    })
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[autostart] não foi possível ajustar a abertura automática:', message)
    return { ok: false, error: message }
  }
}
