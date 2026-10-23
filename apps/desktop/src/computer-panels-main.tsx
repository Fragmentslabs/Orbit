import React from "react"
import ReactDOM from "react-dom/client"
import { ThemeProvider } from "@/components/theme-provider"
import { ErrorBoundary } from "./components/error-boundary"
import { ComputerPanels } from "./components/computer-panels"
import "./i18n"
import "./index.css"

/**
 * Entrada da janela dos painéis do Computer Use. Fica de fora tudo o que a
 * janela principal liga ao carregar (sincronizadores com o celular, fila de
 * mensagens, configurações): esta janela só espelha a conversa — quem age é a
 * janela principal.
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
