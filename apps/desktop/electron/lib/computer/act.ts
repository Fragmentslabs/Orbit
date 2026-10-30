import { frameCenter, shotToGlobal } from './geometry'
import { parseKeys } from './keys'
import type { ElementHandle, ObservationRecord, Registry } from './registry'
import { resolveApp } from './observe'
import { assertTargetAllowed } from './safety'
import type { ShotTarget } from './shots'
import { ComputerError, type AppInfo, type ComputerDriver, type DeliveryMode, type PointerMode } from './types'

/**
 * Execution of a cu_computer action. The order of preference is always the least
 * intrusive: accessibility action on the element (AXPress, AXValue) before a mouse
 * event; event by pid (without moving the user's cursor) before the global pointer,
 * which only exists with the opt-in in the Preferences.
 */

export const COMPUTER_ACTIONS = [
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'move',
  'drag',
  'scroll',
  'type',
  'key',
  'wait',
  'invoke',
  'set_value',
  'select_text',
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
  /** select_text: which occurrence of the text (1 = the first one) */
  occurrence?: number
  pointer: PointerMode
  signal?: AbortSignal
}

export interface ActOutcome {
  /** Readable sentence of what happened (goes to the model and to the chip) */
  summary: string
  app: AppInfo | null
  /** Observation used — the read_back observes the same window */
  record: ObservationRecord | null
  /** The app moved (opened now): the read_back picks the front window */
  reopen?: boolean
  /** Where the action aimed, in global points — the marker of the thumbnail in the panel */
  target?: ShotTarget
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
    // Opening (or bringing to the front) takes a moment until the window exists.
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
  const windowRef = { id: record.window.id, frame: record.window.frame, title: record.window.title }
  // Windows: mouse and wheel through a window message reach the app without moving the
  // cursor. Not on macOS (Phase 0) — there the directed mode is accessibility only.
  const messageMouse = mode === 'pid' && driver.capabilities().messageMouse
  const keys = (input: string) => parseKeys(input, driver.platform)
  // The "go to the end of the line" shortcut is Cmd on the Mac and Ctrl on Windows.
  const modKey = driver.platform === 'win32' ? 'ctrl' : 'cmd'

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
  // The identity goes in the host's vocabulary (UIA on Windows): it is the host that checks it.
  const expect = (h: ElementHandle) => ({ role: h.nativeRole ?? h.role, title: h.title })
  const element = (
    h: ElementHandle,
    kind: 'press' | 'focus' | 'setValue' | 'select',
    extra: { actions?: string[]; value?: string; find?: string; occurrence?: number } = {},
  ) =>
    driver.act(
      { op: 'element', pid: app.pid, window: windowRef, path: h.path, ...(h.ref ? { ref: h.ref } : {}), expect: expect(h), kind, ...extra },
      req.signal,
    )
  const mouse = (point: [number, number], button: 'left' | 'right' | 'middle', clicks = 1, kind: 'click' | 'move' = 'click') =>
    driver.act({ op: 'mouse', pid: app.pid, windowId: record.window.id, x: point[0], y: point[1], button, clicks, kind, mode }, req.signal)
  // Target for the thumbnail marker: the element, or the requested x/y point.
  const aimed = (): ShotTarget | undefined => {
    if (handle?.frame && handle.frame[2] > 0 && handle.frame[3] > 0) return { frame: handle.frame }
    if (req.x === undefined || req.y === undefined) return undefined
    try {
      return { point: shotToGlobal(record.geometry, req.x, req.y) }
    } catch {
      return undefined
    }
  }
  const done = (summary: string): ActOutcome => ({ summary, app, record, target: aimed() })
  const where = (point: [number, number]) => (handle ? `element ${handle.index} (${label(handle)})` : `(${req.x}, ${req.y}) → global (${point[0]}, ${point[1]})`)
  const pressed = (r: { action?: string; unconfirmed?: boolean }, what: string) =>
    `${what} via ${r.action}${r.unconfirmed ? ' (the app did not confirm in time — it probably ran; check the next observation)' : ''}.`
  // Directed mode: a mouse event by pid is ignored by AppKit (Phase 0) —
  // the point becomes an element through the AX hit-test and the action goes through accessibility.
  const hit = (point: [number, number], actions: string[], focusText: boolean) =>
    driver.act({ op: 'hit', pid: app.pid, x: point[0], y: point[1], actions, focusText }, req.signal)
  // What stayed selected after dragging or a double/triple click — data,
  // not an assumption. No selection is an explicit warning: the drag missed the text.
  const selectionNote = async (): Promise<string> => {
    await sleep(150, req.signal)
    const r = await driver.act({ op: 'selection', pid: app.pid }, req.signal).catch(() => null)
    const sel = r?.selection
    if (!sel) return ''
    if (sel.length === 0) {
      return ` Nothing is selected now (text cursor at ${sel.location}) — the gesture missed the text. Check the y against the line in the latest observation (a point below the last line maps to the end of the text), or select with the keyboard (e.g. "shift+${modKey}+left").`
    }
    return ` Selection now: ${sel.length} character(s)${sel.text ? ` ${JSON.stringify(sel.text)}` : ''}.`
  }
  // Click through a window message (Windows, directed mode): the app confirms
  // nothing — the return asks to check the next observation.
  const messageClick = async (point: [number, number], button: 'left' | 'right' | 'middle', clicks = 1, kind: 'click' | 'move' = 'click') => {
    await mouse(point, button, clicks, kind)
    return ' via a window message (the app does not confirm it — check the next observation)'
  }
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
        if (messageMouse) return done(`Clicked ${where(point)}${await messageClick(point, 'left')}.`)
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
        if (messageMouse) return done(`Right-clicked ${where(point)}${await messageClick(point, 'right')}.`)
        throw needsGlobal('A right-click where no element offers a context menu')
      }
      await mouse(point, 'right')
      return done(`Right-clicked ${where(point)} with the global pointer.`)
    }
    case 'middle_click': {
      const point = pointAt(handle, req.x, req.y)
      if (messageMouse) return done(`Middle-clicked ${where(point)}${await messageClick(point, 'middle')}.`)
      if (mode === 'pid') throw needsGlobal('Middle-click')
      await mouse(point, 'middle')
      return done(`Middle-clicked ${where(point)} with the global pointer.`)
    }
    case 'double_click':
    case 'triple_click': {
      // Selecting a word (double) or a line (triple) has no equivalent AX action.
      const triple = req.action === 'triple_click'
      const point = pointAt(handle, req.x, req.y)
      if (messageMouse) {
        const how = await messageClick(point, 'left', triple ? 3 : 2)
        return done(`${triple ? 'Triple' : 'Double'}-clicked ${where(point)}${how}.${await selectionNote()}`)
      }
      if (mode === 'pid') throw needsGlobal(triple ? 'Triple-click' : 'Double-click')
      await mouse(point, 'left', triple ? 3 : 2)
      return done(`${triple ? 'Triple' : 'Double'}-clicked ${where(point)} with the global pointer.${await selectionNote()}`)
    }
    case 'move': {
      const point = pointAt(handle, req.x, req.y)
      if (messageMouse) return done(`Hovered ${where(point)}${await messageClick(point, 'left', 1, 'move')}.`)
      if (mode === 'pid') throw needsGlobal('Hovering (moving the pointer)')
      await mouse(point, 'left', 1, 'move')
      return done(`Moved the pointer to ${where(point)}.`)
    }
    case 'drag': {
      // Dragging a window or a selection depends on a drag session of the window
      // server, which an event by pid does not drive.
      if (mode !== 'global') throw needsGlobal('Dragging')
      const from = pointAt(handle, req.x, req.y)
      const toHandle = req.toElement !== undefined ? registry.element(record, req.toElement) : null
      const to = pointAt(toHandle, req.toX, req.toY)
      await driver.act({ op: 'drag', pid: app.pid, windowId: record.window.id, from, to, mode }, req.signal)
      return done(`Dragged from ${from.join(', ')} to ${to.join(', ')} (global points).${await selectionNote()}`)
    }
    case 'scroll': {
      const direction = req.direction ?? 'down'
      const ticks = Math.min(Math.max(req.amount ?? 3, 1), 20)
      const point =
        handle || (req.x !== undefined && req.y !== undefined) ? pointAt(handle, req.x, req.y) : frameCenter(record.window.frame)
      const pixels = ticks * SCROLL_PIXELS_PER_TICK
      // Positive delta = content goes down (scroll up).
      const dy = direction === 'up' ? pixels : direction === 'down' ? -pixels : 0
      const dx = direction === 'left' ? pixels : direction === 'right' ? -pixels : 0
      if (mode === 'pid') {
        // The wheel by pid is ignored too: it moves the scroll bar through AX and,
        // with no bar exposed, falls back to Page Up/Down (keyboard by pid works).
        const r = await driver.act({ op: 'scrollAx', pid: app.pid, x: point[0], y: point[1], dx, dy }, req.signal)
        if (r.done) return done(`Scrolled ${direction} ~${pixels}px at ${point.join(', ')} (accessibility scroll bar).`)
        if (messageMouse) {
          await driver.act({ op: 'scroll', pid: app.pid, x: point[0], y: point[1], dx, dy, mode }, req.signal)
          return done(`Scrolled ${direction} ${ticks} step(s) at ${point.join(', ')} via a window message (check the next observation).`)
        }
        if (dy !== 0) {
          const key = direction === 'up' ? 'pageup' : 'pagedown'
          const pages = Math.max(1, Math.round(ticks / 3))
          await driver.act({ op: 'keys', pid: app.pid, combos: keys(Array(pages).fill(key).join(' ')), mode }, req.signal)
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
      const combos = keys(req.key)
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
    case 'select_text': {
      // Selection through AX: deterministic, no coordinate and no mouse — it works with
      // the app in the background. It is the right path for "select and replace".
      if (!handle) throw new ComputerError('badRequest', 'Action "select_text" needs "element" (a text field or text area).')
      if (handle.secure) throw secureRefusal()
      const result = await element(handle, 'select', { find: req.text, occurrence: req.occurrence })
      const sel = result.selection
      if (!result.done || !sel) {
        return done(`Element ${handle.index} (${label(handle)}) did not accept a selection — click into it and use the keyboard (e.g. "shift+${modKey}+right").`)
      }
      return done(
        `Selected ${sel.length} character(s) in element ${handle.index} (${label(handle)})${sel.text ? `: ${JSON.stringify(sel.text)}` : ''} (range ${sel.location}–${sel.location + sel.length}). Typing now replaces it.`,
      )
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
