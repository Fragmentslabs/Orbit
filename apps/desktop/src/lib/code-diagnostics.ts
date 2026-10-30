import type { Diagnostic } from "@codemirror/lint"
import i18n from "@/src/i18n"
import { syntaxTree } from "@codemirror/language"
import type { EditorState } from "@codemirror/state"

/**
 * Diagnostics of the file panel editor.
 *
 * Two sources, deliberately separated because they have very different costs:
 *
 * - **Syntax** (here): comes out of the tree Lezer already built to color the
 *   file. There is no new work — only walking the error nodes —, so it
 *   shows up on every keystroke, in any language the editor loads.
 * - **ESLint** (`eslint-service` in main): what the PROJECT considers wrong.
 *   It costs a round trip to the main process and arrives later.
 *
 * What Lezer marks is a STRUCTURE error — unclosed brace, open string.
 * It knows nothing about types, a missing import or a style rule;
 * that is what the second source is for.
 */

/** Cap on marks per file. */
const MAX_SYNTAX_DIAGNOSTICS = 100

/**
 * Structure errors, straight from the syntax tree.
 *
 * Lezer grammars are error-tolerant on purpose (they need to keep
 * coloring the rest of the file), so a broken stretch usually yields a single error
 * node — and not a cascade. Even so there is a cap: a language the
 * grammar covers poorly would produce a wall of red, and a wall of
 * red is indistinguishable from no warning at all.
 */
export function syntaxDiagnostics(state: EditorState): Diagnostic[] {
  const tree = syntaxTree(state)
  // With no language loaded the tree is empty — nothing to say, and never a false
  // positive for lack of a parser.
  if (tree.length === 0) return []
  const found: Diagnostic[] = []
  tree.cursor().iterate((node) => {
    if (found.length >= MAX_SYNTAX_DIAGNOSTICS) return false
    if (!node.type.isError) return
    // A zero-length error node is the common case (the parser points at the
    // POSITION where something is missing). Underlining nothing marks nothing on screen,
    // so the range covers at least one character.
    const from = node.from
    const to = node.to > node.from ? node.to : Math.min(node.from + 1, state.doc.length)
    found.push({
      from: Math.min(from, state.doc.length),
      to,
      severity: "error",
      message: i18n.t("codeInput.syntaxError"),
      source: "sintaxe",
    })
  })
  return found
}

/**
 * Position of the error inside the `JSON.parse` message.
 *
 * V8 changed the text between versions ("at position 12" gained the suffix
 * "(line 2 column 3)"), so whichever appears first counts and there is a fallback.
 */
export function jsonErrorOffset(message: string, docLength: number): number {
  const at = /at position (\d+)/i.exec(message)
  if (!at) return 0
  return Math.min(Number(at[1]), Math.max(docLength - 1, 0))
}

/**
 * JSON gets its own treatment because the `JSON.parse` message says what
 * happened ("Unexpected token }", "Expected double-quoted property name") — the Lezer error
 * node would only say that there is one.
 */
export function jsonDiagnostics(text: string): Diagnostic[] {
  if (!text.trim()) return []
  try {
    JSON.parse(text)
    return []
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const at = jsonErrorOffset(message, text.length)
    return [
      {
        from: at,
        to: Math.min(at + 1, text.length),
        severity: "error",
        message,
        source: "json",
      },
    ]
  }
}

/** An eslint message, as main delivers it. */
export interface LintMessage {
  line: number
  column: number
  endLine?: number
  endColumn?: number
  message: string
  ruleId: string | null
  severity: number
}

/** Converts line/column (1-based) into an offset, tolerating a position outside the text. */
function offsetAt(
  doc: { lines: number; length: number; line: (n: number) => { from: number; to: number } },
  line: number,
  column: number,
): number {
  if (line < 1) return 0
  if (line > doc.lines) return doc.length
  const target = doc.line(line)
  return Math.min(target.from + Math.max(column - 1, 0), target.to)
}

/**
 * Eslint messages become marks in the editor.
 *
 * The buffer may have changed between the request and the response, so every position is
 * pinned to the limits of the current document — a position outside the text takes
 * CodeMirror down, and being red is not worth breaking the editor.
 */
export function eslintDiagnostics(
  doc: { lines: number; length: number; line: (n: number) => { from: number; to: number } },
  messages: LintMessage[],
): Diagnostic[] {
  return messages.map((message) => {
    const from = offsetAt(doc, message.line, message.column)
    const rawTo =
      message.endLine != null && message.endColumn != null
        ? offsetAt(doc, message.endLine, message.endColumn)
        : from + 1
    return {
      from,
      // A zero-width mark does not show; it guarantees at least one character without
      // going past the end of the document.
      to: Math.min(Math.max(rawTo, from + 1), doc.length),
      severity: message.severity === 2 ? "error" : "warning",
      message: message.message,
      source: message.ruleId ?? "eslint",
    }
  })
}
