import { app, utilityProcess, type UtilityProcess } from "electron"
import path from "node:path"
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { isModelDownloaded, modelDir } from "./download"
import { TTS_MAX_CHARS, TTS_MODEL_ID, TTS_STEPS } from "./manifest"

/**
 * Cliente do motor Supertonic 3 — o processo filho que sintetiza a fala.
 *
 * A inferência NUNCA roda no main: ela é CPU-bound e leva segundos por pedaço,
 * o que travaria as janelas e o IPC. Aqui vive só o cliente: sobe o motor
 * (`voice-engine/engine.mjs`) com `utilityProcess.fork`, manda os pedidos e
 * devolve o áudio pedaço a pedaço conforme chega.
 *
 * O motor é caro de subir (lê ~400 MB de ONNX, mantém ~0,5 GB em memória) e
 * barato de manter quente entre falas — então ele fica de pé enquanto está
 * sendo usado e se desliga sozinho depois de um tempo ocioso.
 *
 * O canal é o MessagePort (`child.postMessage` / `child.on("message")`), porque
 * o `utilityProcess.fork` do Electron não aceita stdin como pipe. O formato das
 * mensagens é o do laboratório: `{start}`, um por pedaço `{i,n,text,sr,audioMs,
 * synthMs,pcm:<base64 PCM16>}` e o `{done}` no fim.
 */

/** Um pedaço de fala pronto, já decodificado para PCM 16-bit. */
export interface TtsChunk {
  id: string
  /** Índice do pedaço (0-based) e total de pedaços do pedido. */
  i: number
  n: number
  /** Texto que gerou ESTE pedaço (é o que o corte em fim de frase produziu). */
  text: string
  /** Taxa do PCM — a do contrato: 24000 Hz. */
  sr: number
  pcm: Buffer
  audioMs: number
  synthMs: number
  /** ms do início do pedido até este pedaço ficar pronto. */
  firstMs: number
}

export interface TtsSpeakOptions {
  /** M1–M5 / F1–F5 (o padrão do motor é F2). */
  voice?: string
  /** `pt`, `en`, … ou `na` (agnóstico). */
  lang?: string
  /** Fator de velocidade, 0,5–2,0 (1 = natural). */
  speed?: number
  /** Passos de denoising (padrão 8). */
  steps?: number
  /** Alvo de caracteres por pedaço (o corte real é sempre em fim de frase). */
  maxChars?: number
}

export interface TtsSpeakResult {
  pieces: number
  audioMs: number
  /** Tempo total do pedido, incluindo a espera na fila de inferência. */
  ms: number
  rtf: number | null
  /** true quando o `signal` abortou o pedido (não é erro). */
  cancelled: boolean
}

export interface TtsStatus {
  /** O processo do motor está de pé e pronto. */
  running: boolean
  /** O pacote do modelo está baixado e completo (o TTS não tem extração). */
  installed: boolean
  /** Subindo (carregando os ONNX). */
  starting: boolean
  /** Falas em andamento. */
  pending: number
  pid: number | null
  /** Últimas linhas do stderr do motor — diagnóstico do app empacotado. */
  log: string[]
}

/** Sem uso por este tempo, o motor se desliga (devolve ~0,5 GB de RAM). */
const IDLE_SHUTDOWN_MS = 5 * 60_000
/** Ler 400 MB de ONNX do disco: generoso, é uma leitura só. */
const READY_TIMEOUT_MS = 120_000
/** Fala sem NENHUMA mensagem nova do motor é considerada travada. */
const STALL_TIMEOUT_MS = 120_000
/** Espera pelo `shutdown` antes de matar o processo. */
const GRACE_MS = 2_000
const LOG_LINES = 40

/** Mensagens do motor (engine.mjs). Só os campos que o cliente usa. */
interface EngineMessage {
  type?: "ready" | "status" | "error"
  message?: string
  fatal?: boolean
  ready?: boolean
  bootMs?: number
  id?: string
  start?: boolean
  done?: boolean
  error?: string
  cancelled?: boolean
  i?: number
  n?: number
  text?: string
  sr?: number
  audioMs?: number
  synthMs?: number
  firstMs?: number
  pcm?: string
  pieces?: number
  wallMs?: number
  rtf?: number | null
}

interface Pending {
  resolve: (result: TtsSpeakResult) => void
  reject: (err: Error) => void
  onChunk: (chunk: TtsChunk) => void
  audioMs: number
  pieces: number
  startedAt: number
  /** Reiniciado a cada mensagem: um pedido parado não fica pendurado para sempre. */
  stall: NodeJS.Timeout | null
}

let child: UtilityProcess | null = null
/** Motor pronto para receber falas. */
let ready = false
/** Boot em andamento: chamadas concorrentes compartilham esta promessa. */
let starting: Promise<void> | null = null
let idleTimer: NodeJS.Timeout | null = null
/** O main pediu o encerramento: a saída não é falha. */
let stopping = false
const pending = new Map<string, Pending>()
const logLines: string[] = []

