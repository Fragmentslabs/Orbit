/**
 * Ceiling of the stored name. app-settings.ts imports it from here so the two do not diverge.
 *
 * There is no automatic detection by text: recognizing "my name is X" would require
 * hard-coding phrases of one language, and Orbit is used in any of them. Whoever reads the name is
 * the MODEL, through the `set_user_name` tool — which understands the sentence in any language,
 * including a correction ("no, it is Rafa") or a request to forget it.
 */
export const USER_NAME_MAX = 40
