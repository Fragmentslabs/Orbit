/**
 * Where the dictation models live on disk — and what the engine needs to be
 * ready before opening a session.
 *
 * The DOWNLOAD does not live here: the core's `./download.ts` is what downloads (resumption,
 * progress, sha256), and it already existed when this engine was written. This module
 * only AGREES with it on the layout and checks what arrived:
 *
 *   <userData>/voice/models/<id>/<URL file>   # the core's download
 *   <userData>/voice/models/<id>/model/             # Parakeet extracted (by this engine)
 *   <userData>/voice/models/silero_vad.onnx         # Parakeet VAD (by this engine)
 *
 * The "installed" check repeats the downloader's rule (EXACT file size),
 * so the two views never disagree.
 *
 * Why not import `./download.ts` or `./manifest.ts` from here: `manifest.ts`
 * imports `./stt.ts` and reads `STT_MODELS` at the top of the module. Since `stt.ts` imports
 * the engines, an import of these files here would close a cycle in which the
 * manifest may evaluate before `STT_MODELS` exists (TDZ ReferenceError,
 * depending on which one comes in first). The few path functions were
 * repeated on purpose — they are trivial and the cycle would be worse.
 */

import { app } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import {
  fileNameOf,
  getSttModel,
  modelsForEngine,
  PARAKEET_DIR,
  PARAKEET_EXTRACT_DIR,
  PARAKEET_FILES,
  SILERO_VAD_BYTES,
  SILERO_VAD_FILE,
  SILERO_VAD_URL,
  type SttModelDef,
} from './catalog'

export const PARAKEET_ID = 'parakeet-tdt-0.6b-v3'

/** Root of the voice data: `<userData>/voice`. */
export function voiceDir(): string {
  return path.join(app.getPath('userData'), 'voice')
}

/** Root of the models: `<userData>/voice/models` (same path as the core). */
export function modelsDir(): string {
  return path.join(voiceDir(), 'models')
}

/** Folder of a model — it is the one that disappears when the model is removed. */
export function modelDirFor(id: string): string {
  return path.join(modelsDir(), id)
}

/** Path of the downloaded file (for Parakeet, the `.tar.bz2` itself). */
export function modelFileFor(def: SttModelDef): string {
  return path.join(modelDirFor(def.id), fileNameOf(def))
}

/** Where the Parakeet files live after being extracted. */
export function parakeetFilesDir(id: string = PARAKEET_ID): string {
  return path.join(modelDirFor(id), PARAKEET_EXTRACT_DIR)
}

/** Path of the Silero VAD (shared among Parakeet models). */
export function sileroVadPath(): string {
  return path.join(modelsDir(), SILERO_VAD_FILE)
}

/**
 * `whisper-server` that ships with the app (scripts/build-whisper-server.mjs): in
 * `Resources/whisper` when packaged, in `resources/whisper/<platform>-<arch>`
 * in dev. `null` when the environment does not say where the app is (tests).
 */
export function bundledWhisperServerPath(): string | null {
  const exe = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'
  if (app.isPackaged) return path.join(process.resourcesPath, 'whisper', exe)
  const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : null
  if (!appPath) return null
  return path.join(appPath, 'resources', 'whisper', `${process.platform}-${process.arch}`, exe)
}

/** Path of the optional `whisper-server` binary placed by the user. */
export function localWhisperServerPath(): string {
  return path.join(voiceDir(), 'whisper', process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server')
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** File downloaded in full (same rule as the core downloader). */
export function fileComplete(def: SttModelDef): boolean {
  return sizeOf(modelFileFor(def)) === def.bytes
}

/** A whisper model is ready for the server to load. */
export function isWhisperModelInstalled(id: string): boolean {
  const def = getSttModel(id)
  if (!def || def.engine !== 'whisper') return false
  return fileComplete(def)
}

/** Ids of the whisper models already downloaded, in catalog order. */
export function whisperInstalledIds(): string[] {
  return modelsForEngine('whisper')
    .filter((def) => fileComplete(def))
    .map((def) => def.id)
}

/** The Parakeet package is on disk (downloaded by the core downloader). */
export function parakeetArchiveComplete(): boolean {
  const def = getSttModel(PARAKEET_ID)
  return Boolean(def && fileComplete(def))
}

/** Parakeet is extracted and the VAD present — it can transcribe right now. */
export function isParakeetReady(): boolean {
  const dir = parakeetFilesDir()
  if (!PARAKEET_FILES.every((f) => sizeOf(path.join(dir, f)) > 0)) return false
  return sizeOf(sileroVadPath()) === SILERO_VAD_BYTES
}

// ---------------------------------------------------------------------------
// Parakeet preparation (package extraction + VAD)
// ---------------------------------------------------------------------------

async function fetchFile(url: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`${url} respondeu HTTP ${res.status}`)
  const out = fs.createWriteStream(`${dest}.part`)
  try {
    // `getReader()` and not `for await`: the `ReadableStream` exposed by `fetch`'s
    // type (lib DOM) does not declare `Symbol.asyncIterator` — only Node's does.
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r))
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
    await fsp.rename(`${dest}.part`, dest)
  } catch (err) {
    out.destroy()
    await fsp.rm(`${dest}.part`, { force: true }).catch(() => {})
    throw err
  }
}

