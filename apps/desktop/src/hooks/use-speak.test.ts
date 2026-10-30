import { describe, expect, it, vi } from "vitest"
import { parseVoiceStatus } from "@/src/lib/dictation"
import {
  ChunkPlayer,
  TTS_SAMPLE_RATE,
  decodePcm16,
  readTtsEngine,
  readTtsPrefs,
  readTtsStatus,
  subscribeVoiceStatus,
  type VoiceStatusSource,
} from "./use-speak"

/** Lets the microtask queue drain (the `apply` arrives after the `invoke`). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Fake bridge for the observer: delivers the snapshots in order, counts the
 * queries and keeps the channel listener the way the preload would.
 */
function fakeSource(snapshots: unknown[]) {
  let listener: (() => void) | null = null
  let calls = 0
  const source: VoiceStatusSource = {
    status: () => {
      const raw = snapshots[Math.min(calls, snapshots.length - 1)]
      calls++
      return Promise.resolve(raw)
    },
    onStatusChanged: (next) => {
      listener = next
      return () => {
        listener = null
      }
    },
  }
  return {
    source,
    /** Main reports that the state changed. */
    emit: () => listener?.(),
    calls: () => calls,
    subscribed: () => listener !== null,
  }
}

/** PCM16LE samples -> base64, exactly as they arrive in `voice:tts:chunk`. */
function pcm(...samples: number[]): string {
  const bytes = Buffer.alloc(samples.length * 2)
  samples.forEach((value, index) => bytes.writeInt16LE(value, index * 2))
  return bytes.toString("base64")
}

/** Chunk that ChunkPlayer scheduled, as the fake AudioContext sees it. */
interface FakeSource {
  buffer: AudioBuffer | null
  onended: (() => void) | null
  startedAt: number
  stopped: boolean
}

/**
 * Fake AudioContext: records what was scheduled, without playing anything. Nothing
 * here needs a DOM — that is what makes it possible to test the splicing of the chunks in Node.
 */
class FakeContext {
  currentTime = 0
  state: AudioContextState = "running"
  destination = {} as AudioDestinationNode
  closed = false
  readonly started: FakeSource[] = []
  readonly buffers: { samples: Float32Array; sampleRate: number }[] = []

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    const samples = new Float32Array(length)
    this.buffers.push({ samples, sampleRate })
    return { duration: length / sampleRate, getChannelData: () => samples } as unknown as AudioBuffer
  }

  createBufferSource(): AudioBufferSourceNode {
    const source: FakeSource = { buffer: null, onended: null, startedAt: 0, stopped: false }
    const node = {
      get buffer() {
        return source.buffer
      },
      set buffer(value: AudioBuffer | null) {
        source.buffer = value
      },
      set onended(value: (() => void) | null) {
        source.onended = value
      },
      connect: () => {},
      disconnect: () => {},
      start: (at: number) => {
        source.startedAt = at
        this.started.push(source)
      },
      stop: () => {
        source.stopped = true
      },
    }
    return node as unknown as AudioBufferSourceNode
  }

  resume(): Promise<void> {
    this.state = "running"
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closed = true
    this.state = "closed"
    return Promise.resolve()
  }
}

function newPlayer(context: FakeContext) {
  return new ChunkPlayer(() => context as unknown as AudioContext)
}

describe("decodePcm16", () => {
  it("converts PCM16LE to samples in -1..1", () => {
    const samples = decodePcm16(pcm(0, 32767, -32768, 16384, -16384))

    expect(samples.length).toBe(5)
    expect(samples[0]).toBe(0)
    expect(samples[1]).toBeCloseTo(1, 4)
    expect(samples[2]).toBe(-1)
    expect(samples[3]).toBeCloseTo(0.5, 4)
    expect(samples[4]).toBeCloseTo(-0.5, 4)
  })

  it("a stray byte at the end is dropped (the frame is 2 bytes)", () => {
    const bytes = Buffer.from([0x10, 0x20, 0x30])

    expect(decodePcm16(bytes.toString("base64")).length).toBe(1)
  })

  it("an empty or invalid base64 becomes an empty buffer, without blowing up", () => {
    expect(decodePcm16("").length).toBe(0)
    expect(decodePcm16("isto-não-é-base64!!").length).toBe(0)
  })
})

