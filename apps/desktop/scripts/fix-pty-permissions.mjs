// Corrige o bit de execução do `spawn-helper` do node-pty nos prebuilds.
//
// O tarball oficial do node-pty@1.1.0 publica o binário com modo 644 (sem +x).
// No macOS, o node-pty executa o spawn-helper via posix_spawn, que falha com
// EACCES ("posix_spawnp failed.") quando o arquivo não é executável — e a aba
// de terminal do painel nunca abre, sem erro visível. Roda no postinstall do
// workspace para devs/CI; o main process também faz uma correção defensiva.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)

let ptyRoot
try {
  ptyRoot = path.dirname(_require.resolve('node-pty/package.json'))
} catch {
  console.warn('[fix-pty-permissions] node-pty não encontrado; pulando.')
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
  console.log(`[fix-pty-permissions] spawn-helper (+x) corrigido em ${fixed} prebuild(s)`)
}
