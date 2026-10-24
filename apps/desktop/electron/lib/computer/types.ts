/**
 * Tipos do Computer Use. O driver fala o protocolo da bridge (JSON por
 * operação); o resto do módulo só conhece estes tipos — é o que permite testar
 * tudo com um driver falso, sem tocar no sistema.
 */

/**
 * [x, y, largura, altura] em coordenadas globais: pontos no macOS (origem no
 * topo do monitor principal), pixels físicos do desktop virtual no Windows (o
 * host é per-monitor DPI aware).
 */
export type Frame = [number, number, number, number]

export interface AppInfo {
  pid: number
  bundleId: string | null
  name: string
  active: boolean
  hidden: boolean
  /**
   * Windows: o app roda com integridade maior que a do Orbit (administrador).
   * O UIPI descarta mensagens e SendInput vindos de um processo comum.
   */
  elevated?: boolean
  /** Windows: nome do executável ("chrome.exe"); o `bundleId` é o AUMID quando o app é empacotado */
  exe?: string
}

export interface WindowInfo {
  /** CGWindowID no macOS; HWND no Windows */
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
  /**
   * Identidade estável do elemento dentro da observação (Windows: RuntimeId
   * da UIA). Quando existe, a ação vai por ela e o `path` fica de fallback; o
   * macOS não manda.
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
  /** Por que a árvore parou antes do fim (null = completa) */
  truncated: 'maxNodes' | 'deadline' | 'axTimeout' | null
  omitted: number
  timeouts: number
  enhanced: boolean
  ms: number
}

/** A janela-alvo. `id` (HWND) é o que o Windows usa; o macOS acha pelo frame e título. */
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
      window: WindowRef
      path: number[]
      /** Identidade da observação (Windows); sem ela, o host vai pelo `path` */
      ref?: string
      expect?: { role: string; title?: string | null }
      kind: 'info' | 'press' | 'focus' | 'setValue' | 'select'
      actions?: string[]
      value?: string
      /** select: texto a achar no valor do elemento (sem ele, seleciona tudo) */
      find?: string
      /** select: qual ocorrência (1 = a primeira) */
      occurrence?: number
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
  /** `notes`: o que mais limita o controle nesta máquina (Windows: CLM, integridade) */
  perms(signal?: AbortSignal): Promise<{ accessibility: boolean; notes?: string[] }>
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
  /**
   * Mouse e roda por mensagem de janela chegam ao app sem mover o cursor
   * (Windows). No macOS é false: a Fase 0 mostrou que o AppKit ignora mouse
   * por pid, e o modo dirigido vai todo pela acessibilidade.
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
  /** O elemento do `ref` não existe mais (Windows) */
  | 'staleRef'
  /** App como administrador: o UIPI bloqueia a entrada (Windows) */
  | 'elevated'
  /** UAC, tela de bloqueio ou Ctrl+Alt+Del na frente (Windows) */
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
