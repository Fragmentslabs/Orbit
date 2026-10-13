/**
 * Motor de ditado Parakeet TDT 0.6B v3 (NVIDIA) via `sherpa-onnx-node`.
 *
 * Por que este motor: é o candidato que roda em Windows e Linux (onde não há
 * reconhecedor do sistema em pt-BR) e o `sherpa-onnx-node` é um addon N-API —
 * ABI estável, então o MESMO pacote roda dentro do Electron sem rebuild. Roda
 * na CPU de propósito (tanto que a medição do Mac serve de referência para as
 * outras plataformas).
 *
 * O Parakeet NÃO é um modelo de streaming. O "ao vivo" é montado assim (é o
 * desenho medido no laboratório, `Testes/vozlab/lib/parakeet-stt.js`):
 *   - o Silero VAD fecha um trecho a cada pausa; cada trecho fechado é
 *     transcrito UMA vez e vira texto confirmado;
 *   - o trecho ainda aberto é retranscrito de tempos em tempos e aparece como
 *     provisório — o custo do Parakeet cresce com o áudio, então retranscrever
 *     só o trecho atual é barato;
 *   - ao parar, o VAD fecha o último trecho e só ele falta transcrever (é o que
 *     o push-to-talk espera).
 *
 * Três cuidados que só apareceram medindo no lab (e estão aqui):
 *   1. o trecho do VAD começa DEPOIS do início real da fala, então ele é
 *      transcrito a partir do nosso buffer com 0,4 s de folga antes e 0,25 s
 *      depois — sem isso a primeira palavra some ("Manda mensagem" → "mensagem");
 *   2. o provisório tem freio (intervalo ≥ 2× a duração da última inferência),
 *      senão a CPU fica 100% ocupada retranscrevendo um trecho que cresce;
 *   3. o contexto do recognizer NÃO é reentrante: todas as decodificações de um
 *      mesmo modelo passam por uma fila única.
 */

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  ensureParakeetExtracted,
  isParakeetReady,
  parakeetArchiveComplete,
  parakeetFilesDir,
  PARAKEET_ID,
  sileroVadPath,
  modelsDir,
} from './models-store'
import { PARAKEET_FILES, SILERO_VAD_URL } from './catalog'
import { SampleBuffer, samplesToMs, STT_SAMPLE_RATE } from './audio'
import type { SttEngine, SttEngineStatus, SttHandle, SttStartInput, SttSegment } from './engine'

// ---------------------------------------------------------------------------
// Carregamento do módulo nativo (opcional: o app funciona sem ele, sem o motor)
// ---------------------------------------------------------------------------

interface SherpaStream {
  acceptWaveform(obj: { sampleRate: number; samples: Float32Array }): void
}
interface SherpaRecognizer {
  createStream(): SherpaStream
  decodeAsync(stream: SherpaStream): Promise<{ text?: string }>
}
interface SherpaOfflineRecognizer {
  createAsync(config: Record<string, unknown>): Promise<SherpaRecognizer>
}
interface SherpaSpeechSegment {
  start: number
  samples: Float32Array
}
interface SherpaVad {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  isDetected(): boolean
  front(enableExternalBuffer?: boolean): SherpaSpeechSegment
  pop(): void
  flush(): void
}
interface SherpaModule {
  OfflineRecognizer: SherpaOfflineRecognizer
  Vad: new (config: Record<string, unknown>, bufferSizeInSeconds: number) => SherpaVad
}

const _require = createRequire(import.meta.url)
let sherpa: SherpaModule | null = null
let loadError: string | null = null
try {
  sherpa = _require('sherpa-onnx-node') as SherpaModule
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
}

const RATE = STT_SAMPLE_RATE
const ENGINE_ID = 'parakeet'
const ENGINE_LABEL = 'Parakeet (sherpa-onnx, CPU)'
const DEFAULT_MODEL_ID = PARAKEET_ID
const THREADS = [2, 4, 8]
const DEFAULT_THREADS = 4

const VAD_WINDOW = 512 // o Silero quer janelas de exatamente 512 amostras a 16 kHz
const TAIL_EVERY_SAMPLES = RATE / 2 // retranscreve o trecho aberto a cada ~0,5 s...
const TAIL_DUTY = 2 // ...ou a cada 2× o tempo da última retranscrição, o que for maior
const TAIL_MAX_SAMPLES = RATE * 20
// Folgas do trecho confirmado (o VAD atrasa o início da fala em ~0,25 s).
const SEG_PREROLL = Math.round(RATE * 0.4)
const SEG_POSTROLL = Math.round(RATE * 0.25)
const STOP_TIMEOUT_MS = 20_000

// ---------------------------------------------------------------------------
// Recognizer: um carregado por nº de threads, aquecido, com fila única
// ---------------------------------------------------------------------------

