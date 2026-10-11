import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceModelState } from '@shared/voice'

/**
 * O `voice:status` é o que a UI lê para pintar o selo ("installed") e o texto do
 * motivo. O bug de fundo era o downloader e o motor discordarem: o selo dizia
 * "Not installed" e o motivo, logo abaixo, dizia que o pacote estava baixado.
 *
 * Aqui as duas respostas saem do MESMO retrato (`installed` + `state` +
 * `reason`), então o invariante testado é: `installed` é verdadeiro SÓ quando o
 * motor consegue usar o modelo (`state === "ready"`), e todo estado não pronto
 * traz um motivo. O disco e os motores são dublês: o que se fecha é o mapeamento.
 */

const estado = vi.hoisted(() => ({
  downloaded: false,
  installed: false,
  downloading: false,
  received: 0,
  progress: null as { error?: string } | null,
  extract: { phase: 'idle' as 'idle' | 'extracting' | 'error', error: null as string | null },
  engine: true,
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orbit-voice-status-teste', getAppPath: () => '/tmp/orbit-voice-status-teste' },
}))

vi.mock('./download', () => ({
  isModelDownloaded: async () => estado.downloaded,
  isDownloading: () => estado.downloading,
  receivedBytes: async () => estado.received,
  progressOf: () => estado.progress,
}))

vi.mock('./models-store', () => ({
  parakeetExtractPhase: () => estado.extract,
}))

vi.mock('./tts', () => ({
  enginePresent: () => estado.engine,
}))

// A rota pelo MODELO vive em ./model-tts (catálogo/provedores, que não cabem
// neste teste): aqui só interessa que o retrato a publique como veio.
vi.mock('./model-tts', () => ({
  modelTtsStatus: async () => ({ available: false, reason: 'sem provedor de fala' }),
}))

vi.mock('./stt', () => ({
  STT_MODELS: [
    {
      id: 'parakeet-tdt-0.6b-v3',
      kind: 'stt',
      engine: 'parakeet',
      label: 'Parakeet TDT 0.6B v3',
      bytes: 487170055,
      url: 'https://exemplo/parakeet.tar.bz2',
      langs: ['pt'],
      archive: true,
    },
  ],
  sttEngineStatus: async () => [],
  sttModelInstalled: () => estado.installed,
}))

const { voiceModelStatus, voiceStatusSnapshot } = await import('./status')
const { modelInfo, VOICE_MODELS } = await import('./manifest')

const PARAKEET = 'parakeet-tdt-0.6b-v3'
const TTS = 'supertonic-3'

beforeEach(() => {
  estado.downloaded = false
  estado.installed = false
  estado.downloading = false
  estado.received = 0
  estado.progress = null
  estado.extract = { phase: 'idle', error: null }
  estado.engine = true
})

