// Bundles the CLI (and the shared fragment rules it imports) into one dependency-free file.
import { build } from 'esbuild'
import { chmod, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'dist', 'orbit-fragments.js')

await rm(path.join(root, 'dist'), { recursive: true, force: true })
await build({
  entryPoints: [path.join(root, 'src', 'bin.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  banner: { js: '#!/usr/bin/env node' },
})
await chmod(out, 0o755)
