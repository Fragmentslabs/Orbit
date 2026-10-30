import fsp from 'node:fs/promises'
import path from 'node:path'
import { registerMotion } from './motion-store'

/**
 * Preparing the preview of a motion composition — the step between WRITING the
 * composition and rendering it: the agent writes the HTML, this one registers it and
 * tells the Motion tab of the panel (the user checks with play/pause and slider) and only
 * after the composition is approved does it go to `motion_render`. Nothing is rendered
 * nor written to the working folder here.
 *
 * The target the agent passes (the entry `.html`, or its folder) becomes (served
 * folder, entry file) and the composition enters the registry
 * (video/motion-store), from where the Motion tab loads it through the scheme
 * `orbit-motion://`.
 *
 * It lives outside the tool so that the derivation is PURE: it can be tested without
 * Electron, like the rest of video/.
 */

/** Entry assumed when the target is a FOLDER. */
export const MOTION_ENTRY_FILE = 'index.html'

export interface MotionTarget {
  /** Root folder: the scheme serves nothing outside it (dependencies stay next to it). */
  folder: string
  /** Entry file (absolute), always inside `folder`. */
  file: string
  /**
   * Path of the entry INSIDE the folder, with `/` — it is what the tab joins in
   * `orbit-motion://<id>/<entry>`. Since the folder is always the one containing the
   * file, this is the file name (`index.html`, almost always).
   */
  entry: string
}

/**
 * (folder, entry) from the target already in an absolute path. Pure: `isDir` says
 * whether the target is a folder — a folder uses its `index.html`, a file is the entry
 * itself (and the served folder is the one that contains it).
 */
export function motionTargetFrom(abs: string, isDir: boolean): MotionTarget {
  const resolved = path.resolve(abs)
  const file = isDir ? path.join(resolved, MOTION_ENTRY_FILE) : resolved
  return { folder: path.dirname(file), file, entry: path.basename(file) }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile()
  } catch {
    return false
  }
}

export interface MotionPreview extends MotionTarget {
  /** Registry id — the tab uses it to subscribe to live reload. */
  id: string
  /** Scheme URL the tab loads: `orbit-motion://<id>/<entry>`. */
  url: string
}

/**
 * Resolves the target's folder/entry, checks that the entry EXISTS (the tab would open
 * on a silent 404, and an early error is worth more) and registers the composition. Only the
 * registry touches the disk; the derivation above is pure.
 */
export async function prepareMotionPreview(
  target: string,
  opts: { root?: string; sessionId?: string } = {},
): Promise<MotionPreview> {
  const abs = path.resolve(target)
  let stat: Awaited<ReturnType<typeof fsp.stat>>
  try {
    stat = await fsp.stat(abs)
  } catch {
    throw new Error(`motion composition not found: ${abs}`)
  }
  const { folder, file, entry } = motionTargetFrom(abs, stat.isDirectory())
  if (stat.isDirectory() && !(await isFile(file))) {
    throw new Error(`the composition folder has no ${MOTION_ENTRY_FILE}: ${abs}`)
  }
  const { id, url } = await registerMotion(folder, file, opts)
  return { folder, file, entry, id, url }
}
