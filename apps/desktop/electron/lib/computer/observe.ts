import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { windowSpace, type ShotGeometry } from './geometry'
import { diffTrees, formatTree, SCREEN_CONTENT_CLOSE, SCREEN_CONTENT_OPEN } from './format'
import { newObservationId, type ObservationRecord, type Registry } from './registry'
import { assertTargetAllowed, CHROMIUM_BROWSERS } from './safety'
import { ComputerError, type AppInfo, type AppsSnapshot, type ComputerDriver, type Frame, type TreeSnapshot, type WindowInfo } from './types'

/**
 * Monta uma observação: screenshot + árvore + foco de UMA janela, registrada
 * com índices novos. O texto devolvido declara a geometria (em que espaço
 * estão x/y) e cerca todo conteúdo vindo da tela como dado não confiável.
 */

export interface ObserveOptions {
  sessionId: string
  app: string
  windowId?: number
  includeTree: boolean
  includeScreenshot: boolean
  maxNodes: number
  maxScreenshotEdge: number
  /** Liga a árvore AX de apps Chromium/Electron */
  enhance: boolean
  /** Espera depois de ligar a flag — quem chama sabe se o app já estava ligado */
  enhanceWaitMs?: number
  /** Escala do monitor da janela (2 no Retina) — define o espaço de coordenadas */
  scaleFor?: (frame: Frame) => number
  /**
   * Observação contra a qual o texto pode sair como diff. Só quem chama sabe se
   * o modelo ainda tem essa observação no contexto (uma de outro turno ou do
   * subagente ele nunca viu), então é ela que decide passar a base.
   */
  diffAgainst?: ObservationRecord | null
  signal?: AbortSignal
}

/** Diffs seguidos antes de uma árvore completa: a cadeia não cresce sem fim, e o corte de contexto descarta o que ficou para trás. */
export const MAX_DIFF_CHAIN = 8
/** Acima desta fração da árvore mudada, o diff já não é menor que a árvore. */
const DIFF_MAX_FRACTION = 0.4
const DIFF_MIN_LINES = 12

export interface ObservationResult {
  record: ObservationRecord
  text: string
  /** Imagem já reduzida e codificada para o modelo */
  image: { data: Buffer; mediaType: 'image/webp' } | null
  /** Por que não há imagem, quando pedida */
  imageNote: string | null
  tree: TreeSnapshot | null
}

/** Acha o app pelo que o modelo mandou: bundle id, exe (Windows), nome (sem caixa) ou pid. */
export function resolveApp(snapshot: AppsSnapshot, query: string): AppInfo {
  const q = query.trim()
  const lower = q.toLowerCase()
  const byPid = /^\d+$/.test(q) ? snapshot.apps.find((a) => a.pid === Number(q)) : undefined
  const app =
    byPid ??
    snapshot.apps.find((a) => a.bundleId === q) ??
    snapshot.apps.find((a) => a.bundleId?.toLowerCase() === lower) ??
    // Windows: pelo exe, com ou sem ".exe" ("notepad" acha o Notepad.exe).
    snapshot.apps.find((a) => a.exe && [lower, `${lower}.exe`].includes(a.exe.toLowerCase())) ??
    snapshot.apps.find((a) => a.name.toLowerCase() === lower) ??
    snapshot.apps.find((a) => a.name.toLowerCase().includes(lower))
  if (!app) {
    throw new ComputerError('appNotFound', `No running app matches "${query}". Call cu_apps to list what is open, or use cu_computer with action "open_app".`)
  }
  return app
}

/** A janela pedida, ou a da frente do app (o CGWindowList vem de frente para trás). */
export function resolveWindow(snapshot: AppsSnapshot, app: AppInfo, windowId?: number): WindowInfo {
  if (windowId !== undefined) {
    const win = snapshot.windows.find((w) => w.id === windowId && w.pid === app.pid)
    if (!win) throw new ComputerError('windowNotFound', `Window ${windowId} of ${app.name} is not visible anymore — call cu_apps again.`)
    return win
  }
  const win = snapshot.windows.find((w) => w.pid === app.pid)
  if (!win) {
    throw new ComputerError(
      'windowNotFound',
      `${app.name} has no visible window (minimized, hidden or on another Space). Ask the user to bring it up, or activate it first.`,
    )
  }
  return win
}

/** Redimensiona exatamente para o espaço da janela: com e sem imagem, x/y são os mesmos. */
async function encodeShot(png: Buffer, size: { width: number; height: number }): Promise<{ data: Buffer; width: number; height: number }> {
  const data = await sharp(png).resize(size.width, size.height, { fit: 'fill' }).webp({ quality: 72 }).toBuffer()
  return { data, ...size }
}

