import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react"
import {
  Annotation,
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  EditorView,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import {
  LanguageDescription,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language"
import { languages } from "@codemirror/language-data"
import { highlightSelectionMatches } from "@codemirror/search"
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint"
import { useTheme } from "@/components/theme-provider"
import { darkHighlightStyle, editorChrome, lightHighlightStyle } from "@/src/lib/code-editor-theme"
import { planMerge, type AgentWrite, type MergePlan } from "@/src/lib/agent-merge"
import {
  eslintDiagnostics,
  jsonDiagnostics,
  syntaxDiagnostics,
} from "@/src/lib/code-diagnostics"
import { lintApi } from "@/src/lib/ipc"
import { applyCase, buildMatcher, replaceInText } from "@/src/lib/text-match"

/**
 * Viewer/editor of the files panel.
 *
 * A single renderer for viewing and editing: entering edit mode cannot
 * change the appearance of the file. The highlighting is Lezer's (incremental, it handles
 * typing); shiki keeps serving the DIFF viewer, and the two
 * share the palette via `code-editor-theme` — see the note there.
 *
 * CodeMirror owns its own scroller (it only materializes the visible lines),
 * so the container needs a defined height and CANNOT scroll outside:
 * whoever uses this component passes `overflow-hidden` on the parent.
 */

/**
 * Marks the transaction as coming from the agent, not from the keyboard. `onChange` exists
 * for the automatic saving; fired by an agent write, it
 * would schedule a save right after the disk had changed — and the save would come out with the
 * old mtime, turning into a false conflict.
 */
const fromAgent = Annotation.define<boolean>()

/** Marks the lines the agent has just written. */
const markAgentLines = StateEffect.define<{ from: number; to: number }[]>()
const clearAgentLines = StateEffect.define<null>()

const agentLine = Decoration.line({ class: "cm-agentTouched" })

/**
 * Highlight of what the agent changed. It is what makes its write be perceived as
 * something that happened there, and not as the file having blinked — without it the
 * person only finds out about the change when they bump into it.
 */
const agentHighlight = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(clearAgentLines)) next = Decoration.none
      if (effect.is(markAgentLines)) {
        const lines = new Set<number>()
        for (const range of effect.value) {
          const first = tr.state.doc.lineAt(Math.min(range.from, tr.state.doc.length)).number
          const last = tr.state.doc.lineAt(Math.min(range.to, tr.state.doc.length)).number
          for (let n = first; n <= last; n++) lines.add(n)
        }
        next = Decoration.set(
          [...lines].sort((a, b) => a - b).map((n) => agentLine.range(tr.state.doc.line(n).from)),
        )
      }
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

const agentHighlightTheme = EditorView.baseTheme({
  ".cm-agentTouched": {
    backgroundColor: "color-mix(in oklab, var(--primary) 14%, transparent)",
    transition: "background-color 400ms ease-out",
  },
})

/** How long the highlight of the agent write stays on screen. */
const AGENT_HIGHLIGHT_MS = 4000

/** Highlight of the element selected in the Design canvas (stays until another selection). */
const setElementHighlight = StateEffect.define<{ from: number; to: number } | null>()

const elementMark = Decoration.mark({ class: "cm-selectedElement" })

const elementHighlight = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setElementHighlight)) continue
      const value = effect.value
      if (!value || value.from >= value.to) {
        next = Decoration.none
      } else {
        const from = Math.max(0, Math.min(value.from, tr.state.doc.length))
        const to = Math.max(0, Math.min(value.to, tr.state.doc.length))
        next = Decoration.set([elementMark.range(from, to)])
      }
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

const elementHighlightTheme = EditorView.baseTheme({
  ".cm-selectedElement": {
    backgroundColor: "color-mix(in oklab, var(--primary) 20%, transparent)",
    boxShadow: "0 0 0 1px color-mix(in oklab, var(--primary) 55%, transparent)",
    borderRadius: "2px",
  },
})

const setFindQuery = StateEffect.define<{
  query: string
  options: SearchReplaceOptions
} | null>()

