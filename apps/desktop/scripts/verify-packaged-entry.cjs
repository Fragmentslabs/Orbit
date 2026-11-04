// electron-builder `afterPack` hook: checks that the main process inside app.asar can load.
//
// `dist-electron/main.js` is a tiny entry that imports a hashed chunk
// (`./main-<hash>.js`). If anything else writes to `dist-electron/` while
// electron-builder is collecting files (a `vite` dev server, a second build in
// another terminal), the entry and its chunk can come from different builds: the
// asar then holds a main.js importing a chunk it does not contain. The packaged app
// exits with code 1 on launch, with no window and no message — and the build had
// signed, notarized and published it as if nothing was wrong (release 0.1.4).
//
// This runs after the app is packaged and BEFORE signing: every relative import of
// every script under dist-electron/ must resolve to a file in the asar, or the build
// stops here with the names.
const fs = require('node:fs')
const path = require('node:path')

// Only specifiers with a .js/.mjs extension: that is how rollup writes its chunks, and it
// keeps out code examples living inside strings (a guide's `import { Root } from './Root'`).
const IMPORT_PATTERNS = [
  /\bimport\s+(?:[^'"]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+\.m?js)["']/g,
  /\bexport\s+[^'"]*?\sfrom\s+["'](\.{1,2}\/[^"']+\.m?js)["']/g,
  /\bimport\(\s*["'](\.{1,2}\/[^"']+\.m?js)["']\s*\)/g,
]

function findAsar(appOutDir) {
  const candidates = [path.join(appOutDir, 'resources', 'app.asar')]
  for (const entry of fs.readdirSync(appOutDir)) {
    if (entry.endsWith('.app')) candidates.push(path.join(appOutDir, entry, 'Contents', 'Resources', 'app.asar'))
  }
  return candidates.find((file) => fs.existsSync(file)) ?? null
}

module.exports = async function verifyPackagedEntry(context) {
  const asarFile = findAsar(context.appOutDir)
  if (!asarFile) throw new Error(`[verify-packaged-entry] app.asar not found under ${context.appOutDir}`)
  const asar = require('@electron/asar')
  const files = new Set(asar.listPackage(asarFile).map((file) => file.replace(/\\/g, '/')))
  const scripts = [...files].filter((file) => /^\/dist-electron\/[^/]+\.(?:m?js)$/.test(file))
  if (!files.has('/dist-electron/main.js')) {
    throw new Error('[verify-packaged-entry] dist-electron/main.js is missing from app.asar')
  }

  const missing = []
  for (const script of scripts) {
    const text = asar.extractFile(asarFile, script.slice(1)).toString('utf8')
    for (const pattern of IMPORT_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(script), match[1]))
        if (!files.has(target)) missing.push(`${script.slice(1)} → ${target.slice(1)}`)
      }
    }
  }
  if (missing.length) {
    throw new Error(
      '[verify-packaged-entry] the packaged main process imports files that are not in app.asar:\n  ' +
        [...new Set(missing)].join('\n  ') +
        '\nSomething else wrote to dist-electron/ during the build (a `vite` dev server or another build). ' +
        'Stop it and run the build again.',
    )
  }
  console.log(`  • verified packaged entry  scripts=${scripts.length} asar=${path.relative(process.cwd(), asarFile)}`)
}