export async function observe(
  driver: ComputerDriver,
  registry: Registry,
  options: ObserveOptions,
): Promise<ObservationResult> {
  const snapshot = await driver.apps(options.signal)
  const app = resolveApp(snapshot, options.app)
  assertTargetAllowed(app)
  const win = resolveWindow(snapshot, app, options.windowId)
  const geometry = windowSpace(win.frame, options.scaleFor?.(win.frame) ?? 1, options.maxScreenshotEdge)

  // Captura e árvore em paralelo: são processos diferentes, e a soma dos dois
  // é o tempo que o turno espera.
  const [shot, tree] = await Promise.all([
    options.includeScreenshot
      ? driver
          .capture(win.id, options.signal)
          .then((png) => encodeShot(png, geometry))
          .catch((err: unknown) => {
            if (err instanceof ComputerError && err.code === 'aborted') throw err
            return err instanceof ComputerError ? err : new ComputerError('bridgeError', String(err))
          })
      : Promise.resolve(null),
    options.includeTree
      ? driver.tree(
          {
            pid: app.pid,
            window: { id: win.id, frame: win.frame, title: win.title },
            maxNodes: options.maxNodes,
            enhance: options.enhance,
            enhanceFull: options.enhance && Boolean(app.bundleId && CHROMIUM_BROWSERS.has(app.bundleId)),
            enhanceWaitMs: options.enhanceWaitMs ?? 0,
          },
          options.signal,
        )
      : Promise.resolve(null),
  ])

  const image = shot && !(shot instanceof ComputerError) ? shot : null
  const imageNote = shot instanceof ComputerError ? shot.message : null
  if (!image && !tree) {
    throw shot instanceof ComputerError ? shot : new ComputerError('badRequest', 'Nothing to observe: include_tree and include_screenshot are both false.')
  }

  // Mesma janela: os índices de quem continua na tela não mudam.
  const previous = registry.peek(options.sessionId, app.pid)
  const sameWindow = previous && previous.window.id === win.id ? previous : null
  const formatted = tree ? formatTree(tree, geometry, sameWindow?.keys) : null
  const title = win.title ?? (tree?.nodes[0]?.title || null)

  const base = options.diffAgainst
  const diff =
    formatted && base?.bodies && base.window.id === win.id && (base.diffChain ?? 0) < MAX_DIFF_CHAIN
      ? diffTrees(base.bodies, formatted.bodies)
      : null
  const diffSize = diff ? diff.added.length + diff.changed.length + diff.removed.length : 0
  const useDiff =
    diff !== null && formatted !== null && diffSize <= Math.max(DIFF_MIN_LINES, Math.round(formatted.bodies.size * DIFF_MAX_FRACTION))

  const record: ObservationRecord = {
    id: newObservationId(),
    sessionId: options.sessionId,
    createdAt: Date.now(),
    app,
    window: { ...win, title },
    geometry,
    hasScreenshot: Boolean(image),
    url: formatted?.url ?? null,
    elements: formatted?.handles ?? new Map(),
    digest: formatted ? createHash('sha1').update(formatted.lines.join('\n')).digest('hex') : null,
    keys: formatted?.keys,
    bodies: formatted?.bodies,
    diffChain: useDiff ? (base?.diffChain ?? 0) + 1 : 0,
  }
  registry.record(record)

  const lines: string[] = []
  lines.push(`App: ${app.name} (${app.bundleId ?? 'no bundle id'}, pid ${app.pid})${app.active ? '' : ' — in the background'}`)
  lines.push(
    `Window ${win.id}: ${title ? `"${title}"` : '(untitled)'} — ${Math.round(win.frame[2])}×${Math.round(win.frame[3])} ${driver.platform === 'win32' ? 'px' : 'pt'} at (${Math.round(win.frame[0])}, ${Math.round(win.frame[1])})`,
  )
  lines.push(
    image
      ? `Observation ${record.id} — screenshot ${geometry.width}×${geometry.height} px. x/y in cu_computer are pixels of THIS screenshot; element frames below (@x,y wxh) use the same space.`
      : `Observation ${record.id} — no screenshot${imageNote ? ` (${imageNote})` : ''}. x/y in cu_computer and the frames below (@x,y wxh) still use this window's screenshot space (${geometry.width}×${geometry.height} px) — the same numbers as an observation with the image.`,
  )
  if (record.url) lines.push(`URL: ${record.url}`)
  if (formatted && tree && useDiff && diff && base) {
    const focused = formatted.focusedIndex
    if (focused !== null) lines.push(`Focused: element ${focused}`)
    const unchanged = formatted.bodies.size - diff.added.length - diff.changed.length
    if (diffSize === 0) {
      lines.push(`Tree: no change since ${base.id} — every element keeps its index.`)
    } else {
      lines.push(
        `Tree: changes since ${base.id} (${unchanged} other elements unchanged, same indices; "+" new, "~" changed). Call cu_observe for the whole tree.`,
      )
      lines.push(SCREEN_CONTENT_OPEN)
      const shown = new Set([...diff.added, ...diff.changed])
      const added = new Set(diff.added)
      formatted.indices.forEach((index) => {
        if (shown.has(index)) lines.push(`${added.has(index) ? '+' : '~'} ${index} ${formatted.bodies.get(index)}`)
      })
      if (diff.removed.length) lines.push(`- gone: ${diff.removed.join(', ')}`)
      lines.push(SCREEN_CONTENT_CLOSE)
    }
  } else if (formatted && tree) {
    const focused = formatted.focusedIndex
    if (focused !== null) lines.push(`Focused: element ${focused}`)
    const notes: string[] = []
    if (tree.truncated === 'maxNodes') notes.push(`truncated at ${options.maxNodes} nodes, ${tree.omitted} not shown — use cu_query to search the rest`)
    else if (tree.truncated === 'deadline') notes.push(`stopped by the time budget, ${tree.omitted} not shown — use cu_query or a smaller max_nodes`)
    else if (tree.truncated === 'axTimeout') notes.push(`${tree.timeouts} elements did not answer (app busy) — the tree is partial`)
    lines.push(`Tree (${formatted.handles.size} elements${notes.length ? `; ${notes.join('; ')}` : ''}):`)
    lines.push(SCREEN_CONTENT_OPEN)
    lines.push(...formatted.lines)
    lines.push(SCREEN_CONTENT_CLOSE)
    if (formatted.handles.size <= 2 && !options.enhance) {
      lines.push('The accessibility tree is almost empty. For browsers and Electron apps, observe again with enhance_accessibility: true; otherwise rely on the screenshot and x/y.')
    }
  } else if (options.includeTree === false) {
    lines.push('Tree not requested — act by x/y on the screenshot, or observe with include_tree to get element indices.')
  }
  return { record, text: lines.join('\n'), image: image ? { data: image.data, mediaType: 'image/webp' } : null, imageNote, tree }
}