/**
 * Query of the panel search, to mark the occurrences INSIDE the file.
 *
 * The `@codemirror/search` highlighter cannot be reused: it returns
 * `Decoration.none` while its panel is closed — and here it never
 * opens, because the field on the right is what sends the query.
 */
const findQuery = StateField.define<{
  query: string
  options: SearchReplaceOptions
} | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFindQuery)) value = effect.value
    }
    return value
  },
})

const findMatchMark = Decoration.mark({ class: "cm-findMatch" })

/** Ceiling of marks: a `.*` in a large file would become one per character. */
const FIND_MATCH_LIMIT = 2000

/**
 * Match ranges in the text, with a ceiling.
 *
 * It is the same pass for both ends: what the field marks and what "next"
 * walks through. Split like this, it is impossible for the two to count differently.
 */
function collectMatches(
  text: string,
  matcher: RegExp,
  limit: number,
): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = []
  let match: RegExpExecArray | null
  while ((match = matcher.exec(text)) !== null && ranges.length < limit) {
    if (match[0].length === 0) {
      // An empty match (a regex like `a*`) does not advance by itself: without this the
      // loop does not end.
      matcher.lastIndex += 1
      continue
    }
    ranges.push({ from: match.index, to: match.index + match[0].length })
  }
  return ranges
}

const findMatches = EditorView.decorations.compute(
  [findQuery, "doc"],
  (state) => {
    const search = state.field(findQuery)
    if (!search || search.query === "") return Decoration.none
    const matcher = buildMatcher(search.query, search.options)
    if (!matcher) return Decoration.none
    const ranges = collectMatches(
      state.doc.toString(),
      matcher,
      FIND_MATCH_LIMIT,
    )
    if (ranges.length === 0) return Decoration.none
    return Decoration.set(
      ranges.map((range) => findMatchMark.range(range.from, range.to)),
      true,
    )
  },
)

/** A structure error comes out of the tree that already exists: it can be almost immediate. */
const SYNTAX_LINT_DELAY_MS = 300
/** eslint crosses IPC and runs in a worker; it is not worth chasing every keystroke. */
const ESLINT_DELAY_MS = 700

const JSON_FILE_RE = /\.jsonc?$/i

/**
 * Structure error, from the Lezer tree (or from `JSON.parse`, in .json). It costs
 * almost nothing because the parse already happened to color the file.
 */
function syntaxLinter(filePath: string) {
  const isJson = JSON_FILE_RE.test(filePath)
  return linter(
    (view): Diagnostic[] =>
      isJson ? jsonDiagnostics(view.state.doc.toString()) : syntaxDiagnostics(view.state),
    { delay: SYNTAX_LINT_DELAY_MS },
  )
}

/**
 * What the PROJECT considers wrong, through its eslint. It goes quiet for good when the
 * project has no usable eslint — repeating the attempt on every typing pause
 * would be pure waste.
 */
function projectLinter(filePath: string, root: string | undefined) {
  let unavailable = false
  return linter(
    async (view): Promise<Diagnostic[]> => {
      if (unavailable || !root) return []
      const result = await lintApi.file({ root, filePath, content: view.state.doc.toString() })
      if (!result.ok) {
        unavailable = true
        return []
      }
      return eslintDiagnostics(view.state.doc, result.messages)
    },
    { delay: ESLINT_DELAY_MS },
  )
}

/**
 * Fixed extensions. Assembled by hand instead of `basicSetup` so as not to drag
 * autocomplete and lint, which here have nowhere to take a suggestion from.
 */
function baseExtensions(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    highlightSpecialChars(),
    highlightSelectionMatches(),
    // No `search()`/`searchKeymap`: the file search bar is ours
    // (`FileFindBar`), with the same grammar as the right panel field. The
    // lib panel opened with English labels and white boxes — a foreign
    // body in the middle of the app.
    drawSelection(),
    rectangularSelection(),
    crosshairCursor(),
    indentOnInput(),
    bracketMatching(),
    agentHighlight,
    agentHighlightTheme,
    elementHighlight,
    elementHighlightTheme,
    findQuery,
    findMatches,
    lintGutter(),
    // Alt+click for an extra cursor comes from here: the default of
    // `clickAddsSelectionRange` is already `altKey`, but without this the second cursor
    // is discarded when the selection is applied.
    EditorState.allowMultipleSelections.of(true),
  ]
}

