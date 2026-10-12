/**
 * Motor de ditado whisper.cpp — como PROCESSO AUXILIAR (`whisper-server`).
 *
 * Por que processo e não addon N-API: o lab usou o binding `smart-whisper`
 * porque é Node puro, mas num app Electron um addon nativo sofre com ABI a cada
 * atualização do Electron (o README do lab recomenda explicitamente o
 * `whisper-server` aqui). O servidor é um processo separado: fala por HTTP, não
 * sabe o que é ABI do V8, e se travar não derruba o app.
 *
 * Duas heranças medidas do lab que estão implementadas de propósito:
 *
 *  - **greedy explícito**. O binding do lab partia de `BEAM_SEARCH` (5 feixes)
 *    sem ninguém pedir. O `whisper-server` decide a estratégia por
 *    `beam_size > 1`, então mandamos `beam_size=1` e `best_of=1` — greedy de um
 *    caminho só, que é o mais rápido com o mesmo texto (§17 do README);
 *  - **modelo quente**. O servidor carrega o modelo uma vez e o mantém; a
 *    rotina de aquecimento dele evita pagar a compilação dos shaders na
 *    primeira fala do usuário.
 *
 * O que NÃO vive aqui: o modelo ggml (baixado sob demanda por `models-store`) e
 * o binário do `whisper-server`, compilado no build (scripts/build-whisper-server.mjs).
 * O binário é procurado, nesta ordem: `ORBIT_WHISPER_SERVER`, o que vem com o
 * app, `<userData>/voice/whisper/whisper-server` e o PATH. Sem ele o motor fica indisponível com o motivo escrito — em vez de
 * falhar silenciosamente no meio de uma fala.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { userShellEnv } from '../shell-env'
import type { SttEngine, SttEngineStatus, SttHandle, SttStartInput } from './engine'
import { encodeWavPcm16, SampleBuffer, samplesToMs, STT_SAMPLE_RATE } from './audio'
import { getSttModel } from './catalog'
import {
  bundledWhisperServerPath,
  isWhisperModelInstalled,
  localWhisperServerPath,
  modelFileFor,
  modelsDir,
  whisperInstalledIds,
} from './models-store'

const ENGINE_ID = 'whisper'
const ENGINE_LABEL = 'Whisper (whisper.cpp, processo auxiliar)'
const DEFAULT_MODEL_ID = 'whisper-base'

/** A janela fixa do whisper é 30 s: acima disso a prévia ao vivo não faz sentido. */
const MAX_PREVIEW_SAMPLES = STT_SAMPLE_RATE * 30
/** Cadência da prévia ao vivo (o passo custa ~1,2 s no turbo — §17). */
const PREVIEW_PERIOD_MS = 2000
const READY_TIMEOUT_MS = 120_000
const IDLE_SHUTDOWN_MS = 5 * 60_000

function serverBinaryName(): string {
  return process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'
}

/** Primeiro `dir/name` existente no PATH (o PATH de um app de GUI é enxuto). */
function findInPath(name: string): string | null {
  const dirs = (userShellEnv().PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // segue procurando
    }
  }
  return null
}

/** Caminho do binário do whisper-server, ou null se não houver nenhum. */
export function resolveWhisperServer(): string | null {
  const env = process.env.ORBIT_WHISPER_SERVER
  if (env && fs.existsSync(env)) return env
  const bundled = bundledWhisperServerPath()
  if (bundled && fs.existsSync(bundled)) return bundled
  const local = localWhisperServerPath()
  if (fs.existsSync(local)) return local
  return findInPath(serverBinaryName())
}

function defaultThreads(): number {
  const cpus = os.cpus().length || 4
  return Math.max(2, Math.min(8, cpus - 2))
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('não achei porta livre'))))
    })
  })
}

// ---------------------------------------------------------------------------
// Servidor por modelo
// ---------------------------------------------------------------------------

