import sharp from 'sharp'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, type ActRequest } from './act'
import { createFakeDriver, FAKE_PID, type FakeDriver } from './fake-driver'
import { formatTree, normalizeRole } from './format'
import { windowSpace } from './geometry'
import { observe } from './observe'
import { createRegistry, type Registry } from './registry'
import type { AxNode, TreeSnapshot } from './types'

/**
 * O contrato visto pelo lado do Windows, com o driver falso: papéis da UIA
 * traduzidos, `ref` indo junto do `path`, identidade conferida no papel nativo
 * e o clique por mensagem de janela quando a UIA não tem o que apertar.
 */

let png: Buffer
let driver: FakeDriver
let registry: Registry

function uia(over: Partial<AxNode> & Pick<AxNode, 'id' | 'parent' | 'depth' | 'path' | 'role'>): AxNode {
  return {
    subrole: null,
    title: null,
    value: null,
    desc: null,
    frame: null,
    enabled: true,
    focused: false,
    placeholder: null,
    help: null,
    selected: false,
    url: null,
    secure: false,
    childCount: 0,
    actions: [],
    ...over,
  }
}

/** Uma janela do Bloco de Notas do Windows 11, como o host manda (frame em pixel físico). */
function notepadTree(): TreeSnapshot {
  return {
    nodes: [
      uia({ id: 0, parent: -1, depth: 0, path: [], role: 'Window', title: 'Sem título - Bloco de Notas', frame: [100, 50, 1000, 800], ref: 'r:3:AAEC' }),
      uia({ id: 1, parent: 0, depth: 1, path: [0], role: 'Pane', ref: 'r:3:AAED' }),
      uia({ id: 2, parent: 1, depth: 2, path: [0, 0], role: 'Document', subrole: 'editable', value: 'Olá', frame: [100, 100, 1000, 600], focused: true, ref: 'r:3:AAEE' }),
      uia({ id: 3, parent: 1, depth: 2, path: [0, 1], role: 'Button', title: 'Salvar', frame: [1000, 750, 80, 30], actions: ['AXPress'], ref: 'r:3:AAEF' }),
      uia({ id: 4, parent: 0, depth: 1, path: [1], role: 'Hyperlink', title: 'Ajuda', frame: [200, 760, 60, 20], actions: ['AXPress'], ref: 'k:help|Hyperlink|Ajuda' }),
      uia({ id: 5, parent: 0, depth: 1, path: [2], role: 'Edit', secure: true, frame: [300, 760, 200, 24], ref: 'r:3:AAEG' }),
    ],
    focusedId: 2,
    truncated: null,
    omitted: 0,
    timeouts: 0,
    enhanced: false,
    ms: 4,
  }
}

beforeAll(async () => {
  // Escala 1: o screenshot tem o tamanho do frame físico.
  png = await sharp({ create: { width: 1000, height: 800, channels: 3, background: '#ffffff' } }).png().toBuffer()
})