/** Alvo por descrição em vez de índice: texto da linha (título, valor, descrição) e/ou papel. */
export interface ElementQuery {
  text?: string
  role?: string
}

const roleWord = (role: string) => role.toLowerCase().replace(/^ax/, '').replace(/\s+/g, '')

/** A parte da linha que descreve o elemento — sem ações nem posição, onde "press" ou "12" casariam com tudo. */
const searchable = (body: string) => body.replace(/ (actions: |@\d+,\d+ |offscreen\b).*$/, '').toLowerCase()

/** Algum elemento da observação mostra este texto? (o `expect` das ações) */
export function treeMentions(record: ObservationRecord, text: string): boolean {
  const needle = text.toLowerCase()
  if (record.window.title?.toLowerCase().includes(needle)) return true
  for (const body of record.bodies?.values() ?? []) if (searchable(body).includes(needle)) return true
  return false
}

/**
 * Resolve um alvo descrito contra uma observação. Ambíguo é erro com os
 * candidatos — nunca o primeiro da lista, que é como um clique vai parar no
 * botão errado. Com vários candidatos, o título exatamente igual ao texto vence.
 */
export function findElement(record: ObservationRecord, target: ElementQuery): number {
  if (!target.text && !target.role) throw new ComputerError('badRequest', 'find needs "text" and/or "role".')
  if (!record.bodies) throw new ComputerError('staleIndex', 'The latest observation of this app has no tree — call cu_observe first.')
  const needle = target.text?.toLowerCase() ?? null
  const role = target.role ? roleWord(target.role) : null
  const hits = [...record.bodies].filter(([index, body]) => {
    const handle = record.elements.get(index)
    if (!handle) return false
    if (role && !roleWord(handle.role).includes(role)) return false
    return !needle || searchable(body).includes(needle)
  })
  const what = [target.role, target.text && `"${target.text}"`].filter(Boolean).join(' ')
  if (hits.length === 0) {
    throw new ComputerError('staleIndex', `No element matches ${what} in observation ${record.id}. Call cu_query or cu_observe to see what is there.`)
  }
  if (hits.length > 1 && needle) {
    const exact = hits.filter(([index]) => record.elements.get(index)?.title?.toLowerCase() === needle)
    if (exact.length === 1) return exact[0][0]
  }
  if (hits.length > 1) {
    const list = hits.slice(0, 6).map(([index, body]) => `${index} ${body}`)
    throw new ComputerError(
      'ambiguous',
      `${hits.length} elements match ${what} — be more specific (add role, or more of the text) or use the index:\n${list.join('\n')}`,
    )
  }
  return hits[0][0]
}

