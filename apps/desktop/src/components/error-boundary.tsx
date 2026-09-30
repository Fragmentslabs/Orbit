import { Component, type ErrorInfo, type ReactNode } from "react"

/**
 * Um erro de renderização fica onde aconteceu.
 *
 * O app não tinha nenhum: qualquer componente que lançasse durante a
 * renderização desmontava a árvore inteira, e o que sobrava era o fundo da
 * janela — uma tela preta, sem mensagem, sem nada no log do terminal. Abrir
 * um chat com UMA mensagem que o renderer não soubesse desenhar apagava o app.
 *
 * `resetKeys` devolve a chance de renderizar quando o que quebrou muda — trocar
 * de conversa, por exemplo, não pode continuar mostrando o erro da anterior.
 */
export class ErrorBoundary extends Component<
  {
    children: ReactNode
    fallback: (error: Error, reset: () => void) => ReactNode
    /** Onde isto está, para o log dizer QUAL pedaço quebrou. */
    label: string
    resetKeys?: unknown[]
  },
  { error: Error | null; keys: unknown[] | undefined }
> {
  state: { error: Error | null; keys: unknown[] | undefined } = {
    error: null,
    keys: this.props.resetKeys,
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  static getDerivedStateFromProps(
    props: { resetKeys?: unknown[] },
    state: { error: Error | null; keys: unknown[] | undefined },
  ) {
    const mudou =
      props.resetKeys !== undefined &&
      (state.keys === undefined ||
        props.resetKeys.length !== state.keys.length ||
        props.resetKeys.some((key, i) => !Object.is(key, state.keys?.[i])))
    return mudou ? { error: null, keys: props.resetKeys } : null
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Vai para o console do renderer — e de lá para o terminal, pelo
    // encaminhamento do main. É o que torna o erro achável depois.
    console.error(`[render] ${this.props.label}:`, error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) return this.props.fallback(this.state.error, this.reset)
    return this.props.children
  }
}
