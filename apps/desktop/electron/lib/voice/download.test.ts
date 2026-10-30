import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceDownloadProgress } from '@shared/voice'

/**
 * The downloader is the only path where the app touches the network, and the TTS package
 * is 401 MB: a resumption error here costs the whole download again. What
 * these tests close is the behaviour that the STT models (another worker)
 * assume: file name coming from the URL, EXACT size, a `.part` that survives
 * cancellation and resumes through `Range`, and integrity checked at the end.
 *
 * No real network: a local HTTP server in place of the origin.
 */

const userData = path.join(os.tmpdir(), `orbit-voice-download-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
}))

/** Fake STT catalog: one model, one file, served locally. */
const fakeModel = {
  id: 'test-stt',
  kind: 'stt' as const,
  engine: 'parakeet',
  label: 'Test model',
  bytes: 0,
  url: '',
  sha256: undefined as string | undefined,
}

vi.mock('./stt', () => ({ STT_MODELS: [fakeModel] }))

const { cancelDownload, downloadModel, isModelDownloaded, modelDir, removeModel, startDownload } =
  await import('./download')

const PAYLOAD = Buffer.alloc(64 * 1024)
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = (i * 7) % 251
const SLOW = Buffer.alloc(2 * 1024 * 1024)
for (let i = 0; i < SLOW.length; i++) SLOW[i] = (i * 13) % 251

/** Waits for the `.part` to exist with some content — it is the "download has started". */
async function waitForPartial(minimum = 1 << 15): Promise<number> {
  for (let i = 0; i < 600; i++) {
    try {
      const size = fs.statSync(targetFile() + '.part').size
      if (size >= minimum) return size
    } catch {
      // has not created it yet
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('the download did not start writing the .part')
}

let server: http.Server
let base = ''
/** `Range` requested by each request (null = whole download). */
let ranges: (string | null)[] = []
/** Body to serve and pace (for the cancellation test). */
let body: Buffer = PAYLOAD
let perChunk = 0
let delayMs = 0
let status = 200

function writeSlowly(res: http.ServerResponse, data: Buffer): void {
  if (!perChunk) {
    res.end(data)
    return
  }
  let cursor = 0
  const step = (): void => {
    if (cursor >= data.length) {
      res.end()
      return
    }
    const end = Math.min(cursor + perChunk, data.length)
    res.write(data.subarray(cursor, end))
    cursor = end
    setTimeout(step, delayMs)
  }
  step()
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const range = req.headers.range ?? null
    ranges.push(range)
    if (status !== 200) {
      res.writeHead(status).end()
      return
    }
    if (range) {
      const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0)
      const rest = body.subarray(from)
      res.writeHead(206, {
        'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}`,
        'Content-Length': rest.length,
      })
      writeSlowly(res, rest)
      return
    }
    res.writeHead(200, { 'Content-Length': body.length })
    writeSlowly(res, body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fsp.rm(userData, { recursive: true, force: true })
})

beforeEach(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
  ranges = []
  body = PAYLOAD
  perChunk = 0
  delayMs = 0
  status = 200
  fakeModel.bytes = body.length
  fakeModel.url = `${base}/model.bin`
  fakeModel.sha256 = undefined
})

afterEach(() => {
  cancelDownload(fakeModel.id)
})

function targetFile(): string {
  return path.join(modelDir(fakeModel.id), 'model.bin')
}

