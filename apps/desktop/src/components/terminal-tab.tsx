import { useEffect, useRef } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"
import { usePanelStore } from "@/src/stores/panel-store"
import { terminalTheme } from "@/src/lib/terminal-theme"

interface ManagedTerminalTabProps {
  ptyId: string
  /** Chat session that owns the tab — the terminal links open the browser in it. */
  sessionId?: string
}

/**
 * Persistent terminal session.
 *
 * The side panel unmounts the content of the tab when switching chat/tab (the
 * RightPanel re-renders with another sessionKey and the TerminalTabContent leaves the
 * tree). Recreating the xterm from scratch at that moment would erase the buffer (scrollback) and
 * the `terminal:output` listeners — the terminal "would come back empty".
 *
 * That is why the Terminal instance (and the IPC listeners) lives here, in the module,
 * by ptyId: on unmount we only detach the host from the DOM; on remount,
 * we re-attach the same host with the buffer and the state intact. The output that
 * arrives while the tab is away keeps being written to the buffer (the listener
 * stays registered in the module), so nothing is lost.
 */
const terminalSessions = new Map<
  string,
  { term: Terminal; fitAddon: FitAddon; host: HTMLDivElement; sessionId?: string }
>()

/**
 * The app theme becomes a class on the <html> ([theme-provider.tsx]). The xterm lives outside
 * React, so nobody tells it about the switch: a single observer, in the module, repaints
 * all the open sessions. Swapping `options.theme` recolors without recreating the
 * terminal — buffer, scrollback and listeners stay up.
 */
function prefersDark() {
  return document.documentElement.classList.contains("dark")
}

let themeObserver: MutationObserver | undefined

function watchTheme() {
  if (themeObserver) return
  themeObserver = new MutationObserver(() => {
    const theme = terminalTheme(prefersDark())
    for (const { term } of terminalSessions.values()) term.options.theme = theme
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
}

function getTerminalSession(ptyId: string) {
  const existing = terminalSessions.get(ptyId)
  if (existing) return existing

  watchTheme()

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
    theme: terminalTheme(prefersDark()),
    allowTransparency: true,
    convertEol: false,
  })

  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)

  // Clickable links: a `npm run dev` prints http://localhost:5173 and
  // Ctrl+Click (Windows/Linux) or Cmd+Click (macOS) opens a NEW browser tab
  // in the panel, in the session that owns the terminal. A simple click does
  // nothing (it avoids opening a tab when selecting text or clicking by accident). With no
  // session (orphan) or a scheme outside http(s), it falls into the system browser
  // (main setWindowOpenHandler). The handler replaces the addon default
  // (raw window.open) — it works the same on Windows and on macOS, it is all renderer.
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

  // Listeners registered ONCE, in the module: they stay active even with the tab
  // unmounted, so the buffer receives the output produced during the absence.
  term.onData((data) => {
    window.ipcRenderer.invoke("terminal:write", ptyId, data).catch(console.error)
  })

  term.onResize(({ cols, rows }) => {
    window.ipcRenderer.invoke("terminal:resize", ptyId, cols, rows).catch(console.error)
  })

  // Ctrl+Shift+C: copies the selection (the common Ctrl+C is captured by the
  // Electron native menu and never reaches here). It returns false so as not to send
  // the shortcut to the shell.
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
    // Session that owns the terminal: the xterm lives in the module (outside React), so the
    // link handler reads the session from here at the moment of the click — the tab belongs
    // to the session that created it and the sessionKey does not change during its life.
    session.sessionId = sessionId
    // Re-attaches the host with the buffer intact (it moves the element, does not recreate the xterm)
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
      // It only detaches from the DOM; the session (buffer + PTY) stays alive in the module
      session.host.remove()
    }
    // Re-attaches by ptyId; the sessionId is recorded in the session and does not change during
    // the life of the tab (see the comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId])

  // Terminal surface: `--muted` in light (the xterm is transparent) and the
  // sidebar in dark, as it always was.
  return (
    <div
      className="flex-1 min-h-0 relative bg-muted dark:bg-sidebar"
      onClick={() => getTerminalSession(ptyId).term.focus()}
    >
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  )
}
