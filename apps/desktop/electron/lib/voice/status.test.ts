import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceModelState } from '@shared/voice'
import { setMainLocale } from '../i18n'

/**
 * `voice:status` is what the UI reads to paint the badge ("installed") and the reason
 * text. The underlying bug was the downloader and the engine disagreeing: the badge said
 * "Not installed" and the reason, right below, said the package was downloaded.
 *
 * Here both answers come from the SAME snapshot (`installed` + `state` +
 * `reason`), so the invariant under test is: `installed` is true ONLY when the
 * engine can use the model (`state === "ready"`), and every non-ready state
 * carries a reason. The disk and the engines are stubs: what is closed is the mapping.
 */

const state = vi.hoisted(() => ({
  downloaded: false,
  installed: false,
  downloading: false,
  received: 0,
  progress: null as { error?: string } | null,
  extract: { phase: 'idle' as 'idle' | 'extracting' | 'error', error: null as string | null },
  engine: true,
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orbit-voice-status-test', getAppPath: () => '/tmp/orbit-voice-status-test' },
}))

vi.mock('./download', () => ({
  isModelDownloaded: async () => state.downloaded,
  isDownloading: () => state.downloading,
  receivedBytes: async () => state.received,
  progressOf: () => state.progress,
}))

vi.mock('./models-store', () => ({
  parakeetExtractPhase: () => state.extract,
}))

vi.mock('./tts', () => ({
  enginePresent: () => state.engine,
}))

// The route through the MODEL lives in ./model-tts (catalog/providers, which do not fit
// in this test): what matters here is that the snapshot publishes it as it came.
vi.mock('./model-tts', () => ({
  modelTtsStatus: async () => ({ available: false, reason: 'with no speech provider' }),
}))

vi.mock('./stt', () => ({
  STT_MODELS: [
    {
      id: 'parakeet-tdt-0.6b-v3',
      kind: 'stt',
      engine: 'parakeet',
      label: 'Parakeet TDT 0.6B v3',
      bytes: 487170055,
      url: 'https://example.org/parakeet.tar.bz2',
      langs: ['pt'],
      archive: true,
    },
  ],
  sttEngineStatus: async () => [],
  sttModelInstalled: () => state.installed,
}))

const { voiceModelStatus, voiceStatusSnapshot } = await import('./status')
const { modelInfo, VOICE_MODELS } = await import('./manifest')

const PARAKEET = 'parakeet-tdt-0.6b-v3'
const TTS = 'supertonic-3'

beforeEach(() => {
  // The reason sentences go through the main i18n now; the assertions below are the
  // product's default language.
  setMainLocale('Portuguese')
  state.downloaded = false
  state.installed = false
  state.downloading = false
  state.received = 0
  state.progress = null
  state.extract = { phase: 'idle', error: null }
  state.engine = true
})