/**
 * Language mode by the file name. `language-data` resolves each
 * `@codemirror/lang-*` through dynamic import — in the build they become separate chunks,
 * the same arrangement as the shiki grammars, and none of it enters the initial
 * bundle.
 */
async function languageFor(filePath: string): Promise<Extension> {
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  const found = LanguageDescription.matchFilename(languages, name)
  if (!found) return []
  try {
    return await found.load()
  } catch {
    // A language that did not load becomes plain text: no color, but readable.
    return []
  }
}

type HtmlNode = ReturnType<typeof syntaxTree>["topNode"]

/** Tag of a Lezer `Element` (the name comes from the first `TagName`). */
function tagNameOf(state: EditorState, node: HtmlNode): string | null {
  const open = node.getChild("OpenTag") ?? node.getChild("SelfClosingTag")
  const name = open?.getChild("TagName")
  return name ? state.sliceDoc(name.from, name.to).toLowerCase() : null
}

/** Direct ELEMENT children (the same numbering the artboard DOM uses). */
function childElements(node: HtmlNode): HtmlNode[] {
  const out: HtmlNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "Element") out.push(child)
  }
  return out
}

/**
 * The range in the SOURCE of the element pointed to by the path (element children
 * from the <body>) — the same path the bridge uses on the live DOM. `null` if the
 * source has not been parsed yet (language loading) or the path does not exist.
 */
function elementRange(state: EditorState, path: number[]): { from: number; to: number } | null {
  let body: HtmlNode | null = null
  const pending: HtmlNode[] = [syntaxTree(state).topNode]
  while (pending.length > 0) {
    const node = pending.shift()
    if (!node) break
    if (node.name === "Element" && tagNameOf(state, node) === "body") {
      body = node
      break
    }
    pending.push(...childElements(node))
  }
  if (!body) return null
  let node: HtmlNode | null = body
  for (const index of path) {
    if (!node) return null
    node = childElements(node)[index] ?? null
  }
  return node ? { from: node.from, to: node.to } : null
}

export interface AgentWriteOutcome {
  kind: MergePlan["kind"]
  /** Was the buffer equal to the disk before this write? */
  wasClean: boolean
  /** Buffer content after applying (equal to the previous one if it did not apply). */
  content: string
}

export interface SearchReplaceOptions {
  caseSensitive?: boolean
  regex?: boolean
  wholeWord?: boolean
  preserveCase?: boolean
}

export interface CodeEditorHandle {
  /** Merges the agent write into the buffer. See `planMerge` for the criteria. */
  applyAgentWrite: (write: AgentWrite) => AgentWriteOutcome
  getContent: () => string
  /** Highlights and scrolls to the element of the path (element children of the <body>); `null` clears. */
  revealElement: (path: number[] | null) => void
  /**
   * Replaces in the BUFFER, never on disk.
   *
   * It is the path of "replace in this file": the swap enters as a common
   * edit — undo with Mod+Z, it marks the draft and the automatic saving
   * records it. Writing to disk underneath the buffer would erase what has not been
   * saved yet, which is exactly the work nobody wants to lose.
   */
  replaceAll: (
    query: string,
    replacement: string,
    options?: SearchReplaceOptions,
  ) => number
  /**
   * Takes the view to the line and leaves it selected — without that, clicking an
   * occurrence of the search would open the file always at the top, and the line the
   * user clicked would stay hidden.
   */
  scrollToLine: (line: number) => void
  /**
   * Marks the occurrences of the panel search INSIDE the open file. The field
   * on the right stops being just a list: it points in the text at what it is
   * listing. An empty query clears the marks.
   */
  highlightQuery: (query: string, options?: SearchReplaceOptions) => void
  /**
   * Walks to the next occurrence and selects it, scrolling to it. `start` is the
   * first jump (new query, from the cursor); `next`/`prev` wrap around
   * at the end of the file. Returns the position so the bar can show "3 of 12".
   */
  find: (
    query: string,
    options: SearchReplaceOptions,
    direction: "start" | "next" | "prev",
  ) => { total: number; index: number }
  /**
   * Swaps ONLY the selected occurrence — the "replace" of the file bar.
   * Returns `false` when the selection is not a match (the user touched the
   * text between the jump and the click), and then nothing is written.
   */
  replaceMatch: (
    query: string,
    replacement: string,
    options: SearchReplaceOptions,
  ) => boolean
}

