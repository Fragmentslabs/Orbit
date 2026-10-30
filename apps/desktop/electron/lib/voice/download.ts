import { app } from "electron"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import type { VoiceDownloadProgress, VoiceModelInfo } from "@shared/voice"
import { TTS_ASSETS, isTtsModel, modelInfo, ttsAssetUrl } from "./manifest"

/**
 * Download of the voice models, with progress, cancellation and RESUMPTION.
 *
 * No model in the build: the files go to
 * `<userData>/voice/models/<id>/` and only the download uses the network. The file in
 * transit is `<name>.part`; it is kept when the download is cancelled or the
 * network drops, and the next attempt continues from where it stopped (Range). That is why a
 * 401 MB package on a slow link does not have to start over from scratch.
 *
 * Resumption is per FILE (`vector_estimator.onnx`, `vocoder.onnx`, …) and,
 * within the file, per byte: both levels use the same mechanism.
 */

export type VoiceProgressListener = (progress: VoiceDownloadProgress) => void

/** Emissions at most every X ms — one chunk per event would flood the IPC. */
const EMIT_INTERVAL_MS = 100

interface Job {
  controller: AbortController
  cancelled: boolean
}

/** An expected file of a model, already resolved to an absolute path. */
interface ExpectedFile {
  url: string
  /** Final path (outside the `.part`). */
  path: string
  bytes: number
  sha256?: string
}

const jobs = new Map<string, Job>()
const lastProgress = new Map<string, VoiceDownloadProgress>()

/** Root of the voice models: `<userData>/voice/models`. */
export function modelsRoot(): string {
  return path.join(app.getPath("userData"), "voice", "models")
}

/** Folder of a model — it is the one `voice:remove-model` deletes entirely. */
export function modelDir(modelId: string): string {
  return path.join(modelsRoot(), modelId)
}

/**
 * File name of an STT model: the last segment of the URL. The STT models
 * (another worker) are one file per model; the TTS is the only package case.
 */
function sttFileName(model: VoiceModelInfo): string {
  const tail = decodeURIComponent(model.url.split("?")[0].split("/").filter(Boolean).pop() ?? "")
  return tail && tail.includes(".") ? tail : `${model.id}.bin`
}

/** The files a model must have on disk to be installed. */
function expectedFiles(model: VoiceModelInfo): ExpectedFile[] {
  const dir = modelDir(model.id)
  if (isTtsModel(model.id)) {
    return TTS_ASSETS.map((file) => ({
      url: ttsAssetUrl(file.path),
      path: path.join(dir, ...file.path.split("/")),
      bytes: file.bytes,
      sha256: file.sha256,
    }))
  }
  // One file per STT model; the sha256, when the catalog publishes it, is
  // checked at the end as with the TTS .onnx files (it is a large download, it is worth it).
  return [{ url: model.url, path: path.join(dir, sttFileName(model)), bytes: model.bytes, sha256: model.sha256 }]
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** Known progress of a model (the last one emitted; null if there never was one). */
export function progressOf(modelId: string): VoiceDownloadProgress | null {
  return lastProgress.get(modelId) ?? null
}

export function isDownloading(modelId: string): boolean {
  return jobs.has(modelId)
}

/**
 * Are the model's BYTES complete on disk? It checks the PRESENCE and the SIZE of
 * each file — the size catches the common case (interrupted download with a `.part`
 * left over, file truncated by a full disk) without re-reading 400 MB on every status
 * query. Integrity via sha256 is verified at the end of the download.
 *
 * WARNING: this is "downloaded", not "ready to use". Parakeet's `.tar.bz2`
 * stays downloaded and remains unusable until it is extracted (and the Silero VAD is downloaded)
 * — whoever answers "can it be used?" is `voice:status` (see `./status.ts`), which
 * queries the ENGINE. Never use this function to paint an "installed" badge.
 */
export async function isModelDownloaded(modelId: string): Promise<boolean> {
  const model = modelInfo(modelId)
  if (!model) return false
  const files = expectedFiles(model)
  for (const file of files) {
    if (sizeOf(file.path) !== file.bytes) return false
  }
  return files.length > 0
}

/** Bytes already on disk, counting the `.part` files (it is the progress `received`). */
async function bytesOnDisk(files: ExpectedFile[]): Promise<number> {
  let total = 0
  for (const file of files) {
    const completo = sizeOf(file.path) === file.bytes
    total += completo ? file.bytes : Math.min(sizeOf(file.path + ".part"), file.bytes)
  }
  return total
}

function emit(listener: VoiceProgressListener, progress: VoiceDownloadProgress): void {
  lastProgress.set(progress.modelId, progress)
  listener(progress)
}

/** sha256 of the file, read in chunks (it does not load 256 MB into memory). */
async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256")
  const handle = await fsp.open(file, "r")
  try {
    const buffer = Buffer.alloc(1 << 20)
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead <= 0) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
  return hash.digest("hex")
}

/**
 * Checks the size, the sha256 (when the origin publishes one) and promotes the `.part`
 * to the final name. A file already of the right size is never downloaded again.
 */
async function finalize(dest: string, file: ExpectedFile): Promise<void> {
  const finalSize = sizeOf(dest)
  if (finalSize !== file.bytes) {
    throw new Error(`incomplete download at ${path.basename(file.path)} (${finalSize} of ${file.bytes} bytes)`)
  }
  if (file.sha256) {
    const digest = await sha256Of(dest)
    if (digest !== file.sha256) {
      // Corrupted file: delete the partial so the next attempt can start over.
      await fsp.rm(dest, { force: true })
      throw new Error(`corrupted file: ${path.basename(file.path)} (sha256 mismatch)`)
    }
  }
  await fsp.rename(dest, file.path)
}

