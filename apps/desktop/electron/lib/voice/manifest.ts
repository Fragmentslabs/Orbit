import type { VoiceModelInfo } from "@shared/voice"
import { STT_MODELS } from "./stt"

/**
 * Manifest of the downloadable voice models.
 *
 * The WEIGHTS never enter the build: here there are only the origin, the size and the hash, and the
 * downloader (download.ts) brings the files to `<userData>/voice/models/<id>`
 * the first time the user asks for them.
 *
 * The TTS is Supertonic 3, from the ARCHIVED `supertone-oss-archive/supertonic-3`
 * repository on HuggingFace, at the revision pinned below (changing the revision changes the bytes and the
 * sha256 here — the four .onnx files are LFS, so HF's `x-linked-etag` is the
 * sha256 of the file, checked byte by byte against what the laboratory downloaded).
 *
 * Licence: the engine CODE (voice-engine/helper.js) is MIT and ships with the app;
 * the WEIGHTS are OpenRAIL-M and are downloaded by the user, never redistributed.
 */

/** Origin repository and revision of the TTS assets. */
const REPO = "https://huggingface.co/supertone-oss-archive/supertonic-3"
const REVISION = "aafc6e32416a594460b32413efc49d7fe4ce6d46"

/** TTS model id — it is the folder name in `<userData>/voice/models`. */
export const TTS_MODEL_ID = "supertonic-3"

/** Engine output format: mono, 16-bit PCM. The rate is this one, always. */
export const TTS_SAMPLE_RATE = 24000
/** Native rate of the models (the engine resamples to TTS_SAMPLE_RATE). */
export const TTS_NATIVE_SAMPLE_RATE = 44100
/** Denoising steps: 8 is the upstream default; 10 is more quality and slower. */
export const TTS_STEPS = 8
/** Target characters per chunk in streaming (the real cut is at end of sentence). */
export const TTS_MAX_CHARS = 140
/** Join silence between chunks, the same as the engine's `call()` (0.3 s). */
export const TTS_JOIN_SILENCE_MS = 300

/** A file of the TTS package, relative to the model folder. */
export interface TtsAssetFile {
  path: string
  bytes: number
  /** Only the .onnx files (LFS) publish a sha256 at the origin. */
  sha256?: string
}

/**
 * The 16 files of Supertonic 3 (~401 MB). The sizes and the sha256 came from the
 * laboratory's reference download; the downloader uses both to decide
 * whether a file is already intact on disk.
 */
export const TTS_ASSETS: TtsAssetFile[] = [
  { path: "onnx/vector_estimator.onnx", bytes: 256534781, sha256: "883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c" },
  { path: "onnx/vocoder.onnx", bytes: 101424195, sha256: "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba" },
  { path: "onnx/text_encoder.onnx", bytes: 36416150, sha256: "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff" },
  { path: "onnx/duration_predictor.onnx", bytes: 3700147, sha256: "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db" },
  { path: "onnx/unicode_indexer.json", bytes: 277676 },
  { path: "onnx/tts.json", bytes: 8253 },
  { path: "voice_styles/F1.json", bytes: 292046 },
  { path: "voice_styles/F2.json", bytes: 292423 },
  { path: "voice_styles/F3.json", bytes: 290794 },
  { path: "voice_styles/F4.json", bytes: 291808 },
  { path: "voice_styles/F5.json", bytes: 291479 },
  { path: "voice_styles/M1.json", bytes: 291748 },
  { path: "voice_styles/M2.json", bytes: 292055 },
  { path: "voice_styles/M3.json", bytes: 290198 },
  { path: "voice_styles/M4.json", bytes: 291522 },
  { path: "voice_styles/M5.json", bytes: 291469 },
]

/** Total size of the TTS package (the number the UI shows before downloading). */
export const TTS_BYTES = TTS_ASSETS.reduce((sum, file) => sum + file.bytes, 0)

/** Supertonic 3 voices — each one speaks the 31 languages (it is not per language). */
export const TTS_VOICES: { id: string; label: string }[] = [
  { id: "M1", label: "Masculina animada e confiante (narração, institucional)" },
  { id: "M2", label: "Masculina grave e robusta (corporativo, documentário)" },
  { id: "M3", label: "Masculina polida e autoritária (apresentações, negócios)" },
  { id: "M4", label: "Masculina neutra e suave (educacional, explicadores)" },
  { id: "M5", label: "Masculina calorosa, sussurrada (audiolivros)" },
  { id: "F1", label: "Feminina calma, tom levemente grave (atendimento)" },
  { id: "F2", label: "Feminina brilhante e animada, jovial (conteúdo jovem, ads)" },
  { id: "F3", label: "Feminina estilo locutora (comerciais, notícias)" },
  { id: "F4", label: "Feminina nítida e confiante, expressiva (treinamento)" },
  { id: "F5", label: "Feminina gentil e suave, calmante (bem-estar)" },
]

/** The 31 languages of the weights + `na` (agnostic mode). `pt` is verified. */
export const TTS_LANGS: string[] = [
  "ar", "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "hi", "hr",
  "hu", "id", "it", "ja", "ko", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk",
  "sl", "sv", "tr", "uk", "vi", "na",
]

/**
 * The TTS-side catalog. One model, one entry: the whole package is what
 * gets downloaded or deleted (downloading a single .onnx synthesises nothing). The `url` is
 * the revision page at the origin — the real download uses TTS_ASSETS, file by
 * file, with resumption.
 */
export const TTS_MODELS: VoiceModelInfo[] = [
  {
    id: TTS_MODEL_ID,
    kind: "tts",
    engine: "supertonic",
    label: "Supertonic 3 (TTS local, CPU) — 4 redes ONNX + 10 vozes, 31 idiomas",
    bytes: TTS_BYTES,
    url: `${REPO}/tree/${REVISION}`,
    langs: TTS_LANGS,
  },
]

/** Full catalog: TTS + the STT models (defined by the STT worker). */
export const VOICE_MODELS: VoiceModelInfo[] = [...TTS_MODELS, ...STT_MODELS]

/** URL of a TTS package file, at the pinned revision. */
export function ttsAssetUrl(path: string): string {
  return `${REPO}/resolve/${REVISION}/${path}`
}

/** Information of a catalog id (null when the id does not exist). */
export function modelInfo(modelId: string): VoiceModelInfo | null {
  return VOICE_MODELS.find((model) => model.id === modelId) ?? null
}

/** Catalog STT models (the downloader treats TTS and STT alike). */
export function isTtsModel(modelId: string): boolean {
  return modelId === TTS_MODEL_ID
}