interface RecognizerEntry {
  threads: number
  promise: Promise<SherpaRecognizer>
  loadMs: number | null
  error: string | null
}

let recognizerEntry: RecognizerEntry | null = null

/** Fila única do recognizer: o contexto não é reentrante (medido no lab). */
let decodeChain: Promise<unknown> = Promise.resolve()
function withRecognizer<T>(fn: () => Promise<T>): Promise<T> {
  const run = decodeChain.then(fn, fn)
  decodeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function recognizerConfig(threads: number): Record<string, unknown> {
  const dir = parakeetFilesDir()
  return {
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(dir, 'encoder.int8.onnx'),
        decoder: path.join(dir, 'decoder.int8.onnx'),
        joiner: path.join(dir, 'joiner.int8.onnx'),
      },
      tokens: path.join(dir, 'tokens.txt'),
      modelType: 'nemo_transducer',
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
    },
  }
}

function warmRecognizer(threads: number): Promise<SherpaRecognizer> {
  const mod = sherpa
  if (!mod) throw new Error(`sherpa-onnx-node não está disponível: ${loadError}`)
  if (recognizerEntry && recognizerEntry.threads === threads && !recognizerEntry.error) {
    return recognizerEntry.promise
  }
  const t0 = Date.now()
  let loadMs: number | null = null
  const promise = (async () => {
    const rec = await mod.OfflineRecognizer.createAsync(recognizerConfig(threads))
    // A 1ª inferência inicializa o ONNX Runtime: paga aqui, não na fala do usuário.
    const stream = rec.createStream()
    stream.acceptWaveform({ sampleRate: RATE, samples: new Float32Array(RATE) })
    await rec.decodeAsync(stream)
    loadMs = Date.now() - t0
    return rec
  })()
  const entry: RecognizerEntry = { threads, promise, loadMs: null, error: null }
  promise.then(
    () => {
      entry.loadMs = loadMs
    },
    (err: unknown) => {
      entry.error = err instanceof Error ? err.message : String(err)
    },
  )
  recognizerEntry = entry
  return promise
}

/**
 * Aquece o recognizer SEM abrir sessão: extrai o pacote (se preciso) e carrega
 * o modelo, incluindo a primeira inferência que inicializa o ONNX Runtime.
 *
 * É o que tira o carregamento do caminho do usuário — sem isto, prender o
 * microfone pela primeira vez fica esperando centenas de MB serem lidos, com o
 * botão vermelho. Idempotente (o `warmRecognizer` devolve a promessa já em voo)
 * e silencioso: erro de carga não vira exceção, fica registrado e aparece no
 * `status()`.
 */
export async function warm(modelId?: string | null, threads = DEFAULT_THREADS): Promise<void> {
  if (modelId && modelId !== DEFAULT_MODEL_ID) return
  try {
    await ensureParakeetExtracted()
    await warmRecognizer(THREADS.includes(threads) ? threads : DEFAULT_THREADS)
  } catch {
    // sem motor ou carga falhou: o motivo já está no `status()`
  }
}

/**
 * Solta o recognizer carregado (a fachada chama quando o ditado fica ocioso).
 * O próximo `warm`/`start` carrega de novo — é o que impede o modelo de centenas
 * de MB de ficar residente a sessão inteira.
 */
export function release(): void {
  recognizerEntry = null
}

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------

interface ParakeetSession {
  id: string
  threads: number
  live: boolean
  onPartial: (text: string) => void
  vad: SherpaVad
  buffer: SampleBuffer
  leftover: Float32Array
  commitPos: number
  gen: number
  confirmed: string[]
  provisional: string
  lastView: [string, string]
  chain: Promise<unknown>
  tailQueued: boolean
  lastTailAt: number
  lastTailMs: number
  stopping: boolean
  cancelled: boolean
  segments: number
  /** Trechos confirmados com a posição no áudio — os tempos da transcrição. */
  timed: SttSegment[]
}

