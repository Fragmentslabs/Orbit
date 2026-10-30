import { Component, type ErrorInfo, type ReactNode } from "react"

/**
 * A rendering error stays where it happened.
 *
 * The app had none: any component that threw during
 * rendering unmounted the whole tree, and what was left was the window
 * background — a black screen, with no message, with nothing in the terminal log. Opening
 * a chat with ONE message the renderer did not know how to draw erased the app.
 *
 * `resetKeys` gives back the chance to render when what broke changes — switching
 * conversation, for example, cannot keep showing the previous one's error.
 */
export class ErrorBoundary extends Component<
  {
    children: ReactNode
    fallback: (error: Error, reset: () => void) => ReactNode
    /** Where this is, so the log says WHICH piece broke. */
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
    // It goes to the renderer console — and from there to the terminal, through the
    // forwarding of the main process. It is what makes the error findable later.
    console.error(`[render] ${this.props.label}:`, error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) return this.props.fallback(this.state.error, this.reset)
    return this.props.children
  }
}