describe('voiceModelStatus', () => {
  it('missing model: absent, not installed, with a reason', async () => {
    const st = await voiceModelStatus(modelInfo(PARAKEET)!)
    expect(st).toMatchObject({ downloaded: false, installed: false, state: 'absent' })
    expect(st.reason).toBe('ainda não foi baixado')
    expect(st.total).toBe(487170055)
  })

  it('a downloaded and not extracted package NEVER shows as installed', async () => {
    state.downloaded = true
    state.installed = false
    const st = await voiceModelStatus(modelInfo(PARAKEET)!)
    // The bug: the downloader would say "installed" and the engine "not ready".
    expect(st.downloaded).toBe(true)
    expect(st.installed).toBe(false)
    expect(st.state).toBe('downloaded')
    expect(st.reason).toMatch(/falta extrair/)
  })

  it('extracting the package: an explicit intermediate state', async () => {
    state.downloaded = true
    state.extract = { phase: 'extracting', error: null }
    const st = await voiceModelStatus(modelInfo(PARAKEET)!)
    expect(st.installed).toBe(false)
    expect(st.state).toBe('extracting')
    expect(st.reason).toMatch(/extraindo/)
  })

  it('extraction failed: becomes an error with the concrete reason', async () => {
    state.downloaded = true
    state.extract = { phase: 'error', error: 'falha ao extrair o pacote (tar): bzip2: dados corrompidos' }
    const st = await voiceModelStatus(modelInfo(PARAKEET)!)
    expect(st.state).toBe('error')
    expect(st.installed).toBe(false)
    expect(st.error).toMatch(/bzip2/)
    expect(st.reason).toBe(st.error)
  })

  it('ready: only then is installed true, and with no reason', async () => {
    state.downloaded = true
    state.installed = true
    const st = await voiceModelStatus(modelInfo(PARAKEET)!)
    expect(st.state).toBe('ready')
    expect(st.installed).toBe(true)
    expect(st.reason).toBeUndefined()
  })

  it('download in progress and partial download have distinct states', async () => {
    state.downloading = true
    expect((await voiceModelStatus(modelInfo(PARAKEET)!)).state).toBe('downloading')

    state.downloading = false
    state.received = 1024
    const parcial = await voiceModelStatus(modelInfo(PARAKEET)!)
    expect(parcial.state).toBe('partial')
    expect(parcial.reason).toMatch(/1024 de 487170055/)
  })

  it('download failure: state error with the reason', async () => {
    state.progress = { error: 'origem respondeu 404' }
    const st = await voiceModelStatus(modelInfo(PARAKEET)!)
    expect(st.state).toBe('error')
    expect(st.installed).toBe(false)
    expect(st.reason).toBe('origem respondeu 404')
  })

  it('invariant: installed is true only in ready, and every other state has a reason', async () => {
    const scenarios: Array<[VoiceModelState, () => void]> = [
      ['ready', () => ((state.downloaded = true), (state.installed = true))],
      ['downloaded', () => (state.downloaded = true)],
      ['extracting', () => ((state.downloaded = true), (state.extract = { phase: 'extracting', error: null }))],
      ['error', () => (state.progress = { error: 'falhou' })],
      ['downloading', () => (state.downloading = true)],
      ['partial', () => (state.received = 10)],
      ['absent', () => undefined],
    ]
    for (const [expected, montar] of scenarios) {
      state.downloaded = false
      state.installed = false
      state.downloading = false
      state.received = 0
      state.progress = null
      state.extract = { phase: 'idle', error: null }
      montar()
      const st = await voiceModelStatus(modelInfo(PARAKEET)!)
      expect(st.state).toBe(expected)
      expect(st.installed).toBe(st.state === 'ready')
      expect(st.ready).toBe(st.installed)
      if (st.state !== 'ready') expect(st.reason?.length).toBeGreaterThan(0)
    }
  })
})

describe('voiceStatusSnapshot', () => {
  it('brings the whole catalog and only marks ttsReady with the model and the engine ready', async () => {
    state.downloaded = true
    state.installed = true
    state.engine = false
    const withoutEngine = await voiceStatusSnapshot()
    expect(Object.keys(withoutEngine.models).sort()).toEqual(VOICE_MODELS.map((m) => m.id).sort())
    expect(withoutEngine.models[TTS].installed).toBe(true)
    expect(withoutEngine.ttsReady).toBe(false)

    state.engine = true
    expect((await voiceStatusSnapshot()).ttsReady).toBe(true)
  })

  it('without the Supertonic model, ttsReady is false', async () => {
    const snap = await voiceStatusSnapshot()
    expect(snap.models[TTS].installed).toBe(false)
    expect(snap.models[TTS].state).toBe('absent')
    expect(snap.ttsReady).toBe(false)
  })

  it('publishes the MODEL route next to the local state (audio priority)', async () => {
    const snap = await voiceStatusSnapshot()
    // The local state alone does not answer the "Voice model" preference: the UI
    // needs both halves to say who will speak.
    expect(snap.modelTts).toEqual({ available: false, reason: 'with no speech provider' })
  })
})
