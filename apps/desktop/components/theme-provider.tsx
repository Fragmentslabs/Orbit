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
  /** Tema aplicado a pedido de OUTRA janela: aplica, mas não devolve ao main. */
  const fromOtherWindow = useRef(false)
  const currentTheme = useRef(theme)
  currentTheme.current = theme

  useEffect(() => {
    const root = window.document.documentElement

    // Limpa o fundo inline pintado pelo script de boot do index.html (só
    // cobre o intervalo até o CSS carregar — depois disso viraria cor obsoleta
    // na troca de tema).
    root.style.backgroundColor = ""

    root.classList.remove("light", "dark")

    // O tema também vale para o que é NATIVO no main (menu da bandeja,
    // diálogos do sistema) e para as outras janelas — o main não lê o
    // localStorage, então ele é publicado a cada troca.
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
   * O tema é UM para o app inteiro: quando a janela principal troca, as demais
   * (overlay, painéis do Computer Use) recebem por aqui. Sem isto, a janela
   * pré-aquecida no boot ficava com o tema do nascimento — painel branco num
   * app escuro.
   */
  useEffect(() => {
    const bridge = window.ipcRenderer
    if (!bridge?.on) return
    const wrapper = bridge.on("theme:apply", (next) => {
      if (next !== "light" && next !== "dark" && next !== "system") return
      // Mesmo tema: nada a fazer (e o efeito de aplicação não rodaria — o
      // `false` abaixo ficaria pendente e engoliria a próxima troca local).
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
