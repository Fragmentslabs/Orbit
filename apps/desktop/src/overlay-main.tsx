import React from "react"
import ReactDOM from "react-dom/client"
// Efeito de import: inicializa o i18n e aplica o idioma salvo antes do primeiro
// render (o painel tem poucas palavras, mas elas não podem sair no idioma errado).
import "./i18n"
import "./stores/locale-store"
import "./index.css"
import { ErrorBoundary } from "./components/error-boundary"
import { OverlayApp } from "./components/overlay/overlay-app"

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary
      label="overlay"
      fallback={(error) => (
        <div className="flex h-full items-end justify-center p-2">
          <div className="w-full rounded-2xl border border-destructive/40 bg-card px-4 py-3 text-xs text-destructive">
            {error.message}
          </div>
        </div>
      )}
    >
      <OverlayApp />
    </ErrorBoundary>
  </React.StrictMode>,
)
