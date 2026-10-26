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
const busy = { other: null as string | null }
vi.mock('../computer/session', () => ({
  assertCanControl: () => {
    if (busy.other) throw new ComputerErrorForMock('busy', busy.other)
  },
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
class ComputerErrorForMock extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ComputerError'
  }
}
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
    expect(out).toContain('Screenshot not loaded')
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
    expect(sem).toContain('Screenshot not loaded')
    const com = await call(tools, 'cu_computer', { action: 'left_click', app: 'com.apple.TextEdit', element: 2, screenshot: true })
    expect(com).not.toContain('Screenshot not loaded')
  })

  it('depois de uma observação lida, devolve só o que mudou — com os mesmos índices', async () => {
    const tools = createComputerTools({ sessionId: 's4', modelVision: true })
    const full = await call(tools, 'cu_observe', { app: 'com.apple.TextEdit' })
    expect(full).toContain('Tree (4 elements)')
    const out = await call(tools, 'cu_computer', { action: 'left_click', app: 'com.apple.TextEdit', element: 2 })
    expect(out).toMatch(/Tree: changes since obs_\w+ \(3 other elements unchanged/)
    expect(out).toContain('~ 1 text area = "Olá 1"')
    // O botão não mudou: não volta a aparecer na árvore (só no resumo da ação).
    expect(out.split('<screen_content')[1]).not.toContain('button "Salvar"')
  })

  it('sem observação lida neste loop, a árvore vem inteira (o modelo não tem base para um diff)', async () => {
    const first = createComputerTools({ sessionId: 's5', modelVision: true })
    await call(first, 'cu_observe', { app: 'com.apple.TextEdit' })
    // Outro loop (subagente, turno seguinte) na mesma sessão: nunca leu aquela observação.
    const other = createComputerTools({ sessionId: 's5', modelVision: true })
    const out = await call(other, 'cu_computer', { action: 'left_click', app: 'com.apple.TextEdit', element: 2 })
    expect(out).toContain('Tree (4 elements)')
  })

  it('a observação não carrega a imagem por padrão', async () => {
    const tools = createComputerTools({ sessionId: 's6', modelVision: true })
    const out = await call(tools, 'cu_observe', { app: 'com.apple.TextEdit' })
    expect(out).toContain('Screenshot not loaded')
  })
})

describe('alvo por descrição (find)', () => {
  it('acha o elemento pelo texto da linha', async () => {
    const tools = createComputerTools({ sessionId: 'f1', modelVision: true })
    await call(tools, 'cu_observe', { app: 'com.apple.TextEdit' })
    const out = await call(tools, 'cu_computer', { action: 'left_click', app: 'com.apple.TextEdit', find: { text: 'salvar' } })
    expect(out).toMatch(/^Pressed element 2 \(button "Salvar"\)/)
  })

  it('ambíguo é erro com os candidatos, nunca o primeiro da lista', async () => {
    driver.mutate = (tree) => {
      tree.nodes.push({ ...tree.nodes[3], id: 9, path: [0, 2], title: 'Salvar como…' })
    }
    const tools = createComputerTools({ sessionId: 'f2', modelVision: true })
    await call(tools, 'cu_observe', { app: 'com.apple.TextEdit' })
    const out = await call(tools, 'cu_computer', { action: 'left_click', app: 'com.apple.TextEdit', find: { text: 'salv' } })
    expect(out).toContain('Error (ambiguous): 2 elements match "salv"')
    expect(driver.actions).toHaveLength(0)
    // O título exato desempata.
    const exact = await call(tools, 'cu_computer', { action: 'left_click', app: 'com.apple.TextEdit', find: { text: 'Salvar' } })
    expect(exact).toMatch(/^Pressed element 2 /)
  })

  it('no batch, o passo depois de um clique mira contra a árvore nova', async () => {
    // Depois do primeiro clique, o botão "Salvar" vira "Confirmar" no mesmo lugar.
    driver.mutate = (tree, acted) => {
      if (acted >= 1) tree.nodes[3].title = 'Confirmar'
    }
    const tools = createComputerTools({ sessionId: 'f3', modelVision: true })
    await call(tools, 'cu_observe', { app: 'com.apple.TextEdit' })
    const out = await call(tools, 'cu_batch', {
      app: 'com.apple.TextEdit',
      steps: [
        { action: 'left_click', element: 2 },
        // O índice 2 era o "Salvar": com a tela mudada, não pode virar clique no "Confirmar".
        { action: 'left_click', element: 2 },
      ],
    })
    expect(out).toMatch(/2\. STOPPED — Error \(staleIndex\)/)
    const ok = await call(tools, 'cu_batch', {
      app: 'com.apple.TextEdit',
      steps: [
        { action: 'left_click', find: { text: 'confirmar' } },
        { action: 'left_click', find: { role: 'button', text: 'confirmar' } },
      ],
    })
    expect(ok).toMatch(/1\. Pressed element \d+ \(button "Confirmar"\)/)
    expect(ok).toMatch(/2\. Pressed element \d+ \(button "Confirmar"\)/)
  })
})

describe('expect', () => {
  it('espera o estado e confirma', async () => {
    const tools = createComputerTools({ sessionId: 'e1', modelVision: true })
    await call(tools, 'cu_observe', { app: 'com.apple.TextEdit' })
    const out = await call(tools, 'cu_computer', { action: 'left_click', app: 'com.apple.TextEdit', element: 2, expect: { text: 'Olá 1' } })
    expect(out).toContain('✓ Expected "Olá 1" on screen: confirmed.')
  })

  it('não vindo, diz que não viu — e o batch para ali', async () => {
    const tools = createComputerTools({ sessionId: 'e2', modelVision: true })
    await call(tools, 'cu_observe', { app: 'com.apple.TextEdit' })
    const out = await call(tools, 'cu_batch', {
      app: 'com.apple.TextEdit',
      steps: [
        { action: 'left_click', element: 2, expect: { text: 'Documento salvo', timeout: 0.5 } },
        { action: 'key', key: 'return' },
      ],
    })
    expect(out).toContain('✗ "Documento salvo" on screen NOT seen after 0.5s')
    expect(out).toContain('steps 2–2 were not run')
    expect(driver.actions.some((a) => a.op === 'keys')).toBe(false)
  })
})

describe('trava de estagnação', () => {
  it('três ações seguidas sem mudança: manda parar e avisa quem chamou', async () => {
    driver.changeAfterAction = false
    const onStall = vi.fn()
    const tools = createComputerTools({ sessionId: 't1', modelVision: true, onStall })
    await call(tools, 'cu_observe', { app: 'com.apple.TextEdit' })
    const click = () => call(tools, 'cu_computer', { action: 'left_click', app: 'com.apple.TextEdit', element: 2 })
    expect(await click()).toContain('Nothing changed in the accessibility tree')
    await click()
    expect(await click()).toContain('STOP: 3 actions in a row changed nothing')
    expect(onStall).toHaveBeenCalledTimes(1)
  })
})

describe('uma conversa controla por vez', () => {
  it('com outra conversa controlando, a ação vira erro claro e nada chega ao app', async () => {
    const tools = createComputerTools({ sessionId: 'b1', modelVision: true })
    await call(tools, 'cu_observe', { app: 'com.apple.TextEdit' })
    busy.other = 'Another Orbit conversation is controlling the computer right now (in Safari).'
    try {
      const out = await call(tools, 'cu_computer', { action: 'left_click', app: 'com.apple.TextEdit', element: 2 })
      expect(out).toContain('Another Orbit conversation is controlling')
      expect(driver.actions).toHaveLength(0)
    } finally {
      busy.other = null
    }
  })
})
