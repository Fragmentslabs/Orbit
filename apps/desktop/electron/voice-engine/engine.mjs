/**
 * Motor de TTS do Orbit: processo filho do main (utilityProcess) que roda o
 * Supertonic 3 (ONNX Runtime, CPU) e devolve o áudio EM PEDAÇOS.
 *
 * Por que um processo separado: a inferência é CPU-bound e segura o thread do
 * Node durante segundos — no main isso congelaria janelas e IPC. Aqui ela vive
 * num processo que pode ser morto (por ociosidade) e cujo pico de memória
 * (~1 GB) não é o do app.
 *
 * Protocolo com o main (lib/voice/tts.ts): mensagens por `process.parentPort`
 * — o `utilityProcess.fork` do Electron NÃO aceita stdin como pipe, então o
 * canal é o MessagePort, com o mesmo formato de mensagem do laboratório:
 *
 *   entrada:  { id, cmd: "speak", text, voice?, lang?, speed?, steps?, maxChars? }
 *             { cmd: "status" } | { cmd: "cancel", id } | { cmd: "shutdown" }
 *   saída:    { type: "ready", sr, nativeSr, voices, languages, bootMs }
 *             { type: "status", ... } | { type: "error", message }
 *             { id, start: true, pieces, sr, voice, lang }
 *             { id, i, n, text, sr, audioMs, synthMs, firstMs, pcm: <base64 PCM16> }
 *             { id, done: true, pieces, synthMs, audioMs, wallMs, rtf }
 *             { id, done: true, error: "..." }        (falhou no meio)
 *
 * Uso: utilityProcess.fork("engine.mjs", ["--assets", "<pasta com onnx/ voice_styles/>"])
 */

import fs from "fs"
import path from "path"
import { loadTextToSpeech, loadVoiceStyle } from "./helper.js"

// ------------------------------------------------------------------ argumentos
function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao
}

const ASSETS_DIR = arg("assets", process.env.ORBIT_VOICE_ASSETS || "")
const ONNX_DIR = path.join(ASSETS_DIR, "onnx")
const STYLES_DIR = path.join(ASSETS_DIR, "voice_styles")

const NATIVE_SAMPLE_RATE = 44100 // taxa nativa dos modelos Supertonic 3
const SAMPLE_RATE = Number(arg("sample-rate", 24000)) // taxa do PCM entregue
const STEPS = Number(arg("steps", 8)) // 8 = padrão do upstream
const MAX_CHARS = Number(arg("max-chars", 140)) // alvo por pedaço no streaming
const DEFAULT_VOICE = "F2" // voz padrão do Orbit (feminina brilhante)
const DEFAULT_LANG = "pt"
const DEFAULT_SPEED = 1
const VOICE_IDS = ["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"]
const LANGUAGES = [
  "ar", "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "hi", "hr",
  "hu", "id", "it", "ja", "ko", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk",
  "sl", "sv", "tr", "uk", "vi", "na",
]

// Log vai para o stderr: o stdout fica reservado para o protocolo, mas mesmo
// assim o main ignora linhas soltas (a biblioteca nativa do ONNX escreve direto
// no descritor e não dá para interceptar).
const log = (...partes) => {
  try {
    process.stderr.write(partes.map((p) => (typeof p === "string" ? p : String(p))).join(" ") + "\n")
  } catch {
    // stderr fechado (main encerrando): nada a fazer
  }
}
console.log = log
console.info = log
console.warn = log

const parentPort = process.parentPort
const enviar = (msg) => {
  try {
    parentPort.postMessage(msg)
  } catch (err) {
    log("[engine] falha ao enviar mensagem:", err?.message ?? err)
  }
}

// ------------------------------------------------------------------ resampler
/**
 * Reamostragem band-limited (janela de Blackman + sinc, tabela polifásica).
 * 44100 -> 24000 é um fator racional 147/80, resolvido por interpolação direta
 * com kernel de 65 taps e normalização de ganho DC por fase.
 */
const PHASES = 1024
let resampleTable = null
let resampleK = 0

function buildResampleTable(fsIn, fsOut) {
  const ratio = fsIn / fsOut
  const K = Math.ceil(16 * ratio) + 1
  const cutoff = (Math.min(fsIn, fsOut) / 2) * 0.94 // leve guarda anti-alias
  const fc = cutoff / fsIn
  const table = new Float64Array(PHASES * (2 * K + 1))

  for (let p = 0; p < PHASES; p++) {
    const frac = p / PHASES
    let sum = 0
    for (let k = 0; k <= 2 * K; k++) {
      const d = frac + K - k
      const x = 2 * fc * d
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const w = d <= -K || d >= K ? 0 : 0.42 + 0.5 * Math.cos((Math.PI * d) / K) + 0.08 * Math.cos((2 * Math.PI * d) / K)
      const v = 2 * fc * sinc * w
      table[p * (2 * K + 1) + k] = v
      sum += v
    }
    if (sum !== 0) {
      for (let k = 0; k <= 2 * K; k++) table[p * (2 * K + 1) + k] /= sum // ganho DC = 1
    }
  }
  resampleK = K
  resampleTable = table
}

