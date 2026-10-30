/**
 * Computer Use types. The driver speaks the bridge protocol (JSON per operation); the
 * rest of the module only knows these types — which is what allows testing everything
 * with a fake driver, without touching the system.
 */

/**
 * [x, y, width, height] in global coordinates: points on macOS (origin at the top of
 * the main monitor), physical pixels of the virtual desktop on Windows (the host is
 * per-monitor DPI aware).
 */
export type Frame = [number, number, number, number]

export interface AppInfo {
  pid: number
  bundleId: string | null
  name: string
  active: boolean
  hidden: boolean
  /**
   * Windows: the app runs with higher integrity than Orbit's (administrator).
   * UIPI discards messages and SendInput coming from a common process.
   */
  elevated?: boolean
  /** Windows: name of the executable ("chrome.exe"); the `bundleId` is the AUMID when the app is packaged */
  exe?: string
}

export interface WindowInfo {
  /** CGWindowID on macOS; HWND on Windows */
  id: number
  pid: number
  /** null without the Screen Recording permission */
  title: string | null
  frame: Frame
}

export interface AppsSnapshot {
  apps: AppInfo[]
  /** Visible windows, from the front to the back */
  windows: WindowInfo[]
}

export interface AxNode {
  /** BFS order in the bridge — it is not the index shown to the model */
  id: number
  parent: number
  depth: number
  /** AXChildren indices from the window: it is what finds the element again */
  path: number[]
  /**
   * Stable identity of the element within the observation (Windows: UIA RuntimeId).
   * When it exists, the action goes by it and `path` becomes a fallback; macOS does not
   * send it.
   */
  ref?: string
  role: string
  subrole: string | null
  title: string | null
  value: string | null
  desc: string | null
  frame: Frame | null
  enabled: boolean
  focused: boolean
  placeholder: string | null
  help: string | null
  selected: boolean
  url: string | null
  secure: boolean
  childCount: number
  omittedChildren?: number
  actions: string[]
}

export interface TreeSnapshot {
  nodes: AxNode[]
  focusedId: number | null
  /** Why the tree stopped before the end (null = complete) */
  truncated: 'maxNodes' | 'deadline' | 'axTimeout' | null
  omitted: number
  timeouts: number
  enhanced: boolean
  ms: number
}

/** The target window. `id` (HWND) is what Windows uses; macOS finds it by frame and title. */
export interface WindowRef {
  id?: number
  frame: Frame
  title: string | null
}

export interface TreeRequest {
  pid: number
  window: WindowRef
  maxNodes: number
  maxDepth?: number
  textLimit?: number
  deadlineMs?: number
  /** Turns on the tree of Chromium/Electron apps (AXManualAccessibility) */
  enhance?: boolean
  /** AXEnhancedUserInterface too — Chromium browsers only */
  enhanceFull?: boolean
  /** Wait after turning on the flag (Chromium builds the tree asynchronously); 0 if the app was already on */
  enhanceWaitMs?: number
}

export type PointerMode = 'directed' | 'global'

/** Delivery of the input events: by pid (without moving the cursor) or through HID. */
export type DeliveryMode = 'pid' | 'global'

export type BridgeAction =
  | { op: 'mouse'; pid: number; windowId: number; x: number; y: number; kind: 'click' | 'move'; button?: 'left' | 'right' | 'middle'; clicks?: number; mode: DeliveryMode }
  | { op: 'drag'; pid: number; windowId: number; from: [number, number]; to: [number, number]; steps?: number; mode: DeliveryMode }
  | { op: 'scroll'; pid: number; x: number; y: number; dx: number; dy: number; mode: DeliveryMode }
  | { op: 'keys'; pid: number; combos?: { code: number; flags: number }[]; text?: string; mode: DeliveryMode }
  | { op: 'activate'; pid: number }
  | { op: 'focused'; pid: number }
  | { op: 'hit'; pid: number; x: number; y: number; actions?: string[]; focusText?: boolean }
  | { op: 'scrollAx'; pid: number; x: number; y: number; dx: number; dy: number }
  | { op: 'selection'; pid: number }
  /** Text selected in the app, without the cut of `selection` (overlay) */
  | { op: 'readSelection'; pid: number }
  | {
      op: 'element'
      pid: number
      window: WindowRef
      path: number[]
      /** Identity of the observation (Windows); without it, the host goes by `path` */
      ref?: string
      expect?: { role: string; title?: string | null }
      kind: 'info' | 'press' | 'focus' | 'setValue' | 'select'
      actions?: string[]
      value?: string
      /** select: text to find in the element's value (without it, selects everything) */
      find?: string
      /** select: which occurrence (1 = the first one) */
      occurrence?: number
    }

export interface ElementResult {
  done: string | null
  action?: string
  /** AX did not confirm in time (-25204) — the action probably ran */
  unconfirmed?: boolean
  /** Text selection in the focused element (op selection) */
  selection?: { location: number; length: number; text: string | null } | null
  node?: Omit<AxNode, 'id' | 'parent' | 'depth' | 'path'>
  readBack?: string | null
}

/** What the driver of each OS delivers. The tests use a fake implementation. */
export interface ComputerDriver {
  readonly platform: NodeJS.Platform
  capabilities(): Capabilities
  /** `notes`: what else limits the control on this machine (Windows: CLM, integrity) */
  perms(signal?: AbortSignal): Promise<{ accessibility: boolean; notes?: string[] }>
  /** Asks for Screen Recording through CGRequestScreenCaptureAccess (system dialog) */
  requestScreen(): Promise<{ before: boolean; granted: boolean }>
  apps(signal?: AbortSignal): Promise<AppsSnapshot>
  tree(request: TreeRequest, signal?: AbortSignal): Promise<TreeSnapshot>
  /** PNG of the window (CGWindowID) */
  capture(windowId: number, signal?: AbortSignal): Promise<Buffer>
  act(action: BridgeAction, signal?: AbortSignal): Promise<ElementResult>
  /** Turns off the accessibility flag turned on by `enhance` */
  restore(pids: number[]): Promise<void>
  openApp(app: string, signal?: AbortSignal): Promise<void>
}

export interface Capabilities {
  /** Click by pid without moving the cursor */
  directedPointer: boolean
  /** Dragging requires the global pointer */
  dragNeedsGlobal: boolean
  accessibilityTree: boolean
  /**
   * Mouse and wheel through a window message reach the app without moving the cursor
   * (Windows). On macOS it is false: Phase 0 showed that AppKit ignores mouse by pid, and
   * the directed mode goes entirely through accessibility.
   */
  messageMouse: boolean
}

export type ComputerErrorCode =
  | 'axDenied'
  | 'screenDenied'
  | 'axTimeout'
  | 'timeout'
  | 'aborted'
  | 'windowNotFound'
  | 'appNotFound'
  | 'staleIndex'
  /** The element of `ref` no longer exists (Windows) */
  | 'staleRef'
  /** App as administrator: UIPI blocks the input (Windows) */
  | 'elevated'
  /** UAC, lock screen or Ctrl+Alt+Del in front (Windows) */
  | 'secureDesktop'
  | 'secureField'
  | 'blocked'
  | 'unavailable'
  | 'badRequest'
  | 'bridgeError'

export class ComputerError extends Error {
  constructor(
    readonly code: ComputerErrorCode | string,
    message: string,
  ) {
    super(message)
    this.name = 'ComputerError'
  }
}
