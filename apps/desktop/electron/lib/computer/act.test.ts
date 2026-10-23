import sharp from 'sharp'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, type ActRequest } from './act'
import { createFakeDriver, FAKE_PID, FAKE_WINDOW, fakeTree, type FakeDriver } from './fake-driver'
import { observe, query } from './observe'
import { createRegistry, type Registry } from './registry'

/**
 * O laço observar → agir por índice → reobservar, com o driver falso: o que
 * se confere é o que seria enviado ao sistema (qual operação, onde, como).
 */

let png: Buffer
let driver: FakeDriver
let registry: Registry

beforeAll(async () => {
  // Janela de 1000×800 pt capturada em Retina (2x) → 2000×1600 px.
  png = await sharp({ create: { width: 2000, height: 1600, channels: 3, background: '#ffffff' } }).png().toBuffer()
})

beforeEach(() => {
  driver = createFakeDriver(png)
  registry = createRegistry()
})

const look = () =>
  observe(driver, registry, {
    sessionId: 's1',
    app: 'com.apple.TextEdit',
    includeTree: true,
    includeScreenshot: true,
    maxNodes: 250,
    maxScreenshotEdge: 1280,
    scaleFor: () => 2,
    enhance: true,
  })

const run = (req: Partial<ActRequest>) =>
  act(driver, registry, { sessionId: 's1', action: 'left_click', app: 'com.apple.TextEdit', pointer: 'directed', ...req })

describe('observe', () => {
  it('declara a geometria, numera a árvore e cerca o conteúdo da tela', async () => {
    const result = await look()
    expect(result.image?.mediaType).toBe('image/webp')
    expect(result.record.geometry).toEqual({ frame: FAKE_WINDOW.frame, width: 1280, height: 1024 })
    expect(result.text).toContain('screenshot 1280×1024 px')
    expect(result.text).toContain('<screen_content untrusted="true">')
    expect(result.text).toContain('</screen_content>')
    // O grupo vazio não ganha linha: 0 janela, 1 área de texto, 2 botão, 3 senha.
    expect(result.text).toMatch(/^\t1 text area = "Olá" \[focused\] @0,64 1280x768$/m)
    expect(result.text).toMatch(/^\t2 button "Salvar" actions: press @1152,896 102x38$/m)
    expect(result.text).toMatch(/^\t3 secure text field = \[secure — never type here\]/m)
    expect(result.text).toContain('Focused: element 1')
  })

  it('recusa app da denylist mesmo pedido por pid', async () => {
    await expect(observe(driver, registry, { sessionId: 's1', app: '1', includeTree: true, includeScreenshot: false, maxNodes: 50, maxScreenshotEdge: 1280, enhance: false })).rejects.toThrow(/denylist/)
  })

  it('recusa o próprio Orbit', async () => {
    const own = createFakeDriver(png)
    own.apps = async () => ({
      apps: [{ pid: process.pid, bundleId: 'com.fragmentslabs.orbit.code', name: 'Orbit', active: true, hidden: false }],
      windows: [{ id: 1, pid: process.pid, title: 'Orbit', frame: [0, 0, 800, 600] }],
    })
    await expect(observe(own, registry, { sessionId: 's1', app: 'Orbit', includeTree: true, includeScreenshot: false, maxNodes: 50, maxScreenshotEdge: 1280, enhance: false })).rejects.toThrow(/its own window/)
  })

  it('sem screenshot, x/y continuam no MESMO espaço do screenshot da janela', async () => {
    // Antes, sem imagem, x/y viravam pontos da janela: quem repetia os passos de
    // uma observação com imagem errava pela metade no Retina.
    const result = await observe(driver, registry, { sessionId: 's1', app: 'TextEdit', includeTree: true, includeScreenshot: false, maxNodes: 50, maxScreenshotEdge: 1280, scaleFor: () => 2, enhance: false })
    expect(result.image).toBeNull()
    expect(result.record.geometry).toMatchObject({ width: 1280, height: 1024 })
    expect(result.text).toContain("still use this window's screenshot space (1280×1024 px)")
    // O mesmo elemento sai no mesmo lugar que na observação com imagem.
    expect(result.text).toMatch(/^\t2 button "Salvar" actions: press @1152,896 102x38$/m)
  })
})