describe("ChunkPlayer", () => {
  it("splices each chunk at the end of the previous one, respecting the chunk rate", () => {
    const context = new FakeContext()
    const player = newPlayer(context)

    player.schedule(new Float32Array(2400).fill(0.5), 24000)
    player.schedule(new Float32Array(1200).fill(-0.5), 12000)

    // 0.1s each; the second starts exactly where the first ends.
    expect(context.started[0].startedAt).toBeCloseTo(0.02, 4)
    expect(context.started[1].startedAt).toBeCloseTo(0.12, 4)
    expect(player.scheduledEnd).toBeCloseTo(0.22, 4)
    expect(context.buffers[0].samples[0]).toBe(0.5)
    expect(context.buffers[1].sampleRate).toBe(12000)
    expect(player.pending).toBe(2)
  })

  it("if playback fell behind, it schedules at 'now' instead of piling up delay", () => {
    const context = new FakeContext()
    const player = newPlayer(context)

    player.schedule(new Float32Array(24000).fill(0), 24000)
    context.currentTime = 5
    player.schedule(new Float32Array(240).fill(0), 24000)

    expect(context.started[1].startedAt).toBeCloseTo(5.02, 4)
  })

  it("an empty chunk schedules nothing and creates no context", () => {
    const context = new FakeContext()
    const player = newPlayer(context)

    player.schedule(new Float32Array(0), 24000)

    expect(context.started.length).toBe(0)
    expect(player.pending).toBe(0)
  })

  it("notifies on every chunk that ends and stops counting what already played", () => {
    const context = new FakeContext()
    const player = newPlayer(context)
    const ended = vi.fn()
    player.onEnded = ended

    player.schedule(new Float32Array(2400).fill(0), 24000)
    player.schedule(new Float32Array(2400).fill(0), 24000)
    context.started[0].onended?.()

    expect(player.pending).toBe(1)
    expect(ended).toHaveBeenCalledTimes(1)

    context.started[1].onended?.()

    expect(player.pending).toBe(0)
    expect(ended).toHaveBeenCalledTimes(2)
  })

  it("stopAll interrupts what was scheduled and clears the queue", () => {
    const context = new FakeContext()
    const player = newPlayer(context)

    player.schedule(new Float32Array(2400).fill(0), 24000)
    player.schedule(new Float32Array(2400).fill(0), 24000)
    player.stopAll()

    expect(context.started.every((source) => source.stopped)).toBe(true)
    expect(context.started.every((source) => source.onended === null)).toBe(true)
    expect(player.pending).toBe(0)
    expect(player.scheduledEnd).toBe(0)
  })

  it("close shuts the AudioContext — the hook opens it again if it speaks once more", () => {
    const context = new FakeContext()
    const player = newPlayer(context)

    player.schedule(new Float32Array(240).fill(0), 24000)
    player.close()

    expect(context.closed).toBe(true)
    expect(player.pending).toBe(0)
  })

  it("spokenText grows with the audio, chunk by chunk of the sentence", () => {
    const context = new FakeContext()
    const player = newPlayer(context)
    // 1s each; the first starts at 0.02 and the second splices at 1.02.
    player.schedule(new Float32Array(24000).fill(0), 24000, 0, "Primeira frase.")
    player.schedule(new Float32Array(24000).fill(0), 24000, 0, "Segunda frase.")
    player.schedule(new Float32Array(24000).fill(0), 24000, 1, "Outra frase mais comprida.")

    expect(player.spokenText(0)).toBe("")

    context.currentTime = 0.52
    expect(player.spokenText(0)).toBe("Primeira")

    context.currentTime = 1.5
    expect(player.spokenText(0)).toBe("Primeira frase. Segunda")
    expect(player.spokenText(1)).toBe("")

    context.currentTime = 2.5
    expect(player.spokenText(0)).toBe("Primeira frase. Segunda frase.")
    expect(player.spokenText(1)).toBe("Outra frase mais")
  })

  it("spokenText disappears when the sentence leaves the queue (cut for tools)", () => {
    const context = new FakeContext()
    const player = newPlayer(context)

    player.schedule(new Float32Array(24000).fill(0), 24000, 0, "Fica.")
    player.schedule(new Float32Array(24000).fill(0), 24000, 1, "Sai.")
    context.currentTime = 2.5

    expect(player.spokenText(1)).toBe("Sai.")
    player.dropAfter(0)

    expect(player.spokenText(0)).toBe("Fica.")
    expect(player.spokenText(1)).toBe("")
    player.stopAll()
    expect(player.spokenText(0)).toBe("")
  })
})

describe("readTtsPrefs", () => {
  it("with no `voice` block in the store, the app defaults apply", () => {
    expect(readTtsPrefs(undefined)).toEqual({ enabled: true, voice: "F2", lang: "auto", speed: 1 })
  })

  it("reads whatever is saved", () => {
    const prefs = readTtsPrefs({ tts: { enabled: false, voice: "M1", lang: "en", speed: 1.25 } })

    expect(prefs).toEqual({ enabled: false, voice: "M1", lang: "en", speed: 1.25 })
  })

  it("a value outside the domain falls back to the default instead of breaking speech", () => {
    const prefs = readTtsPrefs({ tts: { voice: "  ", lang: 7, speed: 0 } })

    expect(prefs).toEqual({ enabled: true, voice: "F2", lang: "auto", speed: 1 })
  })
})

