#!/usr/bin/env node
/**
 * Prepara o `whisper-server` (whisper.cpp) que o motor Whisper do ditado sobe
 * como processo auxiliar (ver electron/lib/voice/whisper.ts).
 *
 *   node scripts/build-whisper-server.mjs [--arch arm64|x64] [--force] [--soft]
 *
 * Saída: resources/whisper/<platform>-<arch>/whisper-server — é de lá que o dev
 * lê, e é essa pasta que o electron-builder copia para `Resources/whisper` do
 * app (extraResources).
 *
 * O `npm run dev` chama com `--soft` (predev), igual ao ffmpeg: o servidor sobe
 * junto na primeira vez e depois o carimbo faz a chamada custar nada. No modo
 * soft uma falha (sem rede, sem compilador) só avisa — o dev abre igual, com o
 * motor whisper indisponível e o motivo na tela de voz. No build é fatal.
 *
 * No Windows NÃO compila: baixa o binário oficial do release do whisper.cpp (o
 * build `bNNNN` do mesmo commit da tag — a tag vX.Y.Z sai sem anexos), que vem
 * com as DLLs do ggml ao lado (o backend de CPU é escolhido em runtime, pelo
 * conjunto de instruções da máquina). Junto vão as DLLs do runtime do Visual
 * C++ desta máquina (deploy local ao app, permitido pela licença do
 * redistribuível): sem elas o servidor não abre num Windows sem o VC++.
 * ORBIT_WHISPER_COMPILE=1 força a compilação também no Windows.
 *
 * No macOS e no Linux compila: build ESTÁTICO e com o shader do Metal embutido —
 * um executável só, sem dylib ao lado nem `.metal` para achar em runtime — é o
 * que deixa empacotar sem mexer em rpath. `GGML_NATIVE=OFF` para o binário rodar
 * em qualquer máquina da mesma arquitetura, não só na que compilou
 * (ORBIT_WHISPER_NATIVE=1 desfaz).
 *
 * Nada global: sem cmake no PATH ele vai para um venv em .whisper-build/.venv
 * (a mesma receita do vozlab). Já pronto na mesma versão, não refaz nada.
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
/** Build do release no mesmo commit da TAG (é ele que leva os binários). */
const PREBUILT_BUILD = process.env.WHISPER_PREBUILT_BUILD || 'b5454'
const PREBUILT = {
  'win32-x64': 'whisper-bin-x64.zip',
  'win32-arm64': 'whisper-bin-win-cpu-arm64.zip',
}
/** Runtime do Visual C++ que o whisper-server.exe importa. */
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
// O carimbo diz DE ONDE veio: trocar entre compilado e pré-compilado refaz.
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
  console.log(`» whisper-server ${TAG} (${platform}-${arch}) já pronto: ${path.relative(root, out)}`)
  process.exit(0)
}

/** Primeiro arquivo com esse nome dentro da pasta (o zip aninha em Release/). */
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

/** Binário oficial do release: o servidor e as DLLs do ggml/whisper ao lado. */
async function fetchPrebuilt() {
  const tmp = path.join(work, `prebuilt-${platform}-${arch}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  const archive = path.join(tmp, prebuiltName)
  console.log(`» baixando ${prebuiltUrl}`)
  const res = await fetch(prebuiltUrl, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download falhou (${res.status}): ${prebuiltUrl}`)
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(archive))
  // O tar do Git Bash (GNU) vem antes no PATH e não abre zip; o do sistema abre.
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  execFileSync(path.join(system32, 'tar.exe'), ['-xf', archive, '-C', tmp], { stdio: 'inherit' })
  const found = findFile(tmp, exe)
  if (!found) throw new Error(`${prebuiltName} não trouxe ${exe}`)
  const from = path.dirname(found)

  // Pasta limpa: DLL de outra versão sobrando ao lado confundiria o loader. O
  // resto do zip (cli, bench, parakeet, SDL…) não interessa ao app.
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  const keep = (name) => name === exe || name === 'whisper.dll' || /^ggml.*\.dll$/i.test(name)
  for (const name of fs.readdirSync(from).filter(keep)) fs.copyFileSync(path.join(from, name), path.join(outDir, name))
  // Runtime do VC++ só da MESMA arquitetura desta máquina (o System32 é o nativo).
  if (arch === process.arch) {
    for (const name of VC_RUNTIME) {
      const dll = path.join(system32, name)
      if (fs.existsSync(dll)) fs.copyFileSync(dll, path.join(outDir, name))
      else console.warn(`» aviso: ${name} não está em ${system32} — o app vai depender do VC++ instalado`)
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true })

  if (arch === process.arch) {
    // O uso sai no stderr; o que importa é o binário abrir com as DLLs ao lado.
    const help = spawnSync(out, ['--help'], { encoding: 'utf8', timeout: 20_000 })
    if (!/usage/i.test(`${help.stdout}${help.stderr}`)) {
      throw new Error(`o whisper-server baixado não abriu (${help.error?.message ?? `código ${help.status}`})`)
    }
  }
  fs.writeFileSync(stamp, `${signature}\n`)
  console.log(`» pronto: ${path.relative(root, out)} (whisper.cpp ${TAG}, ${PREBUILT_BUILD})`)
}

function compile() {
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
  fs.writeFileSync(stamp, `${signature}\n`)

  // Um @rpath sobrando quebraria o binário dentro do .app (as dylibs não vão junto).
  if (platform === 'darwin') {
    const libs = execFileSync('otool', ['-L', out], { encoding: 'utf8' })
    if (libs.includes('@rpath')) throw new Error(`o whisper-server saiu dependendo de dylibs:\n${libs}`)
  }

  console.log(`» pronto: ${path.relative(root, out)}`)
}

// Sem process.exit no caminho de erro: no Windows, sair no meio de um fetch que
// falhou derruba o Node numa assertion da libuv (ver fetch-ffmpeg.mjs).
try {
  fs.mkdirSync(work, { recursive: true })
  if (prebuiltUrl) await fetchPrebuilt()
  else compile()
} catch (err) {
  if (soft) {
    console.warn(`» whisper-server: ${err?.message ?? err}`)
    console.warn('» seguindo sem whisper-server — o motor whisper do ditado fica indisponível até `npm run whisper:build` dar certo')
  } else {
    console.error(err)
    process.exitCode = 1
  }
}
