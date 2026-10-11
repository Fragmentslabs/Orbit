import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * O cliente do motor de TTS é o que o resto do app enxerga, e o que ele precisa
 * acertar não é a inferência (essa roda no filho): é o PROTOCOLO. Um `done`
 * perdido deixa o renderer com o spinner para sempre; um `cancel` que não chega
 * ao motor faz o pedaço seguinte tocar depois de o usuário desistir; e um
 * processo que morre sem avisar deixa a fala pendurada.
 *
 * Nada aqui sobe ONNX: o processo filho é de mentira e responde o protocolo na
 * mão. (A inferência de verdade foi medida rodando o motor com os modelos do
 * laboratório — ver README.md de voice-engine.)
 */

// O motor embutido é encontrado a partir do APP_ROOT (como no main em dev).
process.env.APP_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const estado = vi.hoisted(() => ({
  child: null as unknown,
  instalado: true,
  fork: null as unknown,
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class FakeChild extends Emitter {
    posted: Record<string, unknown>[] = []
    pid = 4242
    stdout = new Emitter()
    stderr = new Emitter()
    morto = false
    postMessage(msg: Record<string, unknown>): void {
      this.posted.push(msg)
    }
    kill(): void {
      this.morto = true
      this.emit('exit', 0)
    }
    // ── helpers do teste ────────────────────────────────────────────────────
    pronto(): void {
      this.emit('message', { type: 'ready', bootMs: 12, voices: ['F2'], sr: 24000 })
    }
    pedaco(id: string, i: number, n: number): void {
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
    fim(id: string, extra: Record<string, unknown> = {}): void {
      this.emit('message', { id, done: true, pieces: 1, audioMs: 1500, wallMs: 90, rtf: 0.06, ...extra })
    }
    morrer(code = 1): void {
      this.emit('exit', code)
    }
  }
  return {
    app: { getPath: () => '/tmp/orbit-voice-tts-teste', getAppPath: () => '/tmp/orbit-voice-tts-teste/app' },
    utilityProcess: {
      fork: (file: string, args: string[], options: Record<string, unknown>) => {
        estado.fork = { file, args, options }
        const child = new FakeChild()
        estado.child = child
        return child
      },
    },
  }
})

vi.mock('./download', () => ({
  isModelDownloaded: async () => estado.instalado,
  modelDir: () => '/tmp/orbit-voice-tts-teste/models/supertonic-3',
}))

// O manifesto puxa o catálogo de STT (motor pesado); aqui só interessa o TTS.
vi.mock('./stt', () => ({ STT_MODELS: [] }))

const { enginePresent, shutdownTts, speak, ttsStatus } = await import('./tts')

interface FakeChild {
  posted: Record<string, unknown>[]
  pid: number
  morto: boolean
  pronto(): void
  pedaco(id: string, i: number, n: number): void
  fim(id: string, extra?: Record<string, unknown>): void
  morrer(code?: number): void
}

const filho = (): FakeChild => estado.child as FakeChild

/** Gira as microtarefas até a condição valer (sem depender de contar ticks). */
async function ate<T>(obter: () => T | undefined, o_que: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const valor = obter()
    if (valor !== undefined && valor !== null) return valor
    await Promise.resolve()
  }
  throw new Error(`espera esgotada: ${o_que}`)
}

async function esperarFork(): Promise<FakeChild> {
  return await ate(() => (estado.child ? filho() : undefined), 'o motor subir')
}

async function esperarPostado(cmd: string): Promise<Record<string, unknown>> {
  return await ate(() => filho().posted.find((m) => m.cmd === cmd), `o main mandar ${cmd}`)
}

/**
 * Faz o fluxo completo: pede a fala, responde o `ready` e devolve o pedido que
 * chegou ao (falso) motor.
 */
async function pedidoDeFala(
  texto = 'olá mundo',
  onChunk: (c: { i: number; sr: number; pcm: Buffer }) => void = () => {},
  signal?: AbortSignal,
): Promise<{ id: string; fala: Promise<{ pieces: number; audioMs: number; cancelled: boolean }> }> {
  const fala = speak(texto, { voice: 'F2', lang: 'pt' }, onChunk, signal)
  const motor = await esperarFork()
  motor.pronto()
  const pedido = await esperarPostado('speak')
  return { id: String(pedido.id), fala }
}

afterEach(() => {
  vi.useRealTimers()
  estado.instalado = true
  estado.child = null
  shutdownTts()
})

describe('speak', () => {
  it('sobe o motor embutido, com os assets de userData e heap de 4 GB', async () => {
    const fala = speak('oi', {}, () => {})
    await esperarFork()

    const fork = estado.fork as { file: string; args: string[]; options: Record<string, unknown> }
    expect(fork.file.endsWith(path.join('electron', 'voice-engine', 'engine.mjs'))).toBe(true)
    expect(fork.args).toEqual(['--assets', '/tmp/orbit-voice-tts-teste/models/supertonic-3'])
    expect(fork.options.execArgv).toEqual(['--max-old-space-size=4096'])
    expect(fork.options.stdio).toBe('pipe')

    // Fecha o processo antes de a fala começar: o pedido vira erro, não fica pendurado.
    filho().morrer(0)
    await expect(fala).rejects.toThrow(/encerrou durante a inicialização \(código 0\)/)
  })

  it('entrega cada pedaço como PCM e resolve com o resumo do motor', async () => {
    const pedacos: { i: number; sr: number; pcm: Buffer }[] = []
    const { id, fala } = await pedidoDeFala('olá mundo', (c) => pedacos.push({ i: c.i, sr: c.sr, pcm: c.pcm }))

    const pedido = filho().posted.find((m) => m.cmd === 'speak') as Record<string, unknown>
    expect(pedido).toMatchObject({ cmd: 'speak', text: 'olá mundo', voice: 'F2', lang: 'pt' })

    filho().pedaco(id, 0, 2)
    filho().pedaco(id, 1, 2)
    filho().fim(id, { pieces: 2, audioMs: 3000 })

    expect(await fala).toMatchObject({ pieces: 2, audioMs: 3000, cancelled: false })
    expect(pedacos).toHaveLength(2)
    expect(pedacos[0].pcm.equals(Buffer.from([1, 2, 3, 4]))).toBe(true)
    expect(pedacos[0].sr).toBe(24000)
  })

  it('cancelar avisa o motor e o pedido volta como cancelado', async () => {
    const controle = new AbortController()
    const { id, fala } = await pedidoDeFala('olá mundo', () => {}, controle.signal)
    filho().pedaco(id, 0, 3)

    controle.abort()
    expect(filho().posted.at(-1)).toMatchObject({ cmd: 'cancel', id })

    filho().fim(id, { cancelled: true, audioMs: 1500 })
    expect((await fala).cancelled).toBe(true)
  })

  it('com o signal já abortado, nem chega a pedir fala', async () => {
    const controle = new AbortController()
    controle.abort()
    const resultado = await speak('olá mundo', {}, () => {}, controle.signal)
    expect(resultado).toMatchObject({ cancelled: true, pieces: 0 })
    expect(estado.child).toBeNull()
  })

  it('erro do motor vira rejeição com a mensagem dele', async () => {
    const { id, fala } = await pedidoDeFala()
    filho().fim(id, { error: 'motor sem memória' })
    await expect(fala).rejects.toThrow('motor sem memória')
  })

  it('motor que morre no meio rejeita o pedido em vez de deixá-lo pendurado', async () => {
    const { fala } = await pedidoDeFala()
    filho().morrer(7)
    await expect(fala).rejects.toThrow(/encerrou \(código 7\)/)
  })

  it('sem o modelo baixado, o motor nem sobe', async () => {
    estado.instalado = false
    await expect(speak('olá mundo', {}, () => {})).rejects.toThrow(/não foram baixados/)
    expect(estado.child).toBeNull()
  })

  it('texto vazio é recusado antes de qualquer coisa', async () => {
    await expect(speak('   ', {}, () => {})).rejects.toThrow(/vazio/)
  })
})

describe('ociosidade', () => {
  it('sem uso, o motor recebe shutdown e depois é morto', async () => {
    vi.useFakeTimers()
    const fala = speak('olá mundo', {}, () => {})
    await vi.advanceTimersByTimeAsync(0)
    const motor = await esperarFork()
    motor.pronto()
    const pedido = await esperarPostado('speak')
    motor.fim(String(pedido.id))
    await fala

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1)
    expect(motor.posted.at(-1)).toMatchObject({ cmd: 'shutdown' })

    await vi.advanceTimersByTimeAsync(2_500)
    expect(motor.morto).toBe(true)
    expect(motor.posted.filter((m) => m.cmd === 'shutdown')).toHaveLength(1)
  })
})

describe('ttsStatus', () => {
  it('reflete o modelo instalado e o motor parado', async () => {
    const status = await ttsStatus()
    expect(status).toMatchObject({ installed: true, running: false, pending: 0 })
    expect(Array.isArray(status.log)).toBe(true)
  })

  it('o motor embutido está onde o cliente o procura', () => {
    expect(enginePresent()).toBe(true)
  })
})
