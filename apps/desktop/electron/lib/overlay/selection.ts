import { clipboard } from 'electron'
import { getComputerDriver, isComputerAvailable } from '../computer'
import type { AppInfo } from '../computer/types'

/**
 * Lê o texto selecionado no app que a pessoa está usando, para o overlay
 * (⇧⌘espaço) poder traduzir/resumir sem ela copiar nada.
 *
 * Duas camadas, na ordem:
 *  1. AXSelectedText do elemento com foco do app (sem efeito colateral);
 *  2. cópia por Cmd+C + área de transferência, restaurando o que estava lá.
 *
 * A camada 2 só roda quando pedida (`allowClipboard`) e só com o app em
 * primeiro plano — teclar Cmd+C num app que não está na frente copiaria outra
 * coisa. Nenhuma das duas funciona sem a permissão de Acessibilidade, que é a
 * mesma do Computer Use.
 */

export interface SelectionRead {
  text: string
  /** App de onde o texto saiu (nome exibido). */
  app: string | null
  /** `ax` = leitura direta; `clipboard` = copiou e restaurou a área de transferência. */
  source: 'ax' | 'clipboard'
}

const MAX_SELECTION = 20_000
const COPY_WAIT_MS = 220

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** O app é o próprio Orbit (a janela do overlay ou a principal)? */
function isOrbitApp(app: AppInfo): boolean {
  if (/^orbit$/i.test(app.name) || /^electron$/i.test(app.name)) return true
  return (app.bundleId ?? '').toLowerCase().startsWith('com.fragmentslabs')
}

/** App em primeiro plano, ignorando o Orbit. `null` quando só existe o Orbit. */
export async function frontmostForeignApp(): Promise<AppInfo | null> {
  if (!isComputerAvailable() || process.platform !== 'darwin') return null
  try {
    const snapshot = await getComputerDriver().apps()
    // `apps` vem na ordem do NSWorkspace (arbitrária); `windows` vem da frente
    // para trás. O primeiro pid com janela que não é o Orbit é o app em que a
    // pessoa estava — mesmo que o painel já tenha roubado o foco.
    const byPid = new Map(snapshot.apps.map((app) => [app.pid, app]))
    for (const window of snapshot.windows) {
      const app = byPid.get(window.pid)
      if (!app || app.hidden || isOrbitApp(app)) continue
      return app
    }
    return snapshot.apps.find((app) => app.active && !isOrbitApp(app)) ?? null
  } catch {
    return null
  }
}

/** Texto selecionado via AX no app indicado (sem tocar na área de transferência). */
async function readFromAx(pid: number): Promise<string | null> {
  try {
    const result = await getComputerDriver().act({ op: 'readSelection', pid })
    const text = result.selection?.text
    return text && text.trim() ? text.trim() : null
  } catch {
    return null
  }
}

/**
 * Cmd+C no app e leitura da área de transferência, devolvendo o que estava lá
 * ao final. Sem isso, um "traduz isso" sem seleção deixaria a conversa com o
 * texto errado no clipboard — e o próximo Cmd+V da pessoa colaria lixo.
 */
async function readFromClipboard(pid: number): Promise<string | null> {
  // No Electron 44 a área de transferência é assíncrona nos dois sentidos.
  const before = await clipboard.readText()
  try {
    await getComputerDriver().act({
      op: 'keys',
      pid,
      combos: [{ code: 8 /* C */, flags: 0x100000 /* Command */ }],
      mode: 'global',
    })
  } catch {
    return null
  }
  await sleep(COPY_WAIT_MS)
  const copied = await clipboard.readText()
  if (before !== copied) {
    // Restaura depois de ler: a próxima colagem da pessoa continua sendo a dela.
    await clipboard.writeText(before)
  }
  if (!copied.trim() || copied === before) return null
  return copied.trim()
}

/**
 * Texto selecionado agora. `allowClipboard` deve ser true só quando a pessoa
 * pediu explicitamente (a tool `see_selection`), nunca na abertura do overlay —
 * abrir o painel não pode mexer na área de transferência.
 */
export async function readSelectedText(options?: { allowClipboard?: boolean }): Promise<SelectionRead | null> {
  if (!isComputerAvailable() || process.platform !== 'darwin') return null
  const target = await frontmostForeignApp()
  if (!target) return null

  const ax = await readFromAx(target.pid)
  if (ax) return { text: ax.slice(0, MAX_SELECTION), app: target.name, source: 'ax' }

  if (!options?.allowClipboard) return null
  // Cmd+C vai para o app em primeiro plano: com outro app na frente (o overlay
  // recebeu o foco), teclar agora copiaria do lugar errado.
  if (!target.active) return null
  const copied = await readFromClipboard(target.pid)
  return copied ? { text: copied.slice(0, MAX_SELECTION), app: target.name, source: 'clipboard' } : null
}
