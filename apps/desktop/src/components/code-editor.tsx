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
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
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

/**
 * Visualizador/editor do painel de arquivos.
 *
 * Um renderizador só para ver e editar: entrar no modo de edição não pode
 * mudar a aparência do arquivo. O destaque é do Lezer (incremental, aguenta
 * digitação); o shiki continua servindo o visualizador de DIFF, e os dois
 * compartilham a paleta via `code-editor-theme` — ver a nota lá.
 *
 * O CodeMirror é dono do próprio scroller (só materializa as linhas visíveis),
 * então o container precisa ter altura definida e NÃO pode rolar por fora:
 * quem usa este componente passa `overflow-hidden` no pai.
 */

/**
 * Marca a transação como vinda do agente, não do teclado. O `onChange` existe
 * para o salvamento automático; disparado por uma escrita do agente, ele
 * agendaria um save logo depois de o disco ter mudado — e o save sairia com o
 * mtime velho, virando um falso conflito.
 */
const fromAgent = Annotation.define<boolean>()

/** Marca as linhas que o agente acabou de escrever. */
const markAgentLines = StateEffect.define<{ from: number; to: number }[]>()
const clearAgentLines = StateEffect.define<null>()

const agentLine = Decoration.line({ class: "cm-agentTouched" })

/**
 * Realce do que o agente mudou. É o que faz a escrita dele ser percebida como
 * algo que aconteceu ali, e não como o arquivo tendo piscado — sem isso a
 * pessoa só descobre a alteração quando esbarra nela.
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

/** Quanto tempo o realce da escrita do agente fica na tela. */
const AGENT_HIGHLIGHT_MS = 4000

/** Realce do elemento selecionado no canvas de Design (fica até outra seleção). */
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

/** Erro de estrutura sai da árvore que já existe: dá para ser quase imediato. */
const SYNTAX_LINT_DELAY_MS = 300
/** O eslint atravessa IPC e roda numa worker; não vale correr atrás de cada tecla. */
const ESLINT_DELAY_MS = 700

const JSON_FILE_RE = /\.jsonc?$/i

/**
 * Erro de estrutura, da árvore do Lezer (ou do `JSON.parse`, em .json). Custa
 * quase nada porque o parse já aconteceu para colorir o arquivo.
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
 * O que o PROJETO considera errado, pelo eslint dele. Silencia de vez quando o
 * projeto não tem eslint utilizável — repetir a tentativa a cada pausa na
 * digitação seria puro desperdício.
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
 * Extensões fixas. Montadas à mão em vez do `basicSetup` para não arrastar
 * autocomplete e lint, que aqui não têm de onde tirar sugestão.
 */
function baseExtensions(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    highlightSpecialChars(),
    highlightSelectionMatches(),
    drawSelection(),
    rectangularSelection(),
    crosshairCursor(),
    indentOnInput(),
    bracketMatching(),
    agentHighlight,
    agentHighlightTheme,
    elementHighlight,
    elementHighlightTheme,
    lintGutter(),
    // Alt+clique para cursor extra sai daqui: o padrão do
    // `clickAddsSelectionRange` já é `altKey`, mas sem isto o segundo cursor
    // é descartado na hora de aplicar a seleção.
    EditorState.allowMultipleSelections.of(true),
  ]
}

/**
 * Modo da linguagem pelo nome do arquivo. O `language-data` resolve cada
 * `@codemirror/lang-*` por import dinâmico — no build viram chunks separados,
 * o mesmo arranjo das gramáticas do shiki, e nada disso entra no bundle
 * inicial.
 */
async function languageFor(filePath: string): Promise<Extension> {
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  const found = LanguageDescription.matchFilename(languages, name)
  if (!found) return []
  try {
    return await found.load()
  } catch {
    // Linguagem que não carregou vira texto puro: sem cor, mas legível.
    return []
  }
}

type HtmlNode = ReturnType<typeof syntaxTree>["topNode"]

/** Tag de um `Element` do Lezer (o nome vem do primeiro `TagName`). */
function tagNameOf(state: EditorState, node: HtmlNode): string | null {
  const open = node.getChild("OpenTag") ?? node.getChild("SelfClosingTag")
  const name = open?.getChild("TagName")
  return name ? state.sliceDoc(name.from, name.to).toLowerCase() : null
}

/** Filhos-ELEMENTO diretos (a mesma numeração que o DOM do artboard usa). */
function childElements(node: HtmlNode): HtmlNode[] {
  const out: HtmlNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "Element") out.push(child)
  }
  return out
}

/**
 * O intervalo no FONTE do elemento apontado pelo caminho (filhos-elemento a
 * partir do <body>) — o mesmo caminho que a ponte usa no DOM vivo. `null` se o
 * fonte ainda não foi parseado (idioma carregando) ou o caminho não existe.
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
  /** O buffer estava igual ao disco antes desta escrita? */
  wasClean: boolean
  /** Conteúdo do buffer depois de aplicar (igual ao anterior se não aplicou). */
  content: string
}

