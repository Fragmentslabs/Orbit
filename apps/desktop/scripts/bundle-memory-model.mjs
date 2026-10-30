/**
 * Prepares the embedding model to go INSIDE the app.
 *
 *   npm run memory:bundle
 *
 * Takes `onnx/model.onnx` + `tokenizer.bin` to `resources/memory-embed/<id>`,
 * which electron-builder packs in `extraResources` (`memory-embed` in
 * `process.resourcesPath`). The app loads the model from the bundle itself and never
 * downloads anything — neither during the installation, nor after an update.
 *
 * The 34 MB `.json` stays out: the runtime reads the compiled `.bin`, which is 9 MB.
 * Shipping the `.json` would force the worker to compile inside the signed bundle, which
 * invalidates the app signature on macOS.
 *
 * It fails on purpose when it does not find the model: a build without it would install an
 * Orbit without semantic search, and that cannot pass silently.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { compileTokenizer } from '../electron/memory-embed/tokenizer.mjs'

const ID = 'bekko-a8m'
const FILES = [path.join('onnx', 'model.onnx'), 'tokenizer.bin']

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(here, '..')
const dest = path.join(appRoot, 'resources', 'memory-embed', ID)
const force = process.argv.includes('--force')

const userData =
  process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Application Support', '@orbit/desktop')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? homedir(), 'Orbit')
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'orbit')

/** Where to copy from: development cache first, then an app installation. */
const sources = [
  path.join(appRoot, '.cache', 'memory-embed', ID),
  path.join(userData, 'memory', 'models', ID),
]

const hasGraph = (dir) => fs.existsSync(path.join(dir, 'onnx', 'model.onnx'))
const source = sources.find(hasGraph)

if (!source) {
  console.error(`\n✗ model ${ID} not found.`)
  console.error('  Run `npm run memory:model -- --dev` to download it (130 MB, once).')
  console.error(`  Looked in:\n${sources.map((s) => `    ${s}`).join('\n')}\n`)
  process.exit(1)
}

// The source tokenizer is mandatory to generate the `.bin` when it still
// does not exist (first time after a clean download).
const json = path.join(source, 'tokenizer.json')
const bin = path.join(source, 'tokenizer.bin')
if (!fs.existsSync(bin)) {
  if (!fs.existsSync(json)) {
    console.error(`\n✗ neither tokenizer.bin nor tokenizer.json in ${source}\n`)
    process.exit(1)
  }
  console.log('… compiling tokenizer.json → tokenizer.bin (this machine only, once)')
  compileTokenizer(json, bin)
}

console.log(`model ${ID}`)
console.log(`  from ${source}`)
console.log(`  to   ${dest}`)

let total = 0
for (const file of FILES) {
  const from = path.join(source, file)
  const to = path.join(dest, file)
  if (!fs.existsSync(from)) {
    console.error(`\n✗ ${file} missing in ${source}\n`)
    process.exit(1)
  }
  const size = fs.statSync(from).size
  total += size
  // Identical bytes between builds is what makes the update differential: if the
  // destination already has the same size, it is not touched (not even the mtime).
  if (!force && fs.existsSync(to) && fs.statSync(to).size === size) {
    console.log(`  = ${file} (${(size / 1e6).toFixed(1)} MB, already there)`)
    continue
  }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  console.log(`  + ${file} (${(size / 1e6).toFixed(1)} MB)`)
}

console.log(`ready: ${(total / 1e6).toFixed(0)} MB go inside the app.`)
