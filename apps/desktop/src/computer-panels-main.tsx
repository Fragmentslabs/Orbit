import React from "react"
import ReactDOM from "react-dom/client"
import { ThemeProvider } from "@/components/theme-provider"
import { ErrorBoundary } from "./components/error-boundary"
import { ComputerPanels } from "./components/computer-panels"
import "./i18n"
import "./index.css"

/**
 * Entry point of the Computer Use panels window. Everything the
 * main window wires up on load stays out (phone synchronizers, message
 * queue, settings): this window only mirrors the conversation — the one that acts is the
 * main window.
 */
const sessionId = new URLSearchParams(window.location.search).get("session")

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary label="computer-panels" fallback={() => null}>
      <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
        <ComputerPanels initialSessionId={sessionId} />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