export interface CodeEditorHandle {
  /** Funde a escrita do agente no buffer. Ver `planMerge` para os critérios. */
  applyAgentWrite: (write: AgentWrite) => AgentWriteOutcome
  getContent: () => string
  /** Realça e rola até o elemento do caminho (filhos-elemento do <body>); `null` limpa. */
  revealElement: (path: number[] | null) => void
}

export interface CodeEditorProps {
  /** Conteúdo em disco. Serve de base para saber se há rascunho não salvo. */
  content: string
  /** Caminho do arquivo — define a linguagem e delimita o histórico de undo. */
  filePath: string
  /** Quebra de linha: ligada para prosa (markdown), desligada para código. */
  wrap?: boolean
  editable?: boolean
  /** Raiz do workspace — o eslint do projeto é resolvido a partir dela. */
  workspaceRoot?: string
  onSave?: (content: string) => void
  onDirtyChange?: (dirty: boolean) => void
  /** Cada tecla digitada — usado pelo salvamento automático. */
  onChange?: (content: string) => void
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
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  /** O que está em disco — base da comparação de "sujo". */
  const baseline = useRef(content)
  const dirty = useRef(false)
  const highlightTimer = useRef<number>()
  /** Caminho do elemento a realçar (`undefined` = ninguém pediu ainda). */
  const revealPath = useRef<number[] | null | undefined>(undefined)
  /** Chave do último realce aplicado — evita rolar de novo a cada recarga. */
  const appliedReveal = useRef<string | null>(null)
  /**
   * Callbacks por ref: entram no keymap e no updateListener, que são montados
   * uma vez. Sem isso, cada re-render do pai exigiria recriar o editor.
   */
  const callbacks = useRef({ onSave, onDirtyChange, onChange })
  callbacks.current = { onSave, onDirtyChange, onChange }

  /**
   * Um jogo de compartments POR INSTÂNCIA. Trocar linguagem, tema ou quebra de
   * linha por reconfiguração mantém o editor vivo — recriar o EditorView
   * jogaria fora scroll, seleção e histórico a cada mudança de tema.
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
   * Aplica o realce do elemento pedido por último. `forceScroll` rola até ele
   * (seleção nova); sem isso só reafirma o realce (recarga do arquivo, idioma
   * que terminou de carregar). Se o caminho não resolve (árvore ainda vazia),
   * não faz nada — a próxima chamada tenta de novo.
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
          // A ordem importa: o primeiro keymap que reconhece a tecla vence.
          // Mod+s vem antes do `defaultKeymap` porque salvar é nosso; o resto
          // é o conjunto que se espera de um editor — Alt+seta move a linha,
          // Shift+Alt+seta duplica, Mod+Shift+K apaga, Mod+d seleciona a
          // próxima ocorrência.
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: (v) => {
                callbacks.current.onSave?.(v.state.doc.toString())
                return true
              },
            },
          ]),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
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
    // Só na montagem: as props entram pelos efeitos de sincronia abaixo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Conteúdo vindo de fora: outro arquivo, ou recarga do disco. Substitui o
  // buffer inteiro e zera o estado de rascunho — é uma base nova.
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

  // Linguagem e histórico seguem o ARQUIVO, não o conteúdo. Reconfigurar o
  // `history()` descarta a pilha de undo: sem isso, um Ctrl+Z depois de trocar
  // de arquivo despejaria o texto do arquivo anterior dentro deste.
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

  // O linter do eslint fecha sobre o caminho e a raiz, então é remontado
  // quando qualquer um muda — junto vai o estado de "projeto sem eslint".
  // Erro de sintaxe vale em qualquer arquivo; o do projeto só onde a edição
  // faz sentido (arquivo de commit é histórico, e julgá-lo pela config de
  // hoje diria mais sobre a config do que sobre o arquivo).
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
            // Posições DEPOIS da alteração: o texto inserido é o que deve
            // acender, e ele só existe no documento resultante.
            plan.changes.map((change) => ({
              from: change.from,
              to: change.from + change.insert.length,
            })),
          ),
          // A escrita é do agente: mexer no cursor tiraria a pessoa de onde
          // ela estava lendo.
          scrollIntoView: false,
        })
        window.clearTimeout(highlightTimer.current)
        highlightTimer.current = window.setTimeout(() => {
          view.current?.dispatch({ effects: clearAgentLines.of(null) })
        }, AGENT_HIGHLIGHT_MS)
        const next = instance.state.doc.toString()
        // Buffer limpo antes: agora ele espelha o disco de novo, então a base
        // anda junto e nada fica marcado como rascunho.
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
