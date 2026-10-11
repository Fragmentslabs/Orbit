import { app } from "electron"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import type { VoiceDownloadProgress, VoiceModelInfo } from "@shared/voice"
import { TTS_ASSETS, isTtsModel, modelInfo, ttsAssetUrl } from "./manifest"

/**
 * Download dos modelos de voz, com progresso, cancelamento e RETOMADA.
 *
 * Nada de modelo no build: os arquivos vão para
 * `<userData>/voice/models/<id>/` e só o download usa rede. O arquivo em
 * trânsito é `<nome>.part`; ele é mantido quando o download é cancelado ou a
 * rede cai, e a próxima tentativa continua de onde parou (Range). Por isso um
 * pacote de 401 MB no fio lento não precisa recomeçar do zero.
 *
 * A retomada é por ARQUIVO (`vector_estimator.onnx`, `vocoder.onnx`, …) e,
 * dentro do arquivo, por bytes: os dois níveis usam o mesmo mecanismo.
 */

export type VoiceProgressListener = (progress: VoiceDownloadProgress) => void

/** Emissões no máximo a cada X ms — um chunk por evento inundaria o IPC. */
const EMIT_INTERVAL_MS = 100

interface Job {
  controller: AbortController
  cancelled: boolean
}

/** Um arquivo esperado de um modelo, já resolvido em caminho absoluto. */
interface ExpectedFile {
  url: string
  /** Caminho final (fora do `.part`). */
  path: string
  bytes: number
  sha256?: string
}

const jobs = new Map<string, Job>()
const lastProgress = new Map<string, VoiceDownloadProgress>()

/** Raiz dos modelos de voz: `<userData>/voice/models`. */
export function modelsRoot(): string {
  return path.join(app.getPath("userData"), "voice", "models")
}

/** Pasta de um modelo — é ela que `voice:remove-model` apaga inteira. */
export function modelDir(modelId: string): string {
  return path.join(modelsRoot(), modelId)
}

/**
 * Nome do arquivo de um modelo de STT: o último segmento da URL. Os modelos de
 * STT (outro worker) são um arquivo por modelo; o TTS é o único caso de pacote.
 */
function sttFileName(model: VoiceModelInfo): string {
  const tail = decodeURIComponent(model.url.split("?")[0].split("/").filter(Boolean).pop() ?? "")
  return tail && tail.includes(".") ? tail : `${model.id}.bin`
}

/** Os arquivos que um modelo precisa ter no disco para estar instalado. */
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
  // Um arquivo por modelo de STT; o sha256, quando o catálogo o publica, é
  // conferido no fim como nos .onnx do TTS (é um download grande, vale a pena).
  return [{ url: model.url, path: path.join(dir, sttFileName(model)), bytes: model.bytes, sha256: model.sha256 }]
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** Progresso conhecido de um modelo (o último emitido; null se nunca houve). */
export function progressOf(modelId: string): VoiceDownloadProgress | null {
  return lastProgress.get(modelId) ?? null
}

export function isDownloading(modelId: string): boolean {
  return jobs.has(modelId)
}

/**
 * Os BYTES do modelo estão completos no disco? Checa a PRESENÇA e o TAMANHO de
 * cada arquivo — o tamanho pega o caso comum (download interrompido com `.part`
 * sobrando, arquivo truncado por disco cheio) sem reler 400 MB a cada consulta
 * de status. A integridade por sha256 é verificada no fim do download.
 *
 * ATENÇÃO: isto é "baixado", não "pronto para usar". O `.tar.bz2` do Parakeet
 * fica baixado e continua inutilizável até ser extraído (e o VAD Silero baixar)
 * — quem responde "dá para usar?" é o `voice:status` (ver `./status.ts`), que
 * consulta o MOTOR. Nunca use esta função para pintar um selo de "instalado".
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

/** Bytes já no disco, contando os `.part` (é o `received` do progresso). */
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

/** sha256 do arquivo, lido em pedaços (não carrega 256 MB na memória). */
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
 * Confere o tamanho, o sha256 (quando a origem publica um) e promove o `.part`
 * ao nome final. Um arquivo já do tamanho certo nunca é baixado de novo.
 */
async function finalizar(dest: string, file: ExpectedFile): Promise<void> {
  const finalSize = sizeOf(dest)
  if (finalSize !== file.bytes) {
    throw new Error(`download incompleto em ${path.basename(file.path)} (${finalSize} de ${file.bytes} bytes)`)
  }
  if (file.sha256) {
    const digest = await sha256Of(dest)
    if (digest !== file.sha256) {
      // Arquivo corrompido: apaga o parcial para a próxima tentativa recomeçar.
      await fsp.rm(dest, { force: true })
      throw new Error(`arquivo corrompido: ${path.basename(file.path)} (sha256 não confere)`)
    }
  }
  await fsp.rename(dest, file.path)
}