/** Enfileira trabalho na sessão: nunca em paralelo, nunca fora de ordem. */
function enqueue(s: ParakeetSession, fn: () => Promise<void>): Promise<void> {
  const run = s.chain.then(fn, fn)
  s.chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function decode(s: ParakeetSession, samples: Float32Array): Promise<string> {
  const rec = await warmRecognizer(s.threads)
  return withRecognizer(async () => {
    const stream = rec.createStream()
    stream.acceptWaveform({ sampleRate: RATE, samples })
    const r = await rec.decodeAsync(stream)
    return String(r.text || '').trim()
  })
}

/** Publica o texto ao vivo: confirmado + provisório, só quando muda. */
function publish(s: ParakeetSession): void {
  // Sem prévia ao vivo, quem chamou não quer callback nenhum — nem no fim.
  if (!s.live) return
  const confirmed = s.confirmed.filter(Boolean).join(' ')
  const provisional = s.provisional
  if (confirmed === s.lastView[0] && provisional === s.lastView[1]) return
  s.lastView = [confirmed, provisional]
  const text = [confirmed, provisional].filter(Boolean).join(' ').trim()
  try {
    s.onPartial(text)
  } catch {
    // o callback é do chamador; um erro nele não pode derrubar a sessão
  }
}

/** Trecho fechado pelo VAD: transcreve uma vez (com as folgas) e confirma. */
function commitSegment(s: ParakeetSession, seg: SherpaSpeechSegment): void {
  const from = Math.max(s.commitPos, seg.start - SEG_PREROLL)
  const end = Math.min(s.buffer.samples, seg.start + seg.samples.length + SEG_POSTROLL)
  s.commitPos = Math.max(s.commitPos, end)
  s.gen += 1 // invalida retranscrições do trecho aberto que estão em voo
  s.segments += 1
  const samples = s.buffer.slice(from, end)
  void enqueue(s, async () => {
    const text = await decode(s, samples)
    if (s.cancelled) return
    if (text) s.timed.push({ startMs: samplesToMs(from), endMs: samplesToMs(end), text })
    s.confirmed.push(text)
    s.provisional = ''
    publish(s)
  })
}

/** Retranscreve o trecho aberto (provisório); no máximo uma na fila por vez. */
function scheduleTail(s: ParakeetSession): void {
  if (!s.live || s.tailQueued || s.stopping || s.cancelled) return
  // Freio: o trecho aberto cresce e cada retranscrição fica mais cara. Sem isto
  // o clipe de 21 s custou 9,3 s de CPU no lab (44 decodificações).
  const every = Math.max(TAIL_EVERY_SAMPLES, Math.round(s.lastTailMs * TAIL_DUTY * (RATE / 1000)))
  if (s.buffer.samples - s.lastTailAt < every) return
  if (!s.vad.isDetected()) {
    if (s.provisional) {
      s.provisional = ''
      publish(s)
    }
    return
  }
  s.tailQueued = true
  s.lastTailAt = s.buffer.samples
  const gen = s.gen
  void enqueue(s, async () => {
    s.tailQueued = false
    if (s.stopping || s.cancelled || gen !== s.gen) return
    const from = Math.max(s.commitPos, s.buffer.samples - TAIL_MAX_SAMPLES)
    const t0 = Date.now()
    const text = await decode(s, s.buffer.slice(from, s.buffer.samples))
    s.lastTailMs = Date.now() - t0
    if (s.stopping || s.cancelled || gen !== s.gen) return
    s.provisional = text
    publish(s)
  })
}

function drainVad(s: ParakeetSession): void {
  while (!s.vad.isEmpty()) {
    const seg = s.vad.front(false) // cópia: o buffer interno é reaproveitado no pop
    s.vad.pop()
    commitSegment(s, seg)
  }
}

function feedVad(s: ParakeetSession, chunk: Float32Array): void {
  const all = new Float32Array(s.leftover.length + chunk.length)
  all.set(s.leftover)
  all.set(chunk, s.leftover.length)
  let off = 0
  for (; off + VAD_WINDOW <= all.length; off += VAD_WINDOW) {
    s.vad.acceptWaveform(all.subarray(off, off + VAD_WINDOW))
  }
  s.leftover = all.slice(off)
}

/**
 * Estado do motor.
 *
 * `available` = dá para abrir uma sessão agora: o módulo carregou e o pacote do
 * modelo está no disco (a extração e o VAD, que o motor resolve no primeiro
 * uso, não tiram de `available` — só de `installed`).
 * `installed` = já extraído e com o VAD: nada a preparar antes de falar.
 */
async function status(): Promise<SttEngineStatus> {
  const archive = parakeetArchiveComplete()
  const ready = isParakeetReady()
  const models = {
    defaultModelId: DEFAULT_MODEL_ID,
    archive,
    ready,
    dir: modelsDir(),
    files: PARAKEET_FILES,
    vad: sileroVadPath(),
    vadUrl: SILERO_VAD_URL,
  }
  if (!sherpa) {
    return {
      engine: ENGINE_ID,
      available: false,
      installed: ready,
      reason: `o módulo sherpa-onnx-node não carregou: ${loadError}`,
      detail: models,
    }
  }
  if (!archive && !ready) {
    return {
      engine: ENGINE_ID,
      available: false,
      installed: false,
      reason: `o pacote do Parakeet ainda não foi baixado (~487 MB em <userData>/voice/models/${DEFAULT_MODEL_ID})`,
      detail: { ...models, threads: THREADS, defaultThreads: DEFAULT_THREADS },
    }
  }
  return {
    engine: ENGINE_ID,
    available: true,
    installed: ready,
    // "Baixado" não é "pronto": o pacote precisa ser extraído e o VAD Silero
    // baixado. Isto agora começa sozinho ao fim do download (ver status.ts), e o
    // estado fino de cada modelo (com o motivo) é o `voice:status`.
    reason: ready
      ? undefined
      : 'o pacote está baixado; a extração (e o VAD Silero) ainda não terminou',
    detail: {
      ...models,
      threads: THREADS,
      defaultThreads: DEFAULT_THREADS,
      loaded: recognizerEntry
        ? { threads: recognizerEntry.threads, loadMs: recognizerEntry.loadMs, error: recognizerEntry.error }
        : null,
    },
  }
}

async function start(input: SttStartInput, onPartial: (text: string) => void): Promise<SttHandle> {
  const st = await status()
  if (!st.available) throw new Error(st.reason || 'o motor Parakeet não está disponível')
  const mod = sherpa
  if (!mod) throw new Error(`sherpa-onnx-node não está disponível: ${loadError}`)

  const modelId = input.modelId || DEFAULT_MODEL_ID
  if (modelId !== DEFAULT_MODEL_ID) {
    throw new Error(`o motor Parakeet só tem o modelo "${DEFAULT_MODEL_ID}" (recebido "${modelId}")`)
  }
  const threads = input.threads ?? DEFAULT_THREADS
  if (!THREADS.includes(threads)) {
    throw new Error(`threads inválido para o Parakeet: ${threads} (use ${THREADS.join(', ')})`)
  }

  // Extrai o pacote (se preciso) e AQUEÇE antes de abrir a sessão: qualquer erro
  // de preparo sai no start, não no meio da fala do usuário.
  await ensureParakeetExtracted()
  await warmRecognizer(threads)

  const s: ParakeetSession = {
    id: randomUUID(),
    threads,
    live: input.live,
    onPartial,
    vad: new mod.Vad(
      {
        sileroVad: {
          model: sileroVadPath(),
          threshold: 0.5,
          minSilenceDuration: 0.5,
          minSpeechDuration: 0.25,
          windowSize: VAD_WINDOW,
          maxSpeechDuration: 15,
        },
        sampleRate: RATE,
        numThreads: 1,
        provider: 'cpu',
        debug: false,
      },
      60,
    ),
    buffer: new SampleBuffer(),
    leftover: new Float32Array(0),
    commitPos: 0,
    gen: 0,
    confirmed: [],
    provisional: '',
    lastView: ['', ''],
    chain: Promise.resolve(),
    tailQueued: false,
    lastTailAt: 0,
    lastTailMs: 0,
    stopping: false,
    cancelled: false,
    segments: 0,
    timed: [],
  }

  return {
    pushAudio(samples: Float32Array): void {
      if (s.stopping || s.cancelled) return
      s.buffer.push(samples)
      feedVad(s, samples)
      drainVad(s)
      scheduleTail(s)
    },

    async stop(): Promise<{ text: string; audioMs: number; segments: SttSegment[] }> {
      s.stopping = true
      s.gen += 1 // descarta provisório em voo
      // Fecha o resto do buffer no VAD para o último trecho virar confirmado.
      if (s.leftover.length) {
        const pad = new Float32Array(VAD_WINDOW)
        pad.set(s.leftover)
        s.vad.acceptWaveform(pad)
        s.leftover = new Float32Array(0)
      }
      s.vad.flush()
      drainVad(s)
      // O VAD não viu fala nenhuma (sussurro, fala curtíssima): transcreve tudo.
      if (s.segments === 0 && s.buffer.samples >= RATE * 0.3) {
        const all = s.buffer.slice(0, s.buffer.samples)
        void enqueue(s, async () => {
          const text = await decode(s, all)
          if (text) s.timed.push({ startMs: 0, endMs: samplesToMs(all.length), text })
          s.confirmed.push(text)
        })
      }

      const timedOut = await Promise.race([
        s.chain.then(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(true), STOP_TIMEOUT_MS)),
      ])
      s.provisional = ''
      s.lastView = ['', '']
      publish(s)
      if (timedOut) throw new Error(`a transcrição não terminou em ${STOP_TIMEOUT_MS / 1000} s`)
      return { text: s.confirmed.filter(Boolean).join(' '), audioMs: samplesToMs(s.buffer.samples), segments: s.timed }
    },

    async cancel(): Promise<void> {
      s.cancelled = true
      s.stopping = true
      s.gen += 1
      s.confirmed = []
      s.provisional = ''
    },
  }
}

export const parakeetEngine: SttEngine = {
  id: ENGINE_ID,
  label: ENGINE_LABEL,
  defaultModelId: DEFAULT_MODEL_ID,
  status,
  start,
}
