import { HighlightStyle } from "@codemirror/language"
import { EditorView } from "@codemirror/view"
import { tags as t } from "@lezer/highlight"

/**
 * CodeMirror theme of the file panel.
 *
 * The colors are github-dark / github-light — the SAME ones that
 * `highlightLines` ([code-highlighter.ts]) asks shiki for in the diff
 * viewer. The panel uses two highlighters (Lezer here, TextMate there) and they only
 * avoid clashing on screen because they drink from the same palette; changing a value here without changing
 * the shiki theme makes the same file change color between editing and viewing the diff.
 *
 * The TextMate scopes do not map 1:1 onto the Lezer tags. The mapping
 * below is by INTENT (what the color means on github), not by name.
 */

interface Palette {
  comment: string
  constant: string
  entity: string
  tag: string
  keyword: string
  string: string
  variable: string
  invalid: string
  regexp: string
  heading: string
  quote: string
  inserted: string
  deleted: string
  foreground: string
}

/** github-dark, extracted from @shikijs/themes. */
const DARK: Palette = {
  comment: "#6a737d",
  constant: "#79b8ff",
  entity: "#b392f0",
  tag: "#85e89d",
  keyword: "#f97583",
  string: "#9ecbff",
  variable: "#ffab70",
  invalid: "#fdaeb7",
  regexp: "#dbedff",
  heading: "#79b8ff",
  quote: "#85e89d",
  inserted: "#85e89d",
  deleted: "#fdaeb7",
  foreground: "#e1e4e8",
}

/** github-light, extracted from @shikijs/themes. */
const LIGHT: Palette = {
  comment: "#6a737d",
  constant: "#005cc5",
  entity: "#6f42c1",
  tag: "#22863a",
  keyword: "#d73a49",
  string: "#032f62",
  variable: "#e36209",
  invalid: "#b31d28",
  regexp: "#032f62",
  heading: "#005cc5",
  quote: "#22863a",
  inserted: "#22863a",
  deleted: "#b31d28",
  foreground: "#24292e",
}

function highlightStyle(p: Palette): HighlightStyle {
  return HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: p.comment },
    // On github, keyword and storage modifier share the color —
    // `storage`/`storage.type` point to the same value as `keyword`.
    { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: p.keyword },
    { tag: [t.string, t.special(t.string), t.docString], color: p.string },
    { tag: [t.regexp, t.escape], color: p.regexp },
    // `constant` on github covers number, boolean, null and enum member.
    { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.name)], color: p.constant },
    // `entity`/`entity.name`: function, class, type — everything that NAMES something.
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: p.entity },
    { tag: [t.typeName, t.className, t.namespace, t.macroName], color: p.entity },
    // `support.*` (language/library globals) uses the constant color.
    { tag: [t.standard(t.variableName), t.special(t.variableName)], color: p.constant },
    // plain `variable` is orange on github; `variable.other` goes back to normal
    // text. The generic Lezer tag corresponds to the second case.
    { tag: [t.variableName, t.propertyName, t.attributeValue], color: p.foreground },
    { tag: [t.definition(t.variableName), t.attributeName], color: p.variable },
    { tag: [t.tagName, t.angleBracket], color: p.tag },
    { tag: [t.invalid], color: p.invalid },
    { tag: [t.heading], color: p.heading, fontWeight: "bold" },
    { tag: [t.quote], color: p.quote },
    { tag: [t.inserted], color: p.inserted },
    { tag: [t.deleted], color: p.deleted },
    { tag: [t.link, t.url], color: p.regexp, textDecoration: "underline" },
    { tag: [t.monospace], color: p.constant },
    { tag: [t.strong], fontWeight: "bold" },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.strikethrough], textDecoration: "line-through" },
  ])
}

export const darkHighlightStyle = highlightStyle(DARK)
export const lightHighlightStyle = highlightStyle(LIGHT)

/**
 * Editor chrome. Everything that is not a token comes from the app's CSS vars, so the panel
 * keeps following the theme — including the custom themes, which change
 * the vars and not the hex values above.
 */
