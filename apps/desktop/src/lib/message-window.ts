/**
 * Janela de mensagens montadas no chat: só os últimos turnos entram no DOM, e
 * o resto é montado ao rolar para cima (ou ao pular para uma mensagem antiga).
 * Abrir um chat longo montava o histórico inteiro — markdown, highlight e
 * acordeões de centenas de mensagens — para mostrar só a última tela.
 *
 * A janela sempre começa numa mensagem do usuário: cortar no meio de um turno
 * abriria a tela com meia resposta do agente, sem a pergunta.
 */

/** Turnos montados ao abrir o chat. */
export const INITIAL_TURNS = 12
/** Turnos acrescentados a cada "carregar anteriores". */
export const PAGE_TURNS = 10

interface WindowMessage {
  role: string
}

/**
 * Índice de onde a janela começa para incluir `turns` turnos antes de
 * `endIndex` (exclusivo): a `turns`-ésima mensagem do usuário contando para
 * trás. Sem turnos suficientes, começa do zero.
 */
export function turnStart(messages: readonly WindowMessage[], endIndex: number, turns: number): number {
  let seen = 0
  for (let i = Math.min(endIndex, messages.length) - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      seen += 1
      if (seen === turns) return i
    }
  }
  return 0
}

/** Início da janela ao abrir o chat. */
export function defaultWindowStart(messages: readonly WindowMessage[]): number {
  return turnStart(messages, messages.length, INITIAL_TURNS)
}

/** Início da janela para que a mensagem em `index` apareça com o turno dela. */
export function windowStartFor(messages: readonly WindowMessage[], index: number): number {
  return turnStart(messages, index + 1, 1)
}