interface WhisperServer {
  modelId: string
  bin: string
  port: number
  proc: ChildProcess
  ready: Promise<void>
  log: string[]
  queue: Promise<unknown>
  idleTimer: NodeJS.Timeout | null
}

const servers = new Map<string, WhisperServer>()
const starting = new Map<string, Promise<WhisperServer>>()

async function waitHealthy(server: WhisperServer): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    if (server.proc.exitCode !== null) {
      throw new Error(`o whisper-server saiu (código ${server.proc.exitCode}): ${server.log.slice(-5).join(' ')}`)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`)
      if (res.ok) return
    } catch {
      // ainda subindo
    }
    if (Date.now() > deadline) {
      throw new Error(`o whisper-server não ficou pronto em ${READY_TIMEOUT_MS / 1000} s`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

function touch(server: WhisperServer): void {
  if (server.idleTimer) clearTimeout(server.idleTimer)
  server.idleTimer = setTimeout(() => shutdownServer(server.modelId), IDLE_SHUTDOWN_MS)
  server.idleTimer.unref?.()
}

function shutdownServer(modelId: string): void {
  const server = servers.get(modelId)
  if (!server) return
  if (server.idleTimer) clearTimeout(server.idleTimer)
  servers.delete(modelId)
  try {
    server.proc.kill()
  } catch {
    // já morreu
  }
}

/** Encerra todos os servidores (o app está saindo). */
export function shutdownWhisperServers(): void {
  for (const id of [...servers.keys()]) shutdownServer(id)
}

// Sair do app não pode deixar o `whisper-server` (e o modelo carregado nele)
// vivo como processo órfão. O handler de `exit` só aceita trabalho síncrono, e
// é exatamente o que `kill()` é — o `shutdownWhisperServers` é para quem quiser
// derrubar antes (troca de modelo, tela de configurações).
process.on('exit', () => {
  for (const server of servers.values()) {
    try {
      server.proc.kill()
    } catch {
      // já morreu
    }
  }
})

async function ensureServer(modelId: string, threads: number): Promise<WhisperServer> {
  const current = servers.get(modelId)
  if (current && current.proc.exitCode === null) {
    await current.ready
    touch(current)
    return current
  }
  const inFlight = starting.get(modelId)
  if (inFlight) return inFlight

  const bin = resolveWhisperServer()
  if (!bin) throw new Error('whisper-server não encontrado (veja o motivo no status do motor)')

  const promise = (async () => {
    const def = getSttModel(modelId)
    if (!def) throw new Error(`modelo de ditado desconhecido: ${modelId}`)
    if (!isWhisperModelInstalled(modelId)) throw new Error(`o modelo "${modelId}" não está baixado`)

    const port = await freePort()
    const proc = spawn(
      bin,
      [
        '-m', modelFileFor(def),
        '-t', String(threads),
        '--host', '127.0.0.1',
        '--port', String(port),
        '-nt', // sem timestamps (o ditado não usa)
      ],
      { env: userShellEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const server: WhisperServer = {
      modelId,
      bin,
      port,
      proc,
      ready: Promise.resolve(),
      log: [],
      queue: Promise.resolve(),
      idleTimer: null,
    }
    const capture = (chunk: Buffer): void => {
      server.log.push(chunk.toString().trim())
      if (server.log.length > 40) server.log.shift()
    }
    proc.stdout?.on('data', capture)
    proc.stderr?.on('data', capture)
    proc.on('error', (err) => capture(Buffer.from(String(err))))
    server.ready = waitHealthy(server)
    servers.set(modelId, server)
    try {
      await server.ready
    } catch (err) {
      shutdownServer(modelId)
      throw err
    }
    touch(server)
    return server
  })().finally(() => starting.delete(modelId))

  starting.set(modelId, promise)
  return promise
}

// ---------------------------------------------------------------------------
// Inferência
// ---------------------------------------------------------------------------

/** Monta o multipart do `/inference` (o servidor só aceita arquivo, não PCM). */
function inferenceForm(wav: Buffer, language: string): FormData {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
  form.append('response_format', 'json')
  form.append('language', language || 'auto')
  // Greedy explícito: é `beam_size > 1` que liga o beam search no servidor.
  form.append('beam_size', '1')
  form.append('best_of', '1')
  form.append('no_timestamps', 'true')
  form.append('temperature', '0')
  return form
}

/** Transcreve 16 kHz mono — serializado por servidor (contexto não reentrante). */
async function transcribe(
  modelId: string,
  threads: number,
  samples: Float32Array,
  language: string,
): Promise<string> {
  const server = await ensureServer(modelId, threads)
  const run = server.queue.then(async () => {
    const wav = encodeWavPcm16(samples, STT_SAMPLE_RATE)
    const res = await fetch(`http://127.0.0.1:${server.port}/inference`, {
      method: 'POST',
      body: inferenceForm(wav, language),
    })
    if (!res.ok) throw new Error(`o whisper-server respondeu HTTP ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as { text?: string }
    return String(json.text || '').trim()
  })
  server.queue = run.then(
    () => undefined,
    () => undefined,
  )
  touch(server)
  return run
}

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------

interface WhisperSession {
  id: string
  modelId: string
  threads: number
  language: string
  live: boolean
  onPartial: (text: string) => void
  buffer: SampleBuffer
  chain: Promise<unknown>
  gen: number
  stopping: boolean
  cancelled: boolean
  previewTimer: NodeJS.Timeout | null
  lastPreviewSamples: number
}

function enqueue(s: WhisperSession, fn: () => Promise<void>): Promise<void> {
  const run = s.chain.then(fn, fn)
  s.chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function schedulePreview(s: WhisperSession): void {
  if (!s.live || s.stopping || s.cancelled || s.previewTimer) return
  s.previewTimer = setTimeout(() => {
    s.previewTimer = null
    void runPreview(s)
  }, PREVIEW_PERIOD_MS)
  s.previewTimer.unref?.()
}

function runPreview(s: WhisperSession): Promise<void> {
  if (s.stopping || s.cancelled) return Promise.resolve()
  // Acima de 30 s a prévia para (é a janela do whisper) e o final transcreve tudo.
  if (s.buffer.samples > MAX_PREVIEW_SAMPLES) return Promise.resolve()
  if (s.buffer.samples === s.lastPreviewSamples) {
    schedulePreview(s)
    return Promise.resolve()
  }
  s.lastPreviewSamples = s.buffer.samples
  const gen = s.gen
  const samples = s.buffer.slice(0, s.buffer.samples)
  if (samples.length < STT_SAMPLE_RATE * 0.3) {
    schedulePreview(s)
    return Promise.resolve()
  }
  return enqueue(s, async () => {
    if (s.stopping || s.cancelled || gen !== s.gen) return
    try {
      const text = await transcribe(s.modelId, s.threads, samples, s.language)
      if (s.stopping || s.cancelled || gen !== s.gen || !text) return
      try {
        s.onPartial(text)
      } catch {
        // erro do chamador não derruba a sessão
      }
    } catch {
      // prévia é best-effort: o resultado final é o que conta
    } finally {
      schedulePreview(s)
    }
  })
}

async function status(): Promise<SttEngineStatus> {
  const bin = resolveWhisperServer()
  const installed = whisperInstalledIds()
  const detail: Record<string, unknown> = {
    binary: bin,
    binaryEnv: 'ORBIT_WHISPER_SERVER',
    binaryLocal: localWhisperServerPath(),
    modelsDir: modelsDir(),
    installed,
    defaultModelId: DEFAULT_MODEL_ID,
    decode: 'greedy (beam_size=1, best_of=1)',
  }
  if (!bin) {
    return {
      engine: ENGINE_ID,
      available: false,
      installed: installed.length > 0,
      reason:
        'whisper-server não encontrado — rode `npm run whisper:build` (apps/desktop), ponha o binário em ' +
        `${localWhisperServerPath()}, ou defina ORBIT_WHISPER_SERVER`,
      detail,
    }
  }
  if (!installed.length) {
    return {
      engine: ENGINE_ID,
      available: false,
      installed: false,
      reason: 'nenhum modelo whisper baixado (baixe tiny/base/small/medium/large-v3-turbo sob demanda)',
      detail,
    }
  }
  return { engine: ENGINE_ID, available: true, installed: true, detail }
}

async function start(input: SttStartInput, onPartial: (text: string) => void): Promise<SttHandle> {
  // Valida o modelo ANTES do binário: um id que não é do whisper é erro de
  // integração e o motivo específico ajuda mais que "faltou o servidor".
  const modelId = input.modelId || DEFAULT_MODEL_ID
  const def = getSttModel(modelId)
  if (!def || def.engine !== 'whisper') throw new Error(`o motor whisper não tem o modelo "${modelId}"`)

  const bin = resolveWhisperServer()
  if (!bin) {
    const st = await status()
    throw new Error(st.reason || 'whisper-server não encontrado')
  }
  if (!isWhisperModelInstalled(modelId)) throw new Error(`o modelo "${modelId}" não está baixado`)

  const threads = input.threads ?? defaultThreads()
  const language = input.language || 'pt'

  const s: WhisperSession = {
    id: randomUUID(),
    modelId,
    threads,
    language,
    live: input.live,
    onPartial,
    buffer: new SampleBuffer(),
    chain: Promise.resolve(),
    gen: 0,
    stopping: false,
    cancelled: false,
    previewTimer: null,
    lastPreviewSamples: 0,
  }
  // Sobe o servidor aguardando o modelo carregar: se falhar, o erro sai no start.
  await ensureServer(modelId, threads)

  return {
    pushAudio(samples: Float32Array): void {
      if (s.stopping || s.cancelled) return
      s.buffer.push(samples)
      schedulePreview(s)
    },

    async stop(): Promise<{ text: string; audioMs: number }> {
      s.stopping = true
      s.gen += 1
      if (s.previewTimer) {
        clearTimeout(s.previewTimer)
        s.previewTimer = null
      }
      await s.chain
      const samples = s.buffer.slice(0, s.buffer.samples)
      const audioMs = samplesToMs(samples.length)
      if (samples.length < STT_SAMPLE_RATE * 0.1) return { text: '', audioMs }
      const text = await transcribe(modelId, threads, samples, language)
      return { text, audioMs }
    },

    async cancel(): Promise<void> {
      s.cancelled = true
      s.stopping = true
      s.gen += 1
      if (s.previewTimer) {
        clearTimeout(s.previewTimer)
        s.previewTimer = null
      }
      s.buffer = new SampleBuffer()
    },
  }
}

/**
 * Sobe o `whisper-server` e carrega o modelo ANTES do primeiro uso, para a
 * primeira sessão do usuário não pagar o `spawn` + a leitura do ggml.
 */
async function warmEngine(modelId: string | null, threads?: number): Promise<void> {
  const id = modelId || DEFAULT_MODEL_ID
  const def = getSttModel(id)
  if (!def || def.engine !== ENGINE_ID) return
  try {
    await ensureServer(id, threads ?? defaultThreads())
  } catch {
    // binário ou modelo ausente: o motivo já aparece no `status()`
  }
}

export const whisperEngine: SttEngine = {
  id: ENGINE_ID,
  label: ENGINE_LABEL,
  defaultModelId: DEFAULT_MODEL_ID,
  status,
  warm: warmEngine,
  // O servidor já se encerra sozinho depois de ocioso (`touch`/IDLE_SHUTDOWN_MS);
  // isto é o gatilho explícito da fachada.
  release: shutdownWhisperServers,
  start,
}
