import React from "react"
import ReactDOM from "react-dom/client"
// Efeito de import: inicializa o i18n e aplica o idioma salvo antes do primeiro
// render (o painel tem poucas palavras, mas elas não podem sair no idioma errado).
import "./i18n"
import "./stores/locale-store"
import "./index.css"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ErrorBoundary } from "./components/error-boundary"
import { OverlayApp } from "./components/overlay/overlay-app"

// O ThemeProvider é o que faz o painel SEGUIR o tema do app: ele aplica a
// mesma classe do index.html e entrega o tema à persona — sem ele a persona
// caía no "system" do contexto padrão e podia sair branca sobre um painel
// branco (o inverso do que a tela inicial faz).
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
      {/* O Markdown da resposta traz tooltips (copiar código) — no app eles
          vivem neste provider, em volta da árvore inteira. */}
      <TooltipProvider>
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
      </TooltipProvider>
    </ThemeProvider>
  </React.StrictMode>,
)
