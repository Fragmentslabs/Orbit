#!/usr/bin/env node
/**
 * Prepares the `whisper-server` (whisper.cpp) that the Whisper dictation engine starts
 * as a helper process (see electron/lib/voice/whisper.ts).
 *
 *   node scripts/build-whisper-server.mjs [--arch arm64|x64] [--force] [--soft]
 *
 * Output: resources/whisper/<platform>-<arch>/whisper-server — it is from there that dev
 * reads, and it is this folder that electron-builder copies to `Resources/whisper` of the
 * app (extraResources).
 *
 * `npm run dev` calls it with `--soft` (predev), like ffmpeg: the server comes up
 * along on the first time and afterwards the stamp makes the call cost nothing. In
 * soft mode a failure (no network, no compiler) only warns — dev opens anyway, with the
 * whisper engine unavailable and the reason on the voice screen. In the build it is fatal.
 *
 * On Windows it does NOT compile: it downloads the official binary from the whisper.cpp release (the
 * `bNNNN` build of the same commit as the tag — the vX.Y.Z tag comes out without attachments), which comes
 * with the ggml DLLs next to it (the CPU backend is chosen at runtime, by the
 * instruction set of the machine). Along with them go the Visual C++ runtime DLLs of this machine
 * (local deployment to the app, allowed by the redistributable license): without them the
 * server does not open on a Windows without VC++.
 * ORBIT_WHISPER_COMPILE=1 forces compilation on Windows too.
 *
 * On macOS and Linux it compiles: STATIC build and with the Metal shader embedded —
 * a single executable, without a dylib next to it or a `.metal` to find at runtime — is
 * what allows packaging without touching rpath. `GGML_NATIVE=OFF` so the binary runs
 * on any machine of the same architecture, not only on the one that compiled it
 * (ORBIT_WHISPER_NATIVE=1 undoes it).
 *
 * Nothing global: without cmake in the PATH it goes to a venv in .whisper-build/.venv
 * (the same recipe as vozlab). Already ready in the same version, it redoes nothing.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const TAG = process.env.WHISPER_TAG || 'v1.9.5'
const REPO = 'https://github.com/ggml-org/whisper.cpp.git'
/** Release build at the same commit as the TAG (it is the one that carries the binaries). */
const PREBUILT_BUILD = process.env.WHISPER_PREBUILT_BUILD || 'b5454'
const PREBUILT = {
  'win32-x64': 'whisper-bin-x64.zip',
  'win32-arm64': 'whisper-bin-win-cpu-arm64.zip',
}
/** Visual C++ runtime that whisper-server.exe imports. */
const VC_RUNTIME = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']

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
const exe = platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'

const work = path.join(root, '.whisper-build')
const src = path.join(work, 'whisper.cpp')
const build = path.join(work, `build-${platform}-${arch}`)
const outDir = path.join(root, 'resources', 'whisper', `${platform}-${arch}`)
const out = path.join(outDir, exe)
const stamp = path.join(outDir, 'VERSION')

const prebuiltName = process.env.ORBIT_WHISPER_COMPILE === '1' ? null : PREBUILT[`${platform}-${arch}`]
const prebuiltUrl = prebuiltName
  ? `https://github.com/ggml-org/whisper.cpp/releases/download/${PREBUILT_BUILD}/${prebuiltName}`
  : null
// The stamp says WHERE it came from: switching between compiled and pre-built redoes it.
const signature = prebuiltUrl ? `${TAG} ${prebuiltUrl}` : TAG

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', ...opts })
const has = (cmd) => {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (!force && fs.existsSync(out) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === signature) {
  console.log(`» whisper-server ${TAG} (${platform}-${arch}) already built: ${path.relative(root, out)}`)
  process.exit(0)
}

/** First file with that name inside the folder (the zip nests it in Release/). */
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

/** Official binary from the release: the server and the ggml/whisper DLLs next to it. */
async function fetchPrebuilt() {
  const tmp = path.join(work, `prebuilt-${platform}-${arch}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  const archive = path.join(tmp, prebuiltName)
  console.log(`» downloading ${prebuiltUrl}`)
  const res = await fetch(prebuiltUrl, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}): ${prebuiltUrl}`)
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(archive))
  // The tar from Git Bash (GNU) comes first in the PATH and does not open zip; the system one does.
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  execFileSync(path.join(system32, 'tar.exe'), ['-xf', archive, '-C', tmp], { stdio: 'inherit' })
  const found = findFile(tmp, exe)
  if (!found) throw new Error(`${prebuiltName} did not bring ${exe}`)
  const from = path.dirname(found)

  // Clean folder: a DLL from another version left next to it would confuse the loader. The
  // rest of the zip (cli, bench, parakeet, SDL…) does not interest the app.
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  const keep = (name) => name === exe || name === 'whisper.dll' || /^ggml.*\.dll$/i.test(name)
  for (const name of fs.readdirSync(from).filter(keep)) fs.copyFileSync(path.join(from, name), path.join(outDir, name))
  // VC++ runtime only from the SAME architecture as this machine (System32 is the native one).
  if (arch === process.arch) {
    for (const name of VC_RUNTIME) {
      const dll = path.join(system32, name)
      if (fs.existsSync(dll)) fs.copyFileSync(dll, path.join(outDir, name))
      else console.warn(`» warning: ${name} is not in ${system32} — the app will depend on the installed VC++`)
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true })

  if (arch === process.arch) {
    // The usage goes out on stderr; what matters is the binary opening with the DLLs next to it.
    const help = spawnSync(out, ['--help'], { encoding: 'utf8', timeout: 20_000 })
    if (!/usage/i.test(`${help.stdout}${help.stderr}`)) {
      throw new Error(`the downloaded whisper-server did not open (${help.error?.message ?? `code ${help.status}`})`)
    }
  }
  fs.writeFileSync(stamp, `${signature}\n`)
  console.log(`» ready: ${path.relative(root, out)} (whisper.cpp ${TAG}, ${PREBUILT_BUILD})`)
}

