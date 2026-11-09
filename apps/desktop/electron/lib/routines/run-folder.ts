import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * The scratch folder of ONE execution of a routine that has no folder of its own. A team needs a
 * place where its members write, so each run gets one, named by the routine and the moment it
 * started. It is kept after the run: what the team made is the result, and the run row opens it.
 */

const pad = (n: number) => String(n).padStart(2, '0')

/** "2026-11-08_14-05-09" in local time: sorts by date and is a legal name on every system. */
export function runFolderName(when: number): string {
  const d = new Date(when)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

/** `<root>/<routine id>/<run time>`; an id with path characters cannot leave the root. */
export function runFolderPath(root: string, routineId: string, when: number): string {
  const safe = routineId.replace(/[^A-Za-z0-9_-]/g, '_') || 'routine'
  return path.join(root, safe, runFolderName(when))
}

/** Creates the folder (two runs in the same second get a numbered one) and returns its path. */
export async function createRunFolder(root: string, routineId: string, when: number): Promise<string> {
  const base = runFolderPath(root, routineId, when)
  await fsp.mkdir(path.dirname(base), { recursive: true })
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    try {
      await fsp.mkdir(candidate)
      return candidate
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
}
