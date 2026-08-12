import { useEffect, useRef } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"
import { usePanelStore } from "@/src/stores/panel-store"

interface ManagedTerminalTabProps {
  ptyId: string
  /** Sessão de chat dona da aba — os links do terminal abrem o browser nela. */
  sessionId?: string
}

/**
 * Sessão persistente de terminal.
 *
 * O painel lateral desmonta o conteúdo da aba ao trocar de chat/aba (o
 * RightPanel re-renderiza com outro sessionKey e o TerminalTabContent sai da
 * árvore). Recriar o xterm do zero nessa hora apagaria o buffer (scrollback) e
 * os listeners de `terminal:output` — o terminal "voltaria vazio".
 *
 * Por isso a instância do Terminal (e os listeners IPC) vive aqui, no módulo,
 * por ptyId: ao desmontar apenas desanexamos o host do DOM; ao remontar,
 * reanexamos o mesmo host com o buffer e o estado intactos. O output que
 * chega enquanto a aba está fora continua sendo gravado no buffer (o listener
 * fica registrado no módulo), então nada se perde.
 */
const terminalSessions = new Map<
  string,
  { term: Terminal; fitAddon: FitAddon; host: HTMLDivElement; sessionId?: string }
>()

function getTerminalSession(ptyId: string) {
  const existing = terminalSessions.get(ptyId)
  if (existing) return existing

  const term = new Terminal({
    cols: 80,
    rows: 24,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 2,
    fontSize: 13,
    fontFamily: '"Cascadia Code", "Fira Code", Menlo, Monaco, "Courier New", monospace',
    fontWeight: "normal",
    lineHeight: 1.2,
    scrollback: 5000,
    theme: {
      background: "#00000000",
      foreground: "#cccccc",
      cursor: "#cccccc",
      cursorAccent: "#00000000",
      selectionBackground: "#264f78",
      black: "#1e1e1e",
      red: "#f14c4c",
      green: "#4ec994",
      yellow: "#cdcb70",
      blue: "#569cd6",
      magenta: "#c586c0",
      cyan: "#4ec9b0",
      white: "#d4d4d4",
      brightBlack: "#808080",
      brightRed: "#f14c4c",
      brightGreen: "#4ec994",
      brightYellow: "#cdcb70",
      brightBlue: "#569cd6",
      brightMagenta: "#c586c0",
      brightCyan: "#4ec9b0",
      brightWhite: "#ffffff",
    },
    allowTransparency: true,
    convertEol: false,
  })

  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)

  // Links clicáveis: um `npm run dev` imprime http://localhost:5173 e
  // Ctrl+Clique (Windows/Linux) ou Cmd+Clique (macOS) abre uma NOVA aba de
  // browser no painel, na sessão dona do terminal. Clique simples não faz
  // nada (evita abrir aba ao selecionar texto ou clicar por acidente). Sem
  // sessão (órfão) ou esquema fora de http(s), cai no browser do sistema
  // (setWindowOpenHandler do main). O handler substitui o default do addon
  // (window.open cru) — funciona igual no Windows e no macOS, é tudo renderer.
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (event.button !== 0) return
      if (!(event.ctrlKey || event.metaKey)) return
      const sessionId = terminalSessions.get(ptyId)?.sessionId
      if (/^https?:\/\//i.test(uri) && sessionId) {
        usePanelStore.getState().openTerminalLink(sessionId, uri)
        return
      }
      window.open(uri, "_blank")
    }),
  )

  const host = document.createElement("div")
  host.className = "absolute inset-0 px-2 py-1"
  term.open(host)

  // Listeners registrados UMA vez, no módulo: continuam ativos mesmo com a aba
  // desmontada, então o buffer recebe o output produzido durante a ausência.
  term.onData((data) => {
    window.ipcRenderer.invoke("terminal:write", ptyId, data).catch(console.error)
  })

  term.onResize(({ cols, rows }) => {
    window.ipcRenderer.invoke("terminal:resize", ptyId, cols, rows).catch(console.error)
  })

  // Ctrl+Shift+C: copia a seleção (o Ctrl+C comum é capturado pelo menu
  // nativo do Electron e nunca chega aqui). Retorna false para não enviar
  // o atalho ao shell.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type === "keydown" && event.ctrlKey && event.shiftKey && event.code === "KeyC") {
      const selection = term.getSelection()
      if (selection) void navigator.clipboard.writeText(selection).catch(() => undefined)
      return false
    }
    return true
  })

  const onOutput = (payload: unknown) => {
    const { id, data } = payload as { id: string; data: string }
    if (id === ptyId) term.write(data)
  }

  const onExit = (payload: unknown) => {
    const { id } = payload as { id: string }
    if (id === ptyId) term.write("\r\n\x1b[2m--- Terminal encerrado ---\x1b[0m\r\n")
  }

  window.ipcRenderer.on("terminal:output", onOutput)
  window.ipcRenderer.on("terminal:exit", onExit)

  const session: { term: Terminal; fitAddon: FitAddon; host: HTMLDivElement; sessionId?: string } = { term, fitAddon, host }
  terminalSessions.set(ptyId, session)
  return session
}

export function ManagedTerminalTab({ ptyId, sessionId }: ManagedTerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const session = getTerminalSession(ptyId)
    // Sessão dona do terminal: o xterm vive no módulo (fora do React), então o
    // handler de links lê a sessão daqui no momento do clique — a aba pertence
    // à sessão que a criou e o sessionKey não muda durante a vida dela.
    session.sessionId = sessionId
    // Reanexa o host com o buffer intacto (move o elemento, não recria o xterm)
    container.appendChild(session.host)

    const fit = () => {
      try {
        session.fitAddon.fit()
      } catch {
        return
      }
    }

    requestAnimationFrame(() => {
      fit()
      session.term.scrollToBottom()
      session.term.focus()
    })

    const resizeObserver = new ResizeObserver(fit)
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      // Apenas desanexa do DOM; a sessão (buffer + PTY) continua viva no módulo
      session.host.remove()
    }
  }, [ptyId])

  return (
    <div className="flex-1 min-h-0 relative bg-sidebar" onClick={() => getTerminalSession(ptyId).term.focus()}>
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  )
}