export function editorChrome(dark: boolean) {
  const palette = dark ? DARK : LIGHT
  return EditorView.theme(
    {
      "&": {
        color: palette.foreground,
        backgroundColor: "var(--code-viewer)",
        height: "100%",
        fontSize: "12px",
      },
      ".cm-scroller": {
        fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
        lineHeight: "1.25rem",
      },
      ".cm-content": { padding: "1rem 0", caretColor: "var(--foreground)" },
      ".cm-gutters": {
        backgroundColor: "var(--code-viewer)",
        border: "none",
        color: "color-mix(in oklab, var(--muted-foreground) 50%, transparent)",
        paddingRight: "0.5rem",
      },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 0.25rem 0 0.75rem" },
      ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--foreground) 4%, transparent)" },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: "var(--muted-foreground)",
      },
      "&.cm-focused .cm-cursor": { borderLeftColor: "var(--foreground)" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "color-mix(in oklab, var(--primary) 25%, transparent)",
      },
      ".cm-selectionMatch": {
        backgroundColor: "color-mix(in oklab, var(--primary) 18%, transparent)",
      },
      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: "color-mix(in oklab, var(--primary) 22%, transparent)",
        outline: "none",
      },
      ".cm-searchMatch": {
        backgroundColor: "color-mix(in oklab, var(--primary) 20%, transparent)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "color-mix(in oklab, var(--primary) 40%, transparent)",
      },
      // The panel search highlight uses its own decoration (`findMatches`, in
      // code-editor), but paints like the Cmd+F one: for whoever reads the file, it is the
      // same question — "where is this thing in here".
      ".cm-findMatch": {
        backgroundColor: "color-mix(in oklab, var(--primary) 22%, transparent)",
        boxShadow: "0 0 0 1px color-mix(in oklab, var(--primary) 30%, transparent)",
        borderRadius: "2px",
      },
      // Diagnostics. The @codemirror/lint default theme hardcodes a white background in
      // the tooltip, which is unreadable in the dark — here everything comes from the app vars.
      // The package default is an embedded SVG wave image; `text-decoration`
      // follows the font size and stays sharper when zoomed.
      ".cm-lintRange": { backgroundImage: "none" },
      ".cm-lintRange-error": {
        textDecoration: "underline wavy",
        textDecorationColor: palette.invalid,
        textDecorationSkipInk: "none",
      },
      ".cm-lintRange-warning": {
        textDecoration: "underline wavy",
        textDecorationColor: palette.variable,
        textDecorationSkipInk: "none",
      },
      ".cm-tooltip-lint": {
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
        border: "1px solid var(--border)",
        borderRadius: "0.5rem",
        padding: "0.25rem",
        maxWidth: "32rem",
      },
      ".cm-diagnostic": {
        borderLeftWidth: "3px",
        borderRadius: "0.25rem",
        padding: "0.25rem 0.5rem",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        fontSize: "12px",
      },
      ".cm-diagnostic-error": { borderLeftColor: palette.invalid },
      ".cm-diagnostic-warning": { borderLeftColor: palette.variable },
      ".cm-diagnosticSource": {
        color: "var(--muted-foreground)",
        fontSize: "11px",
        marginLeft: "0.375rem",
      },
      ".cm-lint-marker-error": { color: palette.invalid },
      ".cm-lint-marker-warning": { color: palette.variable },
      ".cm-gutter-lint": { width: "0.75rem" },
      // The file search (Cmd+F). The CodeMirror panel comes with its own look
      // — browser inputs and buttons —, so here it wears the app
      // tokens: same field height as the rest of the UI, same border, same background.
      ".cm-panels": {
        backgroundColor: "var(--card)",
        color: "var(--card-foreground)",
        border: "none",
      },
      ".cm-panel.cm-search": {
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "0.25rem",
        padding: "0.375rem 0.5rem",
        borderBottom: "1px solid var(--border)",
        fontFamily: "var(--font-sans)",
        fontSize: "11px",
      },
      ".cm-panel.cm-search input.cm-textfield": {
        height: "1.75rem",
        minWidth: "9rem",
        padding: "0 0.5rem",
        backgroundColor: "var(--background)",
        color: "var(--foreground)",
        border: "1px solid var(--border)",
        borderRadius: "0.375rem",
        fontSize: "12px",
        outline: "none",
      },
      ".cm-panel.cm-search input.cm-textfield:focus": {
        borderColor: "var(--ring)",
      },
      ".cm-panel.cm-search button": {
        height: "1.75rem",
        padding: "0 0.5rem",
        backgroundColor: "transparent",
        color: "var(--muted-foreground)",
        border: "1px solid var(--border)",
        borderRadius: "0.375rem",
        fontSize: "11px",
        cursor: "pointer",
      },
      ".cm-panel.cm-search button:hover": {
        backgroundColor: "var(--accent)",
        color: "var(--accent-foreground)",
      },
      ".cm-panel.cm-search button[name=close]": {
        marginLeft: "auto",
        border: "none",
        fontSize: "14px",
        lineHeight: "1",
      },
      ".cm-panel.cm-search label": {
        display: "inline-flex",
        alignItems: "center",
        gap: "0.25rem",
        padding: "0 0.25rem",
        color: "var(--muted-foreground)",
        fontSize: "10.5px",
      },
      // CodeMirror separates search from replace with <br>: in flex that becomes
      // a new line, which is the desired behavior — it just cannot leave
      // a blank space at the end of the first one.
      ".cm-panel.cm-search br": { flexBasis: "100%", height: "0" },
    },
    { dark },
  )
}
