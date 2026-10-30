/**
 * Where the persona appears.
 *
 * They were two appearances with different costs handled by a single boolean: the one on the
 * new chat screen is the greeting, and it does not dispute space with anything because there is no
 * conversation yet; the one at the top floats OVER the message list, and charges for
 * that a breathing room at the start of the list and a gradient veil. Whoever turns it off is almost
 * always bothered by the second one, and with a single switch lost both.
 *
 * The values say where it STAYS, not what it hides: it is what the selector
 * shows, and reading the preference has to be the same reading on both screens.
 */
export type PersonaVisibility =
  /** In the new chat and on top of the conversation. */
  | 'all'
  /** Only in the greeting of the new chat — the conversation stays clean. */
  | 'welcome'
  /** Nowhere. */
  | 'none'

export const PERSONA_VISIBILITY: PersonaVisibility[] = ['all', 'welcome', 'none']

export const DEFAULT_PERSONA_VISIBILITY: PersonaVisibility = 'all'

/** Migration of the old boolean: whoever had turned it off wanted to get rid of everything. */
export function personaVisibilityFrom(
  stored: string | null | undefined,
): PersonaVisibility {
  if (stored && (PERSONA_VISIBILITY as string[]).includes(stored)) {
    return stored as PersonaVisibility
  }
  if (stored === 'false') return 'none'
  if (stored === 'true') return 'all'
  return DEFAULT_PERSONA_VISIBILITY
}

/** The floating persona, which goes over the conversation. */
export function showsPersonaInChat(visibility: PersonaVisibility): boolean {
  return visibility === 'all'
}

/** The greeting of the new chat screen. */
export function showsPersonaOnWelcome(visibility: PersonaVisibility): boolean {
  return visibility !== 'none'
}
