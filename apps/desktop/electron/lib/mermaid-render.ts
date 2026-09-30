import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import { BrowserWindow } from 'electron'
import { mermaidSourcesOf, type Block, type RenderedDiagram } from './document-render'

/**
 * Diagramas Mermaid desenhados no MAIN, para os arquivos que saem do app.
 *
 * Na tela quem desenha é o Streamdown, no renderer. O PDF e o .docx não passam
 * por lá: o PDF é a impressão de um HTML estático (sem script nenhum rodando),
 * e o .docx é XML montado à mão. Os dois precisam do diagrama já pronto — o PDF
 * como SVG embutido no HTML (vetor, nítido em qualquer zoom) e o .docx como PNG
 * (o Word até aceita SVG, mas só versões recentes, e o LibreOffice/Google Docs
 * o descartam; PNG abre em todo lugar).
 *
 * O Mermaid precisa de DOM para medir texto, então roda numa janela oculta e
 * isolada (sandbox, sem Node), a mesma receita da miniatura e do PDF. A janela
 * é aberta por lote e fechada no fim — manter uma viva gastaria memória o tempo
 * todo por um recurso que se usa de vez em quando.
 */

const _require = createRequire(import.meta.url)

/** Tempo máximo por lote. Um diagrama que não sai nesse tempo vira código. */
const RENDER_TIMEOUT_MS = 20_000
/** Resolução do PNG em relação ao tamanho do SVG: 2x fica nítido impresso. */
const PNG_SCALE = 2

/**
 * O mesmo diagrama é desenhado várias vezes na vida de um documento (salvar,
 * miniatura, PDF, .docx), sempre com a mesma fonte. Cache pelo hash da fonte
 * evita abrir a janela de novo para o que não mudou.
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
 * Roda DENTRO da janela oculta. É texto, e não uma função serializada com
 * toString: o bundle do main pode reescrever a função (helpers injetados,
 * nomes trocados) e ela chegaria à página referenciando o que lá não existe.
 * Recebe `sources` e `scale`; usa só o `mermaid` global e o DOM.
 */
const PAGE_SCRIPT = `async (sources, scale) => {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'default',
    // Rótulos em HTML (foreignObject) sujam o canvas e o toDataURL falha —
    // o PNG do .docx sairia vazio. Em SVG puro o diagrama rasteriza limpo.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    fontFamily: 'Arial, Helvetica, sans-serif',
  })
  const out = []
  for (let i = 0; i < sources.length; i++) {
    try {
      const { svg } = await mermaid.render('orbit-diagram-' + i, sources[i])
      // Mermaid devolve width="100%" e o tamanho real só no viewBox. Fixar
      // largura e altura em px é o que dá ao PNG e ao Word uma medida.
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
      // Fundo branco: PNG transparente fica preto no tema escuro do Word.
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      out.push({ svg: fixed, png: canvas.toDataURL('image/png'), width, height })
    } catch (err) {
      out.push({ error: err && err.message ? err.message : String(err) })
    }
    // O Mermaid deixa nós temporários no body quando a sintaxe falha.
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
    // O `void 0` no fim é obrigatório: o executeJavaScript devolve o valor da
    // última expressão, que no bundle do Mermaid é um objeto que não passa
    // pelo IPC ("could not be cloned") — e a promessa rejeitaria.
    await win.webContents.executeJavaScript(`${await loadMermaidScript()}\n;void 0`)
    const call = `(${PAGE_SCRIPT})(${JSON.stringify(sources)}, ${PNG_SCALE})`
    return (await Promise.race([
      win.webContents.executeJavaScript(call),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Mermaid demorou demais')), RENDER_TIMEOUT_MS),
      ),
    ])) as PageResult[]
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * Os diagramas Mermaid dos blocos, prontos para o HTML e o .docx. Devolve um
 * lookup pela fonte; o que não desenhou (sintaxe inválida, timeout) fica de
 * fora, e o renderizador cai para o bloco de código — o documento sai inteiro
 * mesmo com um diagrama quebrado.
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
      console.warn('[mermaid] render falhou:', err)
    }
    missing.forEach((source, i) => {
      const r = results[i]
      const ok = r?.svg && r.png && r.width && r.height
      // Falha por timeout não entra no cache: pode ter sido só a máquina
      // ocupada. Erro de sintaxe entra, senão cada salvamento reabriria a janela.
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
      if (!ok) console.warn('[mermaid] diagrama inválido:', r.error)
    })
  }

  return (source) => cache.get(keyOf(source)) ?? undefined
}