/**
 * Downloads a file to `dest` with resumption. The `Range` asks only for what is missing from the
 * `.part`; the write is serialised (one write per chunk read), so there is no
 * 256 MB intermediate buffer in memory.
 */
async function fetchToFile(
  file: ExpectedFile,
  job: Job,
  onBytes: (delta: number) => void,
): Promise<void> {
  const dest = file.path + ".part"
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  // File already downloaded in a previous attempt (without the `.part`): nothing to do.
  if (sizeOf(file.path) === file.bytes) return
  let have = sizeOf(dest)
  if (have > file.bytes) {
    // Leftover larger than expected (the origin changed size): start over.
    await fsp.rm(dest, { force: true })
    have = 0
  }
  // `.part` of the right size: the process died between the last write and the
  // rename. Checks and finishes without asking the origin for anything (with Range that would become
  // a 416 and the complete file would be lost).
  if (have === file.bytes) {
    await finalize(dest, file)
    return
  }

  const res = await fetch(file.url, {
    headers: have > 0 ? { Range: `bytes=${have}-` } : {},
    signal: job.controller.signal,
  })
  if (!res.ok) throw new Error(`origin answered ${res.status} for ${file.url}`)
  // 200 with Range requested = the origin ignored the Range: the body is the whole file.
  const append = have > 0 && res.status === 206
  if (!append && have > 0) have = 0
  if (!res.body) throw new Error(`response with no body for ${file.url}`)

  const handle = await fsp.open(dest, append ? "a" : "w")
  const reader = res.body.getReader()
  try {
    for (;;) {
      if (job.cancelled) throw new Error("cancelled")
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      await handle.write(Buffer.from(value))
      have += value.byteLength
      onBytes(value.byteLength)
    }
  } catch (err) {
    if (job.cancelled || job.controller.signal.aborted) throw new Error("cancelled")
    throw err
  } finally {
    // The reader is not released here on purpose: on an abort it is left with a pending
    // read and `releaseLock` would throw — the response body dies with the fetch.
    await handle.close()
  }

  if (job.cancelled) throw new Error("cancelled")
  await finalize(dest, file)
}

/**
 * Downloads a whole model (TTS = 16 files; STT = 1). Idempotent: what is already
 * complete is skipped, so calling it again resumes what was missing. If there already
 * is a download of the same model in progress, it does nothing — the decision belongs to the
 * `started` returned by `startDownload`.
 */
export async function downloadModel(modelId: string, listener: VoiceProgressListener): Promise<void> {
  const model = modelInfo(modelId)
  if (!model) throw new Error(`modelo desconhecido: ${modelId}`)
  const existente = jobs.get(modelId)
  if (existente) return

  const job: Job = { controller: new AbortController(), cancelled: false }
  jobs.set(modelId, job)
  const files = expectedFiles(model)
  const total = model.bytes
  let received = await bytesOnDisk(files)
  let lastEmit = 0
  emit(listener, { modelId, received, total, done: false })

  const progress = (done: boolean, error?: string) => {
    lastEmit = Date.now()
    emit(listener, { modelId, received, total, done, error })
  }

  try {
    for (const file of files) {
      if (job.cancelled) throw new Error("cancelled")
      if (sizeOf(file.path) === file.bytes) continue
      await fetchToFile(file, job, (delta) => {
        received += delta
        if (Date.now() - lastEmit >= EMIT_INTERVAL_MS) progress(false)
      })
      // End of each file: an exact progress, without waiting for the throttle.
      progress(false)
    }
    progress(true)
  } catch (err) {
    const wasCancelled = job.cancelled || job.controller.signal.aborted || (err as Error).message === "cancelled"
    // Cancellation is not an error: the partial stays on disk for the resumption and the
    // final event just closes the bar (the UI asked to stop, it knows that).
    if (wasCancelled) progress(true)
    else progress(true, (err as Error).message ?? String(err))
  } finally {
    jobs.delete(modelId)
  }
}

/**
 * Starts the download without blocking the IPC. Returns `started: false` when there already
 * was a download of the same model in progress.
 */
export function startDownload(modelId: string, listener: VoiceProgressListener): { started: boolean } {
  if (jobs.has(modelId)) return { started: false }
  void downloadModel(modelId, listener).catch(() => {
    // the error already went through progress(done, error); here it only avoids an unhandled
  })
  return { started: true }
}

/** Requests cancellation: the `.part` stays on disk and the download resumes later. */
export function cancelDownload(modelId: string): void {
  const job = jobs.get(modelId)
  if (!job) return
  job.cancelled = true
  job.controller.abort()
}

/** Deletes the model (cancelling the download in progress first). */
export async function removeModel(modelId: string): Promise<void> {
  cancelDownload(modelId)
  await fsp.rm(modelDir(modelId), { recursive: true, force: true })
  lastProgress.delete(modelId)
}

/**
 * How much of the model is already on disk, in bytes — used by `voice:status`
 * (for the progress of a partial download) and by the UI notice.
 */
export async function receivedBytes(modelId: string): Promise<number> {
  const model = modelInfo(modelId)
  if (!model) return 0
  return await bytesOnDisk(expectedFiles(model))
}