describe('act', () => {
  it('clique por elemento usa AXPress e confere a identidade', async () => {
    await look()
    const outcome = await run({ element: 2 })
    expect(outcome.summary).toMatch(/Pressed element 2 \(button "Salvar"\) via AXPress/)
    expect(driver.actions[0]).toMatchObject({ op: 'element', pid: FAKE_PID, path: [0, 1], kind: 'press', expect: { role: 'AXButton', title: 'Salvar' } })
  })

  it('sem ação no elemento, o modo dirigido faz hit-test no centro dele (mouse por pid é ignorado pelo AppKit)', async () => {
    await look()
    driver.elementResult = { done: null }
    await run({ element: 2 })
    expect(driver.actions[1]).toMatchObject({ op: 'hit', pid: FAKE_PID, x: 1040, y: 765, focusText: true })
    expect(driver.actions.some((a) => a.op === 'mouse')).toBe(false)
  })

  it('a ação devolve o alvo (elemento ou ponto) para o marcador da miniatura', async () => {
    await look()
    expect((await run({ element: 2 })).target).toEqual({ frame: [1000, 750, 80, 30] })
    await look()
    expect((await run({ x: 640, y: 512 })).target).toEqual({ point: [600, 450] })
    await look()
    expect((await run({ action: 'key', key: 'return' })).target).toBeUndefined()
  })

  it('x/y do screenshot viram pontos globais — e, no modo dirigido, hit-test', async () => {
    await look()
    const outcome = await run({ x: 640, y: 512 })
    expect(driver.actions[0]).toMatchObject({ op: 'hit', x: 600, y: 450 })
    expect(outcome.summary).toMatch(/Pressed button "Salvar" .* via AXPress/)
  })

  it('hit-test em campo de texto dá foco; sem nada clicável é erro explicando o ponteiro global', async () => {
    await look()
    driver.hitResult = { done: 'focus', node: { ...fakeTree().nodes[2] } }
    expect((await run({ x: 10, y: 100 })).summary).toMatch(/Focused textarea .* use "type"/)
    driver.hitResult = { done: null, node: { ...fakeTree().nodes[0] } }
    await expect(run({ x: 10, y: 10 })).rejects.toThrow(/Nothing clickable .*Global pointer/)
  })

  it('ação que o app não confirma a tempo é relatada como provável, não como falha', async () => {
    await look()
    driver.elementResult = { done: 'press', action: 'AXPress', unconfirmed: true }
    expect((await run({ element: 2 })).summary).toMatch(/did not confirm in time/)
  })

  it('ponteiro global entrega pelo HID', async () => {
    await look()
    await run({ x: 0, y: 0, pointer: 'global' })
    expect(driver.actions[0]).toMatchObject({ op: 'mouse', x: 100, y: 50, mode: 'global' })
  })

  it('clique duplo, do meio e hover só existem com o ponteiro global', async () => {
    await look()
    await expect(run({ action: 'double_click', x: 10, y: 10 })).rejects.toThrow(/Double-click needs the global pointer/)
    await expect(run({ action: 'middle_click', x: 10, y: 10 })).rejects.toThrow(/global pointer/)
    await expect(run({ action: 'move', x: 10, y: 10 })).rejects.toThrow(/global pointer/)
    await run({ action: 'double_click', x: 0, y: 0, pointer: 'global' })
    expect(driver.actions.findLast((a) => a.op === 'mouse')).toMatchObject({ op: 'mouse', clicks: 2, mode: 'global' })
  })

  it('agir sem observar antes é erro', async () => {
    await expect(run({ element: 2 })).rejects.toThrow(/cu_observe first/)
  })

  it('índice de observação velha é recusado', async () => {
    const first = await look()
    await look()
    await expect(run({ element: 2, observationId: first.record.id })).rejects.toThrow(/not the latest/)
  })

  it('nunca digita em campo de senha — nem pelo índice, nem pelo foco', async () => {
    await look()
    await expect(run({ action: 'type', element: 3, text: 'segredo' })).rejects.toThrow(/secure/)
    driver.act = async (action) => {
      driver.actions.push(action)
      return action.op === 'focused' ? { done: 'focused', node: { ...fakeSecureNode() } } : { done: action.op }
    }
    await expect(run({ action: 'type', text: 'segredo' })).rejects.toThrow(/secure/)
    expect(driver.actions.some((a) => a.op === 'keys')).toBe(false)
  })

  it('type no foco manda Unicode para o app', async () => {
    await look()
    await run({ action: 'type', text: 'ação ✓' })
    expect(driver.actions.at(-1)).toMatchObject({ op: 'keys', pid: FAKE_PID, text: 'ação ✓', mode: 'pid' })
  })

  it('key resolve o atalho', async () => {
    await look()
    await run({ action: 'key', key: 'cmd+s' })
    expect(driver.actions[0]).toMatchObject({ op: 'keys', combos: [{ code: 1, flags: 0x100000 }] })
  })

  it('drag exige o ponteiro global', async () => {
    await look()
    await expect(run({ action: 'drag', x: 10, y: 10, toX: 100, toY: 100 })).rejects.toThrow(/global pointer/)
    await run({ action: 'drag', x: 0, y: 0, toX: 1280, toY: 1024, pointer: 'global' })
    expect(driver.actions.findLast((a) => a.op === 'drag')).toMatchObject({ op: 'drag', from: [100, 50], to: [1100, 850], mode: 'global' })
  })

  it('depois de arrastar, o resultado diz o que ficou selecionado — ou avisa que nada foi', async () => {
    await look()
    const ok = await run({ action: 'drag', x: 0, y: 0, toX: 640, toY: 0, pointer: 'global' })
    expect(ok.summary).toMatch(/Selection now: 49 character\(s\) "Rascunho/)
    await look()
    driver.selection = { location: 49, length: 0, text: null }
    const missed = await run({ action: 'drag', x: 0, y: 0, toX: 640, toY: 0, pointer: 'global' })
    expect(missed.summary).toMatch(/Nothing is selected now \(text cursor at 49\) — the gesture missed the text/)
  })

  it('clique triplo: só com o ponteiro global, três cliques e o retorno da seleção', async () => {
    await look()
    await expect(run({ action: 'triple_click', x: 10, y: 10 })).rejects.toThrow(/Triple-click needs the global pointer/)
    const outcome = await run({ action: 'triple_click', element: 1, pointer: 'global' })
    expect(driver.actions.find((a) => a.op === 'mouse')).toMatchObject({ clicks: 3, mode: 'global' })
    expect(outcome.summary).toMatch(/Triple-clicked element 1 .* Selection now: 49/)
  })

  it('scroll dirigido move a barra pelo AX, no centro da janela', async () => {
    await look()
    await run({ action: 'scroll', direction: 'down', amount: 2 })
    expect(driver.actions[0]).toMatchObject({ op: 'scrollAx', x: 600, y: 450, dy: -120, dx: 0 })
  })

  it('sem barra acessível, o scroll cai para Page Down (teclado por pid funciona)', async () => {
    await look()
    driver.scrollResult = { done: null }
    const outcome = await run({ action: 'scroll', direction: 'down', amount: 6 })
    expect(driver.actions.at(-1)).toMatchObject({ op: 'keys', combos: [{ code: 121 }, { code: 121 }] })
    expect(outcome.summary).toMatch(/2× pagedown/)
  })

  it('scroll com ponteiro global usa a roda', async () => {
    await look()
    await run({ action: 'scroll', direction: 'up', amount: 1, pointer: 'global' })
    expect(driver.actions[0]).toMatchObject({ op: 'scroll', dy: 60, mode: 'global' })
  })

  it('wait não precisa de app', async () => {
    const outcome = await act(driver, registry, { sessionId: 's1', action: 'wait', seconds: 0.1, pointer: 'directed' })
    expect(outcome.summary).toMatch(/Waited/)
  })

  it('abort interrompe o wait', async () => {
    const controller = new AbortController()
    const pending = act(driver, registry, { sessionId: 's1', action: 'wait', seconds: 5, pointer: 'directed', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
  })
})

describe('query', () => {
  it('acha por texto e devolve índices válidos para agir', async () => {
    await look()
    const text = await query(driver, registry, { sessionId: 's1', app: 'TextEdit', text: 'salvar', maxNodes: 500, limit: 10, enhance: true, maxScreenshotEdge: 1280, scaleFor: () => 2 })
    expect(text).toContain('1 match(es)')
    expect(text).toMatch(/2 button "Salvar"/)
    // Mantém o espaço do último screenshot (a janela não mudou).
    expect(text).toContain("this window's screenshot space (1280×1024 px)")
    const outcome = await run({ element: 2 })
    expect(outcome.summary).toMatch(/Salvar/)
  })

  it('filtra por papel', async () => {
    await look()
    const text = await query(driver, registry, { sessionId: 's1', app: 'TextEdit', role: 'text field', maxNodes: 500, limit: 10, enhance: true, maxScreenshotEdge: 1280, scaleFor: () => 2 })
    expect(text).toMatch(/secure text field/)
    expect(text).not.toMatch(/Salvar/)
  })
})

function fakeSecureNode() {
  return {
    role: 'AXTextField',
    subrole: 'AXSecureTextField',
    title: null,
    value: null,
    desc: null,
    frame: null,
    enabled: true,
    focused: true,
    placeholder: null,
    help: null,
    selected: false,
    url: null,
    secure: true,
    childCount: 0,
    actions: [],
  }
}
