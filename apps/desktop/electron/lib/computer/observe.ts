import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { fitWithin, type ShotGeometry } from './geometry'
import { formatTree, SCREEN_CONTENT_CLOSE, SCREEN_CONTENT_OPEN } from './format'
import { newObservationId, type ObservationRecord, type Registry } from './registry'
import { assertTargetAllowed, CHROMIUM_BROWSERS } from './safety'
import { ComputerError, type AppInfo, type AppsSnapshot, type ComputerDriver, type TreeSnapshot, type WindowInfo } from './types'

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
  signal?: AbortSignal
}

export interface ObservationResult {
  record: ObservationRecord
  text: string
  /** Imagem já reduzida e codificada para o modelo */
  image: { data: Buffer; mediaType: 'image/webp' } | null
  /** Por que não há imagem, quando pedida */
  imageNote: string | null
  tree: TreeSnapshot | null
}

/** Acha o app pelo que o modelo mandou: bundle id, nome (sem caixa) ou pid. */
export function resolveApp(snapshot: AppsSnapshot, query: string): AppInfo {
  const q = query.trim()
  const lower = q.toLowerCase()
  const byPid = /^\d+$/.test(q) ? snapshot.apps.find((a) => a.pid === Number(q)) : undefined
  const app =
    byPid ??
    snapshot.apps.find((a) => a.bundleId === q) ??
    snapshot.apps.find((a) => a.bundleId?.toLowerCase() === lower) ??
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

async function encodeShot(png: Buffer, maxEdge: number): Promise<{ data: Buffer; width: number; height: number }> {
  const meta = await sharp(png).metadata()
  const size = fitWithin(meta.width ?? maxEdge, meta.height ?? maxEdge, maxEdge)
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

  // Captura e árvore em paralelo: são processos diferentes, e a soma dos dois
  // é o tempo que o turno espera.
  const [shot, tree] = await Promise.all([
    options.includeScreenshot
      ? driver
          .capture(win.id, options.signal)
          .then((png) => encodeShot(png, options.maxScreenshotEdge))
          .catch((err: unknown) => {
            if (err instanceof ComputerError && err.code === 'aborted') throw err
            return err instanceof ComputerError ? err : new ComputerError('bridgeError', String(err))
          })
      : Promise.resolve(null),
    options.includeTree
      ? driver.tree(
          {
            pid: app.pid,
            window: { frame: win.frame, title: win.title },
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

  // Sem screenshot, o espaço de coordenadas é o da janela em pontos — dito no texto.
  const geometry: ShotGeometry = image
    ? { frame: win.frame, width: image.width, height: image.height }
    : { frame: win.frame, width: Math.round(win.frame[2]), height: Math.round(win.frame[3]) }
  const formatted = tree ? formatTree(tree, geometry) : null
  const title = win.title ?? (tree?.nodes[0]?.title || null)

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
  }
  registry.record(record)

  const lines: string[] = []
  lines.push(`App: ${app.name} (${app.bundleId ?? 'no bundle id'}, pid ${app.pid})${app.active ? '' : ' — in the background'}`)
  lines.push(
    `Window ${win.id}: ${title ? `"${title}"` : '(untitled)'} — ${Math.round(win.frame[2])}×${Math.round(win.frame[3])} pt at (${Math.round(win.frame[0])}, ${Math.round(win.frame[1])})`,
  )
  lines.push(
    image
      ? `Observation ${record.id} — screenshot ${geometry.width}×${geometry.height} px. x/y in cu_computer are pixels of THIS screenshot; element frames below (@x,y wxh) use the same space.`
      : `Observation ${record.id} — no screenshot${imageNote ? ` (${imageNote})` : ''}. x/y in cu_computer are window points (0..${geometry.width} × 0..${geometry.height}).`,
  )
  if (record.url) lines.push(`URL: ${record.url}`)
  if (formatted && tree) {
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
      window: { frame: win.frame, title: win.title },
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
  const geometry: ShotGeometry =
    previous && sameFrame && previous.hasScreenshot
      ? previous.geometry
      : { frame: win.frame, width: Math.round(win.frame[2]), height: Math.round(win.frame[3]) }
  const formatted = formatTree(tree, geometry)
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
  }
  registry.record(record)

  const needle = options.text?.toLowerCase() ?? null
  const role = options.role?.toLowerCase().replace(/^ax/, '') ?? null
  const matches: string[] = []
  formatted.lines.forEach((line, index) => {
    const handle = formatted.handles.get(index)
    if (!handle) return
    const body = line.trimStart()
    if (needle && !body.toLowerCase().includes(needle)) return
    if (role && !handle.role.toLowerCase().replace(/^ax/, '').includes(role.replace(/\s+/g, ''))) return
    matches.push(body)
  })
  const shown = matches.slice(0, options.limit)
  const space = record.hasScreenshot
    ? `frames and x/y use the pixels of the last screenshot (${geometry.width}×${geometry.height})`
    : `no screenshot for this window: frames and x/y are window points (${geometry.width}×${geometry.height})`
  const header = [
    `App: ${app.name} (${app.bundleId ?? 'no bundle id'}, pid ${app.pid}) — window ${win.id}`,
    `Observation ${record.id} (replaces the previous one of this app; ${space}). Searched ${tree.nodes.length} nodes${tree.truncated ? ` (stopped: ${tree.truncated})` : ''}.`,
    shown.length
      ? `${matches.length} match(es)${matches.length > shown.length ? `, showing ${shown.length}` : ''}:`
      : 'No element matches. Try another word, a role (button, text field, link…), or cu_observe to see the screen.',
  ]
  return [...header, ...(shown.length ? [SCREEN_CONTENT_OPEN, ...shown, SCREEN_CONTENT_CLOSE] : [])].join('\n')
}