/** Downloads the Silero VAD (~629 KiB) if it is not on disk yet. */
export async function ensureSileroVad(): Promise<string> {
  const dest = sileroVadPath()
  if (sizeOf(dest) === SILERO_VAD_BYTES) return dest
  await fetchFile(SILERO_VAD_URL, dest)
  if (sizeOf(dest) !== SILERO_VAD_BYTES) {
    await fsp.rm(dest, { force: true }).catch(() => {})
    throw new Error('the Silero VAD downloaded with the wrong size')
  }
  return dest
}

function extractTarBz2(archive: string, destDir: string): Promise<void> {
  // `tar` with bzip2 exists on macOS, on Linux and on Windows 10+ (bsdtar).
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xjf', archive, '-C', destDir], { timeout: 600_000 }, (err, _o, stderr) =>
      err ? reject(new Error(`failed to extract the package (tar): ${stderr || err.message}`)) : resolve(),
    )
  })
}

let extractInFlight: Promise<void> | null = null

// ---------------------------------------------------------------------------
// Extraction phase (`voice:status` publishes this; see `./status.ts`)
// ---------------------------------------------------------------------------

/** Phase of the Parakeet package extraction. */
export type ExtractPhase = 'idle' | 'extracting' | 'error'

let extractPhase: ExtractPhase = 'idle'
let extractError: string | null = null
const extractListeners = new Set<(phase: ExtractPhase, error: string | null) => void>()

/** Current extraction phase (`idle` when there is no extraction in progress). */
export function parakeetExtractPhase(): { phase: ExtractPhase; error: string | null } {
  return { phase: extractPhase, error: extractError }
}

/**
 * Notifies on EVERY extraction phase change (start, end, error). It is through here that
 * the core emits `voice:status-changed` even when the extraction is triggered on
 * first use (inside the engine), and not only right after the download.
 */
export function onParakeetExtractPhaseChange(
  listener: (phase: ExtractPhase, error: string | null) => void,
): () => void {
  extractListeners.add(listener)
  return () => {
    extractListeners.delete(listener)
  }
}

function setExtractPhase(phase: ExtractPhase, error: string | null = null): void {
  extractPhase = phase
  extractError = error
  for (const listener of extractListeners) {
    try {
      listener(phase, error)
    } catch {
      // a faulty listener cannot take the extraction down
    }
  }
}

/**
 * Extracts the Parakeet package to `<models>/<id>/model/`.
 *
 * The core downloader does not unpack STT packages, so the extraction belongs to the
 * engine. It goes to a temporary folder and only changes name at the end: with the
 * files appearing little by little, an optimistic `status` would say "ready" with the
 * encoder half written (that is exactly what happened in the laboratory).
 *
 * The phase lives in `parakeetExtractPhase()` — "downloaded" never presents itself as
 * "ready": while the package is not extracted the state is `downloaded` or
 * `extracting`, and that is what `voice:status` publishes.
 */
export function ensureParakeetExtracted(): Promise<void> {
  if (isParakeetReady()) return Promise.resolve()
  if (extractInFlight) return extractInFlight

  const def = getSttModel(PARAKEET_ID)
  if (!def) return Promise.reject(new Error('the Parakeet model is not in the catalog'))

  extractInFlight = (async () => {
    if (!fileComplete(def)) {
      throw new Error(`the Parakeet package has not been downloaded yet (${def.bytes} bytes at <userData>/voice/models/${PARAKEET_ID})`)
    }
    const archive = modelFileFor(def)
    const dir = modelDirFor(def.id)
    const tmp = path.join(dir, '.extract')
    setExtractPhase('extracting')
    try {
      await fsp.rm(tmp, { recursive: true, force: true })
      await fsp.mkdir(tmp, { recursive: true })
      await extractTarBz2(archive, tmp)
      const inner = path.join(tmp, PARAKEET_DIR)
      const source = fs.existsSync(inner) ? inner : tmp
      const target = parakeetFilesDir()
      await fsp.rm(target, { recursive: true, force: true })
      await fsp.rename(source, target)
      if (!PARAKEET_FILES.every((f) => sizeOf(path.join(target, f)) > 0)) {
        throw new Error(`the package did not bring ${PARAKEET_FILES.join(', ')}`)
      }
      await ensureSileroVad()
    } catch (err) {
      setExtractPhase('error', (err as Error).message ?? String(err))
      throw err
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
    setExtractPhase('idle')
  })().finally(() => {
    extractInFlight = null
  })

  return extractInFlight
}