describe("readTtsEngine", () => {
  it("with no saved choice, the default applies: the model", () => {
    expect(readTtsEngine(undefined)).toBe("model")
    expect(readTtsEngine({})).toBe("model")
  })

  it("reads the saved choice and ignores a value outside the domain", () => {
    expect(readTtsEngine({ tts: { engine: "local" } })).toBe("local")
    expect(readTtsEngine({ tts: { engine: "x" } })).toBe("model")
  })
})

describe("readTtsStatus", () => {
  it("with no answer from main (or no engine), the button is not blocked", () => {
    expect(readTtsStatus(undefined)).toEqual({ ready: true, known: false })
    expect(readTtsStatus({ engines: [] })).toEqual({ ready: true, known: false })
  })

  it("ttsReady decides when it comes from main", () => {
    expect(readTtsStatus({ ttsReady: false, models: {} })).toEqual({ ready: false, known: true })
    expect(readTtsStatus({ ttsReady: true })).toEqual({ ready: true, known: true })
  })

  it("without ttsReady, any installed model frees the button", () => {
    expect(readTtsStatus({ models: { tts: { installed: true } } }).ready).toBe(true)
    expect(readTtsStatus({ models: { tts: { installed: false } } })).toEqual({ ready: false, known: true })
  })

  it("with the 'model' priority, the provider route frees the button without the local model", () => {
    expect(readTtsStatus({ ttsReady: false, models: {}, modelTts: { available: true } }, "model")).toEqual({
      ready: true,
      known: true,
    })
  })

  it("with the 'local' priority, the model route does not interfere", () => {
    expect(readTtsStatus({ ttsReady: false, models: {}, modelTts: { available: true } }, "local")).toEqual({
      ready: false,
      known: true,
    })
  })
})

describe("subscribeVoiceStatus", () => {
  it("reads the state on subscribe and re-reads on every voice:status-changed", async () => {
    const fake = fakeSource([{ ttsReady: false }, { ttsReady: true }])
    const seen: unknown[] = []

    const subscription = subscribeVoiceStatus(fake.source, (raw) => seen.push(raw))
    await flush()

    expect(fake.calls()).toBe(1)
    expect(readTtsStatus(seen.at(-1))).toEqual({ ready: false, known: true })

    // The download finished in Settings: the event unlocks the button without
    // having to leave the chat and come back.
    fake.emit()
    await flush()

    expect(fake.calls()).toBe(2)
    expect(readTtsStatus(seen.at(-1))).toEqual({ ready: true, known: true })

    subscription.unsubscribe()
    expect(fake.subscribed()).toBe(false)

    fake.emit()
    await flush()
    expect(fake.calls()).toBe(2)
  })

  it("the same payload serves both readings (TTS and dictation)", async () => {
    const fake = fakeSource([
      {
        ttsReady: true,
        engines: [{ id: "whisper", available: true, installed: true }],
        models: { small: { engine: "whisper", installed: false } },
      },
    ])
    const seen: unknown[] = []

    subscribeVoiceStatus(fake.source, (raw) => seen.push(raw))
    await flush()

    expect(readTtsStatus(seen[0])).toEqual({ ready: true, known: true })
    expect(parseVoiceStatus(seen[0])).toEqual({
      engines: [{ id: "whisper", available: true, downloaded: true }],
      models: [{ id: "small", engine: "whisper", downloaded: false }],
    })
  })

  it("a main that did not answer (error or no bridge) blocks nobody", async () => {
    const seen: unknown[] = []
    const broken: VoiceStatusSource = {
      status: () => Promise.reject(new Error("sem motor")),
      onStatusChanged: () => () => {},
    }
    subscribeVoiceStatus(broken, (raw) => seen.push(raw))
    await flush()

    expect(readTtsStatus(seen.at(-1))).toEqual({ ready: true, known: false })
    expect(parseVoiceStatus(seen.at(-1))).toBeNull()

    // A bridge that does not even exist (browser preview): the invoke throws right away.
    const noBridge: VoiceStatusSource = {
      status: () => {
        throw new Error("sem ipcRenderer")
      },
      onStatusChanged: () => () => {},
    }
    subscribeVoiceStatus(noBridge, (raw) => seen.push(raw))

    expect(seen.at(-1)).toBeUndefined()
    expect(readTtsStatus(seen.at(-1))).toEqual({ ready: true, known: false })
  })
})

describe("TTS_SAMPLE_RATE", () => {
  it("it is the engine's chunk rate (24 kHz)", () => {
    expect(TTS_SAMPLE_RATE).toBe(24000)
  })
})
