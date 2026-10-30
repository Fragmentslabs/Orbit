import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Continuous speech (`voice:tts:stream-*`, call mode): the sentences arrive at the
 * chunks and the synthesis runs ahead of playback — the next sentence starts
 * being generated as soon as the previous one finishes being GENERATED, without waiting for the renderer
 * to play it. It was that wait that left the silence between "Claro." and the rest.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const sent: { canal: string; payload: { id?: string; error?: string; pcm?: string } }[] = []

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orbit-tts-stream-test', isPackaged: false },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (canal: string, payload: never) => sent.push({ canal, payload }) } },
    ],
  },
  ipcMain: { handle: (canal: string, fn: (...args: unknown[]) => unknown) => handlers.set(canal, fn) },
}))
vi.mock('../app-settings', async () => {
  const { DEFAULT_APP_SETTINGS } = await import('@shared/app-settings')
  return { getAppSettings: () => DEFAULT_APP_SETTINGS, onAppSettingsChange: () => () => {} }
})

/** Simulated synthesis: 30 ms per sentence, one audio chunk per sentence. */
const spoken: { text: string; startedAt: number }[] = []
let failOn: string | null = null
vi.mock('./tts', () => ({
  speak: async (
    text: string,
    _options: unknown,
    onChunk: (chunk: { pcm: Buffer; sr: number; i: number; n: number }) => void,
    signal?: AbortSignal,
  ) => {
    spoken.push({ text, startedAt: Date.now() })
    await new Promise((resolve) => setTimeout(resolve, 30))
    if (signal?.aborted) throw new Error('cancelada')
    if (text === failOn) throw new Error('motor caiu')
    onChunk({ pcm: Buffer.from(text), sr: 24000, i: 0, n: 1 })
    return {}
  },
  shutdownTts: () => {},
  ttsStatus: async () => ({}),
  enginePresent: () => true,
}))

const { registerVoiceIpc } = await import('./index')
registerVoiceIpc()

const call = (canal: string, payload: unknown) => handlers.get(canal)!({}, payload)
const doneOf = (id: string) => sent.filter((e) => e.canal === 'voice:tts:done' && e.payload.id === id)
const waitDone = (id: string) =>
  vi.waitFor(() => {
    if (doneOf(id).length === 0) throw new Error('still without done')
  })

beforeEach(() => {
  sent.length = 0
  spoken.length = 0
  failOn = null
})

describe('continuous speech', () => {
  it('speaks the sentences in order, one spliced onto the next, and ends only once', async () => {
    const { id } = (await call('voice:tts:stream-start', { engine: 'local' })) as { id: string }
    await call('voice:tts:stream-append', { id, text: 'Claro.' })
    // It arrives while "Claro." is still being generated.
    await call('voice:tts:stream-append', { id, text: 'Aqui está o resumo.' })
    await call('voice:tts:stream-append', { id, text: 'Foram três decisões.' })
    await call('voice:tts:stream-end', { id })
    await waitDone(id)

    expect(spoken.map((s) => s.text)).toEqual(['Claro.', 'Aqui está o resumo.', 'Foram três decisões.'])
    const audio = sent
      .filter((e) => e.canal === 'voice:tts:chunk' && e.payload.id === id)
      .map((e) => Buffer.from(e.payload.pcm ?? '', 'base64').toString())
    expect(audio).toEqual(['Claro.', 'Aqui está o resumo.', 'Foram três decisões.'])
    // Each sentence starts as soon as the previous one was generated (~30 ms), not after it plays.
    expect(spoken[1].startedAt - spoken[0].startedAt).toBeLessThan(200)
    // Each chunk says which sentence it belongs to: the renderer shows the one that is playing.
    const segs = sent.filter((e) => e.canal === 'voice:tts:chunk').map((e) => (e.payload as { seg?: number }).seg)
    expect(segs).toEqual([0, 1, 2])
    expect(doneOf(id)).toEqual([{ canal: 'voice:tts:done', payload: { id } }])
  })

  it('waits for the next sentence while the speech is open', async () => {
    const { id } = (await call('voice:tts:stream-start', { engine: 'local' })) as { id: string }
    await call('voice:tts:stream-append', { id, text: 'Um.' })
    await new Promise((resolve) => setTimeout(resolve, 120))
    // The queue emptied, but without `end` the utterance stays open.
    expect(doneOf(id)).toHaveLength(0)
    await call('voice:tts:stream-append', { id, text: 'Dois.' })
    await call('voice:tts:stream-end', { id })
    await waitDone(id)
    expect(spoken.map((s) => s.text)).toEqual(['Um.', 'Dois.'])
  })

  it('a synthesis failure closes the speech with the error', async () => {
    failOn = 'Dois.'
    const { id } = (await call('voice:tts:stream-start', { engine: 'local' })) as { id: string }
    await call('voice:tts:stream-append', { id, text: 'Um.' })
    await call('voice:tts:stream-append', { id, text: 'Dois.' })
    await waitDone(id)
    expect(doneOf(id)[0].payload.error).toBe('motor caiu')
  })

  it('clear drops the sentences not yet generated and the speech stays open', async () => {
    const { id } = (await call('voice:tts:stream-start', { engine: 'local' })) as { id: string }
    await call('voice:tts:stream-append', { id, text: 'Deixa eu ver.' })
    await call('voice:tts:stream-append', { id, text: 'Pensamento um.' })
    await call('voice:tts:stream-append', { id, text: 'Pensamento dois.' })
    // "Deixa eu ver." is already being generated; the other two still wait.
    await call('voice:tts:stream-clear', { id })
    await call('voice:tts:stream-append', { id, text: 'Abre às oito.' })
    await call('voice:tts:stream-end', { id })
    await waitDone(id)
    expect(spoken.map((s) => s.text)).toEqual(['Deixa eu ver.', 'Abre às oito.'])
    // The discarded ones consumed numbers 1 and 2: the renderer counts the same way.
    const segs = sent.filter((e) => e.canal === 'voice:tts:chunk').map((e) => (e.payload as { seg?: number }).seg)
    expect(segs).toEqual([0, 3])
  })

  it('cancelled (interrupt), it stops generating and does not report an error', async () => {
    const { id } = (await call('voice:tts:stream-start', { engine: 'local' })) as { id: string }
    await call('voice:tts:stream-append', { id, text: 'Um.' })
    await call('voice:tts:stream-append', { id, text: 'Dois.' })
    await call('voice:tts:cancel', { id })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(spoken.map((s) => s.text)).toEqual(['Um.'])
    expect(doneOf(id)).toHaveLength(0)
  })
})
