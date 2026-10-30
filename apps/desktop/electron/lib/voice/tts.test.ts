import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The TTS engine client is what the rest of the app sees, and what it has to get
 * right is not the inference (that runs in the child): it is the PROTOCOL. A lost
 * `done` leaves the renderer with the spinner forever; a `cancel` that does not reach
 * the engine makes the next chunk play after the user gave up; and a
 * process that dies without warning leaves the utterance hanging.
 *
 * Nothing here loads ONNX: the child process is fake and answers the protocol by
 * hand. (The real inference was measured by running the engine with the laboratory
 * models — see voice-engine's README.md.)
 */

// The bundled engine is found from APP_ROOT (as in the main in dev).
process.env.APP_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const state = vi.hoisted(() => ({
  child: null as unknown,
  installed: true,
  fork: null as unknown,
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class FakeChild extends Emitter {
    posted: Record<string, unknown>[] = []
    pid = 4242
    stdout = new Emitter()
    stderr = new Emitter()
    dead = false
    postMessage(msg: Record<string, unknown>): void {
      this.posted.push(msg)
    }
    kill(): void {
      this.dead = true
      this.emit('exit', 0)
    }
    // ── test helpers ────────────────────────────────────────────────────────
    ready(): void {
      this.emit('message', { type: 'ready', bootMs: 12, voices: ['F2'], sr: 24000 })
    }
    chunk(id: string, i: number, n: number): void {
      this.emit('message', {
        id,
        i,
        n,
        text: 'olá',
        sr: 24000,
        audioMs: 1500,
        synthMs: 40,
        firstMs: 50,
        pcm: Buffer.from([1, 2, 3, 4]).toString('base64'),
      })
    }
    finish(id: string, extra: Record<string, unknown> = {}): void {
      this.emit('message', { id, done: true, pieces: 1, audioMs: 1500, wallMs: 90, rtf: 0.06, ...extra })
    }
    die(code = 1): void {
      this.emit('exit', code)
    }
  }
  return {
    app: { getPath: () => '/tmp/orbit-voice-tts-test', getAppPath: () => '/tmp/orbit-voice-tts-test/app' },
    utilityProcess: {
      fork: (file: string, args: string[], options: Record<string, unknown>) => {
        state.fork = { file, args, options }
        const child = new FakeChild()
        state.child = child
        return child
      },
    },
  }
})

vi.mock('./download', () => ({
  isModelDownloaded: async () => state.installed,
  modelDir: () => '/tmp/orbit-voice-tts-test/models/supertonic-3',
}))

// The manifest pulls in the STT catalog (heavy engine); only the TTS matters here.
vi.mock('./stt', () => ({ STT_MODELS: [] }))

const { enginePresent, shutdownTts, speak, ttsStatus } = await import('./tts')

interface FakeChild {
  posted: Record<string, unknown>[]
  pid: number
  dead: boolean
  ready(): void
  chunk(id: string, i: number, n: number): void
  finish(id: string, extra?: Record<string, unknown>): void
  die(code?: number): void
}

const fakeChild = (): FakeChild => state.child as FakeChild

/** Spins the microtasks until the condition holds (without relying on counting ticks). */
async function until<T>(get: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = get()
    if (value !== undefined && value !== null) return value
    await Promise.resolve()
  }
  throw new Error(`espera esgotada: ${what}`)
}

async function waitForFork(): Promise<FakeChild> {
  return await until(() => (state.child ? fakeChild() : undefined), 'o motor subir')
}

async function waitForPosted(cmd: string): Promise<Record<string, unknown>> {
  return await until(() => fakeChild().posted.find((m) => m.cmd === cmd), `o main mandar ${cmd}`)
}

/**
 * Runs the whole flow: requests the speech, answers the `ready` and returns the request that
 * arrived at the (fake) engine.
 */
async function speechRequest(
  text = 'olá mundo',
  onChunk: (c: { i: number; sr: number; pcm: Buffer }) => void = () => {},
  signal?: AbortSignal,
): Promise<{ id: string; speech: Promise<{ pieces: number; audioMs: number; cancelled: boolean }> }> {
  const speech = speak(text, { voice: 'F2', lang: 'pt' }, onChunk, signal)
  const engine = await waitForFork()
  engine.ready()
  const request = await waitForPosted('speak')
  return { id: String(request.id), speech }
}

afterEach(() => {
  vi.useRealTimers()
  state.installed = true
  state.child = null
  shutdownTts()
})

describe('speak', () => {
  it('starts the embedded engine, with the userData assets and a 4 GB heap', async () => {
    const speech = speak('oi', {}, () => {})
    await waitForFork()

    const fork = state.fork as { file: string; args: string[]; options: Record<string, unknown> }
    expect(fork.file.endsWith(path.join('electron', 'voice-engine', 'engine.mjs'))).toBe(true)
    expect(fork.args).toEqual(['--assets', '/tmp/orbit-voice-tts-test/models/supertonic-3'])
    expect(fork.options.execArgv).toEqual(['--max-old-space-size=4096'])
    expect(fork.options.stdio).toBe('pipe')

    // Closes the process before the speech starts: the request becomes an error, it does not hang.
    fakeChild().die(0)
    await expect(speech).rejects.toThrow(/exited while starting \(code 0\)/)
  })

  it('delivers each chunk as PCM and resolves with the engine summary', async () => {
    const chunks: { i: number; sr: number; pcm: Buffer }[] = []
    const { id, speech } = await speechRequest('olá mundo', (c) => chunks.push({ i: c.i, sr: c.sr, pcm: c.pcm }))

    const request = fakeChild().posted.find((m) => m.cmd === 'speak') as Record<string, unknown>
    expect(request).toMatchObject({ cmd: 'speak', text: 'olá mundo', voice: 'F2', lang: 'pt' })

    fakeChild().chunk(id, 0, 2)
    fakeChild().chunk(id, 1, 2)
    fakeChild().finish(id, { pieces: 2, audioMs: 3000 })

    expect(await speech).toMatchObject({ pieces: 2, audioMs: 3000, cancelled: false })
    expect(chunks).toHaveLength(2)
    expect(chunks[0].pcm.equals(Buffer.from([1, 2, 3, 4]))).toBe(true)
    expect(chunks[0].sr).toBe(24000)
  })

  it('cancelling tells the engine and the request comes back as cancelled', async () => {
    const controller = new AbortController()
    const { id, speech } = await speechRequest('olá mundo', () => {}, controller.signal)
    fakeChild().chunk(id, 0, 3)

    controller.abort()
    expect(fakeChild().posted.at(-1)).toMatchObject({ cmd: 'cancel', id })

    fakeChild().finish(id, { cancelled: true, audioMs: 1500 })
    expect((await speech).cancelled).toBe(true)
  })

  it('with the signal already aborted, it does not even ask for speech', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await speak('olá mundo', {}, () => {}, controller.signal)
    expect(result).toMatchObject({ cancelled: true, pieces: 0 })
    expect(state.child).toBeNull()
  })

  it('an engine error becomes a rejection with its message', async () => {
    const { id, speech } = await speechRequest()
    fakeChild().finish(id, { error: 'motor sem memória' })
    await expect(speech).rejects.toThrow('motor sem memória')
  })

  it('an engine that dies midway rejects the request instead of leaving it hanging', async () => {
    const { speech } = await speechRequest()
    fakeChild().die(7)
    await expect(speech).rejects.toThrow(/exited \(code 7\)/)
  })

  it('without the downloaded model, the engine does not even start', async () => {
    state.installed = false
    await expect(speak('olá mundo', {}, () => {})).rejects.toThrow(/have not been downloaded/)
    expect(state.child).toBeNull()
  })

  it('empty text is refused before anything else', async () => {
    await expect(speak('   ', {}, () => {})).rejects.toThrow(/empty/)
  })
})

describe('ociosidade', () => {
  it('with no use, the engine gets shutdown and is then killed', async () => {
    vi.useFakeTimers()
    const speech = speak('olá mundo', {}, () => {})
    await vi.advanceTimersByTimeAsync(0)
    const motor = await waitForFork()
    motor.ready()
    const request = await waitForPosted('speak')
    motor.finish(String(request.id))
    await speech

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1)
    expect(motor.posted.at(-1)).toMatchObject({ cmd: 'shutdown' })

    await vi.advanceTimersByTimeAsync(2_500)
    expect(motor.dead).toBe(true)
    expect(motor.posted.filter((m) => m.cmd === 'shutdown')).toHaveLength(1)
  })
})

describe('ttsStatus', () => {
  it('reflects the installed model and a stopped engine', async () => {
    const status = await ttsStatus()
    expect(status).toMatchObject({ installed: true, running: false, pending: 0 })
    expect(Array.isArray(status.log)).toBe(true)
  })

  it('the embedded engine is where the client looks for it', () => {
    expect(enginePresent()).toBe(true)
  })
})
