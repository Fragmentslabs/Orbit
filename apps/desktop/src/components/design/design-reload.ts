/**
 * What to reload when the watcher warns that the canvas folder changed.
 *
 * The main process sends the LIST of files that changed (see design-store.ts) — it is what
 * allows reloading only the artboard the agent wrote, instead of remounting
 * all the iframes on every write. This module is the translation of that list to
 * the two tabs that receive it (the editor and the presentation), pure and testable.
 */

const isBoardFile = (file: string) => /\.html?$/i.test(file)
const isIndexFile = (file: string) => file.toLowerCase().endsWith('canvas.json')

export interface DesignReloadPlan {
  /** `canvas.json` may have changed: re-read the index (new screens, removed ones,
   *  moved ones). */
  index: boolean
  /** Artboards that actually changed, with the name that is in canvas.json. */
  boards: string[]
  /** Change outside the artboards (CSS, image, folder font): any screen
   *  may have changed appearance, so all of them reload. */
  all: boolean
}

/**
 * With no list — a platform where `fs.watch` does not report the name, or an event
 * it could not describe — there is no way to be surgical: it reloads everything, as
 * it was before the watcher sent the names.
 */
export function planDesignReload(files: string[] | undefined): DesignReloadPlan {
  const list = files ?? []
  if (list.length === 0) return { index: true, boards: [], all: true }
  return {
    index: list.some(isIndexFile),
    boards: list.filter(isBoardFile),
    all: list.some((file) => !isBoardFile(file) && !isIndexFile(file)),
  }
}
