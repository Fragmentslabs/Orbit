#!/usr/bin/env node
/**
 * Compila o `whisper-server` (whisper.cpp) que o motor Whisper do ditado sobe
 * como processo auxiliar (ver electron/lib/voice/whisper.ts).
 *
 *   node scripts/build-whisper-server.mjs [--arch arm64|x64] [--force]
 *
 * Saída: resources/whisper/<platform>-<arch>/whisper-server — é de lá que o dev
 * lê, e é essa pasta que o electron-builder copia para `Resources/whisper` do
 * app (extraResources).
 *
 * Build ESTÁTICO e com o shader do Metal embutido: um executável só, sem dylib
 * ao lado nem `.metal` para achar em runtime — é o que deixa empacotar sem
 * mexer em rpath. `GGML_NATIVE=OFF` para o binário rodar em qualquer máquina da
 * mesma arquitetura, não só na que compilou (ORBIT_WHISPER_NATIVE=1 desfaz).
 *
 * Nada global: sem cmake no PATH ele vai para um venv em .whisper-build/.venv
 * (a mesma receita do vozlab). Já compilado na mesma versão, não refaz nada.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TAG = process.env.WHISPER_TAG || 'v1.9.5'
const REPO = 'https://github.com/ggml-org/whisper.cpp.git'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argValue = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const arch = argValue('--arch') || process.arch
const force = args.includes('--force')
const platform = process.platform
const exe = platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'

const work = path.join(root, '.whisper-build')
const src = path.join(work, 'whisper.cpp')
const build = path.join(work, `build-${platform}-${arch}`)
const outDir = path.join(root, 'resources', 'whisper', `${platform}-${arch}`)
const out = path.join(outDir, exe)
const stamp = path.join(outDir, 'VERSION')

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', ...opts })
const has = (cmd) => {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (!force && fs.existsSync(out) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === TAG) {
  console.log(`» whisper-server ${TAG} (${platform}-${arch}) já compilado: ${path.relative(root, out)}`)
  process.exit(0)
}

fs.mkdirSync(work, { recursive: true })

let cmake = 'cmake'
if (!has(cmake)) {
  const venv = path.join(work, '.venv')
  cmake = path.join(venv, platform === 'win32' ? 'Scripts/cmake.exe' : 'bin/cmake')
  if (!fs.existsSync(cmake)) {
    console.log('» cmake local (venv em .whisper-build/.venv)')
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
  console.log(`» baixando whisper.cpp ${TAG}`)
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
    // Mesmo piso do app (electron-builder.json5 → mac.minimumSystemVersion).
    '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0',
  )
}

console.log(`» compilando whisper-server ${TAG} (${platform}-${arch}, estático)`)
run(cmake, ['-S', src, '-B', build, ...flags])
run(cmake, ['--build', build, '--config', 'Release', '--target', 'whisper-server', '-j', String(os.availableParallelism?.() ?? os.cpus().length)])

const candidates = [path.join(build, 'bin', exe), path.join(build, 'bin', 'Release', exe)]
const built = candidates.find((file) => fs.existsSync(file))
if (!built) throw new Error(`whisper-server não apareceu em ${candidates.join(' nem em ')}`)

fs.mkdirSync(outDir, { recursive: true })
fs.copyFileSync(built, out)
fs.chmodSync(out, 0o755)
fs.writeFileSync(stamp, `${TAG}\n`)

// Um @rpath sobrando quebraria o binário dentro do .app (as dylibs não vão junto).
if (platform === 'darwin') {
  const libs = execFileSync('otool', ['-L', out], { encoding: 'utf8' })
  if (libs.includes('@rpath')) throw new Error(`o whisper-server saiu dependendo de dylibs:\n${libs}`)
}

console.log(`» pronto: ${path.relative(root, out)}`)
