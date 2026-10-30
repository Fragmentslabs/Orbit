import type { ITheme } from "@xterm/xterm"

/**
 * Palette of the panel terminal (xterm).
 *
 * xterm does not read CSS vars — it wants hex —, so the colors live here, in a dark/light
 * pair. In the dark the background is transparent and what shows up is the tab's
 * `bg-sidebar` (as it always was); in the light the terminal paints its own background in a gray
 * one line above white, so as not to glare next to the almost white panel,
 * and writes with the github-light palette — the same family as the code editor
 * ([code-editor-theme.ts]), which shares the panel with it.
 */

/** VS Code dark+ — the palette the terminal always used in the dark. */
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
 * github-light (primer's ANSI) over the light theme's `--muted` (#f4f4f5), which is
 * the surface the tab paints underneath (`bg-muted`). The background stays
 * transparent here too: that way the color comes from the token (a custom theme
 * follows along) and the host's padding does not draw a lighter frame around
 * the canvas.
 *
 * In the dark "bright" lightens; in the light that pushes the color into the background —
 * primer's brightBlue, brightCyan, brightMagenta and brightWhite sit between
 * 2.7:1 and 3.3:1 over #f4f4f5, so they come close to the normal value (>= 4:1). The rest
 * is pure primer, with the text at 13.3:1.
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
 * Always returns a NEW object: xterm compares `options.theme` by reference
 * and ignores the assignment when it is the same object.
 */
export function terminalTheme(dark: boolean): ITheme {
  return { ...(dark ? DARK : LIGHT) }
}
