import { tool } from 'ai'
import { z } from 'zod'
import { USER_NAME_MAX } from '@shared/user-name'
import { getAppSettings, setAppSettings } from '../app-settings'

/**
 * Saves the name the person wants to be called by — the SAME field as
 * Preferences → General (`userName`), which is born empty.
 *
 * The automatic detection ("my name is X", "call me X") runs in the renderer on
 * every message sent; this tool covers what it does not catch: "I am Rafael",
 * "this is Bia", a correction ("no, it is Rafa") or the explicit request to
 * forget the name.
 *
 * The write goes through `setAppSettings`, which normalizes (trim, `USER_NAME_MAX`
 * cap, empty = null) and notifies the renderers — the Preference and the
 * title of the start screen reflect it right away.
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
