/**
 * The slug of a deck — the name of its folder in the Orbit storage.
 *
 * It lives in a module of its own because TWO ends have to agree: the one that
 * WRITES (`slides_write` creates `orbit-data/slides/<session>/<slug>/`) and the one
 * that LOOKS IT UP (`slidesIdForName`, when the conversation card sends the deck
 * title and not the path). Without the same function on both sides, the card of a
 * deck written in the chat would reopen nothing.
 *
 * "Orbit em 12 slides" → "orbit-em-12-slides". Same algorithm as designSlug.
 */
export function slidesSlug(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'deck'
}
