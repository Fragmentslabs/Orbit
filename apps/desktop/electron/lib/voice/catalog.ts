/**
 * Catalog of the dictation models (STT).
 *
 * It is the source of `STT_MODELS` (the list `manifest.ts` joins with the TTS one and that the
 * core downloader consumes): `bytes` is the EXACT size of the file at the origin
 * and `url` is the file directly — the core downloader derives the file name
 * from the last segment of the URL and only considers the model installed when the size
 * matches byte for byte. That is why the numbers here are not estimates: they were measured
 * with `curl -I` on the URLs (content-length / `x-linked-size`, and HuggingFace's
 * `x-linked-etag` is the sha256 checked by the downloader).
 *
 * None of this goes into the repo or the build: each model is downloaded on demand to
 * `<userData>/voice/models/<id>/`.
 *
 * Parakeet is the only PACKAGE case: the origin publishes a `.tar.bz2` with the
 * four int8 files, and the extraction (which the core downloader does not do for
 * STT) happens on first use, inside the engine itself — see `parakeet.ts`.
 */

export type SttEngineKind = 'whisper' | 'parakeet'

export interface SttModelDef {
  id: string
  label: string
  engine: SttEngineKind
  /** Exact download size, in bytes. */
  bytes: number
  /** File directly at the origin (for Parakeet, the .tar.bz2 package). */
  url: string
  /** sha256 published by the origin (HuggingFace LFS); absent = not verified. */
  sha256?: string
  /** Languages the UI can offer ("auto" = the engine detects it by itself). */
  langs: string[]
  /** Usage profile, in one line (it makes up the UI label). */
  note: string
  /** Needs the package extracted before use (Parakeet). */
  archive?: boolean
}

const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'
const SHERPA_ASR = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/'

/** Directory/file of the Parakeet package in the sherpa-onnx release. */
export const PARAKEET_DIR = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
/** Subfolder where the extracted files live (inside `<models>/<id>/`). */
export const PARAKEET_EXTRACT_DIR = 'model'
/** Files that prove Parakeet was fully extracted. */
export const PARAKEET_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']

/** Silero VAD (slices Parakeet's audio) — a standalone, shared file. */
export const SILERO_VAD_FILE = 'silero_vad.onnx'
export const SILERO_VAD_URL = `${SHERPA_ASR}${SILERO_VAD_FILE}`
export const SILERO_VAD_BYTES = 643854

/** Parakeet v3 languages (25 European languages; it detects by itself). */
const PARAKEET_LANGS = ['pt', 'auto', 'en', 'es', 'fr', 'de', 'it']

/** Languages offered for the whisper multilingual models. */
const WHISPER_LANGS = ['pt', 'auto', 'en', 'es', 'fr', 'de', 'it', 'ja', 'zh']

export const STT_MODEL_DEFS: SttModelDef[] = [
  {
    id: 'whisper-tiny',
    label: 'Whisper tiny (whisper.cpp) — 78 MB, the fastest and the least accurate',
    engine: 'whisper',
    bytes: 77691713,
    url: `${HF_WHISPER}ggml-tiny.bin`,
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
    langs: WHISPER_LANGS,
    note: 'fastest; lowest accuracy',
  },
  {
    id: 'whisper-base',
    label: 'Whisper base (whisper.cpp) — 148 MB, balance between speed and accuracy',
    engine: 'whisper',
    bytes: 147951465,
    url: `${HF_WHISPER}ggml-base.bin`,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    langs: WHISPER_LANGS,
    note: 'starting balance',
  },
  {
    id: 'whisper-small',
    label: 'Whisper small (whisper.cpp) — 488 MB, good accuracy beyond English',
    engine: 'whisper',
    bytes: 487601967,
    url: `${HF_WHISPER}ggml-small.bin`,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    langs: WHISPER_LANGS,
    note: 'good accuracy beyond English',
  },
  {
    id: 'whisper-medium',
    label: 'Whisper medium (whisper.cpp) — 539 MB, high accuracy (quantized q5_0)',
    engine: 'whisper',
    bytes: 539212467,
    url: `${HF_WHISPER}ggml-medium-q5_0.bin`,
    sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f',
    langs: WHISPER_LANGS,
    note: 'high accuracy (quantized q5_0)',
  },
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper large-v3-turbo (whisper.cpp) — 574 MB, the most accurate (turbo q5_0)',
    engine: 'whisper',
    bytes: 574041195,
    url: `${HF_WHISPER}ggml-large-v3-turbo-q5_0.bin`,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    langs: WHISPER_LANGS,
    note: 'best accuracy (turbo, quantized q5_0)',
  },
  {
    id: 'parakeet-tdt-0.6b-v3',
    label: 'Parakeet TDT 0.6B v3 (sherpa-onnx, CPU) — 487 MB, 25 European languages, detects the language',
    engine: 'parakeet',
    bytes: 487170055,
    url: `${SHERPA_ASR}${PARAKEET_DIR}.tar.bz2`,
    langs: PARAKEET_LANGS,
    note: 'CPU, 25 European languages, detects the language by itself',
    archive: true,
  },
]

/**
 * Whisper that fits the machine: the small one (good accuracy beyond English, ~0.5 GB) and,
 * below 7 GB of RAM, the base one. It is the rule of the recommendation (`hardware.ts`) and of the
 * engine's "Automatic" (`whisper.ts`) — a single one, so the two do not diverge.
 */
export function preferredWhisperModelId(totalMemGb: number): string {
  return totalMemGb >= 7 ? 'whisper-small' : 'whisper-base'
}

export function getSttModel(id: string | null | undefined): SttModelDef | null {
  if (!id) return null
  return STT_MODEL_DEFS.find((m) => m.id === id) || null
}

export function modelsForEngine(engine: SttEngineKind): SttModelDef[] {
  return STT_MODEL_DEFS.filter((m) => m.engine === engine)
}

/** Name of the downloaded file: the last segment of the URL (same rule as the downloader). */
export function fileNameOf(def: SttModelDef): string {
  const tail = decodeURIComponent(def.url.split('?')[0].split('/').filter(Boolean).pop() ?? '')
  return tail && tail.includes('.') ? tail : `${def.id}.bin`
}
