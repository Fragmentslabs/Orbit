import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import { BrowserWindow } from 'electron'
import { mermaidSourcesOf, type Block, type RenderedDiagram } from './document-render'

/**
 * Mermaid diagrams drawn in the MAIN, for the files that leave the app.
 *
 * On screen whoever draws is Streamdown, in the renderer. The PDF and the .docx do not go
 * through there: the PDF is the printing of a static HTML (with no script running),
 * and the .docx is hand-assembled XML. Both need the diagram ready — the PDF
 * as SVG embedded in the HTML (vector, sharp at any zoom) and the .docx as PNG
 * (Word even accepts SVG, but only recent versions, and LibreOffice/Google Docs
 * discard it; PNG opens everywhere).
 *
 * Mermaid needs a DOM to measure text, so it runs in a hidden and isolated
 * window (sandbox, no Node), the same recipe as the thumbnail and the PDF. The window
 * is opened per batch and closed at the end — keeping one alive would spend memory all the
 * time for a resource that is used now and then.
 */

const _require = createRequire(import.meta.url)

/** Maximum time per batch. A diagram that does not come out in that time becomes code. */
const RENDER_TIMEOUT_MS = 20_000
/** PNG resolution relative to the SVG size: 2x stays sharp in print. */
const PNG_SCALE = 2

/**
 * The same diagram is drawn several times in a document's life (save,
 * thumbnail, PDF, .docx), always from the same source. Cache by the source's hash
 * avoids opening the window again for what has not changed.
 */
const cache = new Map<string, RenderedDiagram | null>()
const CACHE_LIMIT = 200

const keyOf = (source: string) => createHash('sha1').update(source).digest('hex')

let mermaidScript: Promise<string> | null = null
function loadMermaidScript(): Promise<string> {
  mermaidScript ??= fsp.readFile(_require.resolve('mermaid/dist/mermaid.min.js'), 'utf8')
  return mermaidScript
}

interface PageResult {
  svg?: string
  png?: string
  width?: number
  height?: number
  error?: string
}

/**
 * Runs INSIDE the hidden window. It is text, and not a function serialized with
 * toString: the main's bundle may rewrite the function (injected helpers, renamed
 * names) and it would reach the page referencing what does not exist there.
 * It receives `sources` and `scale`; it uses only the global `mermaid` and the DOM.
 */
const PAGE_SCRIPT = `async (sources, scale) => {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'default',
    // HTML labels (foreignObject) dirty the canvas and toDataURL fails —
    // the .docx PNG would come out empty. In pure SVG the diagram rasterizes cleanly.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    fontFamily: 'Arial, Helvetica, sans-serif',
  })
  const out = []
  for (let i = 0; i < sources.length; i++) {
    try {
      const { svg } = await mermaid.render('orbit-diagram-' + i, sources[i])
      // Mermaid returns width="100%" and the real size only in the viewBox. Fixing
      // width and height in px is what gives the PNG and Word a measurement.
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const el = doc.documentElement
      const box = (el.getAttribute('viewBox') || '').trim().split(/[ ,]+/).map(Number)
      const width = Math.ceil(box[2] || 600)
      const height = Math.ceil(box[3] || 400)
      el.setAttribute('width', String(width))
      el.setAttribute('height', String(height))
      el.removeAttribute('style')
      const fixed = new XMLSerializer().serializeToString(el)

      const img = new Image()
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(fixed)
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
      const ctx = canvas.getContext('2d')
      // White background: a transparent PNG turns black in the dark theme of Word.
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      out.push({ svg: fixed, png: canvas.toDataURL('image/png'), width, height })
    } catch (err) {
      out.push({ error: err && err.message ? err.message : String(err) })
    }
    // Mermaid leaves temporary nodes in the body when the syntax fails.
    document.body.innerHTML = ''
  }
  return out
}`

async function renderBatch(sources: string[]): Promise<PageResult[]> {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      partition: `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  try {
    await win.loadURL('about:blank')
    // The `void 0` at the end is mandatory: executeJavaScript returns the value of the
    // last expression, which in Mermaid's bundle is an object that does not pass
    // through IPC ("could not be cloned") — and the promise would reject.
    await win.webContents.executeJavaScript(`${await loadMermaidScript()}\n;void 0`)
    const call = `(${PAGE_SCRIPT})(${JSON.stringify(sources)}, ${PNG_SCALE})`
    return (await Promise.race([
      win.webContents.executeJavaScript(call),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Mermaid took too long')), RENDER_TIMEOUT_MS),
      ),
    ])) as PageResult[]
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * The Mermaid diagrams of the blocks, ready for the HTML and the .docx. It returns a
 * lookup by source; what did not draw (invalid syntax, timeout) stays
 * out, and the renderer falls back to the code block — the document comes out whole
 * even with a broken diagram.
 */
export async function renderDiagrams(
  blocks: Block[],
): Promise<(source: string) => RenderedDiagram | undefined> {
  const sources = [...new Set(mermaidSourcesOf(blocks))]
  const missing = sources.filter((s) => !cache.has(keyOf(s)))

  if (missing.length > 0) {
    let results: PageResult[] = []
    try {
      results = await renderBatch(missing)
    } catch (err) {
      console.warn('[mermaid] render failed:', err)
    }
    missing.forEach((source, i) => {
      const r = results[i]
      const ok = r?.svg && r.png && r.width && r.height
      // A timeout failure does not enter the cache: it may have been just the machine
      // being busy. A syntax error enters, otherwise every save would reopen the window.
      if (!ok && !r) return
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
      cache.set(
        keyOf(source),
        ok
          ? {
              svg: r.svg!,
              png: Buffer.from(r.png!.slice(r.png!.indexOf(',') + 1), 'base64'),
              width: r.width!,
              height: r.height!,
            }
          : null,
      )
      if (!ok) console.warn('[mermaid] invalid diagram:', r.error)
    })
  }

  return (source) => cache.get(keyOf(source)) ?? undefined
}
