import { frameCenter, shotToGlobal } from './geometry'
import { parseKeys } from './keys'
import type { ElementHandle, ObservationRecord, Registry } from './registry'
import { resolveApp } from './observe'
import { assertTargetAllowed } from './safety'
import { ComputerError, type AppInfo, type ComputerDriver, type DeliveryMode, type PointerMode } from './types'

/**
 * Execução de uma ação do cu_computer. A ordem de preferência é sempre a menos
 * intrusiva: ação de acessibilidade no elemento (AXPress, AXValue) antes de
 * evento de mouse; evento por pid (sem mover o cursor do usuário) antes do
 * ponteiro global, que só existe com o opt-in nas Preferências.
 */

export const COMPUTER_ACTIONS = [
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'move',
  'drag',
  'scroll',
  'type',
  'key',
  'wait',
  'invoke',
  'set_value',
  'open_app',
] as const

export type ComputerAction = (typeof COMPUTER_ACTIONS)[number]

export interface ActRequest {
  sessionId: string
  action: ComputerAction
  app?: string
  observationId?: string
  element?: number
  x?: number
  y?: number
  toElement?: number
  toX?: number
  toY?: number
  text?: string
  key?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  seconds?: number
  axAction?: string
  pointer: PointerMode
  signal?: AbortSignal
}

export interface ActOutcome {
  /** Frase legível do que aconteceu (vai para o modelo e para o chip) */
  summary: string
  app: AppInfo | null
  /** Observação usada — o read_back observa a mesma janela */
  record: ObservationRecord | null
  /** O app saiu do lugar (aberto agora): o read_back escolhe a janela da frente */
  reopen?: boolean
}

