#!/usr/bin/env node
/**
 * Baixa o ffmpeg e o ffprobe ESTÁTICOS que o Orbit leva junto (edição de
 * vídeo do agente — ver electron/lib/video/ffmpeg.ts).
 *
 *   node scripts/fetch-ffmpeg.mjs [--arch arm64|x64] [--force]
 *
 * Saída: resources/ffmpeg/<platform>-<arch>/{ffmpeg,ffprobe} — é de lá que o
 * dev lê, e é essa pasta que o electron-builder copia para `Resources/ffmpeg`
 * do app (extraResources), igual ao whisper-server.
 *
 * Builds estáticos de terceiros, com versão fixa onde a fonte permite:
 *   - Windows: gyan.dev "essentials" (espelho versionado no GitHub);
 *   - macOS:   martin-riedl.de (arm64 e Intel, caminho versionado);
 *   - Linux:   BtbN, ramo n9.0 (o arquivo é "latest" do ramo, sem versão fixa).
 * Todos trazem libx264, libass, freetype/fontconfig e o filtro `subtitles` —
 * o render do EDL depende deles, e a verificação no fim recusa um build sem.
 *
 * Já baixado na mesma fonte, não refaz nada (carimbo em VERSION).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const MAC_ARM = 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2'
const MAC_X64 = 'https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2'
const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'

/** Arquivos a baixar por alvo; cada um contém um ou os dois executáveis. */
const TARGETS = {
  'win32-x64': [
    'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip',
  ],
  'darwin-arm64': [`${MAC_ARM}/ffmpeg.zip`, `${MAC_ARM}/ffprobe.zip`],
  'darwin-x64': [`${MAC_X64}/ffmpeg.zip`, `${MAC_X64}/ffprobe.zip`],
  'linux-x64': [`${BTBN}/ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz`],
  'linux-arm64': [`${BTBN}/ffmpeg-n9.0-latest-linuxarm64-gpl-9.0.tar.xz`],
}

/** O que o render precisa do build — sem isto o EDL não fecha. */
const REQUIRED_FILTERS = ['subtitles', 'ass', 'drawtext', 'ebur128', 'loudnorm', 'afade', 'overlay', 'showwavespic']
const REQUIRED_ENCODERS = ['libx264', 'aac']

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argValue = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const arch = argValue('--arch') || process.arch
const force = args.includes('--force')
const platform = process.platform
const key = `${platform}-${arch}`
const sources = TARGETS[key]
if (!sources) {
  console.log(`» ffmpeg: sem build estático conhecido para ${key} — o app vai procurar um ffmpeg no PATH`)
  process.exit(0)
}

const ext = platform === 'win32' ? '.exe' : ''
const work = path.join(root, '.ffmpeg-build', key)
const outDir = path.join(root, 'resources', 'ffmpeg', key)
const stamp = path.join(outDir, 'VERSION')
const wanted = ['ffmpeg', 'ffprobe'].map((name) => name + ext)
const signature = sources.join('\n')

const done = () => wanted.every((name) => fs.existsSync(path.join(outDir, name)))
if (!force && done() && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === signature) {
  console.log(`» ffmpeg (${key}) já baixado: ${path.relative(root, outDir)}`)
  process.exit(0)
}

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download falhou (${res.status}): ${url}`)
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file))
}

/** Primeiro arquivo com esse nome dentro da pasta (os pacotes aninham em bin/). */
function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(full, name)
      if (found) return found
    } else if (entry.name === name) {
      return full
    }
  }
  return null
}

fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })
fs.mkdirSync(outDir, { recursive: true })

for (const url of sources) {
  const archive = path.join(work, path.basename(new URL(url).pathname))
  console.log(`» baixando ${url}`)
  await download(url, archive)
  const into = path.join(work, `x-${path.basename(archive)}`)
  fs.mkdirSync(into)
  // bsdtar (Windows 10+ e macOS) abre zip; no Linux as fontes são .tar.xz. No
  // Windows o caminho é explícito: o tar do Git Bash (GNU) vem antes no PATH e
  // não abre zip.
  const tar = platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  execFileSync(tar, ['-xf', archive, '-C', into], { stdio: 'inherit' })
  for (const name of wanted) {
    const found = findFile(into, name)
    if (!found) continue
    const out = path.join(outDir, name)
    fs.copyFileSync(found, out)
    fs.chmodSync(out, 0o755)
  }
}

const missing = wanted.filter((name) => !fs.existsSync(path.join(outDir, name)))
if (missing.length) throw new Error(`os pacotes não trouxeram: ${missing.join(', ')}`)

// Verificação: só dá para executar o binário da arquitetura desta máquina (ou
// Intel num Mac com Rosetta). Quando não roda aqui, o build segue com aviso.
try {
  const ffmpeg = path.join(outDir, wanted[0])
  const filters = execFileSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' })
  const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' })
  const hasWord = (text, word) => new RegExp(`\\s${word}\\s`).test(text)
  const lacking = [
    ...REQUIRED_FILTERS.filter((f) => !hasWord(filters, f)).map((f) => `filtro ${f}`),
    ...REQUIRED_ENCODERS.filter((e) => !hasWord(encoders, e)).map((e) => `encoder ${e}`),
  ]
  if (lacking.length) throw Object.assign(new Error(`o build não tem: ${lacking.join(', ')}`), { fatal: true })
  const version = execFileSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0]
  console.log(`» ${version}`)
} catch (err) {
  if (err.fatal) throw err
  console.warn(`» aviso: não deu para executar o ffmpeg de ${key} nesta máquina (${err.code ?? err.message}); verificação pulada`)
}

fs.writeFileSync(stamp, `${signature}\n`)
fs.rmSync(work, { recursive: true, force: true })
console.log(`» pronto: ${path.relative(root, outDir)}`)