describe('downloadModel', () => {
  it('downloads to userData/voice/models/<id> and reports progress until done', async () => {
    const events: VoiceDownloadProgress[] = []
    await downloadModel(fakeModel.id, (p) => events.push(p))

    expect(fs.readFileSync(targetFile()).equals(PAYLOAD)).toBe(true)
    expect(await isModelDownloaded(fakeModel.id)).toBe(true)

    const last = events.at(-1) as VoiceDownloadProgress
    expect(last).toMatchObject({ modelId: fakeModel.id, received: PAYLOAD.length, total: PAYLOAD.length, done: true })
    expect(last.error).toBeUndefined()
    expect(modelDir(fakeModel.id).startsWith(userData)).toBe(true)
  })

  it('does not download again what is already complete (idempotent)', async () => {
    await downloadModel(fakeModel.id, () => {})
    ranges = []
    await downloadModel(fakeModel.id, () => {})
    expect(ranges).toEqual([])
  })

  it('cancelling keeps the .part for resuming, without marking an error', async () => {
    body = SLOW
    fakeModel.bytes = SLOW.length
    perChunk = 8 * 1024
    delayMs = 3

    const events: VoiceDownloadProgress[] = []
    const downloading = downloadModel(fakeModel.id, (p) => events.push(p))
    await waitForPartial()
    cancelDownload(fakeModel.id)
    await downloading

    const partial = targetFile() + '.part'
    expect(fs.existsSync(partial)).toBe(true)
    expect(fs.statSync(partial).size).toBeLessThan(SLOW.length)
    expect(await isModelDownloaded(fakeModel.id)).toBe(false)

    const last = events.at(-1) as VoiceDownloadProgress
    expect(last.done).toBe(true)
    expect(last.error).toBeUndefined()
    expect(last.received).toBeGreaterThan(0)
  })

  it('resumes where it stopped, asking for a Range with what is already on disk', async () => {
    body = SLOW
    fakeModel.bytes = SLOW.length
    perChunk = 16 * 1024
    delayMs = 5

    const downloading = downloadModel(fakeModel.id, () => {})
    await waitForPartial(64 * 1024)
    cancelDownload(fakeModel.id)
    await downloading

    const partial = fs.statSync(targetFile() + '.part').size
    ranges = []
    perChunk = 0
    await downloadModel(fakeModel.id, () => {})

    expect(ranges[0]).toBe(`bytes=${partial}-`)
    expect(await isModelDownloaded(fakeModel.id)).toBe(true)
    expect(fs.readFileSync(targetFile()).equals(SLOW)).toBe(true)
  })

  it('a .part already at the right size is finalized without touching the origin', async () => {
    // The process died between the last write and the rename.
    await fsp.mkdir(modelDir(fakeModel.id), { recursive: true })
    await fsp.writeFile(targetFile() + '.part', PAYLOAD)

    ranges = []
    await downloadModel(fakeModel.id, () => {})

    expect(ranges).toEqual([])
    expect(await isModelDownloaded(fakeModel.id)).toBe(true)
    expect(fs.existsSync(targetFile() + '.part')).toBe(false)
  })

  it('a sha256 mismatch becomes an error and deletes the partial', async () => {
    fakeModel.sha256 = '0'.repeat(64)
    const events: VoiceDownloadProgress[] = []
    await downloadModel(fakeModel.id, (p) => events.push(p))

    const last = events.at(-1) as VoiceDownloadProgress
    expect(last.done).toBe(true)
    expect(last.error).toMatch(/corrupted/)
    expect(fs.existsSync(targetFile())).toBe(false)
    expect(fs.existsSync(targetFile() + '.part')).toBe(false)
    expect(await isModelDownloaded(fakeModel.id)).toBe(false)
  })

  it('an origin with an error becomes a progress error, with no installed file', async () => {
    status = 404
    const events: VoiceDownloadProgress[] = []
    await downloadModel(fakeModel.id, (p) => events.push(p))

    const last = events.at(-1) as VoiceDownloadProgress
    expect(last.error).toMatch(/404/)
    expect(await isModelDownloaded(fakeModel.id)).toBe(false)
  })

  it('startDownload does not open a second download of the same model', async () => {
    body = SLOW
    fakeModel.bytes = SLOW.length
    perChunk = 8 * 1024
    delayMs = 3

    const first = startDownload(fakeModel.id, () => {})
    expect(first.started).toBe(true)
    expect(startDownload(fakeModel.id, () => {}).started).toBe(false)
    cancelDownload(fakeModel.id)
  })

  it('removeModel deletes the model folder', async () => {
    await downloadModel(fakeModel.id, () => {})
    await removeModel(fakeModel.id)
    expect(fs.existsSync(modelDir(fakeModel.id))).toBe(false)
    expect(await isModelDownloaded(fakeModel.id)).toBe(false)
  })
})