beforeEach(() => {
  driver = createFakeDriver(png, { platform: 'win32' })
  driver.tree = async () => notepadTree()
  driver.apps = async () => ({
    apps: [{ pid: FAKE_PID, bundleId: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', exe: 'Notepad.exe', name: 'Bloco de Notas', active: false, hidden: false }],
    windows: [{ id: 0x40a2c, pid: FAKE_PID, title: 'Sem título - Bloco de Notas', frame: [100, 50, 1000, 800] }],
  })
  registry = createRegistry()
})

const look = () =>
  observe(driver, registry, {
    sessionId: 'w1',
    app: 'notepad',
    includeTree: true,
    includeScreenshot: true,
    maxNodes: 250,
    maxScreenshotEdge: 1280,
    scaleFor: () => 1,
    enhance: false,
  })

const run = (req: Partial<ActRequest>) => act(driver, registry, { sessionId: 'w1', action: 'left_click', app: 'notepad', pointer: 'directed', ...req })

describe('papéis da UIA', () => {
  it('traduz para o vocabulário do AX', () => {
    expect(normalizeRole({ role: 'Button', subrole: null, url: null })).toBe('AXButton')
    expect(normalizeRole({ role: 'Edit', subrole: null, url: null })).toBe('AXTextField')
    expect(normalizeRole({ role: 'Hyperlink', subrole: null, url: null })).toBe('AXLink')
    expect(normalizeRole({ role: 'Document', subrole: null, url: 'https://a.com' })).toBe('AXWebArea')
    expect(normalizeRole({ role: 'Document', subrole: 'editable', url: null })).toBe('AXTextArea')
    expect(normalizeRole({ role: 'Document', subrole: 'editable', url: 'https://a.com' })).toBe('AXWebArea')
    expect(normalizeRole({ role: 'NovoTipo', subrole: null, url: null })).toBe('AXUnknown')
    // Papel do macOS passa direto.
    expect(normalizeRole({ role: 'AXTextArea', subrole: 'AXUnknown', url: null })).toBe('AXTextArea')
  })

  it('Pane vazio some, os handles levam ref e papel nativo', () => {
    const formatted = formatTree(notepadTree(), windowSpace([100, 50, 1000, 800], 1, 1280))
    expect(formatted.lines[0]).toBe('0 window "Sem título - Bloco de Notas" @0,0 1000x800')
    expect(formatted.lines[1]).toBe('\t1 text area = "Olá" [focused] @0,50 1000x600')
    expect(formatted.lines[2]).toBe('\t2 button "Salvar" actions: press @900,700 80x30')
    expect(formatted.lines[3]).toMatch(/^\t3 link "Ajuda"/)
    expect(formatted.lines[4]).toMatch(/^\t4 text field = \[secure — never type here\]/)
    expect(formatted.handles.get(2)).toMatchObject({ ref: 'r:3:AAEF', role: 'AXButton', nativeRole: 'Button' })
    expect(formatted.focusedIndex).toBe(1)
  })
})

describe('act no Windows', () => {
  it('elemento por índice manda ref, path de fallback, HWND e a identidade no papel nativo', async () => {
    await look()
    await run({ element: 2 })
    expect(driver.actions[0]).toEqual({
      op: 'element',
      pid: FAKE_PID,
      window: { id: 0x40a2c, frame: [100, 50, 1000, 800], title: 'Sem título - Bloco de Notas' },
      path: [0, 1],
      ref: 'r:3:AAEF',
      expect: { role: 'Button', title: 'Salvar' },
      kind: 'press',
      actions: ['AXPress', 'AXConfirm', 'AXOpen', 'AXPick'],
    })
  })

  it('ponto sem nada para apertar pela UIA vira clique por mensagem de janela (sem mover o cursor)', async () => {
    await look()
    driver.hitResult = { done: null, node: { ...notepadTree().nodes[1] } }
    const out = await run({ x: 500, y: 400 })
    expect(driver.actions.map((a) => a.op)).toEqual(['hit', 'mouse'])
    expect(driver.actions[1]).toMatchObject({ op: 'mouse', x: 600, y: 450, button: 'left', clicks: 1, kind: 'click', mode: 'pid' })
    expect(out.summary).toMatch(/window message/)
  })

  it('no macOS o mesmo caso continua recusando (o AppKit ignora mouse por pid)', async () => {
    const mac = createFakeDriver(png)
    const reg = createRegistry()
    await observe(mac, reg, { sessionId: 'm', app: 'TextEdit', includeTree: true, includeScreenshot: false, maxNodes: 50, maxScreenshotEdge: 1280, scaleFor: () => 1, enhance: false })
    mac.hitResult = { done: null }
    await expect(act(mac, reg, { sessionId: 'm', action: 'left_click', app: 'TextEdit', pointer: 'directed', x: 10, y: 10 })).rejects.toThrow(/Nothing clickable/)
    expect(mac.actions.map((a) => a.op)).toEqual(['hit'])
  })

  it('duplo clique e rolagem sem barra acessível também vão por mensagem no modo dirigido', async () => {
    await look()
    await run({ action: 'double_click', x: 100, y: 100 })
    expect(driver.actions[0]).toMatchObject({ op: 'mouse', clicks: 2, mode: 'pid' })
    driver.actions.length = 0
    driver.scrollResult = { done: null }
    const out = await run({ action: 'scroll', direction: 'down', amount: 2 })
    expect(driver.actions.map((a) => a.op)).toEqual(['scrollAx', 'scroll'])
    expect(driver.actions[1]).toMatchObject({ dy: -120, mode: 'pid' })
    expect(out.summary).toMatch(/window message/)
  })

  it('arrastar continua exigindo o ponteiro global', async () => {
    await look()
    await expect(run({ action: 'drag', x: 1, y: 1, toX: 50, toY: 50 })).rejects.toThrow(/global pointer/)
  })

  it('tecla usa VK do Windows: cmd+s vira Ctrl+S', async () => {
    await look()
    await run({ action: 'key', key: 'cmd+s' })
    expect(driver.actions[0]).toEqual({ op: 'keys', pid: FAKE_PID, combos: [{ code: 0x53, flags: 2 }], mode: 'pid' })
  })

  it('campo de senha (IsPassword) é recusado', async () => {
    await look()
    await expect(run({ action: 'type', element: 4, text: 'segredo' })).rejects.toThrow(/secure/)
  })

  it('app elevado é recusado antes de agir', async () => {
    driver.apps = async () => ({
      apps: [{ pid: FAKE_PID, bundleId: 'notepad.exe', exe: 'notepad.exe', name: 'Notepad', active: false, hidden: false, elevated: true }],
      windows: [{ id: 1, pid: FAKE_PID, title: 'x', frame: [0, 0, 100, 100] }],
    })
    await expect(look()).rejects.toThrow(/administrator/)
  })
})
