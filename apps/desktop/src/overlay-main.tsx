import React from "react"
import ReactDOM from "react-dom/client"
// Import effect: initializes i18n and applies the saved language before the first
// render (the panel has few words, but they cannot come out in the wrong language).
import "./i18n"
import "./stores/locale-store"
import "./index.css"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ErrorBoundary } from "./components/error-boundary"
import { OverlayApp } from "./components/overlay/overlay-app"

// The ThemeProvider is what makes the panel FOLLOW the app theme: it applies the
// same class as index.html and hands the theme to the persona — without it the persona
// fell into the default context's "system" and could come out white over a white
// panel (the inverse of what the start screen does).
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
      {/* The answer's Markdown brings tooltips (copy code) — in the app they
          live in this provider, around the whole tree. */}
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
