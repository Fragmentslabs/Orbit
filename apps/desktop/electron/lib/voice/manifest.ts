import type { VoiceModelInfo } from "@shared/voice"
import { STT_MODELS } from "./stt"

/**
 * Manifesto dos modelos de voz baixáveis.
 *
 * O PESO nunca entra no build: aqui só ficam a origem, o tamanho e o hash, e o
 * downloader (download.ts) traz os arquivos para `<userData>/voice/models/<id>`
 * na primeira vez que o usuário pede.
 *
 * O TTS é o Supertonic 3, do repositório ARQUIVADO `supertone-oss-archive/supertonic-3`
 * no HuggingFace, na revisão fixada abaixo (mudar a revisão muda os bytes e os
 * sha256 daqui — os quatro .onnx são LFS, então o `x-linked-etag` do HF é o
 * sha256 do arquivo, conferido byte a byte com o que o laboratório baixou).
 *
 * Licença: o CÓDIGO do motor (voice-engine/helper.js) é MIT e vai junto no app;
 * os PESOS são OpenRAIL-M e são baixados pelo usuário, nunca redistribuídos.
 */

/** Repositório e revisão de origem dos assets do TTS. */
const REPO = "https://huggingface.co/supertone-oss-archive/supertonic-3"
const REVISION = "aafc6e32416a594460b32413efc49d7fe4ce6d46"

/** id do modelo de TTS — é o nome da pasta em `<userData>/voice/models`. */
export const TTS_MODEL_ID = "supertonic-3"

/** Formato de saída do motor: mono, PCM 16-bit. A taxa é esta, sempre. */
export const TTS_SAMPLE_RATE = 24000
/** Taxa nativa dos modelos (o motor reamostra para TTS_SAMPLE_RATE). */
export const TTS_NATIVE_SAMPLE_RATE = 44100
/** Passos de denoising: 8 é o padrão do upstream; 10 é mais qualidade e mais lento. */
export const TTS_STEPS = 8
/** Alvo de caracteres por pedaço no streaming (o corte real é em fim de frase). */
export const TTS_MAX_CHARS = 140
/** Silêncio de ligação entre pedaços, igual ao `call()` do motor (0,3 s). */
export const TTS_JOIN_SILENCE_MS = 300

/** Um arquivo do pacote do TTS, relativo à pasta do modelo. */
export interface TtsAssetFile {
  path: string
  bytes: number
  /** Só os .onnx (LFS) publicam sha256 na origem. */
  sha256?: string
}

/**
 * Os 16 arquivos do Supertonic 3 (~401 MB). Os tamanhos e os sha256 vieram do
 * download de referência do laboratório; o downloader usa os dois para decidir
 * se um arquivo já está íntegro no disco.
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

/** Tamanho total do pacote do TTS (o número que a UI mostra antes de baixar). */
export const TTS_BYTES = TTS_ASSETS.reduce((sum, file) => sum + file.bytes, 0)

/** Vozes do Supertonic 3 — cada uma fala os 31 idiomas (não é por idioma). */
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

/** Os 31 idiomas dos pesos + `na` (modo agnóstico). `pt` é verificado. */
export const TTS_LANGS: string[] = [
  "ar", "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "hi", "hr",
  "hu", "id", "it", "ja", "ko", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk",
  "sl", "sv", "tr", "uk", "vi", "na",
]

/**
 * O catálogo do lado do TTS. Um modelo, uma entrada: o pacote inteiro é o que
 * se baixa ou se apaga (baixar um .onnx sozinho não sintetiza nada). A `url` é
 * a página da revisão na origem — o download real usa TTS_ASSETS, arquivo a
 * arquivo, com retomada.
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

/** Catálogo completo: TTS + os modelos de STT (definidos pelo worker de STT). */
export const VOICE_MODELS: VoiceModelInfo[] = [...TTS_MODELS, ...STT_MODELS]

/** URL de um arquivo do pacote do TTS, na revisão fixada. */
export function ttsAssetUrl(path: string): string {
  return `${REPO}/resolve/${REVISION}/${path}`
}

/** Informação de um id do catálogo (null quando o id não existe). */
export function modelInfo(modelId: string): VoiceModelInfo | null {
  return VOICE_MODELS.find((model) => model.id === modelId) ?? null
}

/** Modelos de STT do catálogo (o downloader trata TTS e STT igual). */
export function isTtsModel(modelId: string): boolean {
  return modelId === TTS_MODEL_ID
}