function pushLog(line: string): void {
  const text = line.trimEnd()
  if (!text) return
  logLines.push(text)
  if (logLines.length > LOG_LINES) logLines.splice(0, logLines.length - LOG_LINES)
  console.log(`[voice-engine] ${text}`)
}

/**
 * Pasta do motor embutido. O main roda de `dist-electron`, então APP_ROOT é a
 * raiz do app nos dois modos (em dev: apps/desktop; empacotado: o app.asar) e o
 * diretório do motor é distribuído junto — sem nenhum peso de modelo dentro.
 */
function engineFile(): string {
  const raiz = process.env.APP_ROOT ?? app.getAppPath()
  return path.join(raiz, "electron", "voice-engine", "engine.mjs")
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

/** Reagenda o desligamento por ociosidade (só com o motor de pé e sem fala). */
function scheduleIdleShutdown(): void {
  clearIdleTimer()
  if (!child || pending.size > 0) return
  idleTimer = setTimeout(() => {
    if (pending.size === 0) shutdownTts()
  }, IDLE_SHUTDOWN_MS)
  idleTimer.unref?.()
}

/** Rejeita todas as falas em andamento (o motor caiu ou não subiu). */
function failAll(reason: string): void {
  for (const [id, entry] of pending) {
    if (entry.stall) clearTimeout(entry.stall)
    pending.delete(id)
    entry.reject(new Error(reason))
  }
}

function onEngineMessage(message: EngineMessage): void {
  if (!message || typeof message !== "object") return
  if (message.type === "ready") {
    pushLog(`[voice] motor pronto em ${message.bootMs ?? 0} ms`)
    return
  }
  if (message.type === "error") {
    pushLog(`[voice][erro] ${message.message ?? "erro no motor"}`)
    return
  }
  if (message.type === "status") return

  const id = String(message.id ?? "")
  const entry = pending.get(id)
  // Mensagem de um pedido já resolvido (cancelado pelo usuário): só o motor
  // terminando o que tinha começado — não há para quem entregar.
  if (!entry) return

  if (entry.stall) clearTimeout(entry.stall)

  if (message.i !== undefined && message.pcm !== undefined) {
    entry.pieces = message.n ?? entry.pieces
    entry.audioMs += message.audioMs ?? 0
    entry.stall = setTimeout(() => {
      pending.delete(id)
      // Sem ninguém esperando, o motor volta à contagem de ociosidade — senão
      // um pedido travado deixaria o processo de ~0,5 GB vivo para sempre.
      scheduleIdleShutdown()
      entry.reject(new Error("o motor de voz parou de responder no meio da fala"))
    }, STALL_TIMEOUT_MS)
    entry.onChunk({
      id,
      i: message.i,
      n: message.n ?? 1,
      text: message.text ?? "",
      sr: message.sr ?? 24000,
      pcm: Buffer.from(message.pcm, "base64"),
      audioMs: message.audioMs ?? 0,
      synthMs: message.synthMs ?? 0,
      firstMs: message.firstMs ?? 0,
    })
    return
  }

  if (message.done) {
    pending.delete(id)
    scheduleIdleShutdown()
    if (message.error) {
      entry.reject(new Error(message.error))
      return
    }
    entry.resolve({
      pieces: message.pieces ?? entry.pieces,
      audioMs: message.audioMs ?? entry.audioMs,
      ms: message.wallMs ?? Date.now() - entry.startedAt,
      rtf: message.rtf ?? null,
      cancelled: Boolean(message.cancelled),
    })
  }
}

/** Sobe o motor e espera o `ready`. Sempre a mesma promessa enquanto sobe. */
function startEngine(): Promise<void> {
  if (child && ready) return Promise.resolve()
  if (starting) return starting

  starting = new Promise<void>((resolve, reject) => {
    let settled = false
    const proc = utilityProcess.fork(engineFile(), ["--assets", modelDir(TTS_MODEL_ID)], {
      stdio: "pipe",
      // A mesma folga de heap do laboratório: a inferência converte os tensores
      // em arrays JS a cada passo do denoising, e o pedaço maior pesa.
      execArgv: ["--max-old-space-size=4096"],
    })
    child = proc
    stopping = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`o motor de voz não ficou pronto em ${Math.round(READY_TIMEOUT_MS / 1000)}s`))
    }, READY_TIMEOUT_MS)

    proc.stdout?.on("data", (chunk: Buffer) => pushLog(chunk.toString()))
    proc.stderr?.on("data", (chunk: Buffer) => pushLog(chunk.toString()))

    proc.on("message", (message: EngineMessage) => {
      if (message?.type === "ready" && !settled) {
        settled = true
        clearTimeout(timeout)
        ready = true
        scheduleIdleShutdown()
        resolve()
      }
      onEngineMessage(message)
    })

    proc.on("exit", (code) => {
      if (child === proc) child = null
      ready = false
      clearIdleTimer()
      const pedido = stopping
      stopping = false
      if (!settled) {
        // Morreu antes de ficar pronto (modelo ausente, binding do ONNX…) —
        // a mensagem do motor já foi para o log.
        settled = true
        clearTimeout(timeout)
        reject(new Error(`o motor de voz encerrou durante a inicialização (código ${code})`))
      }
      // Processo morto não responde mais nada: pendências viram erro, mesmo
      // quando a saída foi pedida (desligamento por ociosidade com fala viva).
      failAll(`o motor de voz encerrou (código ${code})`)
      pushLog(`[voice] motor encerrou (código ${code})${pedido ? " (pedido pelo app)" : ""}`)
    })
  }).finally(() => {
    starting = null
  })

  return starting
}

