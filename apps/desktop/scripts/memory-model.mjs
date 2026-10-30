/**
 * Downloads the memory embedding model to the app folder.
 *
 *   npm run memory:model            # downloads Bekko a8m (130 MB)
 *   npm run memory:model -- --dev   # downloads to the development cache (without app)
 *
 * The app looks first in `<userData>/memory/models/<id>` and, when it does not find it,
 * in the development cache `<repo>/apps/desktop/.cache/memory-embed/<id>`.
 * Without the model, the memory retrieval works only in lexical mode.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ID = 'bekko-a8m'
const REPO = `hotchpotch/bekko-embedding-v1-${ID.split('-')[1]}`
const FILES = ['onnx/model.onnx', 'tokenizer.json']

const here = path.dirname(fileURLToPath(import.meta.url))
const dev = process.argv.includes('--dev')
const appName = '@orbit/desktop'
const userData =
  process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Application Support', appName)
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? homedir(), 'Orbit')
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'orbit')

const dir = dev ? path.join(here, '..', '.cache', 'memory-embed', ID) : path.join(userData, 'memory', 'models', ID)

async function download(file) {
  const target = path.join(dir, file)
  if (fs.existsSync(target)) {
    console.log(`= ${file} (already there)`)
    return
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const url = `https://huggingface.co/${REPO}/resolve/main/${file}`
  console.log(`↓ ${file}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`${file}: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const part = `${target}.part`
  const out = fs.createWriteStream(part)
  let received = 0
  let last = 0
  for await (const chunk of res.body) {
    received += chunk.length
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
    const now = Date.now()
    if (now - last > 500) {
      last = now
      const pct = total ? ` ${((received / total) * 100).toFixed(0)}%` : ''
      process.stdout.write(`\r  ${(received / 1e6).toFixed(1)} MB${pct}   `)
    }
  }
  out.end()
  await new Promise((r) => out.once('close', r))
  fs.renameSync(part, target)
  process.stdout.write('\r  ok                        \n')
}

console.log(`model ${ID} → ${dir}`)
for (const file of FILES) await download(file)
console.log('done.')
