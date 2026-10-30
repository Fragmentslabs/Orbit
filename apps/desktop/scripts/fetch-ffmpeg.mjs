#!/usr/bin/env node
/**
 * Downloads the STATIC ffmpeg and ffprobe that Orbit ships (video editing
 * of the agent — see electron/lib/video/ffmpeg.ts).
 *
 *   node scripts/fetch-ffmpeg.mjs [--arch arm64|x64] [--force] [--soft]
 *
 * `npm run dev` calls it with `--soft` (predev): ffmpeg comes up along on the first
 * time, and afterwards the stamp makes the call cost nothing. In soft mode a failure
 * (no network, source down) only warns — dev opens anyway, without the video
 * tools, instead of blocking whoever is not even going to touch video. In the build the failure is
 * fatal: a release without ffmpeg would be a broken release.
 *
 * Output: resources/ffmpeg/<platform>-<arch>/{ffmpeg,ffprobe} — it is from there that
 * dev reads, and it is this folder that electron-builder copies to `Resources/ffmpeg`
 * of the app (extraResources), like whisper-server.
 *
 * Third-party static builds, with a fixed version where the source allows it:
 *   - Windows: gyan.dev "essentials" (versioned mirror on GitHub);
 *   - macOS:   martin-riedl.de (arm64 and Intel, versioned path);
 *   - Linux:   BtbN, n9.0 branch (the file is the "latest" of the branch, without a fixed version).
 * All of them bring libx264, libass, freetype/fontconfig and the `subtitles` filter —
 * the EDL render depends on them, and the check at the end rejects a build without them.
 *
 * Already downloaded from the same source, it redoes nothing (stamp in VERSION).
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

/** Files to download per target; each one contains one or both executables. */
const TARGETS = {
  'win32-x64': [
    'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip',
  ],
  'darwin-arm64': [`${MAC_ARM}/ffmpeg.zip`, `${MAC_ARM}/ffprobe.zip`],
  'darwin-x64': [`${MAC_X64}/ffmpeg.zip`, `${MAC_X64}/ffprobe.zip`],
  'linux-x64': [`${BTBN}/ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz`],
  'linux-arm64': [`${BTBN}/ffmpeg-n9.0-latest-linuxarm64-gpl-9.0.tar.xz`],
}

/** What the render needs from the build — without it the EDL does not close. */
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
const soft = args.includes('--soft')
const platform = process.platform
const key = `${platform}-${arch}`
const sources = TARGETS[key]
if (!sources) {
  console.log(`» ffmpeg: no known static build for ${key} — the app will look for an ffmpeg in the PATH`)
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
  console.log(`» ffmpeg (${key}) already downloaded: ${path.relative(root, outDir)}`)
  process.exit(0)
}

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}): ${url}`)
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file))
}

/** First file with that name inside the folder (the packages nest it in bin/). */
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

async function fetchAll() {
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })
  fs.mkdirSync(outDir, { recursive: true })

  for (const url of sources) {
    const archive = path.join(work, path.basename(new URL(url).pathname))
    console.log(`» downloading ${url}`)
    await download(url, archive)
    const into = path.join(work, `x-${path.basename(archive)}`)
    fs.mkdirSync(into)
    // bsdtar (Windows 10+ and macOS) opens zip; on Linux the sources are .tar.xz. On
    // Windows the path is explicit: the tar from Git Bash (GNU) comes first in the PATH and
    // does not open zip.
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
  if (missing.length) throw new Error(`the packages did not bring: ${missing.join(', ')}`)

  // Verification: only the binary of this machine's architecture can be executed (or
  // Intel on a Mac with Rosetta). When it does not run here, the build goes on with a warning.
  try {
    const ffmpeg = path.join(outDir, wanted[0])
    const filters = execFileSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' })
    const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' })
    const hasWord = (text, word) => new RegExp(`\\s${word}\\s`).test(text)
    const lacking = [
      ...REQUIRED_FILTERS.filter((f) => !hasWord(filters, f)).map((f) => `filter ${f}`),
      ...REQUIRED_ENCODERS.filter((e) => !hasWord(encoders, e)).map((e) => `encoder ${e}`),
    ]
    if (lacking.length) throw Object.assign(new Error(`the build does not have: ${lacking.join(', ')}`), { fatal: true })
    const version = execFileSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0]
    console.log(`» ${version}`)
  } catch (err) {
    if (err.fatal) throw err
    console.warn(`» warning: could not run the ffmpeg of ${key} on this machine (${err.code ?? err.message}); verification skipped`)
  }

  fs.writeFileSync(stamp, `${signature}\n`)
  fs.rmSync(work, { recursive: true, force: true })
  console.log(`» ready: ${path.relative(root, outDir)}`)
}

// No process.exit here: on Windows, exiting in the middle of a fetch that failed
// it takes Node down in a libuv assertion (code 127), and the predev would break the
// dev precisely in the case the --soft exists to tolerate.
try {
  await fetchAll()
} catch (err) {
  fs.rmSync(work, { recursive: true, force: true })
  if (soft) {
    console.warn(`» ffmpeg: ${err?.message ?? err}`)
    console.warn('» going on without ffmpeg — the video tools stay off until `npm run ffmpeg:fetch` succeeds')
  } else {
    console.error(err)
    process.exitCode = 1
  }
}
