import type { AppsSnapshot, AxNode, BridgeAction, ComputerDriver, ElementResult, TreeSnapshot } from './types'

/**
 * Driver de mentira para os testes: um TextEdit com uma janela, um campo de
 * texto, um botão "Salvar" e um campo de senha. Registra as ações recebidas
 * — os testes conferem o que teria sido enviado ao sistema, sem tocar nele.
 */

export const FAKE_PID = 4711
export const FAKE_WINDOW = { id: 99, pid: FAKE_PID, title: 'Sem título', frame: [100, 50, 1000, 800] as [number, number, number, number] }

function node(over: Partial<AxNode> & Pick<AxNode, 'id' | 'parent' | 'depth' | 'path' | 'role'>): AxNode {
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

export function fakeTree(): TreeSnapshot {
  return {
    nodes: [
      node({ id: 0, parent: -1, depth: 0, path: [], role: 'AXWindow', subrole: 'AXStandardWindow', title: 'Sem título', frame: [100, 50, 1000, 800] }),
      // Grupo vazio: não ganha linha, os filhos sobem de nível.
      node({ id: 1, parent: 0, depth: 1, path: [0], role: 'AXGroup' }),
      node({ id: 2, parent: 1, depth: 2, path: [0, 0], role: 'AXTextArea', value: 'Olá', frame: [100, 100, 1000, 600], focused: true }),
      node({ id: 3, parent: 1, depth: 2, path: [0, 1], role: 'AXButton', title: 'Salvar', frame: [1000, 750, 80, 30], actions: ['AXPress'] }),
      node({ id: 4, parent: 0, depth: 1, path: [1], role: 'AXTextField', subrole: 'AXSecureTextField', frame: [200, 760, 200, 24], secure: true }),
    ],
    focusedId: 2,
    truncated: null,
    omitted: 0,
    timeouts: 0,
    enhanced: false,
    ms: 5,
  }
}

export interface FakeDriver extends ComputerDriver {
  actions: BridgeAction[]
  /** Resposta da próxima ação de elemento */
  elementResult: ElementResult
  /** Resposta do hit-test (clique por coordenada no modo dirigido) */
  hitResult: ElementResult
  /** Resposta da rolagem pelo AX */
  scrollResult: ElementResult
  /** A árvore muda depois de uma ação? (para o "nada mudou") */
  changeAfterAction: boolean
  restored: number[][]
}

export function createFakeDriver(png: Buffer): FakeDriver {
  let acted = 0
  const driver: FakeDriver = {
    platform: 'darwin',
    actions: [],
    restored: [],
    elementResult: { done: 'press', action: 'AXPress' },
    hitResult: { done: 'press', action: 'AXPress', node: { ...fakeTree().nodes[3] } },
    scrollResult: { done: 'scroll' },
    changeAfterAction: true,
    capabilities: () => ({ directedPointer: true, dragNeedsGlobal: true, accessibilityTree: true }),
    perms: async () => ({ accessibility: true }),
    apps: async (): Promise<AppsSnapshot> => ({
      apps: [
        { pid: FAKE_PID, bundleId: 'com.apple.TextEdit', name: 'TextEdit', active: false, hidden: false },
        { pid: 1, bundleId: 'com.1password.1password', name: '1Password', active: false, hidden: false },
      ],
      windows: [FAKE_WINDOW, { id: 7, pid: 1, title: 'Cofre', frame: [0, 0, 500, 500] }],
    }),
    tree: async () => {
      const tree = fakeTree()
      if (driver.changeAfterAction && acted > 0) tree.nodes[2].value = `Olá ${acted}`
      return tree
    },
    capture: async () => png,
    act: async (action) => {
      driver.actions.push(action)
      if (action.op === 'focused') return { done: 'focused', node: { ...fakeTree().nodes[2] } }
      acted++
      if (action.op === 'hit') return driver.hitResult
      if (action.op === 'scrollAx') return driver.scrollResult
      return action.op === 'element' ? driver.elementResult : { done: action.op }
    },
    restore: async (pids) => {
      driver.restored.push(pids)
    },
    openApp: async () => {},
  }
  return driver
}
