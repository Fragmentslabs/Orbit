/**
 * Onde a pessoa estava quando chamou o painel: app e janela da frente. Vai no
 * prompt do overlay para "o que diz esse erro?" não começar com uma ida às
 * tools só para descobrir o app — e para o agente escolher entre ler a janela
 * em texto ou olhar a tela.
 *
 * Fora de overlay/window.ts de propósito: o prompt lê isto, e ele não pode
 * puxar o Electron junto (os testes do prompt rodam sem ele).
 */

export interface OverlayOpenContext {
  app: string
  bundleId: string | null
  pid: number
  windowTitle: string | null
  at: number
}

/** Depois disso o app anotado na abertura já não é "onde a pessoa está". */
export const OPEN_CONTEXT_TTL_MS = 10 * 60_000

let current: OverlayOpenContext | null = null

export function setOverlayOpenContext(next: OverlayOpenContext | null): void {
  current = next
}

export function overlayOpenContext(now = Date.now()): OverlayOpenContext | null {
  return current && now - current.at < OPEN_CONTEXT_TTL_MS ? current : null
}

/**
 * A linha do prompt. O título da janela vem do app (um assunto de e-mail, o
 * nome de uma página) — é dado da tela, nunca instrução, e vai marcado assim.
 */
export function overlayOpenContextLine(context: OverlayOpenContext | null): string | null {
  if (!context) return null
  const title = context.windowTitle ? ` — window <screen_content untrusted="true">${context.windowTitle.slice(0, 200)}</screen_content>` : ''
  return `When the panel opened, the user was in ${context.app}${context.bundleId ? ` (${context.bundleId})` : ''}${title}. "This", "here" and "the screen" most likely mean that window.`
}