/**
 * Baixa um arquivo para `dest` com retomada. O `Range` pede só o que falta do
 * `.part`; a escrita é serializada (uma escrita por pedaço lido), então não há
 * buffer intermediário de 256 MB na memória.
 */
async function fetchToFile(
  file: ExpectedFile,
  job: Job,
  onBytes: (delta: number) => void,
): Promise<void> {
  const dest = file.path + ".part"
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  // Arquivo já baixado numa tentativa anterior (sem o `.part`): nada a fazer.
  if (sizeOf(file.path) === file.bytes) return
  let have = sizeOf(dest)
  if (have > file.bytes) {
    // Sobra maior que o esperado (origem mudou de tamanho): recomeça.
    await fsp.rm(dest, { force: true })
    have = 0
  }
  // `.part` do tamanho certo: o processo morreu entre a última escrita e o
  // rename. Confere e finaliza sem pedir nada à origem (com Range isso viraria
  // um 416 e o arquivo completo se perderia).
  if (have === file.bytes) {
    await finalizar(dest, file)
    return
  }

  const res = await fetch(file.url, {
    headers: have > 0 ? { Range: `bytes=${have}-` } : {},
    signal: job.controller.signal,
  })
  if (!res.ok) throw new Error(`origem respondeu ${res.status} para ${file.url}`)
  // 200 com Range pedido = a origem ignorou o Range: o corpo é o arquivo todo.
  const append = have > 0 && res.status === 206
  if (!append && have > 0) have = 0
  if (!res.body) throw new Error(`resposta sem corpo para ${file.url}`)

  const handle = await fsp.open(dest, append ? "a" : "w")
  const reader = res.body.getReader()
  try {
    for (;;) {
      if (job.cancelled) throw new Error("cancelado")
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      await handle.write(Buffer.from(value))
      have += value.byteLength
      onBytes(value.byteLength)
    }
  } catch (err) {
    if (job.cancelled || job.controller.signal.aborted) throw new Error("cancelado")
    throw err
  } finally {
    // O leitor não é solto aqui de propósito: num abort ele fica com a leitura
    // pendente e `releaseLock` lançaria — o corpo da resposta morre com o fetch.
    await handle.close()
  }

  if (job.cancelled) throw new Error("cancelado")
  await finalizar(dest, file)
}

/**
 * Baixa um modelo inteiro (TTS = 16 arquivos; STT = 1). Idempotente: o que já
 * está completo é pulado, então chamar de novo retoma o que faltou. Se já
 * houver um download do mesmo modelo em curso, não faz nada — quem decide é o
 * `started` devolvido por `startDownload`.
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

  const progresso = (done: boolean, error?: string) => {
    lastEmit = Date.now()
    emit(listener, { modelId, received, total, done, error })
  }

  try {
    for (const file of files) {
      if (job.cancelled) throw new Error("cancelado")
      if (sizeOf(file.path) === file.bytes) continue
      await fetchToFile(file, job, (delta) => {
        received += delta
        if (Date.now() - lastEmit >= EMIT_INTERVAL_MS) progresso(false)
      })
      // Fim de cada arquivo: um progresso certo, sem esperar o throttle.
      progresso(false)
    }
    progresso(true)
  } catch (err) {
    const cancelado = job.cancelled || job.controller.signal.aborted || (err as Error).message === "cancelado"
    // Cancelamento não é erro: o parcial fica no disco para a retomada e o
    // evento final só fecha a barra (a UI pediu para parar, ela sabe disso).
    if (cancelado) progresso(true)
    else progresso(true, (err as Error).message ?? String(err))
  } finally {
    jobs.delete(modelId)
  }
}

/**
 * Inicia o download sem bloquear o IPC. Devolve `started: false` quando já
 * havia um download do mesmo modelo em curso.
 */
export function startDownload(modelId: string, listener: VoiceProgressListener): { started: boolean } {
  if (jobs.has(modelId)) return { started: false }
  void downloadModel(modelId, listener).catch(() => {
    // o erro já foi pela progresso(done, error); aqui só evita unhandled
  })
  return { started: true }
}

/** Pede o cancelamento: o `.part` fica no disco e o download retoma depois. */
export function cancelDownload(modelId: string): void {
  const job = jobs.get(modelId)
  if (!job) return
  job.cancelled = true
  job.controller.abort()
}

/** Apaga o modelo (cancela o download em curso antes). */
export async function removeModel(modelId: string): Promise<void> {
  cancelDownload(modelId)
  await fsp.rm(modelDir(modelId), { recursive: true, force: true })
  lastProgress.delete(modelId)
}

/**
 * Quanto do modelo já está no disco, em bytes — usado pelo `voice:status`
 * (para o progresso de um download parcial) e pelo aviso da UI.
 */
export async function receivedBytes(modelId: string): Promise<number> {
  const model = modelInfo(modelId)
  if (!model) return 0
  return await bytesOnDisk(expectedFiles(model))
}
