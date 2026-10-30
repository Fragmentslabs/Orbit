import { createContext, useContext, useEffect, useRef, useState } from "react"

type Theme = "dark" | "light" | "system"

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
}

type ThemeProviderState = {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const initialState: ThemeProviderState = {
  theme: "system",
  setTheme: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "vite-ui-theme",
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(storageKey) as Theme) || defaultTheme
  )
  /** Theme applied at the request of ANOTHER window: applies it, but does not send it back to the main. */
  const fromOtherWindow = useRef(false)
  const currentTheme = useRef(theme)
  currentTheme.current = theme

  useEffect(() => {
    const root = window.document.documentElement

    // Clears the inline background painted by the boot script of index.html (it only
    // covers the interval until the CSS loads — after that it would become a stale color
    // on the theme switch).
    root.style.backgroundColor = ""

    root.classList.remove("light", "dark")

    // The theme is also worth for what is NATIVE in the main (tray menu,
    // system dialogs) and for the other windows — the main does not read the
    // localStorage, so it is published on every switch.
    if (fromOtherWindow.current) fromOtherWindow.current = false
    else window.ipcRenderer?.send("theme:sync", theme)

    if (theme === "system") {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light"

      root.classList.add(systemTheme)
      return
    }

    root.classList.add(theme)
  }, [theme])

  /**
   * The theme is ONE for the whole app: when the main window switches, the others
   * (overlay, Computer Use panels) receive it from here. Without this, the window
   * pre-warmed at boot kept the theme of its birth — a white panel in a
   * dark app.
   */
  useEffect(() => {
    const bridge = window.ipcRenderer
    if (!bridge?.on) return
    const wrapper = bridge.on("theme:apply", (next) => {
      if (next !== "light" && next !== "dark" && next !== "system") return
      // Same theme: nothing to do (and the application effect would not run — the
      // `false` below would stay pending and would swallow the next local switch).
      if (next === currentTheme.current) return
      fromOtherWindow.current = true
      setTheme(next)
    })
    return () => bridge.off("theme:apply", wrapper)
  }, [])

  const value = {
    theme,
    setTheme: (theme: Theme) => {
      localStorage.setItem(storageKey, theme)
      setTheme(theme)
    },
  }

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)

  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider")

  return context
}
