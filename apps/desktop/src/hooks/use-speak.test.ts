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

/** Deixa a fila de microtasks esvaziar (o `apply` chega depois do `invoke`). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Ponte de mentira do observador: entrega os retratos em ordem, conta as
 * consultas e guarda o listener do canal como o preload faria.
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
    /** O main avisa que o estado mudou. */
    emit: () => listener?.(),
    calls: () => calls,
    subscribed: () => listener !== null,
  }
}

/** Amostras PCM16LE -> base64, exatamente como chegam em `voice:tts:chunk`. */
function pcm(...samples: number[]): string {
  const bytes = Buffer.alloc(samples.length * 2)
  samples.forEach((value, index) => bytes.writeInt16LE(value, index * 2))
  return bytes.toString("base64")
}

/** Pedaço que o ChunkPlayer agendou, como o AudioContext de mentira o vê. */
interface FakeSource {
  buffer: AudioBuffer | null
  onended: (() => void) | null
  startedAt: number
  stopped: boolean
}

/**
 * AudioContext de mentira: registra o que foi agendado, sem tocar nada. Nada
 * aqui precisa de DOM — é o que permite testar a emenda dos pedaços em Node.
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
  it("converte PCM16LE para amostras em -1..1", () => {
    const samples = decodePcm16(pcm(0, 32767, -32768, 16384, -16384))

    expect(samples.length).toBe(5)
    expect(samples[0]).toBe(0)
    expect(samples[1]).toBeCloseTo(1, 4)
    expect(samples[2]).toBe(-1)
    expect(samples[3]).toBeCloseTo(0.5, 4)
    expect(samples[4]).toBeCloseTo(-0.5, 4)
  })

  it("byte solto no fim é descartado (o quadro é de 2 bytes)", () => {
    const bytes = Buffer.from([0x10, 0x20, 0x30])

    expect(decodePcm16(bytes.toString("base64")).length).toBe(1)
  })

  it("base64 vazio ou inválido vira um buffer vazio, sem estourar", () => {
    expect(decodePcm16("").length).toBe(0)
    expect(decodePcm16("isto-não-é-base64!!").length).toBe(0)
  })
})

describe("ChunkPlayer", () => {
  it("emenda cada pedaço no fim do anterior, respeitando a taxa do pedaço", () => {
    const context = new FakeContext()
    const player = newPlayer(context)

    player.schedule(new Float32Array(2400).fill(0.5), 24000)
    player.schedule(new Float32Array(1200).fill(-0.5), 12000)

    // 0.1s cada; o segundo começa exatamente onde o primeiro termina.
    expect(context.started[0].startedAt).toBeCloseTo(0.02, 4)
    expect(context.started[1].startedAt).toBeCloseTo(0.12, 4)
    expect(player.scheduledEnd).toBeCloseTo(0.22, 4)
    expect(context.buffers[0].samples[0]).toBe(0.5)
    expect(context.buffers[1].sampleRate).toBe(12000)
    expect(player.pending).toBe(2)
  })

  it("se a reprodução atrasou, agenda em 'agora' em vez de acumular espera", () => {
    const context = new FakeContext()
    const player = newPlayer(context)

    player.schedule(new Float32Array(24000).fill(0), 24000)
    context.currentTime = 5
    player.schedule(new Float32Array(240).fill(0), 24000)

    expect(context.started[1].startedAt).toBeCloseTo(5.02, 4)
  })

  it("pedaço vazio não agenda nada nem cria contexto", () => {
    const context = new FakeContext()
    const player = newPlayer(context)

    player.schedule(new Float32Array(0), 24000)

    expect(context.started.length).toBe(0)
    expect(player.pending).toBe(0)
  })

  it("avisa a cada pedaço que termina e para de contar o que já tocou", () => {
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

  it("stopAll interrompe o que estava agendado e zera a fila", () => {
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

  it("close fecha o AudioContext — o hook o abre de novo se falar outra vez", () => {
    const context = new FakeContext()
    const player = newPlayer(context)

    player.schedule(new Float32Array(240).fill(0), 24000)
    player.close()

    expect(context.closed).toBe(true)
    expect(player.pending).toBe(0)
  })
})

describe("readTtsPrefs", () => {
  it("sem o bloco `voice` no store, valem os padrões do app", () => {
    expect(readTtsPrefs(undefined)).toEqual({ enabled: true, voice: "F2", lang: "auto", speed: 1 })
  })

  it("lê o que estiver gravado", () => {
    const prefs = readTtsPrefs({ tts: { enabled: false, voice: "M1", lang: "en", speed: 1.25 } })

    expect(prefs).toEqual({ enabled: false, voice: "M1", lang: "en", speed: 1.25 })
  })

  it("valor fora do domínio cai no padrão em vez de quebrar a fala", () => {
    const prefs = readTtsPrefs({ tts: { voice: "  ", lang: 7, speed: 0 } })

    expect(prefs).toEqual({ enabled: true, voice: "F2", lang: "auto", speed: 1 })
  })
})

describe("readTtsEngine", () => {
  it("sem escolha gravada, vale o padrão: o modelo", () => {
    expect(readTtsEngine(undefined)).toBe("model")
    expect(readTtsEngine({})).toBe("model")
  })

  it("lê a escolha gravada e ignora um valor fora do domínio", () => {
    expect(readTtsEngine({ tts: { engine: "local" } })).toBe("local")
    expect(readTtsEngine({ tts: { engine: "x" } })).toBe("model")
  })
})

describe("readTtsStatus", () => {
  it("sem resposta do main (ou sem motor), o botão não é bloqueado", () => {
    expect(readTtsStatus(undefined)).toEqual({ ready: true, known: false })
    expect(readTtsStatus({ engines: [] })).toEqual({ ready: true, known: false })
  })

  it("ttsReady decide quando vem do main", () => {
    expect(readTtsStatus({ ttsReady: false, models: {} })).toEqual({ ready: false, known: true })
    expect(readTtsStatus({ ttsReady: true })).toEqual({ ready: true, known: true })
  })

  it("sem ttsReady, qualquer modelo instalado libera o botão", () => {
    expect(readTtsStatus({ models: { tts: { installed: true } } }).ready).toBe(true)
    expect(readTtsStatus({ models: { tts: { installed: false } } })).toEqual({ ready: false, known: true })
  })

  it("na prioridade 'modelo', a rota do provedor destrava o botão sem o modelo local", () => {
    expect(readTtsStatus({ ttsReady: false, models: {}, modelTts: { available: true } }, "model")).toEqual({
      ready: true,
      known: true,
    })
  })

  it("na prioridade 'local', a rota do modelo não interfere", () => {
    expect(readTtsStatus({ ttsReady: false, models: {}, modelTts: { available: true } }, "local")).toEqual({
      ready: false,
      known: true,
    })
  })
})

describe("subscribeVoiceStatus", () => {
  it("lê o estado ao assinar e reconsulta a cada voice:status-changed", async () => {
    const fake = fakeSource([{ ttsReady: false }, { ttsReady: true }])
    const seen: unknown[] = []

    const subscription = subscribeVoiceStatus(fake.source, (raw) => seen.push(raw))
    await flush()

    expect(fake.calls()).toBe(1)
    expect(readTtsStatus(seen.at(-1))).toEqual({ ready: false, known: true })

    // O download terminou nas Preferências: o evento destrava o botão sem
    // precisar sair e voltar para o chat.
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

  it("o mesmo payload serve às duas leituras (TTS e ditado)", async () => {
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

  it("main que não respondeu (erro ou sem ponte) não bloqueia ninguém", async () => {
    const seen: unknown[] = []
    const quebrada: VoiceStatusSource = {
      status: () => Promise.reject(new Error("sem motor")),
      onStatusChanged: () => () => {},
    }
    subscribeVoiceStatus(quebrada, (raw) => seen.push(raw))
    await flush()

    expect(readTtsStatus(seen.at(-1))).toEqual({ ready: true, known: false })
    expect(parseVoiceStatus(seen.at(-1))).toBeNull()

    // Ponte que nem existe (preview no navegador): o invoke estoura na hora.
    const semPonte: VoiceStatusSource = {
      status: () => {
        throw new Error("sem ipcRenderer")
      },
      onStatusChanged: () => () => {},
    }
    subscribeVoiceStatus(semPonte, (raw) => seen.push(raw))

    expect(seen.at(-1)).toBeUndefined()
    expect(readTtsStatus(seen.at(-1))).toEqual({ ready: true, known: false })
  })
})

describe("TTS_SAMPLE_RATE", () => {
  it("é a taxa dos pedaços do motor (24 kHz)", () => {
    expect(TTS_SAMPLE_RATE).toBe(24000)
  })
})
