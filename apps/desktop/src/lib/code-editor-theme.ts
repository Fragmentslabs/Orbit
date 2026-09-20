import { HighlightStyle } from "@codemirror/language"
import { EditorView } from "@codemirror/view"
import { tags as t } from "@lezer/highlight"

/**
 * Tema do CodeMirror do painel de arquivos.
 *
 * As cores são as do github-dark / github-light — as MESMAS que o
 * `highlightLines` ([code-highlighter.ts]) pede ao shiki para o visualizador de
 * diff. O painel usa dois destacadores (Lezer aqui, TextMate lá) e eles só não
 * brigam na tela porque bebem da mesma paleta; trocar um valor aqui sem trocar
 * o tema do shiki faz o mesmo arquivo mudar de cor entre editar e ver o diff.
 *
 * Os scopes do TextMate não mapeiam 1:1 nas tags do Lezer. A correspondência
 * abaixo é por INTENÇÃO (o que a cor significa no github), não por nome.
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

/** github-dark, extraído de @shikijs/themes. */
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

/** github-light, extraído de @shikijs/themes. */
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
    // No github, palavra-chave e modificador de armazenamento dividem a cor —
    // `storage`/`storage.type` apontam para o mesmo valor de `keyword`.
    { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: p.keyword },
    { tag: [t.string, t.special(t.string), t.docString], color: p.string },
    { tag: [t.regexp, t.escape], color: p.regexp },
    // `constant` no github cobre número, booleano, null e membro de enum.
    { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.name)], color: p.constant },
    // `entity`/`entity.name`: função, classe, tipo — tudo que NOMEIA algo.
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: p.entity },
    { tag: [t.typeName, t.className, t.namespace, t.macroName], color: p.entity },
    // `support.*` (globais da linguagem/biblioteca) usa a cor de constante.
    { tag: [t.standard(t.variableName), t.special(t.variableName)], color: p.constant },
    // `variable` puro é laranja no github; `variable.other` volta ao texto
    // normal. A tag genérica do Lezer corresponde ao segundo caso.
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
 * Cromo do editor. Tudo que não é token sai das CSS vars do app, para o painel
 * continuar acompanhando o tema — inclusive os temas customizados, que mexem
 * nas vars e não nos hex acima.
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
      // Diagnósticos. O tema padrão do @codemirror/lint fixa fundo branco no
      // balão, o que fica ilegível no escuro — aqui tudo sai das vars do app.
      // O padrão do pacote é uma imagem SVG de onda embutida; `text-decoration`
      // acompanha o tamanho da fonte e fica mais nítido no zoom.
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
      ".cm-panels": {
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
        border: "none",
      },
      ".cm-panel input, .cm-panel button": {
        backgroundColor: "var(--background)",
        color: "var(--foreground)",
        border: "1px solid var(--border)",
        borderRadius: "0.375rem",
        padding: "0.125rem 0.375rem",
      },
    },
    { dark },
  )
}