export interface CodeEditorProps {
  /** Content on disk. It serves as a basis to know whether there is an unsaved draft. */
  content: string
  /** File path — it defines the language and delimits the undo history. */
  filePath: string
  /** Line wrapping: on for prose (markdown), off for code. */
  wrap?: boolean
  editable?: boolean
  /** Workspace root — the project eslint is resolved from it. */
  workspaceRoot?: string
  onSave?: (content: string) => void
  onDirtyChange?: (dirty: boolean) => void
  /** Every key typed — used by the automatic saving. */
  onChange?: (content: string) => void
  /** Cmd+F: the owner of the editor opens its search bar. */
  onRequestFind?: () => void
}

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  {
    content,
    filePath,
    wrap = false,
    editable = false,
    workspaceRoot,
    onSave,
    onDirtyChange,
    onChange,
    onRequestFind,
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  /** What is on disk — basis of the "dirty" comparison. */
  const baseline = useRef(content)
  const dirty = useRef(false)
  const highlightTimer = useRef<number>()
  /** Path of the element to highlight (`undefined` = nobody asked yet). */
  const revealPath = useRef<number[] | null | undefined>(undefined)
  /** Key of the last highlight applied — avoids scrolling again on every reload. */
  const appliedReveal = useRef<string | null>(null)
  /**
   * Callbacks by ref: they enter the keymap and the updateListener, which are mounted
   * once. Without that, every re-render of the parent would require recreating the editor.
   */
  const callbacks = useRef({ onSave, onDirtyChange, onChange, onRequestFind })
  callbacks.current = { onSave, onDirtyChange, onChange, onRequestFind }

  /**
   * One set of compartments PER INSTANCE. Swapping language, theme or line
   * wrapping by reconfiguration keeps the editor alive — recreating the EditorView
   * would throw away scroll, selection and history on every theme change.
   */
  const conf = useRef({
    language: new Compartment(),
    theme: new Compartment(),
    wrap: new Compartment(),
    history: new Compartment(),
    editable: new Compartment(),
    diagnostics: new Compartment(),
  })
  const { theme } = useTheme()
  const isDark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)

  const reportDirty = useCallback((next: boolean) => {
    if (dirty.current === next) return
    dirty.current = next
    callbacks.current.onDirtyChange?.(next)
  }, [])

  /**
   * Applies the highlight of the element requested last. `forceScroll` scrolls to it
   * (new selection); without that it only reasserts the highlight (file reload, language
   * that finished loading). If the path does not resolve (tree still empty),
   * it does nothing — the next call tries again.
   */
  const applyReveal = useCallback((forceScroll: boolean) => {
    const instance = view.current
    const path = revealPath.current
    if (!instance || path === undefined) return
    if (path === null) {
      appliedReveal.current = null
      instance.dispatch({ effects: setElementHighlight.of(null) })
      return
    }
    const range = elementRange(instance.state, path)
    if (!range) return
    const key = path.join(".")
    const scroll = forceScroll || appliedReveal.current !== key
    appliedReveal.current = key
    instance.dispatch({
      effects: [
        setElementHighlight.of(range),
        ...(scroll ? [EditorView.scrollIntoView(range.from, { y: "center" })] : []),
      ],
    })
  }, [])

  useEffect(() => {
    if (!host.current) return
    const c = conf.current
    const instance = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          ...baseExtensions(),
          // The order matters: the first keymap that recognizes the key wins.
          // Mod+s comes before the `defaultKeymap` because saving is ours; the rest
          // is the set one expects from an editor — Alt+arrow moves the line,
          // Shift+Alt+arrow duplicates, Mod+Shift+K deletes, Mod+d selects the
          // next occurrence.
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: (v) => {
                callbacks.current.onSave?.(v.state.doc.toString())
                return true
              },
            },
            {
              // Whoever opens the search is the owner of the editor: the bar lives next to
              // it, with the state that survives the file switch.
              key: "Mod-f",
              preventDefault: true,
              run: () => {
                callbacks.current.onRequestFind?.()
                return true
              },
            },
          ]),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const text = update.state.doc.toString()
            reportDirty(text !== baseline.current)
            const agentOrigin = update.transactions.some((tr) => tr.annotation(fromAgent))
            if (!agentOrigin) callbacks.current.onChange?.(text)
          }),
          c.language.of([]),
          c.theme.of([]),
          c.wrap.of([]),
          c.history.of(history()),
          c.editable.of(EditorState.readOnly.of(true)),
          c.diagnostics.of([]),
        ],
      }),
      parent: host.current,
    })
    view.current = instance
    return () => {
      window.clearTimeout(highlightTimer.current)
      instance.destroy()
      view.current = null
    }
    // Only on mount: the props enter through the sync effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Content coming from outside: another file, or a disk reload. It replaces the
  // whole buffer and resets the draft state — it is a new basis.
  useEffect(() => {
    baseline.current = content
    const instance = view.current
    if (!instance) return
    if (instance.state.doc.toString() === content) {
      reportDirty(false)
      return
    }
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: content },
      effects: clearAgentLines.of(null),
    })
    reportDirty(false)
    applyReveal(false)
  }, [content, reportDirty, applyReveal])

  // Language and history follow the FILE, not the content. Reconfiguring
  // `history()` discards the undo stack: without that, a Ctrl+Z after switching
  // file would dump the text of the previous file into this one.
  useEffect(() => {
    const c = conf.current
    view.current?.dispatch({ effects: c.history.reconfigure(history()) })
    let cancelled = false
    void languageFor(filePath).then((extension) => {
      if (cancelled) return
      view.current?.dispatch({ effects: c.language.reconfigure(extension) })
      applyReveal(false)
    })
    return () => {
      cancelled = true
    }
  }, [filePath, applyReveal])

  useEffect(() => {
    view.current?.dispatch({
      effects: conf.current.theme.reconfigure([
        editorChrome(isDark),
        syntaxHighlighting(isDark ? darkHighlightStyle : lightHighlightStyle),
      ]),
    })
  }, [isDark])

  useEffect(() => {
    view.current?.dispatch({
      effects: conf.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
    })
  }, [wrap])

  useEffect(() => {
    view.current?.dispatch({
      effects: conf.current.editable.reconfigure(EditorState.readOnly.of(!editable)),
    })
  }, [editable])

  // The eslint linter closes over the path and the root, so it is remounted
  // when either changes — the "project without eslint" state goes along.
  // A syntax error applies in any file; the project one only where the edit
  // makes sense (a commit file is history, and judging it by today's config
  // would say more about the config than about the file).
  useEffect(() => {
    view.current?.dispatch({
      effects: conf.current.diagnostics.reconfigure([
        syntaxLinter(filePath),
        ...(editable ? [projectLinter(filePath, workspaceRoot)] : []),
      ]),
    })
  }, [filePath, editable, workspaceRoot])

  useImperativeHandle(
    ref,
    (): CodeEditorHandle => ({
      getContent: () => view.current?.state.doc.toString() ?? baseline.current,
      revealElement: (path) => {
        revealPath.current = path
        applyReveal(true)
      },
      replaceAll: (query, replacement, options = {}) => {
        const instance = view.current
        if (!instance || query === "") return 0
        const before = instance.state.doc.toString()
        // The same rules as the occurrence list (whole word, case,
        // preserve format): the preview is only honest if the key does the same.
        const { text: after, count } = replaceInText(
          before,
          query,
          replacement,
          options,
        )
        if (count === 0) return 0
        // A single transaction: the whole replacement is ONE undo step.
        instance.dispatch({ changes: { from: 0, to: before.length, insert: after } })
        return count
      },
      scrollToLine: (line) => {
        const instance = view.current
        if (!instance) return
        // The document may have shrunk since the search (mass replacement):
        // the line comes from an old result and needs to fit in what exists today.
        const target = instance.state.doc.line(
          Math.min(Math.max(1, line), instance.state.doc.lines),
        )
        instance.dispatch({
          selection: { anchor: target.from, head: target.to },
          effects: EditorView.scrollIntoView(target.from, { y: "center" }),
        })
        instance.focus()
      },
      /**
       * Marks by the panel search query: same options (case, whole
       * word, regex) and its own decoration, because the `@codemirror/search`
       * highlighter only paints with its panel open.
       */
      highlightQuery: (query, options = {}) => {
        const instance = view.current
        if (!instance) return
        instance.dispatch({
          effects: setFindQuery.of(query === "" ? null : { query, options }),
        })
      },
      find: (query, options, direction) => {
        const instance = view.current
        if (!instance || query === "") return { total: 0, index: 0 }
        const matcher = buildMatcher(query, options)
        if (!matcher) return { total: 0, index: 0 }
        const matches = collectMatches(
          instance.state.doc.toString(),
          matcher,
          FIND_MATCH_LIMIT,
        )
        if (matches.length === 0) return { total: 0, index: 0 }
        const selection = instance.state.selection.main
        let index = -1
        if (direction === "prev") {
          for (let i = matches.length - 1; i >= 0; i -= 1) {
            if (matches[i].to <= selection.from) {
              index = i
              break
            }
          }
          // From the start of the file, "previous" wraps around: the end is the previous
          // one of whoever is at the top.
          if (index === -1) index = matches.length - 1
        } else {
          const after = direction === "next" ? selection.to : selection.from
          index = matches.findIndex((match) => match.from >= after)
          if (index === -1) index = 0
        }
        const range = matches[index]
        instance.dispatch({
          selection: { anchor: range.from, head: range.to },
          effects: EditorView.scrollIntoView(range.from, { y: "center" }),
        })
        return { total: matches.length, index: index + 1 }
      },
      replaceMatch: (query, replacement, options) => {
        const instance = view.current
        if (!instance || query === "") return false
        const selection = instance.state.selection.main
        if (selection.empty) return false
        const selected = instance.state.sliceDoc(selection.from, selection.to)
        const matcher = buildMatcher(query, options)
        if (!matcher) return false
        // The selection has to be EXACTLY a match: between the jump and the
        // click the text may have changed, and swapping what is selected without
        // checking would eat a stretch nobody asked for.
        const exact = new RegExp(
          "^(?:" + matcher.source + ")$",
          matcher.flags.replace("g", ""),
        )
        if (!exact.test(selected)) return false
        const insert = options.preserveCase
          ? applyCase(selected, replacement)
          : replacement
        instance.dispatch({
          changes: { from: selection.from, to: selection.to, insert },
        })
        return true
      },
      applyAgentWrite: (write) => {
        const instance = view.current
        const doc = instance?.state.doc.toString() ?? baseline.current
        const wasClean = !dirty.current
        const plan = planMerge(doc, write)
        if (plan.kind !== "apply" || !instance) {
          return { kind: plan.kind, wasClean, content: doc }
        }
        instance.dispatch({
          annotations: fromAgent.of(true),
          changes: plan.changes,
          effects: markAgentLines.of(
            // Positions AFTER the change: the inserted text is what should
            // light up, and it only exists in the resulting document.
            plan.changes.map((change) => ({
              from: change.from,
              to: change.from + change.insert.length,
            })),
          ),
          // The write is the agent's: touching the cursor would take the person out of where
          // they were reading.
          scrollIntoView: false,
        })
        window.clearTimeout(highlightTimer.current)
        highlightTimer.current = window.setTimeout(() => {
          view.current?.dispatch({ effects: clearAgentLines.of(null) })
        }, AGENT_HIGHLIGHT_MS)
        const next = instance.state.doc.toString()
        // Clean buffer before: now it mirrors the disk again, so the basis
        // moves along and nothing is marked as a draft.
        if (wasClean) {
          baseline.current = next
          reportDirty(false)
        } else {
          reportDirty(next !== baseline.current)
        }
        return { kind: "apply", wasClean, content: next }
      },
    }),
    [reportDirty, applyReveal],
  )

  return <div ref={host} className="h-full min-h-0 min-w-0 overflow-hidden" />
})