const PRESS_ACTIONS = ['AXPress', 'AXConfirm', 'AXOpen', 'AXPick']
const SCROLL_PIXELS_PER_TICK = 60

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ComputerError('aborted', 'Computer use was stopped.'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ComputerError('aborted', 'Computer use was stopped.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function label(handle: ElementHandle): string {
  const role = handle.role.replace(/^AX/, '').toLowerCase()
  return handle.title ? `${role} "${handle.title}"` : role
}

export async function act(driver: ComputerDriver, registry: Registry, req: ActRequest): Promise<ActOutcome> {
  if (req.action === 'wait') {
    const seconds = Math.min(Math.max(req.seconds ?? 1, 0.1), 10)
    await sleep(seconds * 1000, req.signal)
    return { summary: `Waited ${seconds}s.`, app: null, record: null }
  }
  if (!req.app) throw new ComputerError('badRequest', `Action "${req.action}" needs "app" (bundle id or name from cu_observe).`)

  if (req.action === 'open_app') {
    await driver.openApp(req.app, req.signal)
    // Abrir (ou trazer para a frente) leva um instante até a janela existir.
    await sleep(900, req.signal)
    const snapshot = await driver.apps(req.signal)
    const app = resolveApp(snapshot, req.app)
    assertTargetAllowed(app)
    return { summary: `Opened ${app.name} (brought to the front).`, app, record: null, reopen: true }
  }

  const snapshot = await driver.apps(req.signal)
  const app = resolveApp(snapshot, req.app)
  assertTargetAllowed(app)
  const record = registry.forAction(req.sessionId, app.pid, req.observationId)
  const mode: DeliveryMode = req.pointer === 'global' ? 'global' : 'pid'
  const windowRef = { frame: record.window.frame, title: record.window.title }

  const handle = req.element !== undefined ? registry.element(record, req.element) : null
  const pointAt = (h: ElementHandle | null, x?: number, y?: number): [number, number] => {
    if (h) {
      if (!h.frame || h.frame[2] <= 0 || h.frame[3] <= 0) {
        throw new ComputerError('badRequest', `Element ${h.index} has no position on screen (offscreen or hidden) — scroll to it, or use x/y.`)
      }
      return frameCenter(h.frame)
    }
    if (x === undefined || y === undefined) throw new ComputerError('badRequest', `Action "${req.action}" needs element or x/y.`)
    return shotToGlobal(record.geometry, x, y)
  }
  const expect = (h: ElementHandle) => ({ role: h.role, title: h.title })
  const element = (h: ElementHandle, kind: 'press' | 'focus' | 'setValue', extra: { actions?: string[]; value?: string } = {}) =>
    driver.act({ op: 'element', pid: app.pid, window: windowRef, path: h.path, expect: expect(h), kind, ...extra }, req.signal)
  const mouse = (point: [number, number], button: 'left' | 'right' | 'middle', clicks = 1, kind: 'click' | 'move' = 'click') =>
    driver.act({ op: 'mouse', pid: app.pid, windowId: record.window.id, x: point[0], y: point[1], button, clicks, kind, mode }, req.signal)
  const done = (summary: string): ActOutcome => ({ summary, app, record })
  const where = (point: [number, number]) => (handle ? `element ${handle.index} (${label(handle)})` : `(${req.x}, ${req.y}) → global (${point[0]}, ${point[1]})`)
  const pressed = (r: { action?: string; unconfirmed?: boolean }, what: string) =>
    `${what} via ${r.action}${r.unconfirmed ? ' (the app did not confirm in time — it probably ran; check the next observation)' : ''}.`
  // Modo dirigido: evento de mouse por pid é ignorado pelo AppKit (Fase 0) —
  // o ponto vira elemento pelo hit-test do AX e a ação vai pela acessibilidade.
  const hit = (point: [number, number], actions: string[], focusText: boolean) =>
    driver.act({ op: 'hit', pid: app.pid, x: point[0], y: point[1], actions, focusText }, req.signal)
  const needsGlobal = (what: string) =>
    new ComputerError(
      'unavailable',
      `${what} needs the global pointer (it moves the user's real cursor), which is off. In directed mode only accessibility actions work: use an element index, keyboard ("key"/"type"), set_value or invoke — or tell the user they can enable "Global pointer" in Settings → Computer.`,
    )

  switch (req.action) {
    case 'left_click': {
      if (handle) {
        const r = await element(handle, 'press', { actions: PRESS_ACTIONS })
        if (r.done) return done(pressed(r, `Pressed element ${handle.index} (${label(handle)})`))
      }
      const point = pointAt(handle, req.x, req.y)
      if (mode === 'pid') {
        const r = await hit(point, PRESS_ACTIONS, true)
        if (r.done === 'press') return done(pressed(r, `Pressed ${r.node ? roleOf(r.node) : 'the element'} at ${where(point)}`))
        if (r.done === 'focus') return done(`Focused ${r.node ? roleOf(r.node) : 'the text field'} at ${where(point)} — use "type" to write in it.`)
        throw new ComputerError(
          'unavailable',
          `Nothing clickable through accessibility at ${where(point)}${r.node ? ` (found ${roleOf(r.node)} without a press action)` : ''}. In directed mode a click must land on a button/link/control or a text field. Try another element from the tree, the keyboard, or ask the user to enable "Global pointer" in Settings → Computer.`,
        )
      }
      await mouse(point, 'left')
      return done(`Clicked ${where(point)} with the global pointer.`)
    }
    case 'right_click': {
      if (handle) {
        const r = await element(handle, 'press', { actions: ['AXShowMenu'] })
        if (r.done) return done(`Opened the context menu of element ${handle.index} (${label(handle)}).`)
      }
      const point = pointAt(handle, req.x, req.y)
      if (mode === 'pid') {
        const r = await hit(point, ['AXShowMenu'], false)
        if (r.done) return done(`Opened the context menu at ${where(point)}.`)
        throw needsGlobal('A right-click where no element offers a context menu')
      }
      await mouse(point, 'right')
      return done(`Right-clicked ${where(point)} with the global pointer.`)
    }
    case 'middle_click': {
      if (mode === 'pid') throw needsGlobal('Middle-click')
      const point = pointAt(handle, req.x, req.y)
      await mouse(point, 'middle')
      return done(`Middle-clicked ${where(point)} with the global pointer.`)
    }
    case 'double_click': {
      // Selecionar palavra/abrir item com clique duplo não tem ação AX equivalente.
      if (mode === 'pid') throw needsGlobal('Double-click')
      const point = pointAt(handle, req.x, req.y)
      await mouse(point, 'left', 2)
      return done(`Double-clicked ${where(point)} with the global pointer.`)
    }
    case 'move': {
      if (mode === 'pid') throw needsGlobal('Hovering (moving the pointer)')
      const point = pointAt(handle, req.x, req.y)
      await mouse(point, 'left', 1, 'move')
      return done(`Moved the pointer to ${where(point)}.`)
    }
    case 'drag': {
      // Arrastar janela ou seleção depende de uma sessão de drag do window
      // server, que evento por pid não conduz.
      if (mode !== 'global') throw needsGlobal('Dragging')
      const from = pointAt(handle, req.x, req.y)
      const toHandle = req.toElement !== undefined ? registry.element(record, req.toElement) : null
      const to = pointAt(toHandle, req.toX, req.toY)
      await driver.act({ op: 'drag', pid: app.pid, windowId: record.window.id, from, to, mode }, req.signal)
      return done(`Dragged from ${from.join(', ')} to ${to.join(', ')} (global points).`)
    }
    case 'scroll': {
      const direction = req.direction ?? 'down'
      const ticks = Math.min(Math.max(req.amount ?? 3, 1), 20)
      const point =
        handle || (req.x !== undefined && req.y !== undefined) ? pointAt(handle, req.x, req.y) : frameCenter(record.window.frame)
      const pixels = ticks * SCROLL_PIXELS_PER_TICK
      // Roda positiva = conteúdo desce (rolar para cima).
      const dy = direction === 'up' ? pixels : direction === 'down' ? -pixels : 0
      const dx = direction === 'left' ? pixels : direction === 'right' ? -pixels : 0
      if (mode === 'pid') {
        // A roda por pid também é ignorada: move a barra de rolagem pelo AX e,
        // sem barra exposta, cai para Page Up/Down (teclado por pid funciona).
        const r = await driver.act({ op: 'scrollAx', pid: app.pid, x: point[0], y: point[1], dx, dy }, req.signal)
        if (r.done) return done(`Scrolled ${direction} ~${pixels}px at ${point.join(', ')} (accessibility scroll bar).`)
        if (dy !== 0) {
          const key = direction === 'up' ? 'pageup' : 'pagedown'
          const pages = Math.max(1, Math.round(ticks / 3))
          await driver.act({ op: 'keys', pid: app.pid, combos: parseKeys(Array(pages).fill(key).join(' ')), mode }, req.signal)
          return done(`Scrolled ${direction} with ${pages}× ${key} (no accessible scroll bar there; the keys go to the focused element).`)
        }
        throw needsGlobal('Horizontal scrolling here')
      }
      await driver.act({ op: 'scroll', pid: app.pid, x: point[0], y: point[1], dx, dy, mode }, req.signal)
      return done(`Scrolled ${direction} ${ticks} step(s) at ${point.join(', ')} with the global pointer.`)
    }
    case 'type': {
      if (!req.text) throw new ComputerError('badRequest', 'Action "type" needs "text".')
      if (handle) {
        if (handle.secure) throw secureRefusal()
        await element(handle, 'focus')
      } else {
        const focused = await driver.act({ op: 'focused', pid: app.pid }, req.signal)
        if (focused.node?.secure) throw secureRefusal()
      }
      await driver.act({ op: 'keys', pid: app.pid, text: req.text, mode }, req.signal)
      return done(`Typed ${req.text.length} character(s)${handle ? ` into element ${handle.index} (${label(handle)})` : ' into the focused element'}.`)
    }
    case 'key': {
      if (!req.key) throw new ComputerError('badRequest', 'Action "key" needs "key" (e.g. "cmd+s", "return", "ctrl+a ctrl+c").')
      const combos = parseKeys(req.key)
      await driver.act({ op: 'keys', pid: app.pid, combos, mode }, req.signal)
      return done(`Pressed ${req.key}.`)
    }
    case 'set_value': {
      if (!handle) throw new ComputerError('badRequest', 'Action "set_value" needs "element".')
      if (handle.secure) throw secureRefusal()
      if (req.text === undefined) throw new ComputerError('badRequest', 'Action "set_value" needs "text" (the new value).')
      const result = await element(handle, 'setValue', { value: req.text })
      if (!result.done) {
        return done(`Element ${handle.index} (${label(handle)}) does not accept a value directly — click it and use "type" instead.`)
      }
      return done(`Set the value of element ${handle.index} (${label(handle)}). Read back: ${JSON.stringify(result.readBack ?? '')}.`)
    }
    case 'invoke': {
      if (!handle) throw new ComputerError('badRequest', 'Action "invoke" needs "element".')
      const wanted = req.axAction ? [req.axAction.startsWith('AX') ? req.axAction : `AX${req.axAction[0].toUpperCase()}${req.axAction.slice(1)}`] : PRESS_ACTIONS
      const result = await element(handle, 'press', { actions: wanted })
      if (!result.done) {
        const available = handle.actions.join(', ') || 'none'
        return done(`Element ${handle.index} (${label(handle)}) does not support ${wanted.join('/')} (available: ${available}).`)
      }
      return done(pressed(result, `Invoked on element ${handle.index} (${label(handle)})`))
    }
  }
  throw new ComputerError('badRequest', `Unknown action: ${req.action as string}`)
}

function roleOf(node: { role: string; title?: string | null }): string {
  const role = node.role.replace(/^AX/, '').toLowerCase()
  return node.title ? `${role} "${node.title}"` : role
}

function secureRefusal(): ComputerError {
  return new ComputerError(
    'secureField',
    'The target is a secure (password) field. Never type passwords, 2FA codes or payment data — ask the user to type it themselves.',
  )
}
