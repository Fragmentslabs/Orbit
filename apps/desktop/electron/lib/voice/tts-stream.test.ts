import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Fala contínua (`voice:tts:stream-*`, modo chamada): as frases chegam aos
 * pedaços e a síntese corre à frente da reprodução — a frase seguinte começa a
 * ser gerada assim que a anterior termina de ser GERADA, sem esperar o renderer
 * tocá-la. Era essa espera que deixava o silêncio entre "Claro." e o resto.
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

/** Síntese simulada: 30 ms por frase, um pedaço de áudio por frase. */
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
    if (doneOf(id).length === 0) throw new Error('ainda sem done')
  })

beforeEach(() => {
  sent.length = 0
  spoken.length = 0
  failOn = null
})

describe('fala contínua', () => {
  it('fala as frases na ordem, uma emendada na outra, e termina uma vez só', async () => {
    const { id } = (await call('voice:tts:stream-start', { engine: 'local' })) as { id: string }
    await call('voice:tts:stream-append', { id, text: 'Claro.' })
    // Chega enquanto "Claro." ainda está sendo gerado.
    await call('voice:tts:stream-append', { id, text: 'Aqui está o resumo.' })
    await call('voice:tts:stream-append', { id, text: 'Foram três decisões.' })
    await call('voice:tts:stream-end', { id })
    await waitDone(id)

    expect(spoken.map((s) => s.text)).toEqual(['Claro.', 'Aqui está o resumo.', 'Foram três decisões.'])
    const audio = sent
      .filter((e) => e.canal === 'voice:tts:chunk' && e.payload.id === id)
      .map((e) => Buffer.from(e.payload.pcm ?? '', 'base64').toString())
    expect(audio).toEqual(['Claro.', 'Aqui está o resumo.', 'Foram três decisões.'])
    // Cada frase começa logo que a anterior foi gerada (~30 ms), não depois de tocar.
    expect(spoken[1].startedAt - spoken[0].startedAt).toBeLessThan(200)
    // Cada pedaço diz de qual frase é: o renderer mostra a que está tocando.
    const segs = sent.filter((e) => e.canal === 'voice:tts:chunk').map((e) => (e.payload as { seg?: number }).seg)
    expect(segs).toEqual([0, 1, 2])
    expect(doneOf(id)).toEqual([{ canal: 'voice:tts:done', payload: { id } }])
  })

  it('espera a próxima frase enquanto a fala estiver aberta', async () => {
    const { id } = (await call('voice:tts:stream-start', { engine: 'local' })) as { id: string }
    await call('voice:tts:stream-append', { id, text: 'Um.' })
    await new Promise((resolve) => setTimeout(resolve, 120))
    // A fila esvaziou, mas sem `end` a fala continua aberta.
    expect(doneOf(id)).toHaveLength(0)
    await call('voice:tts:stream-append', { id, text: 'Dois.' })
    await call('voice:tts:stream-end', { id })
    await waitDone(id)
    expect(spoken.map((s) => s.text)).toEqual(['Um.', 'Dois.'])
  })

  it('falha da síntese encerra a fala com o erro', async () => {
    failOn = 'Dois.'
    const { id } = (await call('voice:tts:stream-start', { engine: 'local' })) as { id: string }
    await call('voice:tts:stream-append', { id, text: 'Um.' })
    await call('voice:tts:stream-append', { id, text: 'Dois.' })
    await waitDone(id)
    expect(doneOf(id)[0].payload.error).toBe('motor caiu')
  })

  it('clear descarta as frases ainda não geradas e a fala continua aberta', async () => {
    const { id } = (await call('voice:tts:stream-start', { engine: 'local' })) as { id: string }
    await call('voice:tts:stream-append', { id, text: 'Deixa eu ver.' })
    await call('voice:tts:stream-append', { id, text: 'Pensamento um.' })
    await call('voice:tts:stream-append', { id, text: 'Pensamento dois.' })
    // "Deixa eu ver." já está sendo gerada; as outras duas ainda esperam.
    await call('voice:tts:stream-clear', { id })
    await call('voice:tts:stream-append', { id, text: 'Abre às oito.' })
    await call('voice:tts:stream-end', { id })
    await waitDone(id)
    expect(spoken.map((s) => s.text)).toEqual(['Deixa eu ver.', 'Abre às oito.'])
    // As descartadas consumiram os números 1 e 2: o renderer conta igual.
    const segs = sent.filter((e) => e.canal === 'voice:tts:chunk').map((e) => (e.payload as { seg?: number }).seg)
    expect(segs).toEqual([0, 3])
  })

  it('cancelada (interromper), para de gerar e não acusa erro', async () => {
    const { id } = (await call('voice:tts:stream-start', { engine: 'local' })) as { id: string }
    await call('voice:tts:stream-append', { id, text: 'Um.' })
    await call('voice:tts:stream-append', { id, text: 'Dois.' })
    await call('voice:tts:cancel', { id })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(spoken.map((s) => s.text)).toEqual(['Um.'])
    expect(doneOf(id)).toHaveLength(0)
  })
})
