import type { DetailedHTMLProps, HTMLAttributes } from "react"

/**
 * `<webview>` é uma tag do Electron, não do DOM padrão — sem esta declaração
 * o TSX a trata como elemento desconhecido, e o código convivia com um
 * `@ts-ignore` e um `props as any` para contornar.
 *
 * Só os atributos que o app realmente usa: o dono do guest é o pool
 * (webview-session.ts), que fala com o elemento pela API imperativa.
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