function resample(input, fsIn, fsOut) {
  if (fsIn === fsOut) return input
  if (!resampleTable) buildResampleTable(fsIn, fsOut)
  const K = resampleK
  const taps = 2 * K + 1
  const ratio = fsIn / fsOut
  const nOut = Math.floor((input.length / fsIn) * fsOut)
  const out = new Float32Array(nOut)

  for (let m = 0; m < nOut; m++) {
    const t = m * ratio
    const i0 = Math.floor(t)
    let p = Math.round((t - i0) * PHASES)
    let base = i0
    if (p >= PHASES) {
      p = 0
      base = i0 + 1
    }
    const row = p * taps
    let acc = 0
    for (let k = 0; k < taps; k++) {
      const j = base - K + k
      if (j >= 0 && j < input.length) acc += input[j] * resampleTable[row + k]
    }
    out[m] = acc
  }
  return out
}

/** Float32 -> PCM 16-bit LE cru (no fluxo vão amostras, não um WAV por pedaço). */
function floatToPcm16(samples) {
  const buf = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.floor(s * 32767), i * 2)
  }
  return buf
}

/**
 * Divide o texto em pedaços para a síntese em fluxo.
 *
 * Só corta em FIM DE FRASE — o `call()` do motor insere 0,3 s de silêncio entre
 * os pedaços, então um corte no meio de uma frase criaria uma pausa onde a fala
 * não tem uma. O `maxChars` é um ALVO, não um limite rígido.
 */
