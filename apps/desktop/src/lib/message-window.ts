/**
 * Window of messages mounted in the chat: only the last turns go into the DOM, and
 * the rest is mounted when scrolling up (or when jumping to an old message).
 * Opening a long chat mounted the whole history — markdown, highlight and
 * accordions of hundreds of messages — to show only the last screen.
 *
 * The window always starts at a user message: cutting in the middle of a turn
 * would open the screen with half an answer from the agent, without the question.
 */

/** Turns mounted when opening the chat. */
export const INITIAL_TURNS = 12
/** Turns added on each "load earlier". */
export const PAGE_TURNS = 10

interface WindowMessage {
  role: string
}

/**
 * Index where the window starts to include `turns` turns before
 * `endIndex` (exclusive): the `turns`-th user message counting
 * backwards. Without enough turns, it starts from zero.
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

/** Start of the window when opening the chat. */
export function defaultWindowStart(messages: readonly WindowMessage[]): number {
  return turnStart(messages, messages.length, INITIAL_TURNS)
}

/** Start of the window so that the message at `index` shows up with its turn. */
export function windowStartFor(messages: readonly WindowMessage[], index: number): number {
  return turnStart(messages, index + 1, 1)
}
