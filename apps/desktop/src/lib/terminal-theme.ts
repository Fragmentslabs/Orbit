import type { ITheme } from "@xterm/xterm"

/**
 * Paleta do terminal do painel (xterm).
 *
 * O xterm não lê CSS vars — ele quer hex —, então as cores moram aqui, num par
 * dark/light. No escuro o fundo é transparente e quem aparece é o `bg-sidebar`
 * da aba (como sempre foi); no claro o terminal pinta o próprio fundo num cinza
 * uma linha acima do branco, para não estourar ao lado do painel quase branco,
 * e escreve com a paleta github-light — a mesma família do editor de código
 * ([code-editor-theme.ts]), que divide o painel com ele.
 */

/** VS Code dark+ — a paleta que o terminal sempre usou no escuro. */
const DARK: ITheme = {
  background: "#00000000",
  foreground: "#cccccc",
  cursor: "#cccccc",
  cursorAccent: "#00000000",
  selectionBackground: "#264f78",
  black: "#1e1e1e",
  red: "#f14c4c",
  green: "#4ec994",
  yellow: "#cdcb70",
  blue: "#569cd6",
  magenta: "#c586c0",
  cyan: "#4ec9b0",
  white: "#d4d4d4",
  brightBlack: "#808080",
  brightRed: "#f14c4c",
  brightGreen: "#4ec994",
  brightYellow: "#cdcb70",
  brightBlue: "#569cd6",
  brightMagenta: "#c586c0",
  brightCyan: "#4ec9b0",
  brightWhite: "#ffffff",
}

/**
 * github-light (ANSI do primer) sobre `--muted` do tema claro (#f4f4f5), que é
 * a superfície que a aba pinta por baixo (`bg-muted`). O fundo fica
 * transparente aqui também: assim a cor vem do token (tema customizado
 * acompanha) e o padding do host não desenha uma moldura mais clara em volta
 * do canvas.
 *
 * No escuro "bright" clareia; no claro isso joga a cor para dentro do fundo —
 * brightBlue, brightCyan, brightMagenta e brightWhite do primer ficam entre
 * 2,7:1 e 3,3:1 sobre #f4f4f5, então encostam no valor normal (>= 4:1). O resto
 * é o primer puro, com o texto em 13,3:1.
 */
const LIGHT: ITheme = {
  background: "#00000000",
  foreground: "#24292f",
  cursor: "#24292f",
  cursorAccent: "#f4f4f5",
  selectionBackground: "#cfe3ff",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#4d2d00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#0969da",
  brightMagenta: "#8250df",
  brightCyan: "#1b7c83",
  brightWhite: "#6e7781",
}

/**
 * Devolve sempre um objeto NOVO: o xterm compara `options.theme` por referência
 * e ignora a atribuição quando é o mesmo objeto.
 */
export function terminalTheme(dark: boolean): ITheme {
  return { ...(dark ? DARK : LIGHT) }
}
