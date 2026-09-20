import path from 'node:path'
import { Worker } from 'node:worker_threads'

/**
 * ESLint do PROJETO, servindo o painel de arquivos.
 *
 * Duas decisões que valem registro:
 *
 * 1. É o eslint do projeto aberto, resolvido a partir do `package.json` dele —
 *    não um que o Orbit embute. O que aparece sublinhado tem que ser o que o
 *    projeto considera erro; uma segunda opinião de um analisador nosso seria
 *    ruído, e divergiria do que o CI reprova.
 *
 * 2. Roda numa worker thread, não no processo principal. Lint é trabalho de
 *    CPU: rodá-lo aqui travaria o event loop do main a cada pausa na
 *    digitação — e é pelo main que passa o stream do chat. Medido neste
 *    repositório: a primeira chamada leva ~2,8s (carregar eslint, config e
 *    plugins) e as seguintes 16–40ms, porque a instância fica viva.
 *
 * O script do worker é uma string avaliada em vez de um arquivo separado: o
 * main é empacotado pelo vite num bundle só, e um arquivo de worker exigiria
 * um entry point à parte só para isto.
 */

const WORKER_SOURCE = [
  "const { parentPort } = require('node:worker_threads')",
  "const { createRequire } = require('node:module')",
  'let engine = null',
  'let unavailable = false',
  "parentPort.on('message', async (msg) => {",
  '  if (unavailable) {',
  '    parentPort.postMessage({ id: msg.id, unavailable: true })',
  '    return',
  '  }',
  '  try {',
  '    if (!engine) {',
  '      // Resolve a partir do ARQUIVO, não da raiz: num monorepo o eslint que',
  "      // vale é o mais próximo dele, que é o mesmo que enxerga a config que",
  '      // será aplicada. A raiz fica de reserva.',
  '      let ESLint',
  '      try {',
  "        ESLint = createRequire(msg.filePath)('eslint').ESLint",
  '      } catch {',
  "        ESLint = createRequire(msg.root + '/package.json')('eslint').ESLint",
  '      }',
  '      engine = new ESLint({ cwd: msg.root })',
  '    }',
  '    const results = await engine.lintText(msg.content, {',
  '      filePath: msg.filePath,',
  '      warnIgnored: false,',
  '    })',
  '    parentPort.postMessage({ id: msg.id, messages: results[0] ? results[0].messages : [] })',
  '  } catch (err) {',
  '    // Projeto sem eslint, ou config que não carrega: desiste de vez em vez',
  '    // de repetir o erro a cada tecla.',
  '    unavailable = true',
  '    parentPort.postMessage({',
  '      id: msg.id,',
  '      unavailable: true,',
  '      error: String((err && err.message) || err),',
  '    })',
  '  }',
  '})',
].join('\n')

/** Uma mensagem do eslint, já no formato que o renderer consome. */
export interface LintMessage {
  line: number
  column: number
  endLine?: number
  endColumn?: number
  message: string
  ruleId: string | null
  /** 1 = aviso, 2 = erro (o mesmo do eslint). */
  severity: number
}

export type LintFileResult =
  | { ok: true; messages: LintMessage[] }
  /** Projeto sem eslint utilizável — o painel para de pedir. */
  | { ok: false; unavailable: true }

interface Pending {
  resolve: (value: LintFileResult) => void
  timer: NodeJS.Timeout
}

interface Instance {
  worker: Worker
  pending: Map<number, Pending>
  unavailable: boolean
}

/** Uma worker por raiz: cada projeto tem sua config e seus plugins. */
const instances = new Map<string, Instance>()
let nextId = 1

/** Teto por chamada: um plugin lento não pode deixar o painel esperando. */
const LINT_TIMEOUT_MS = 15_000

function settle(instance: Instance, id: number, value: LintFileResult): void {
  const pending = instance.pending.get(id)
  if (!pending) return
  clearTimeout(pending.timer)
  instance.pending.delete(id)
  pending.resolve(value)
}

function instanceFor(root: string): Instance {
  const existing = instances.get(root)
  if (existing) return existing
  const worker = new Worker(WORKER_SOURCE, { eval: true })
  const instance: Instance = { worker, pending: new Map(), unavailable: false }
  worker.on('message', (msg: { id: number; messages?: LintMessage[]; unavailable?: boolean; error?: string }) => {
    if (msg.unavailable) {
      if (!instance.unavailable && msg.error) {
        console.warn('[eslint] indisponível para', root, '—', msg.error)
      }
      instance.unavailable = true
      settle(instance, msg.id, { ok: false, unavailable: true })
      return
    }
    settle(instance, msg.id, { ok: true, messages: msg.messages ?? [] })
  })
  worker.on('error', (err: unknown) => {
    console.error('[eslint] worker falhou:', err instanceof Error ? err.message : String(err))
    instance.unavailable = true
    for (const id of [...instance.pending.keys()]) {
      settle(instance, id, { ok: false, unavailable: true })
    }
  })
  // A worker não pode segurar o app aberto no fechamento.
  worker.unref()
  instances.set(root, instance)
  return instance
}

export async function lintFile(
  root: string,
  filePath: string,
  content: string,
): Promise<LintFileResult> {
  const normalizedRoot = path.resolve(root).replace(/\\/g, '/')
  const instance = instanceFor(normalizedRoot)
  if (instance.unavailable) return { ok: false, unavailable: true }
  const id = nextId++
  return new Promise<LintFileResult>((resolve) => {
    const timer = setTimeout(() => {
      settle(instance, id, { ok: false, unavailable: true })
    }, LINT_TIMEOUT_MS)
    instance.pending.set(id, { resolve, timer })
    instance.worker.postMessage({
      id,
      root: normalizedRoot,
      filePath: path.resolve(filePath),
      content,
    })
  })
}

/** Encerra as workers — chamado no fechamento do app. */
export function stopLintWorkers(): void {
  for (const instance of instances.values()) void instance.worker.terminate()
  instances.clear()
}
