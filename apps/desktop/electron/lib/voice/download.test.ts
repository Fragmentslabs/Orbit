import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceDownloadProgress } from '@shared/voice'

/**
 * O downloader é o único caminho em que o app toca a rede, e o pacote do TTS
 * são 401 MB: um erro de retomada aqui custa o download inteiro de novo. O que
 * estes testes fecham é o comportamento que os modelos de STT (outro worker)
 * assumem: nome do arquivo vindo da URL, tamanho EXATO, `.part` que sobrevive ao
 * cancelamento e volta por `Range`, e integridade conferida no fim.
 *
 * Nada de rede de verdade: um servidor HTTP local no lugar da origem.
 */

const userData = path.join(os.tmpdir(), `orbit-voice-download-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
}))

/** Catálogo de STT de mentira: um modelo, um arquivo, servido localmente. */
const fakeModel = {
  id: 'teste-stt',
  kind: 'stt' as const,
  engine: 'parakeet',
  label: 'Modelo de teste',
  bytes: 0,
  url: '',
  sha256: undefined as string | undefined,
}

vi.mock('./stt', () => ({ STT_MODELS: [fakeModel] }))

const { cancelDownload, downloadModel, isModelDownloaded, modelDir, removeModel, startDownload } =
  await import('./download')

const PAYLOAD = Buffer.alloc(64 * 1024)
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = (i * 7) % 251
const LENTO = Buffer.alloc(2 * 1024 * 1024)
for (let i = 0; i < LENTO.length; i++) LENTO[i] = (i * 13) % 251

/** Espera o `.part` existir com algum conteúdo — é o "já começou a baixar". */
async function esperarParcial(minimo = 1 << 15): Promise<number> {
  for (let i = 0; i < 600; i++) {
    try {
      const tamanho = fs.statSync(arquivo() + '.part').size
      if (tamanho >= minimo) return tamanho
    } catch {
      // ainda não criou
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('o download não começou a escrever o .part')
}

let servidor: http.Server
let base = ''
/** `Range` pedido por cada requisição (null = download inteiro). */
let ranges: (string | null)[] = []
/** Corpo a servir e ritmo (para o teste de cancelamento). */
let corpo: Buffer = PAYLOAD
let porPedaco = 0
let atrasoMs = 0
let status = 200

function escreverDevagar(res: http.ServerResponse, dados: Buffer): void {
  if (!porPedaco) {
    res.end(dados)
    return
  }
  let pos = 0
  const passo = (): void => {
    if (pos >= dados.length) {
      res.end()
      return
    }
    const fim = Math.min(pos + porPedaco, dados.length)
    res.write(dados.subarray(pos, fim))
    pos = fim
    setTimeout(passo, atrasoMs)
  }
  passo()
}

beforeAll(async () => {
  servidor = http.createServer((req, res) => {
    const range = req.headers.range ?? null
    ranges.push(range)
    if (status !== 200) {
      res.writeHead(status).end()
      return
    }
    if (range) {
      const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0)
      const resto = corpo.subarray(from)
      res.writeHead(206, {
        'Content-Range': `bytes ${from}-${corpo.length - 1}/${corpo.length}`,
        'Content-Length': resto.length,
      })
      escreverDevagar(res, resto)
      return
    }
    res.writeHead(200, { 'Content-Length': corpo.length })
    escreverDevagar(res, corpo)
  })
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve))
  const { port } = servidor.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => servidor.close(() => resolve()))
  await fsp.rm(userData, { recursive: true, force: true })
})

beforeEach(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
  ranges = []
  corpo = PAYLOAD
  porPedaco = 0
  atrasoMs = 0
  status = 200
  fakeModel.bytes = corpo.length
  fakeModel.url = `${base}/modelo.bin`
  fakeModel.sha256 = undefined
})

afterEach(() => {
  cancelDownload(fakeModel.id)
})

function arquivo(): string {
  return path.join(modelDir(fakeModel.id), 'modelo.bin')
}

describe('downloadModel', () => {
  it('baixa para userData/voice/models/<id> e avisa o progresso até done', async () => {
    const eventos: VoiceDownloadProgress[] = []
    await downloadModel(fakeModel.id, (p) => eventos.push(p))

    expect(fs.readFileSync(arquivo()).equals(PAYLOAD)).toBe(true)
    expect(await isModelDownloaded(fakeModel.id)).toBe(true)

    const ultimo = eventos.at(-1) as VoiceDownloadProgress
    expect(ultimo).toMatchObject({ modelId: fakeModel.id, received: PAYLOAD.length, total: PAYLOAD.length, done: true })
    expect(ultimo.error).toBeUndefined()
    expect(modelDir(fakeModel.id).startsWith(userData)).toBe(true)
  })

  it('não baixa de novo o que já está completo (idempotente)', async () => {
    await downloadModel(fakeModel.id, () => {})
    ranges = []
    await downloadModel(fakeModel.id, () => {})
    expect(ranges).toEqual([])
  })

  it('cancelar mantém o .part para a retomada, sem marcar erro', async () => {
    corpo = LENTO
    fakeModel.bytes = LENTO.length
    porPedaco = 8 * 1024
    atrasoMs = 3

    const eventos: VoiceDownloadProgress[] = []
    const baixando = downloadModel(fakeModel.id, (p) => eventos.push(p))
    await esperarParcial()
    cancelDownload(fakeModel.id)
    await baixando

    const parcial = arquivo() + '.part'
    expect(fs.existsSync(parcial)).toBe(true)
    expect(fs.statSync(parcial).size).toBeLessThan(LENTO.length)
    expect(await isModelDownloaded(fakeModel.id)).toBe(false)

    const ultimo = eventos.at(-1) as VoiceDownloadProgress
    expect(ultimo.done).toBe(true)
    expect(ultimo.error).toBeUndefined()
    expect(ultimo.received).toBeGreaterThan(0)
  })

  it('retoma de onde parou, pedindo Range com o que já está no disco', async () => {
    corpo = LENTO
    fakeModel.bytes = LENTO.length
    porPedaco = 16 * 1024
    atrasoMs = 5

    const baixando = downloadModel(fakeModel.id, () => {})
    await esperarParcial(64 * 1024)
    cancelDownload(fakeModel.id)
    await baixando

    const parcial = fs.statSync(arquivo() + '.part').size
    ranges = []
    porPedaco = 0
    await downloadModel(fakeModel.id, () => {})

    expect(ranges[0]).toBe(`bytes=${parcial}-`)
    expect(await isModelDownloaded(fakeModel.id)).toBe(true)
    expect(fs.readFileSync(arquivo()).equals(LENTO)).toBe(true)
  })

  it('um .part já do tamanho certo é finalizado sem tocar na origem', async () => {
    // O processo caiu entre a última escrita e o rename.
    await fsp.mkdir(modelDir(fakeModel.id), { recursive: true })
    await fsp.writeFile(arquivo() + '.part', PAYLOAD)

    ranges = []
    await downloadModel(fakeModel.id, () => {})

    expect(ranges).toEqual([])
    expect(await isModelDownloaded(fakeModel.id)).toBe(true)
    expect(fs.existsSync(arquivo() + '.part')).toBe(false)
  })

  it('sha256 que não confere vira erro e apaga o parcial', async () => {
    fakeModel.sha256 = '0'.repeat(64)
    const eventos: VoiceDownloadProgress[] = []
    await downloadModel(fakeModel.id, (p) => eventos.push(p))

    const ultimo = eventos.at(-1) as VoiceDownloadProgress
    expect(ultimo.done).toBe(true)
    expect(ultimo.error).toMatch(/corrompido/)
    expect(fs.existsSync(arquivo())).toBe(false)
    expect(fs.existsSync(arquivo() + '.part')).toBe(false)
    expect(await isModelDownloaded(fakeModel.id)).toBe(false)
  })

  it('origem com erro vira erro no progresso, sem arquivo instalado', async () => {
    status = 404
    const eventos: VoiceDownloadProgress[] = []
    await downloadModel(fakeModel.id, (p) => eventos.push(p))

    const ultimo = eventos.at(-1) as VoiceDownloadProgress
    expect(ultimo.error).toMatch(/404/)
    expect(await isModelDownloaded(fakeModel.id)).toBe(false)
  })

  it('startDownload não abre um segundo download do mesmo modelo', async () => {
    corpo = LENTO
    fakeModel.bytes = LENTO.length
    porPedaco = 8 * 1024
    atrasoMs = 3

    const primeiro = startDownload(fakeModel.id, () => {})
    expect(primeiro.started).toBe(true)
    expect(startDownload(fakeModel.id, () => {}).started).toBe(false)
    cancelDownload(fakeModel.id)
  })

  it('removeModel apaga a pasta do modelo', async () => {
    await downloadModel(fakeModel.id, () => {})
    await removeModel(fakeModel.id)
    expect(fs.existsSync(modelDir(fakeModel.id))).toBe(false)
    expect(await isModelDownloaded(fakeModel.id)).toBe(false)
  })
})
