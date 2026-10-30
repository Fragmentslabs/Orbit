// Empties `dist-electron/` BEFORE the build.
//
// `vite-plugin-electron` turns off Vite's `emptyOutDir` on purpose
// (see node_modules/vite-plugin-electron/dist/index.js:47): main and preload
// write into the SAME directory, so emptying on every build would make the second
// delete the output of the first. The side effect is that the build of the main never
// discards the previous round — every run leaves the old chunks
// (main-*.js, index-*.js, token-*.js, always with a new hash) coexisting with the
// new ones. That is why enabling `emptyOutDir: true` in the Vite config is not the solution:
// it would break the build and, in dev/watch, would delete the files under the running
// Electron.
//
// Since `dist-electron` is in the `files` of electron-builder, this accumulated garbage
// goes whole into the app.asar. Measured in this tree before this fix:
// 703 MB, 824 files, 274 `token-*.js` chunks, with files from Aug 15 to
// Sep 10 coexisting — against 4.6 MB of a freshly installed clone. The arm64 DMG
// came out at 402 MB, against 254 MB of the x64 one, which had been built from scratch.
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from the location of the script (not the cwd), because in CI the
// build goes in through `npm run build:linux --workspace=@orbit/desktop`.
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(appDir, 'dist-electron')

// Guard against deleting the wrong directory if the script is moved somewhere else.
if (path.basename(appDir) !== 'desktop' || path.basename(target) !== 'dist-electron') {
  console.error(`[clean-electron-output] unexpected path (${target}); aborting.`)
  process.exit(1)
}

if (!existsSync(target)) {
  console.log('[clean-electron-output] dist-electron is already missing; nothing to do.')
  process.exit(0)
}

rmSync(target, { recursive: true, force: true })
console.log('[clean-electron-output] dist-electron removed.')