function splitForStreaming(text, maxChars = MAX_CHARS) {
  const clean = String(text).replace(/\s+/g, " ").trim()
  if (!clean) return []
  const sentences = clean.match(/[^.!?…]+[.!?…]+[»”’")\]]*(?=\s|$)|[^.!?…]+$/g) || [clean]
  const pieces = []
  let current = ""
  for (const raw of sentences) {
    const sentence = raw.trim()
    if (!sentence) continue
    if (!current) current = sentence
    else if (current.length + 1 + sentence.length <= maxChars) current += " " + sentence
    else {
      pieces.push(current)
      current = sentence
    }
  }
  if (current) pieces.push(current)
  return pieces
}

// -------------------------------------------------------------- estado do motor
let tts = null // modelos ONNX carregados (warm)
const styles = new Map() // id da voz -> Style
let bootMs = 0
let busy = false

/** Serializa a inferência: o Runtime é CPU-bound e o Node é single-thread. */
let chain = Promise.resolve()
function withLock(fn) {
  const next = chain.then(fn, fn)
  chain = next.then(
    () => {},
    () => {},
  )
  return next
}

/** Ids cancelados pelo main (o `cancel` pode chegar antes ou durante o pedaço). */
const cancelados = new Set()

async function boot() {
  const t0 = Date.now()
  if (!ASSETS_DIR) throw new Error("--assets não informado (pasta dos modelos)")
  if (!fs.existsSync(ONNX_DIR)) throw new Error(`modelos ONNX ausentes em ${ONNX_DIR} — baixe em Configurações → Voz`)
  log(`[boot] carregando modelos ONNX de ${ONNX_DIR} ...`)
  tts = await loadTextToSpeech(ONNX_DIR, false)
  log(`[boot] modelos prontos (taxa nativa ${tts.sampleRate} Hz); carregando vozes...`)
  for (const id of VOICE_IDS) {
    const file = path.join(STYLES_DIR, `${id}.json`)
    if (!fs.existsSync(file)) continue
    styles.set(id, loadVoiceStyle([file], false))
  }
  if (styles.size === 0) throw new Error(`nenhuma voz encontrada em ${STYLES_DIR}`)
  if (SAMPLE_RATE !== tts.sampleRate) {
    buildResampleTable(tts.sampleRate, SAMPLE_RATE)
    log(`[boot] resampling ${tts.sampleRate} Hz -> ${SAMPLE_RATE} Hz`)
  }
  bootMs = Date.now() - t0
  log(`[boot] ok em ${bootMs} ms — vozes: ${[...styles.keys()].join(", ")}`)
}

function normalizeVoice(v) {
  if (v == null || v === "") return DEFAULT_VOICE
  const id = String(v).toUpperCase().replace(/\.JSON$/, "").trim()
  return styles.has(id) ? id : null
}

/** Silêncio de ligação entre pedaços, igual ao do `call()` do motor (0,3 s). */
const silence = () => new Float32Array(Math.floor(0.3 * SAMPLE_RATE))

async function speak(msg) {
  const id = String(msg.id ?? "")
  const texto = typeof msg.text === "string" ? msg.text.trim() : ""
  if (!id) return
  if (!texto) return enviar({ id, done: true, error: "texto vazio" })
  if (!tts) return enviar({ id, done: true, error: "motor não está pronto" })

  const voice = normalizeVoice(msg.voice)
  if (voice === null) return enviar({ id, done: true, error: `voz desconhecida: ${msg.voice}` })
  const lang = String(msg.lang ?? DEFAULT_LANG).toLowerCase()
  if (!LANGUAGES.includes(lang)) return enviar({ id, done: true, error: `idioma não suportado: ${msg.lang}` })
  const speed = Math.min(2, Math.max(0.5, Number(msg.speed) || DEFAULT_SPEED))
  const steps = Number.isInteger(msg.steps) ? Math.min(32, Math.max(1, msg.steps)) : STEPS
  const maxChars = Number.isInteger(msg.maxChars) ? msg.maxChars : MAX_CHARS

  const style = styles.get(voice)
  const pieces = splitForStreaming(texto, maxChars)
  if (!pieces.length) return enviar({ id, done: true, error: "nada para sintetizar depois de limpar o texto" })

  const streamStart = Date.now()
  let totalSynthMs = 0
  let totalSamples = 0

  enviar({ id, start: true, pieces: pieces.length, sr: SAMPLE_RATE, nativeSr: tts.sampleRate, voice, lang, chars: pieces.map((p) => p.length) })

  try {
    for (let i = 0; i < pieces.length; i++) {
      if (cancelados.has(id)) break
      const piece = pieces[i]
      const t0 = Date.now()
      let tInfer = t0
      const out = await withLock(() => {
        if (cancelados.has(id)) return null // desistiu enquanto esperava a vez
        tInfer = Date.now()
        busy = true
        return tts._infer([piece], [lang], style, steps, speed)
      })
      if (!out) break
      // Cancelaram enquanto este pedaço era inferido: não entrega o áudio dele
      // (o main já parou de esperar, e um pedaço depois do cancel é lixo).
      if (cancelados.has(id)) break
      const synthMs = Date.now() - tInfer
      totalSynthMs += synthMs

      let pcm = resample(Float32Array.from(out.wav), tts.sampleRate, SAMPLE_RATE)
      if (i < pieces.length - 1) {
        const sil = silence()
        const juntos = new Float32Array(pcm.length + sil.length)
        juntos.set(pcm, 0)
        juntos.set(sil, pcm.length)
        pcm = juntos
      }
      totalSamples += pcm.length

      enviar({
        id,
        i,
        n: pieces.length,
        text: piece,
        sr: SAMPLE_RATE,
        audioMs: Math.round((pcm.length / SAMPLE_RATE) * 1000),
        synthMs,
        queueMs: tInfer - t0, // espera pela vez, não é inferência
        // Tempo do pedido até ESTE pedaço ficar pronto: no primeiro, é a
        // latência que o streaming existe para reduzir.
        firstMs: Date.now() - streamStart,
        pcm: floatToPcm16(pcm).toString("base64"),
      })
    }
    busy = false
  } catch (err) {
    busy = false
    cancelados.delete(id)
    return enviar({ id, done: true, error: String(err?.message ?? err) })
  }

  const cancelado = cancelados.has(id)
  cancelados.delete(id)
  const audioMs = Math.round((totalSamples / SAMPLE_RATE) * 1000)
  const wallMs = Date.now() - streamStart
  enviar({
    id,
    done: true,
    cancelled: cancelado || undefined,
    pieces: pieces.length,
    synthMs: totalSynthMs,
    audioMs,
    wallMs,
    rtf: audioMs ? Number((wallMs / audioMs).toFixed(3)) : null,
  })
}

function status() {
  return {
    type: "status",
    ready: tts !== null,
    busy,
    voices: [...styles.keys()],
    languages: LANGUAGES,
    sr: SAMPLE_RATE,
    nativeSr: tts?.sampleRate ?? NATIVE_SAMPLE_RATE,
    bootMs,
    modelVersion: tts?.cfgs?.tts_version ?? null,
  }
}

parentPort.on("message", (event) => {
  const msg = event?.data
  if (!msg || typeof msg !== "object") return
  switch (msg.cmd) {
    case "speak":
      void speak(msg)
      return
    case "cancel":
      cancelados.add(String(msg.id))
      return
    case "status":
      enviar(status())
      return
    case "shutdown":
      log("[engine] encerrando a pedido do main")
      process.exit(0)
      return
    default:
      enviar({ type: "error", message: `comando desconhecido: ${String(msg.cmd)}` })
  }
})
parentPort.start()

// ------------------------------------------------------------------------ main
try {
  await boot()
  // o `type` vem DEPOIS do spread: status() também tem `type`, e o do status
  // sobrescreveria o do ready (o main ignoraria a mensagem em silêncio).
  enviar({ ...status(), type: "ready" })
} catch (err) {
  log("[engine][erro] boot falhou:", err?.stack ?? err)
  enviar({ type: "error", fatal: true, message: String(err?.message ?? err) })
  process.exit(1)
}
