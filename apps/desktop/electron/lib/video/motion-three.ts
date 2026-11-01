import fs from 'node:fs'
import path from 'node:path'
import { MOTION_THREE_HELPER_PATH } from './motion-three-helper'

/**
 * three.js as part of the motion runtime: the composition writes `import * as THREE from 'three'`
 * and `from 'three/addons/loaders/GLTFLoader.js'` and nothing else — no copy of ~1 MB per
 * piece (motion_asset), no CDN (the render is offline), no version drift between pieces.
 *
 * Two halves, mirroring `/__orbit-runtime.js`:
 *  - a reserved path of the scheme (`/__orbit-three/…`) that serves the files of the `three`
 *    package the app ships (build/ and examples/jsm/);
 *  - an import map injected next to the runtime tag, pointing the bare specifiers at it.
 *
 * Only the `three` package is reachable through this path: every file is resolved inside
 * its build/ or examples/jsm/ folder, `..` and anything that is not a .js are refused.
 */

export const MOTION_THREE_PREFIX = '/__orbit-three/'

/** Mark of the injected import map, so it is not duplicated in a composition already served. */
export const IMPORT_MAP_MARK = 'data-orbit-motion-importmap'

/** The import map for the composition of `id`. */
export function motionImportMapTag(scheme: string, id: string): string {
  const base = `${scheme}://${id}${MOTION_THREE_PREFIX}`
  const map = {
    imports: { three: `${base}three.module.js`, 'three/addons/': `${base}addons/`, 'orbit-three': `${base}${MOTION_THREE_HELPER_PATH}` },
  }
  return `<script type="importmap" ${IMPORT_MAP_MARK}>${JSON.stringify(map)}</script>`
}

/** The page brings its own import map: two maps fight, so the composition's wins. */
export function hasOwnImportMap(html: string): boolean {
  return /<script[^>]*type\s*=\s*["']?importmap/i.test(html) && !html.includes(IMPORT_MAP_MARK)
}

/**
 * `/__orbit-three/three.module.js` → build/three.module.js
 * `/__orbit-three/three.core.js`   → build/three.core.js (newer releases split the core out)
 * `/__orbit-three/addons/x/Y.js`   → examples/jsm/x/Y.js
 * Anything else (or an escape from those folders) → null.
 */
export function resolveThreeFile(threeRoot: string, pathname: string): string | null {
  if (!pathname.startsWith(MOTION_THREE_PREFIX)) return null
  let rel: string
  try {
    rel = decodeURIComponent(pathname.slice(MOTION_THREE_PREFIX.length))
  } catch {
    return null
  }
  if (!rel.endsWith('.js') || rel.includes('\0')) return null
  const [base, sub] = rel.startsWith('addons/')
    ? [path.join(threeRoot, 'examples', 'jsm'), rel.slice('addons/'.length)]
    : [path.join(threeRoot, 'build'), rel]
  if (!sub || sub.includes('\\')) return null
  const target = path.resolve(base, sub)
  const inside = path.relative(base, target)
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null
  return target
}

/** The `three` package folder: packaged app first, then the workspace (dev). */
export function findThreeRoot(appPath: string): string | null {
  const candidates = [
    path.join(appPath, 'node_modules', 'three'),
    path.join(appPath, '..', '..', 'node_modules', 'three'),
    path.join(process.cwd(), 'node_modules', 'three'),
  ]
  return candidates.find((c) => fs.existsSync(path.join(c, 'build', 'three.module.js'))) ?? null
}