function compile() {
  let cmake = 'cmake'
  if (!has(cmake)) {
    const venv = path.join(work, '.venv')
    cmake = path.join(venv, platform === 'win32' ? 'Scripts/cmake.exe' : 'bin/cmake')
    if (!fs.existsSync(cmake)) {
      console.log('» local cmake (venv in .whisper-build/.venv)')
      run('python3', ['-m', 'venv', venv])
      run(path.join(venv, platform === 'win32' ? 'Scripts/pip' : 'bin/pip'), ['install', '-q', 'cmake'])
    }
  }

  const currentTag = () => {
    try {
      return execFileSync('git', ['-C', src, 'describe', '--tags'], { encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  }
  if (currentTag() !== TAG) {
    console.log(`» downloading whisper.cpp ${TAG}`)
    fs.rmSync(src, { recursive: true, force: true })
    run('git', ['clone', '-q', '--depth', '1', '--branch', TAG, REPO, src])
  }

  const flags = [
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_EXAMPLES=ON',
    '-DWHISPER_BUILD_SERVER=ON',
    `-DGGML_NATIVE=${process.env.ORBIT_WHISPER_NATIVE === '1' ? 'ON' : 'OFF'}`,
  ]
  if (platform === 'darwin') {
    flags.push(
      '-DGGML_METAL=ON',
      '-DGGML_METAL_EMBED_LIBRARY=ON',
      `-DCMAKE_OSX_ARCHITECTURES=${arch === 'x64' ? 'x86_64' : 'arm64'}`,
      // Same floor as the app (electron-builder.json5 → mac.minimumSystemVersion).
      '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0',
    )
  }

  console.log(`» compiling whisper-server ${TAG} (${platform}-${arch}, static)`)
  run(cmake, ['-S', src, '-B', build, ...flags])
  run(cmake, ['--build', build, '--config', 'Release', '--target', 'whisper-server', '-j', String(os.availableParallelism?.() ?? os.cpus().length)])

  const candidates = [path.join(build, 'bin', exe), path.join(build, 'bin', 'Release', exe)]
  const built = candidates.find((file) => fs.existsSync(file))
  if (!built) throw new Error(`whisper-server did not show up in ${candidates.join(' nor in ')}`)

  fs.mkdirSync(outDir, { recursive: true })
  fs.copyFileSync(built, out)
  fs.chmodSync(out, 0o755)
  fs.writeFileSync(stamp, `${signature}\n`)

  // A leftover @rpath would break the binary inside the .app (the dylibs do not go along).
  if (platform === 'darwin') {
    const libs = execFileSync('otool', ['-L', out], { encoding: 'utf8' })
    if (libs.includes('@rpath')) throw new Error(`whisper-server came out depending on dylibs:\n${libs}`)
  }

  console.log(`» ready: ${path.relative(root, out)}`)
}

// Without process.exit on the error path: on Windows, exiting in the middle of a fetch that
// failed takes Node down in a libuv assertion (see fetch-ffmpeg.mjs).
try {
  fs.mkdirSync(work, { recursive: true })
  if (prebuiltUrl) await fetchPrebuilt()
  else compile()
} catch (err) {
  if (soft) {
    console.warn(`» whisper-server: ${err?.message ?? err}`)
    console.warn('» going on without whisper-server — the dictation whisper engine stays unavailable until `npm run whisper:build` succeeds')
  } else {
    console.error(err)
    process.exitCode = 1
  }
}