export interface QueryOptions {
  sessionId: string
  app: string
  windowId?: number
  text?: string
  role?: string
  maxNodes: number
  limit: number
  enhance: boolean
  enhanceWaitMs?: number
  maxScreenshotEdge: number
  scaleFor?: (frame: Frame) => number
  signal?: AbortSignal
}

/**
 * Busca na árvore sem screenshot — o caminho barato quando o app é grande. Lê
 * com orçamento maior e devolve só as linhas que casam, com índices válidos
 * para o cu_computer: vira a observação mais recente do app. Se a janela não
 * mudou desde o último screenshot, mantém o espaço de coordenadas dele.
 */
export async function query(driver: ComputerDriver, registry: Registry, options: QueryOptions): Promise<string> {
  if (!options.text && !options.role) throw new ComputerError('badRequest', 'cu_query needs "text" and/or "role".')
  const snapshot = await driver.apps(options.signal)
  const app = resolveApp(snapshot, options.app)
  assertTargetAllowed(app)
  const win = resolveWindow(snapshot, app, options.windowId)
  const tree = await driver.tree(
    {
      pid: app.pid,
      window: { id: win.id, frame: win.frame, title: win.title },
      maxNodes: options.maxNodes,
      deadlineMs: 8000,
      enhance: options.enhance,
      enhanceFull: options.enhance && Boolean(app.bundleId && CHROMIUM_BROWSERS.has(app.bundleId)),
      enhanceWaitMs: options.enhanceWaitMs ?? 0,
    },
    options.signal,
  )
  const previous = registry.peek(options.sessionId, app.pid)
  const sameFrame = previous && previous.window.id === win.id && previous.window.frame.every((v, i) => Math.abs(v - win.frame[i]) < 1)
  const geometry: ShotGeometry = windowSpace(win.frame, options.scaleFor?.(win.frame) ?? 1, options.maxScreenshotEdge)
  const formatted = formatTree(tree, geometry, previous && previous.window.id === win.id ? previous.keys : undefined)
  // Nunca vira base de diff (diffChain no teto): a busca lê com outro
  // orçamento, e um diff contra ela apontaria como sumido tudo o que a
  // observação seguinte não alcança. As linhas ficam para a busca por alvo.
  const record: ObservationRecord = {
    id: newObservationId(),
    sessionId: options.sessionId,
    createdAt: Date.now(),
    app,
    window: win,
    geometry,
    hasScreenshot: Boolean(previous && sameFrame && previous.hasScreenshot),
    url: formatted.url,
    elements: formatted.handles,
    digest: null,
    keys: formatted.keys,
    bodies: formatted.bodies,
    diffChain: MAX_DIFF_CHAIN,
  }
  registry.record(record)

  const needle = options.text?.toLowerCase() ?? null
  const role = options.role?.toLowerCase().replace(/^ax/, '') ?? null
  const matches: string[] = []
  formatted.lines.forEach((line, i) => {
    const handle = formatted.handles.get(formatted.indices[i])
    if (!handle) return
    const body = line.trimStart()
    if (needle && !body.toLowerCase().includes(needle)) return
    if (role && !handle.role.toLowerCase().replace(/^ax/, '').includes(role.replace(/\s+/g, ''))) return
    matches.push(body)
  })
  const shown = matches.slice(0, options.limit)
  const space = `frames and x/y use this window's screenshot space (${geometry.width}×${geometry.height} px), with or without an image`
  const header = [
    `App: ${app.name} (${app.bundleId ?? 'no bundle id'}, pid ${app.pid}) — window ${win.id}`,
    `Observation ${record.id} (replaces the previous one of this app; ${space}). Searched ${tree.nodes.length} nodes${tree.truncated ? ` (stopped: ${tree.truncated})` : ''}.`,
    shown.length
      ? `${matches.length} match(es)${matches.length > shown.length ? `, showing ${shown.length}` : ''}:`
      : 'No element matches. Try another word, a role (button, text field, link…), or cu_observe to see the screen.',
  ]
  return [...header, ...(shown.length ? [SCREEN_CONTENT_OPEN, ...shown, SCREEN_CONTENT_CLOSE] : [])].join('\n')
}
