/**
 * Onde os modelos de ditado ficam no disco — e o que o motor precisa que esteja
 * pronto antes de abrir uma sessão.
 *
 * O DOWNLOAD não mora aqui: quem baixa é o `./download.ts` do núcleo (retomada,
 * progresso, sha256), que já existia quando este motor foi escrito. Este módulo
 * só CONCORDA com ele sobre o layout e checa o que chegou:
 *
 *   <userData>/voice/models/<id>/<arquivo da URL>   # o download do núcleo
 *   <userData>/voice/models/<id>/model/             # Parakeet extraído (por este motor)
 *   <userData>/voice/models/silero_vad.onnx         # VAD do Parakeet (por este motor)
 *
 * A checagem de "instalado" repete a regra do downloader (tamanho EXATO do
 * arquivo), para as duas visões nunca discordarem.
 *
 * Por que não importar `./download.ts` ou `./manifest.ts` daqui: `manifest.ts`
 * importa `./stt.ts` e lê `STT_MODELS` no topo do módulo. Como `stt.ts` importa
 * os motores, um import destes arquivos aqui fecharia um ciclo em que o
 * manifesto pode avaliar antes de `STT_MODELS` existir (ReferenceError de TDZ,
 * dependendo de quem entra primeiro). As poucas funções de caminho foram
 * repetidas de propósito — são triviais e o ciclo seria pior.
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

/** Raiz dos dados de voz: `<userData>/voice`. */
export function voiceDir(): string {
  return path.join(app.getPath('userData'), 'voice')
}

/** Raiz dos modelos: `<userData>/voice/models` (mesmo caminho do núcleo). */
export function modelsDir(): string {
  return path.join(voiceDir(), 'models')
}

/** Pasta de um modelo — é ela que some quando o modelo é removido. */
export function modelDirFor(id: string): string {
  return path.join(modelsDir(), id)
}

/** Caminho do arquivo baixado (para o Parakeet, o próprio `.tar.bz2`). */
export function modelFileFor(def: SttModelDef): string {
  return path.join(modelDirFor(def.id), fileNameOf(def))
}

/** Onde os arquivos do Parakeet ficam depois de extraídos. */
export function parakeetFilesDir(id: string = PARAKEET_ID): string {
  return path.join(modelDirFor(id), PARAKEET_EXTRACT_DIR)
}

/** Caminho do VAD Silero (compartilhado entre modelos de Parakeet). */
export function sileroVadPath(): string {
  return path.join(modelsDir(), SILERO_VAD_FILE)
}

/** Caminho do binário opcional do `whisper-server` posto pelo usuário. */
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

/** Arquivo baixado por inteiro (mesma regra do downloader do núcleo). */
export function fileComplete(def: SttModelDef): boolean {
  return sizeOf(modelFileFor(def)) === def.bytes
}

/** Um modelo de whisper está pronto para o servidor carregar. */
export function isWhisperModelInstalled(id: string): boolean {
  const def = getSttModel(id)
  if (!def || def.engine !== 'whisper') return false
  return fileComplete(def)
}

/** Ids de modelos de whisper já baixados, na ordem do catálogo. */
export function whisperInstalledIds(): string[] {
  return modelsForEngine('whisper')
    .filter((def) => fileComplete(def))
    .map((def) => def.id)
}

/** O pacote do Parakeet está no disco (baixado pelo downloader do núcleo). */
export function parakeetArchiveComplete(): boolean {
  const def = getSttModel(PARAKEET_ID)
  return Boolean(def && fileComplete(def))
}

/** O Parakeet está extraído e o VAD presente — dá para transcrever já. */
export function isParakeetReady(): boolean {
  const dir = parakeetFilesDir()
  if (!PARAKEET_FILES.every((f) => sizeOf(path.join(dir, f)) > 0)) return false
  return sizeOf(sileroVadPath()) === SILERO_VAD_BYTES
}

// ---------------------------------------------------------------------------
// Preparo do Parakeet (extração do pacote + VAD)
// ---------------------------------------------------------------------------

async function fetchFile(url: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`${url} respondeu HTTP ${res.status}`)
  const out = fs.createWriteStream(`${dest}.part`)
  try {
    // `getReader()` e não `for await`: o `ReadableStream` que o tipo de `fetch`
    // expõe (lib DOM) não declara `Symbol.asyncIterator` — só o do Node declara.
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

/** Baixa o VAD Silero (~629 KiB) se ele ainda não estiver no disco. */
export async function ensureSileroVad(): Promise<string> {
  const dest = sileroVadPath()
  if (sizeOf(dest) === SILERO_VAD_BYTES) return dest
  await fetchFile(SILERO_VAD_URL, dest)
  if (sizeOf(dest) !== SILERO_VAD_BYTES) {
    await fsp.rm(dest, { force: true }).catch(() => {})
    throw new Error('o VAD Silero baixou com tamanho errado')
  }
  return dest
}

function extractTarBz2(archive: string, destDir: string): Promise<void> {
  // `tar` com bzip2 existe no macOS, no Linux e no Windows 10+ (bsdtar).
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xjf', archive, '-C', destDir], { timeout: 600_000 }, (err, _o, stderr) =>
      err ? reject(new Error(`falha ao extrair o pacote (tar): ${stderr || err.message}`)) : resolve(),
    )
  })
}

let extractInFlight: Promise<void> | null = null

// ---------------------------------------------------------------------------
// Fase da extração (o `voice:status` publica isto; ver `./status.ts`)
// ---------------------------------------------------------------------------

/** Fase da extração do pacote do Parakeet. */
export type ExtractPhase = 'idle' | 'extracting' | 'error'

let extractPhase: ExtractPhase = 'idle'
let extractError: string | null = null
const extractListeners = new Set<(phase: ExtractPhase, error: string | null) => void>()

/** Fase atual da extração (`idle` quando não há extração em curso). */
export function parakeetExtractPhase(): { phase: ExtractPhase; error: string | null } {
  return { phase: extractPhase, error: extractError }
}

/**
 * Avisa a CADA mudança de fase da extração (início, fim, erro). É por aqui que
 * o núcleo emite `voice:status-changed` mesmo quando a extração é disparada no
 * primeiro uso (dentro do motor), e não só logo depois do download.
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
      // um listener com defeito não pode derrubar a extração
    }
  }
}

/**
 * Extrai o pacote do Parakeet para `<models>/<id>/model/`.
 *
 * O downloader do núcleo não descompacta pacotes de STT, então a extração é do
 * motor. Ela vai para uma pasta temporária e só troca de nome no fim: com os
 * arquivos aparecendo aos poucos, um `status` otimista diria "pronto" com o
 * encoder pela metade (foi exatamente o que aconteceu no laboratório).
 *
 * A fase fica em `parakeetExtractPhase()` — "baixado" nunca se apresenta como
 * "pronto": enquanto o pacote não está extraído o estado é `downloaded` ou
 * `extracting`, e é isso que o `voice:status` publica.
 */
export function ensureParakeetExtracted(): Promise<void> {
  if (isParakeetReady()) return Promise.resolve()
  if (extractInFlight) return extractInFlight

  const def = getSttModel(PARAKEET_ID)
  if (!def) return Promise.reject(new Error('o modelo do Parakeet não está no catálogo'))

  extractInFlight = (async () => {
    if (!fileComplete(def)) {
      throw new Error(`o pacote do Parakeet ainda não foi baixado (${def.bytes} bytes em <userData>/voice/models/${PARAKEET_ID})`)
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
        throw new Error(`o pacote não trouxe ${PARAKEET_FILES.join(', ')}`)
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