/**
 * Sintetiza `text` e entrega o áudio em pedaços.
 *
 * O `onChunk` é chamado na ordem dos pedaços; o retorno só chega no fim (ou com
 * `cancelled: true` quando o `signal` aborta — aí o motor para entre pedaços e
 * nada mais é entregue).
 */
export async function speak(
  text: string,
  options: TtsSpeakOptions = {},
  onChunk: (chunk: TtsChunk) => void,
  signal?: AbortSignal,
): Promise<TtsSpeakResult> {
  const texto = String(text ?? "").trim()
  if (!texto) throw new Error("nada para sintetizar: o texto está vazio")
  if (!(await isModelDownloaded(TTS_MODEL_ID))) {
    throw new Error("os modelos do TTS ainda não foram baixados (Configurações → Voz)")
  }
  if (signal?.aborted) return { pieces: 0, audioMs: 0, ms: 0, rtf: null, cancelled: true }

  await startEngine()
  const proc = child
  if (!proc) throw new Error("o motor de voz não está de pé")

  const id = randomUUID()
  return await new Promise<TtsSpeakResult>((resolve, reject) => {
    // `terminado` fecha o pedido uma vez só: sem ele, um `signal` que aborta
    // DEPOIS do fim mandaria um cancel para o motor por um id que não existe
    // mais (o `cancelados` do motor cresceria à toa).
    let terminado = false
    const entry: Pending = {
      resolve: (result) => {
        terminado = true
        resolve(result)
      },
      reject: (err) => {
        terminado = true
        reject(err)
      },
      onChunk,
      audioMs: 0,
      pieces: 0,
      startedAt: Date.now(),
      stall: null,
    }
    pending.set(id, entry)
    clearIdleTimer()

    entry.stall = setTimeout(() => {
      pending.delete(id)
      try {
        proc.postMessage({ cmd: "cancel", id })
      } catch {
        // motor já foi
      }
      scheduleIdleShutdown()
      reject(new Error("o motor de voz não começou a responder a tempo"))
    }, STALL_TIMEOUT_MS)

    const cancelar = () => {
      if (terminado) return
      // O motor confere o cancelamento entre pedaços (e não manda o pedaço que
      // estava inferindo); o `done` cancelado chega logo depois e resolve o
      // pedido como `cancelled`.
      try {
        proc.postMessage({ cmd: "cancel", id })
      } catch {
        // motor já foi
      }
    }
    if (signal) {
      if (signal.aborted) {
        pending.delete(id)
        if (entry.stall) clearTimeout(entry.stall)
        resolve({ pieces: 0, audioMs: 0, ms: 0, rtf: null, cancelled: true })
        return
      }
      signal.addEventListener("abort", cancelar, { once: true })
    }

    try {
      proc.postMessage({
        id,
        cmd: "speak",
        text: texto,
        voice: options.voice,
        lang: options.lang,
        speed: options.speed,
        steps: options.steps ?? TTS_STEPS,
        maxChars: options.maxChars ?? TTS_MAX_CHARS,
      })
    } catch (err) {
      pending.delete(id)
      if (entry.stall) clearTimeout(entry.stall)
      reject(new Error(`não foi possível falar com o motor de voz: ${(err as Error).message}`))
    }
  })
}

/** Estado do motor (para `voice:status` e para o diagnóstico). */
export async function ttsStatus(): Promise<TtsStatus> {
  return {
    running: Boolean(child) && ready,
    installed: await isModelDownloaded(TTS_MODEL_ID),
    starting: starting !== null,
    pending: pending.size,
    pid: child?.pid ?? null,
    log: [...logLines],
  }
}

/** O motor embutido está no disco? (o arquivo vem no build, não é baixado). */
export function enginePresent(): boolean {
  return existsSync(engineFile())
}

/** Encerra o motor: `shutdown` educado e, se ele não sair, `kill`. */
export function shutdownTts(): void {
  clearIdleTimer()
  const proc = child
  if (!proc) return
  stopping = true
  child = null
  ready = false
  try {
    proc.postMessage({ cmd: "shutdown" })
  } catch {
    // já morreu
  }
  const kill = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // já morreu
    }
  }, GRACE_MS)
  kill.unref?.()
}
