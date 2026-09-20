import type { Diagnostic } from "@codemirror/lint"
import { syntaxTree } from "@codemirror/language"
import type { EditorState } from "@codemirror/state"

/**
 * Diagnósticos do editor do painel de arquivos.
 *
 * Duas fontes, deliberadamente separadas porque têm custos muito diferentes:
 *
 * - **Sintaxe** (aqui): sai da árvore que o Lezer já construiu para colorir o
 *   arquivo. Não há trabalho novo — só percorrer os nós de erro —, então
 *   aparece a cada tecla, em qualquer linguagem que o editor carregue.
 * - **ESLint** (`eslint-service` no main): o que o PROJETO considera errado.
 *   Custa uma ida ao processo principal e chega depois.
 *
 * O que o Lezer marca é erro de ESTRUTURA — chave não fechada, string aberta.
 * Ele não sabe nada de tipos, de import inexistente ou de regra de estilo;
 * para isso existe a segunda fonte.
 */

/** Teto de marcas por arquivo. */
const MAX_SYNTAX_DIAGNOSTICS = 100

/**
 * Erros de estrutura, direto da árvore sintática.
 *
 * Gramáticas do Lezer são tolerantes a erro de propósito (precisam continuar
 * colorindo o resto do arquivo), então um trecho quebrado costuma render um nó
 * de erro só — e não uma cascata. Ainda assim há teto: linguagem que a
 * gramática cobre mal produziria uma parede de vermelho, e uma parede de
 * vermelho é indistinguível de nenhum aviso.
 */
export function syntaxDiagnostics(state: EditorState): Diagnostic[] {
  const tree = syntaxTree(state)
  // Sem linguagem carregada a árvore é vazia — nada a dizer, e nunca um falso
  // positivo por ausência de parser.
  if (tree.length === 0) return []
  const found: Diagnostic[] = []
  tree.cursor().iterate((node) => {
    if (found.length >= MAX_SYNTAX_DIAGNOSTICS) return false
    if (!node.type.isError) return
    // Nó de erro de comprimento zero é o caso comum (o parser aponta a
    // POSIÇÃO em que faltou algo). Sublinhar nada não marca nada na tela,
    // então o intervalo cobre ao menos um caractere.
    const from = node.from
    const to = node.to > node.from ? node.to : Math.min(node.from + 1, state.doc.length)
    found.push({
      from: Math.min(from, state.doc.length),
      to,
      severity: "error",
      message: "Erro de sintaxe",
      source: "sintaxe",
    })
  })
  return found
}

/**
 * Posição do erro dentro da mensagem do `JSON.parse`.
 *
 * O V8 mudou o texto entre versões ("at position 12" ganhou o sufixo
 * "(line 2 column 3)"), então vale o que aparecer primeiro e há fallback.
 */
export function jsonErrorOffset(message: string, docLength: number): number {
  const at = /at position (\d+)/i.exec(message)
  if (!at) return 0
  return Math.min(Number(at[1]), Math.max(docLength - 1, 0))
}

/**
 * JSON tem tratamento próprio porque a mensagem do `JSON.parse` diz o que
 * houve ("Unexpected token }", "Expected double-quoted property name") — o nó
 * de erro do Lezer só diria que há um.
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

/** Uma mensagem do eslint, como o main a entrega. */
export interface LintMessage {
  line: number
  column: number
  endLine?: number
  endColumn?: number
  message: string
  ruleId: string | null
  severity: number
}

/** Converte linha/coluna (base 1) em offset, tolerando posição fora do texto. */
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
 * Mensagens do eslint viram marcas no editor.
 *
 * O buffer pode ter mudado entre o pedido e a resposta, então toda posição é
 * presa aos limites do documento atual — uma posição fora do texto derruba o
 * CodeMirror, e ficar vermelho não vale quebrar o editor.
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
      // Marca de largura zero não aparece; garante ao menos um caractere sem
      // passar do fim do documento.
      to: Math.min(Math.max(rawTo, from + 1), doc.length),
      severity: message.severity === 2 ? "error" : "warning",
      message: message.message,
      source: message.ruleId ?? "eslint",
    }
  })
}
