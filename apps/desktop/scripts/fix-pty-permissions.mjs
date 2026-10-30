// Fixes the execution bit of node-pty's `spawn-helper` in the prebuilds.
//
// The official node-pty@1.1.0 tarball publishes the binary with mode 644 (without +x).
// On macOS, node-pty runs spawn-helper through posix_spawn, which fails with
// EACCES ("posix_spawnp failed.") when the file is not executable — and the terminal
// tab of the panel never opens, without a visible error. It runs in the postinstall of the
// workspace for devs/CI; the main process also does a defensive fix.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)

let ptyRoot
try {
  ptyRoot = path.dirname(_require.resolve('node-pty/package.json'))
} catch {
  console.warn('[fix-pty-permissions] node-pty not found; skipping.')
  process.exit(0)
}

const prebuildsDir = path.join(ptyRoot, 'prebuilds')
if (!existsSync(prebuildsDir)) process.exit(0)

let fixed = 0
for (const dir of readdirSync(prebuildsDir)) {
  const helper = path.join(prebuildsDir, dir, 'spawn-helper')
  if (existsSync(helper)) {
    chmodSync(helper, 0o755)
    fixed++
  }
}
if (fixed > 0) {
  console.log(`[fix-pty-permissions] spawn-helper (+x) fixed in ${fixed} prebuild(s)`)
}
