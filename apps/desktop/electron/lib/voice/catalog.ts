/**
 * Catálogo dos modelos de ditado (STT).
 *
 * É a fonte do `STT_MODELS` (a lista que `manifest.ts` junta à do TTS e que o
 * downloader do núcleo consome): `bytes` é o tamanho EXATO do arquivo na origem
 * e `url` é o arquivo direto — o downloader do núcleo deriva o nome do arquivo
 * do último segmento da URL e só considera o modelo instalado quando o tamanho
 * bate byte a byte. Por isso os números aqui não são estimativas: foram medidos
 * com `curl -I` nas URLs (content-length / `x-linked-size`, e o `x-linked-etag`
 * do HuggingFace é o sha256 conferido pelo downloader).
 *
 * Nada disto vai no repo nem no build: cada modelo é baixado sob demanda para
 * `<userData>/voice/models/<id>/`.
 *
 * O Parakeet é o único caso de PACOTE: a origem publica um `.tar.bz2` com os
 * quatro arquivos int8, e a extração (que o downloader do núcleo não faz para
 * STT) acontece no primeiro uso, dentro do próprio motor — ver `parakeet.ts`.
 */

export type SttEngineKind = 'whisper' | 'parakeet'

export interface SttModelDef {
  id: string
  label: string
  engine: SttEngineKind
  /** Tamanho exato do download, em bytes. */
  bytes: number
  /** Arquivo direto na origem (para o Parakeet, o pacote .tar.bz2). */
  url: string
  /** sha256 publicado pela origem (LFS do HuggingFace); ausente = não verificado. */
  sha256?: string
  /** Idiomas que a UI pode oferecer ("auto" = o motor detecta sozinho). */
  langs: string[]
  /** Perfil de uso, em uma linha (compõe o rótulo da UI). */
  note: string
  /** Precisa extrair o pacote antes de usar (Parakeet). */
  archive?: boolean
}

const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'
const SHERPA_ASR = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/'

/** Diretório/arquivo do pacote do Parakeet no release do sherpa-onnx. */
export const PARAKEET_DIR = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
/** Subpasta onde os arquivos extraídos ficam (dentro de `<models>/<id>/`). */
export const PARAKEET_EXTRACT_DIR = 'model'
/** Arquivos que provam que o Parakeet foi extraído por inteiro. */
export const PARAKEET_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']

/** VAD Silero (fatia o áudio do Parakeet) — arquivo solto, compartilhado. */
export const SILERO_VAD_FILE = 'silero_vad.onnx'
export const SILERO_VAD_URL = `${SHERPA_ASR}${SILERO_VAD_FILE}`
export const SILERO_VAD_BYTES = 643854

/** Idiomas do Parakeet v3 (25 línguas europeias; ele detecta sozinho). */
const PARAKEET_LANGS = ['pt', 'auto', 'en', 'es', 'fr', 'de', 'it']

/** Idiomas oferecidos para os modelos multilíngues do whisper. */
const WHISPER_LANGS = ['pt', 'auto', 'en', 'es', 'fr', 'de', 'it', 'ja', 'zh']

export const STT_MODEL_DEFS: SttModelDef[] = [
  {
    id: 'whisper-tiny',
    label: 'Whisper tiny (whisper.cpp) — 78 MB, o mais rápido e o menos preciso',
    engine: 'whisper',
    bytes: 77691713,
    url: `${HF_WHISPER}ggml-tiny.bin`,
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
    langs: WHISPER_LANGS,
    note: 'o mais rápido; menor precisão',
  },
  {
    id: 'whisper-base',
    label: 'Whisper base (whisper.cpp) — 148 MB, equilíbrio entre tempo e precisão',
    engine: 'whisper',
    bytes: 147951465,
    url: `${HF_WHISPER}ggml-base.bin`,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    langs: WHISPER_LANGS,
    note: 'equilíbrio inicial',
  },
  {
    id: 'whisper-small',
    label: 'Whisper small (whisper.cpp) — 488 MB, boa precisão em pt-BR',
    engine: 'whisper',
    bytes: 487601967,
    url: `${HF_WHISPER}ggml-small.bin`,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    langs: WHISPER_LANGS,
    note: 'boa precisão em pt-BR',
  },
  {
    id: 'whisper-medium',
    label: 'Whisper medium (whisper.cpp) — 539 MB, alta precisão (quantizado q5_0)',
    engine: 'whisper',
    bytes: 539212467,
    url: `${HF_WHISPER}ggml-medium-q5_0.bin`,
    sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f',
    langs: WHISPER_LANGS,
    note: 'alta precisão (quantizado q5_0)',
  },
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper large-v3-turbo (whisper.cpp) — 574 MB, o mais preciso (turbo q5_0)',
    engine: 'whisper',
    bytes: 574041195,
    url: `${HF_WHISPER}ggml-large-v3-turbo-q5_0.bin`,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    langs: WHISPER_LANGS,
    note: 'melhor precisão (turbo, quantizado q5_0)',
  },
  {
    id: 'parakeet-tdt-0.6b-v3',
    label: 'Parakeet TDT 0.6B v3 (sherpa-onnx, CPU) — 487 MB, 25 línguas europeias, detecta o idioma',
    engine: 'parakeet',
    bytes: 487170055,
    url: `${SHERPA_ASR}${PARAKEET_DIR}.tar.bz2`,
    langs: PARAKEET_LANGS,
    note: 'CPU, 25 línguas europeias, detecta o idioma sozinho',
    archive: true,
  },
]

/**
 * Whisper que cabe na máquina: o small (boa precisão em pt-BR, ~0,5 GB) e,
 * abaixo de 7 GB de RAM, o base. É a regra da recomendação (`hardware.ts`) e do
 * "Automático" do motor (`whisper.ts`) — uma só, para os dois não divergirem.
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

/** Nome do arquivo baixado: o último segmento da URL (mesma regra do downloader). */
export function fileNameOf(def: SttModelDef): string {
  const tail = decodeURIComponent(def.url.split('?')[0].split('/').filter(Boolean).pop() ?? '')
  return tail && tail.includes('.') ? tail : `${def.id}.bin`
}