describe('voiceModelStatus', () => {
  it('modelo ausente: absent, não instalado, com motivo', async () => {
    const st = await voiceModelStatus(modelInfo(PARAKEET)!)
    expect(st).toMatchObject({ downloaded: false, installed: false, state: 'absent' })
    expect(st.reason).toBe('ainda não foi baixado')
    expect(st.total).toBe(487170055)
  })

  it('o pacote baixado e não extraído NUNCA aparece como instalado', async () => {
    estado.downloaded = true
    estado.installed = false
    const st = await voiceModelStatus(modelInfo(PARAKEET)!)
    // O bug: o downloader diria "instalado" e o motor "não pronto".
    expect(st.downloaded).toBe(true)
    expect(st.installed).toBe(false)
    expect(st.state).toBe('downloaded')
    expect(st.reason).toMatch(/falta extrair/)
  })

  it('extraindo o pacote: estado intermediário explícito', async () => {
    estado.downloaded = true
    estado.extract = { phase: 'extracting', error: null }
    const st = await voiceModelStatus(modelInfo(PARAKEET)!)
    expect(st.installed).toBe(false)
    expect(st.state).toBe('extracting')
    expect(st.reason).toMatch(/extraindo/)
  })

  it('extração falhou: vira erro com o motivo concreto', async () => {
    estado.downloaded = true
    estado.extract = { phase: 'error', error: 'falha ao extrair o pacote (tar): bzip2: dados corrompidos' }
    const st = await voiceModelStatus(modelInfo(PARAKEET)!)
    expect(st.state).toBe('error')
    expect(st.installed).toBe(false)
    expect(st.error).toMatch(/bzip2/)
    expect(st.reason).toBe(st.error)
  })

  it('pronto: só aí installed é true, e sem motivo', async () => {
    estado.downloaded = true
    estado.installed = true
    const st = await voiceModelStatus(modelInfo(PARAKEET)!)
    expect(st.state).toBe('ready')
    expect(st.installed).toBe(true)
    expect(st.reason).toBeUndefined()
  })

  it('download em curso e download parcial têm estados distintos', async () => {
    estado.downloading = true
    expect((await voiceModelStatus(modelInfo(PARAKEET)!)).state).toBe('downloading')

    estado.downloading = false
    estado.received = 1024
    const parcial = await voiceModelStatus(modelInfo(PARAKEET)!)
    expect(parcial.state).toBe('partial')
    expect(parcial.reason).toMatch(/1024 de 487170055/)
  })

  it('falha de download: state error com o motivo', async () => {
    estado.progress = { error: 'origem respondeu 404' }
    const st = await voiceModelStatus(modelInfo(PARAKEET)!)
    expect(st.state).toBe('error')
    expect(st.installed).toBe(false)
    expect(st.reason).toBe('origem respondeu 404')
  })

  it('invariante: installed é true só em ready, e todo outro estado tem motivo', async () => {
    const cenarios: Array<[VoiceModelState, () => void]> = [
      ['ready', () => ((estado.downloaded = true), (estado.installed = true))],
      ['downloaded', () => (estado.downloaded = true)],
      ['extracting', () => ((estado.downloaded = true), (estado.extract = { phase: 'extracting', error: null }))],
      ['error', () => (estado.progress = { error: 'falhou' })],
      ['downloading', () => (estado.downloading = true)],
      ['partial', () => (estado.received = 10)],
      ['absent', () => undefined],
    ]
    for (const [esperado, montar] of cenarios) {
      estado.downloaded = false
      estado.installed = false
      estado.downloading = false
      estado.received = 0
      estado.progress = null
      estado.extract = { phase: 'idle', error: null }
      montar()
      const st = await voiceModelStatus(modelInfo(PARAKEET)!)
      expect(st.state).toBe(esperado)
      expect(st.installed).toBe(st.state === 'ready')
      expect(st.ready).toBe(st.installed)
      if (st.state !== 'ready') expect(st.reason?.length).toBeGreaterThan(0)
    }
  })
})

describe('voiceStatusSnapshot', () => {
  it('traz todo o catálogo e só marca ttsReady com o modelo e o motor prontos', async () => {
    estado.downloaded = true
    estado.installed = true
    estado.engine = false
    const semMotor = await voiceStatusSnapshot()
    expect(Object.keys(semMotor.models).sort()).toEqual(VOICE_MODELS.map((m) => m.id).sort())
    expect(semMotor.models[TTS].installed).toBe(true)
    expect(semMotor.ttsReady).toBe(false)

    estado.engine = true
    expect((await voiceStatusSnapshot()).ttsReady).toBe(true)
  })

  it('sem o modelo do Supertonic, ttsReady é false', async () => {
    const snap = await voiceStatusSnapshot()
    expect(snap.models[TTS].installed).toBe(false)
    expect(snap.models[TTS].state).toBe('absent')
    expect(snap.ttsReady).toBe(false)
  })

  it('publica a rota do MODELO junto do estado local (prioridade de áudio)', async () => {
    const snap = await voiceStatusSnapshot()
    // O estado local sozinho não responde à preferência "Modelo de voz": a UI
    // precisa das duas metades para dizer quem vai falar.
    expect(snap.modelTts).toEqual({ available: false, reason: 'sem provedor de fala' })
  })
})
