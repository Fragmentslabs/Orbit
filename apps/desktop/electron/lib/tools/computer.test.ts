import sharp from 'sharp'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * cu_batch e o read_back com o driver falso: o que a tool devolve ao modelo.
 * Electron, indicadores e gravação ficam de fora (mocks) — o que se confere é
 * o lote parar no primeiro erro e observar uma vez só, no fim, sem imagem.
 */

vi.mock('electron', () => ({
  screen: { getDisplayMatching: () => ({ scaleFactor: 2 }) },
  shell: { openExternal: vi.fn() },
  app: { getPath: () => '/tmp', isPackaged: false },
  systemPreferences: {},
  desktopCapturer: {},
  BrowserWindow: class {},
  session: {},
}))
vi.mock('../computer/session', () => ({
  noteActivity: vi.fn(),
  noteEnhanced: vi.fn(),
  noteShotChanged: vi.fn(),
  isEnhanced: () => true,
  endActivity: vi.fn(),
  stopComputer: vi.fn(),
  getComputerActivity: () => [],
  setComputerStopHandler: vi.fn(),
  setComputerRestoreHandler: vi.fn(),
  disposeComputerSessions: vi.fn(),
}))
vi.mock('../computer/recording', () => ({ isRecording: () => false, noteRecordedAction: vi.fn(), markRecording: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn() }))
vi.mock('../app-settings', async () => {
  const { DEFAULT_APP_SETTINGS } = await import('@shared/app-settings')
  return { getAppSettings: () => ({ ...DEFAULT_APP_SETTINGS, computer: { ...DEFAULT_APP_SETTINGS.computer, enabled: true } }) }
})
vi.mock('../vision', () => ({ describeImage: vi.fn() }))
vi.mock('../video/video-gallery', () => ({ addVideoToGallery: vi.fn() }))

const { createFakeDriver } = await import('../computer/fake-driver')
const { setComputerDriver } = await import('../computer')
const { createComputerTools } = await import('./computer')

let png: Buffer
beforeAll(async () => {
  png = await sharp({ create: { width: 2000, height: 1600, channels: 3, background: '#ffffff' } }).png().toBuffer()
})

let driver: ReturnType<typeof createFakeDriver>
beforeEach(() => {
  driver = createFakeDriver(png)
  setComputerDriver(driver)
})

const call = async (tools: ReturnType<typeof createComputerTools>, name: string, args: unknown) =>
  (tools[name] as unknown as { execute: (a: unknown, o: unknown) => Promise<string> }).execute(args, { toolCallId: 'c1', messages: [], abortSignal: undefined })

describe('cu_batch', () => {
  it('roda os passos em ordem e observa uma vez só, no fim, sem carregar a imagem', async () => {
    const tools = createComputerTools({ sessionId: 's1', modelVision: true })
    await call(tools, 'cu_observe', { app: 'com.apple.TextEdit' })
    const out = await call(tools, 'cu_batch', {
      app: 'com.apple.TextEdit',
      steps: [
        { action: 'left_click', element: 2 },
        { action: 'type', text: 'oi' },
        { action: 'key', key: 'return' },
      ],
    })
    expect(out).toMatch(/^1\. Pressed element 2 .*\n2\. Typed 2 character\(s\).*\n3\. Pressed return\./)
    expect(out.match(/App: TextEdit/g)).toHaveLength(1)
    expect(out).toContain('Screenshot not loaded to save context')
  })

  it('para no primeiro passo que falha e diz quais não rodaram', async () => {
    const tools = createComputerTools({ sessionId: 's2', modelVision: true })
    await call(tools, 'cu_observe', { app: 'com.apple.TextEdit' })
    const out = await call(tools, 'cu_batch', {
      app: 'com.apple.TextEdit',
      steps: [
        { action: 'left_click', element: 2 },
        { action: 'type', element: 3, text: 'segredo' },
        { action: 'key', key: 'return' },
      ],
    })
    expect(out).toMatch(/2\. STOPPED — Error \(secureField\)/)
    expect(out).toContain('Steps 3–3 were not run')
    expect(driver.actions.some((a) => a.op === 'keys')).toBe(false)
  })
})

describe('read_back do cu_computer', () => {
  it('traz a árvore em texto; a imagem só com screenshot: true', async () => {
    const tools = createComputerTools({ sessionId: 's3', modelVision: true })
    await call(tools, 'cu_observe', { app: 'com.apple.TextEdit' })
    const sem = await call(tools, 'cu_computer', { action: 'left_click', app: 'com.apple.TextEdit', element: 2 })
    expect(sem).toContain('Screenshot not loaded to save context')
    const com = await call(tools, 'cu_computer', { action: 'left_click', app: 'com.apple.TextEdit', element: 2, screenshot: true })
    expect(com).not.toContain('Screenshot not loaded')
  })
})
