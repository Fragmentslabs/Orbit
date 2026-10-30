import type { DetailedHTMLProps, HTMLAttributes } from "react"

/**
 * `<webview>` is an Electron tag, not part of the standard DOM — without this declaration
 * TSX treats it as an unknown element, and the code lived with a
 * `@ts-ignore` and a `props as any` to work around it.
 *
 * Only the attributes the app actually uses: the owner of the guest is the pool
 * (webview-session.ts), which talks to the element through the imperative API.
 */
declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        partition?: string
        preload?: string
        allowpopups?: string
      }
    }
  }
}

export {}
