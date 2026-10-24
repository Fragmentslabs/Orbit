import { tool } from 'ai'
import { z } from 'zod'
import { USER_NAME_MAX } from '@shared/user-name'
import { getAppSettings, setAppSettings } from '../app-settings'

/**
 * Grava o nome pelo qual a pessoa quer ser chamada — o MESMO campo das
 * Preferências → Geral (`userName`), que nasce vazio.
 *
 * A detecção automática ("meu nome é X", "me chama de X") roda no renderer a
 * cada mensagem enviada; esta tool cobre o que ela não pega: "sou o Rafael",
 * "aqui é a Bia", uma correção ("não, é Rafa") ou o pedido explícito para
 * esquecer o nome.
 *
 * A escrita passa por `setAppSettings`, que normaliza (trim, teto de
 * `USER_NAME_MAX`, vazio = null) e avisa os renderers — a Preferência e o
 * título da tela inicial refletem na hora.
 */
export function createUserNameTool() {
  return tool({
    description: [
      'Saves the name the user wants to be called by, in the app settings — the same field as Preferences → General.',
      'Call it when the user TELLS you their name or asks to be called something ("me chama de Ana", "sou o Rafael", "call me Alex"), including corrections; the greeting screen and your context use it.',
      'Never infer the name from an e-mail, a username, a folder or a file — only what the user actually said.',
      'Pass an empty name to forget it.',
    ].join(' '),
    inputSchema: z.object({
      name: z
        .string()
        .max(USER_NAME_MAX)
        .describe('The name as the user said it, e.g. "Ana Clara". An empty string clears the saved name.'),
    }),
    execute: async ({ name }) => {
      const next = name.trim()
      const previous = getAppSettings().userName
      await setAppSettings({ ...getAppSettings(), userName: next })
      if (!next) return previous ? `Cleared the saved name (was ${previous}).` : 'There was no saved name.'
      return `Saved: the user is called ${next}.`
    },
  })
}
