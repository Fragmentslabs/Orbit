/**
 * Tipos do Computer Use. O driver fala o protocolo da bridge (JSON por
 * operação); o resto do módulo só conhece estes tipos — é o que permite testar
 * tudo com um driver falso, sem tocar no sistema.
 */

/** [x, y, largura, altura] em pontos globais (origem no topo do monitor principal). */
export type Frame = [number, number, number, number]

export interface AppInfo {
  pid: number
  bundleId: string | null
  name: string
  active: boolean
  hidden: boolean
}

export interface WindowInfo {
  /** CGWindowID */
  id: number
  pid: number
  /** null sem a permissão de Gravação de Tela */
  title: string | null
  frame: Frame
}

export interface AppsSnapshot {
  apps: AppInfo[]
  /** Janelas visíveis, da frente para trás */
  windows: WindowInfo[]
}

export interface AxNode {
  /** Ordem do BFS na bridge — não é o índice mostrado ao modelo */
  id: number
  parent: number
  depth: number
  /** Índices de AXChildren a partir da janela: é o que re-encontra o elemento */
  path: number[]
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
  /** Por que a árvore parou antes do fim (null = completa) */
  truncated: 'maxNodes' | 'deadline' | 'axTimeout' | null
  omitted: number
  timeouts: number
  enhanced: boolean
  ms: number
}

export interface TreeRequest {
  pid: number
  window: { frame: Frame; title: string | null }
  maxNodes: number
  maxDepth?: number
  textLimit?: number
  deadlineMs?: number
  /** Liga a árvore de apps Chromium/Electron (AXManualAccessibility) */
  enhance?: boolean
  /** Também AXEnhancedUserInterface — só navegadores Chromium */
  enhanceFull?: boolean
  /** Espera depois de ligar a flag (o Chromium monta a árvore assíncrono); 0 se o app já estava ligado */
  enhanceWaitMs?: number
}

export type PointerMode = 'directed' | 'global'

/** Entrega dos eventos de entrada: por pid (sem mover o cursor) ou pelo HID. */
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
  | {
      op: 'element'
      pid: number
      window: { frame: Frame; title: string | null }
      path: number[]
      expect?: { role: string; title?: string | null }
      kind: 'info' | 'press' | 'focus' | 'setValue'
      actions?: string[]
      value?: string
    }

export interface ElementResult {
  done: string | null
  action?: string
  /** O AX não confirmou a tempo (-25204) — a ação provavelmente rodou */
  unconfirmed?: boolean
  /** Seleção de texto no elemento com foco (op selection) */
  selection?: { location: number; length: number; text: string | null } | null
  node?: Omit<AxNode, 'id' | 'parent' | 'depth' | 'path'>
  readBack?: string | null
}

/** O que o driver de cada SO entrega. Os testes usam uma implementação falsa. */
export interface ComputerDriver {
  readonly platform: NodeJS.Platform
  capabilities(): Capabilities
  perms(signal?: AbortSignal): Promise<{ accessibility: boolean }>
  apps(signal?: AbortSignal): Promise<AppsSnapshot>
  tree(request: TreeRequest, signal?: AbortSignal): Promise<TreeSnapshot>
  /** PNG da janela (CGWindowID) */
  capture(windowId: number, signal?: AbortSignal): Promise<Buffer>
  act(action: BridgeAction, signal?: AbortSignal): Promise<ElementResult>
  /** Desliga a flag de acessibilidade ligada por `enhance` */
  restore(pids: number[]): Promise<void>
  openApp(app: string, signal?: AbortSignal): Promise<void>
}

export interface Capabilities {
  /** Clique por pid sem mover o cursor */
  directedPointer: boolean
  /** Arrastar exige o ponteiro global */
  dragNeedsGlobal: boolean
  accessibilityTree: boolean
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
