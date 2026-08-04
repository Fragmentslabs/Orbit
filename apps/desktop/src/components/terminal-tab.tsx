import { useCallback, useEffect, useRef } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"

interface ManagedTerminalTabProps {
  ptyId: string
}

export function ManagedTerminalTab({ ptyId }: ManagedTerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  const handleClick = useCallback(() => {
    termRef.current?.focus()
  }, [])

  useEffect(() => {
    const container = containerRef.current!
    const pid = ptyId

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
    term.open(container)
    termRef.current = term

    const onOutput = (payload: unknown) => {
      const { id, data } = payload as { id: string; data: string }
      if (id === pid) term.write(data)
    }

    const onExit = (payload: unknown) => {
      const { id } = payload as { id: string }
      if (id === pid) term.write("\r\n\x1b[2m--- Terminal encerrado ---\x1b[0m\r\n")
    }

    const removeOutput = window.ipcRenderer.on("terminal:output", onOutput)
    const removeExit = window.ipcRenderer.on("terminal:exit", onExit)

    const disposable = term.onData((data) => {
      window.ipcRenderer.invoke("terminal:write", pid, data).catch(console.error)
    })

    term.onResize(({ cols, rows }) => {
      window.ipcRenderer.invoke("terminal:resize", pid, cols, rows).catch(console.error)
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

    const fit = () => {
      try { fitAddon.fit() } catch { return }
    }

    requestAnimationFrame(() => {
      fit()
      term.focus()
    })

    const resizeObserver = new ResizeObserver(fit)
    resizeObserver.observe(container)

    return () => {
      disposable.dispose()
      resizeObserver.disconnect()
      window.ipcRenderer.off("terminal:output", removeOutput)
      window.ipcRenderer.off("terminal:exit", removeExit)
      term.dispose()
      termRef.current = null
    }
  }, [ptyId])

  return (
    <div className="flex-1 min-h-0 relative bg-sidebar" onClick={handleClick}>
      <div ref={containerRef} className="absolute inset-0 px-2 py-1" />
    </div>
  )
}
