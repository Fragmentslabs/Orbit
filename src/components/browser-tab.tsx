import { useCallback, useEffect, useRef } from "react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  MousePointerClickIcon,
  RefreshCcwIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  WebPreview,
  WebPreviewBody,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
  WebPreviewBackButton,
  WebPreviewForwardButton,
  WebPreviewReloadButton,
  WebPreviewOpenInNewTabButton,
  useWebPreview,
} from "@/src/components/ai/web-preview"
import { panelApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"

/**
 * Aba Browser do painel direito, controlável pelo agente (tools panel_*):
 * - registra o webContents do <webview> no main (panel:register)
 * - navegação da barra de URL é controlada (loadURL), sem remount do webview
 * - modo seleção: clique em um elemento vira badge/anexo no input do code mode
 *   (o script injetado reporta via console-message com prefixo __ORBIT_SELECT__)
 */

/** Superfície do <webview> do Electron usada aqui (tipos do renderer não incluem electron) */
interface WebviewElement extends HTMLElement {
  getWebContentsId(): number
  getURL(): string
  loadURL(url: string): Promise<void>
  executeJavaScript(code: string): Promise<unknown>
  isLoading(): boolean
}

const SELECT_PREFIX = "__ORBIT_SELECT__"

const SELECT_ON = `(() => {
  if (window.__orbitSelectCleanup) window.__orbitSelectCleanup()
  let last = null
  const restore = () => { if (last) { last.style.outline = last.__orbitOutline || ''; last = null } }
  const over = (e) => {
    restore()
    last = e.target
    last.__orbitOutline = last.style.outline
    last.style.outline = '2px solid #22c55e'
  }
  const cssPath = (el) => {
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && parts.length < 5) {
      if (node.id) { parts.unshift('#' + node.id); break }
      let part = node.tagName.toLowerCase()
      const cls = [...node.classList].slice(0, 2).join('.')
      if (cls) part += '.' + cls
      const parent = node.parentElement
      if (parent) {
        const siblings = [...parent.children].filter((c) => c.tagName === node.tagName)
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      node = node.parentElement
    }
    return parts.join(' > ')
  }
  const click = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.target
    console.log('${SELECT_PREFIX}' + JSON.stringify({
      tag: el.tagName.toLowerCase(),
      selector: cssPath(el),
      text: (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 200),
      html: el.outerHTML.slice(0, 1500),
      url: location.href,
    }))
    window.__orbitSelectCleanup()
  }
  document.addEventListener('mouseover', over, true)
  document.addEventListener('click', click, true)
  window.__orbitSelectCleanup = () => {
    document.removeEventListener('mouseover', over, true)
    document.removeEventListener('click', click, true)
    restore()
    window.__orbitSelectCleanup = null
  }
})()`

const SELECT_OFF = `window.__orbitSelectCleanup && window.__orbitSelectCleanup()`

function PanelBrowserBody() {
  const { url, setUrl } = useWebPreview()
  const selectMode = usePanelStore((s) => s.selectMode)
  const webviewRef = useRef<WebviewElement | null>(null)
  const readyRef = useRef(false)
  const initialSrcRef = useRef(url)

  const handleWebviewRef = useCallback((el: HTMLElement | null) => {
    const webview = el as WebviewElement | null
    // Limpa listeners/registro do webview anterior
    if (!webview) {
      readyRef.current = false
      webviewRef.current = null
      panelApi.register(null)
      return
    }
    webviewRef.current = webview

    webview.addEventListener("dom-ready", () => {
      readyRef.current = true
      panelApi.register(webview.getWebContentsId())
    })
    const syncUrl = (e: Event) => {
      const navUrl = (e as Event & { url?: string }).url
      if (navUrl && navUrl !== "about:blank") setUrlRef.current(navUrl)
    }
    webview.addEventListener("did-navigate", syncUrl)
    webview.addEventListener("did-navigate-in-page", syncUrl)
    webview.addEventListener("console-message", (e) => {
      const message = (e as Event & { message?: string }).message
      if (!message?.startsWith(SELECT_PREFIX)) return
      try {
        const payload = JSON.parse(message.slice(SELECT_PREFIX.length))
        usePanelStore.getState().addSelection(payload)
      } catch {
        // payload malformado — ignora
      }
    })
  }, [])

  // setUrl muda a cada render do provider — ref estável para os listeners
  const setUrlRef = useRef(setUrl)
  setUrlRef.current = setUrl

  // Navegação controlada: mudanças na barra de URL viram loadURL (sem remount)
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview || !readyRef.current || !url) return
    if (webview.getURL() !== url) {
      void webview.loadURL(url).catch(() => {})
    }
  }, [url])

  // Modo seleção: injeta/remove o script de captura
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview || !readyRef.current) return
    void webview.executeJavaScript(selectMode ? SELECT_ON : SELECT_OFF).catch(() => {})
  }, [selectMode])

  return <WebPreviewBody src={initialSrcRef.current || undefined} onWebviewRef={handleWebviewRef} />
}

function SelectModeButton() {
  const selectMode = usePanelStore((s) => s.selectMode)
  const setSelectMode = usePanelStore((s) => s.setSelectMode)
  return (
    <WebPreviewNavigationButton
      tooltip={selectMode ? "Selecionando… clique em um elemento da página" : "Selecionar elemento para o agente"}
      onClick={() => setSelectMode(!selectMode)}
      className={cn(selectMode && "bg-emerald-500/15 text-emerald-500 hover:text-emerald-400")}
    >
      <MousePointerClickIcon className="size-4" />
    </WebPreviewNavigationButton>
  )
}

export function BrowserTab() {
  const browserUrl = usePanelStore((s) => s.browserUrl)

  return (
    <WebPreview defaultUrl={browserUrl ?? ""} className="h-full w-full rounded-none border-0 bg-sidebar">
      <WebPreviewNavigation>
        <WebPreviewBackButton>
          <ArrowLeftIcon className="size-4" />
        </WebPreviewBackButton>
        <WebPreviewForwardButton>
          <ArrowRightIcon className="size-4" />
        </WebPreviewForwardButton>
        <WebPreviewReloadButton>
          <RefreshCcwIcon className="size-4" />
        </WebPreviewReloadButton>
        <WebPreviewUrl />
        <SelectModeButton />
        <WebPreviewOpenInNewTabButton>
          <ExternalLinkIcon className="size-4" />
        </WebPreviewOpenInNewTabButton>
      </WebPreviewNavigation>
      <PanelBrowserBody />
    </WebPreview>
  )
}
