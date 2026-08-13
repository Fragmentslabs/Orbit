import type { ChatMessage, ToolPart } from '@shared/chat'

/**
 * toModelMessages/textOf (compaction) só reenviam TextParts — ToolParts
 * (incluindo cada chamada de todowrite) nunca voltam ao modelo em turnos
 * futuros. Isso apaga o estado da TODO entre turnos: ao dizer "continue", o
 * modelo não vê mais sua própria lista e frequentemente recria uma do zero.
 * Este módulo extrai esse estado como texto pra sobreviver ao corte.
 */

interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

function todoItems(message: ChatMessage): TodoItem[] | undefined {
  const todo = [...message.parts]
    .reverse()
    .find((p): p is ToolPart => p.type === 'tool' && p.tool === 'todowrite' && p.state === 'done')
  return todo?.input?.items as TodoItem[] | undefined
}

function formatTodoState(items: TodoItem[]): string {
  const mark = { completed: 'x', in_progress: '~', pending: ' ' } as const
  const lines = items.map((i) => `- [${mark[i.status] ?? ' '}] ${i.content}`)
  return `[TODO for this response]\n${lines.join('\n')}`
}

/** Quantos arquivos citar no registro antes de resumir (contexto é caro). */
const LEDGER_FILE_LIMIT = 12

/**
 * Registro verificado do turno: o que o engine MEDIU comparando os snapshots
 * do filesystem, não o que o agente disse ter feito.
 *
 * É a peça que fecha o buraco descrito no topo deste arquivo: como ToolParts
 * não voltam ao modelo, o histórico de um chat longo guarda só a narrativa do
 * agente sobre o próprio trabalho. Uma frase como "implementei X" fica
 * indistinguível de ter implementado de fato, e nos turnos seguintes o modelo
 * a trata como fato consumado ("como já implementei X, falta só Y").
 * Colando o veredito medido ao lado da narrativa, a alegação falsa passa a
 * chegar sempre acompanhada do desmentido.
 */
function formatChangeLedger(message: ChatMessage): string | null {
  const verified = message.snapshot?.verified
  if (!verified) return null
  if (verified === 'unknown') {
    return '[Verified record: file tracking failed for this turn — no claim can be made about what was written.]'
  }
  if (verified === 'unchanged') {
    return '[Verified record: NO file was modified in this turn (filesystem snapshot before/after identical).]'
  }
  const files = message.snapshot?.files ?? []
  if (files.length === 0) return '[Verified record: files were modified in this turn.]'
  const shown = files.slice(0, LEDGER_FILE_LIMIT).join(', ')
  const rest = files.length > LEDGER_FILE_LIMIT ? ` (+${files.length - LEDGER_FILE_LIMIT} more)` : ''
  return `[Verified record: ${files.length} file(s) modified in this turn — ${shown}${rest}]`
}

/** Texto de uma mensagem pra enviar ao modelo ou resumir na compactação:
 * narração + (se houver) o estado mais recente da TODO e um aviso quando a
 * resposta foi cortada por atingir o teto de passos. */
export function messageContextText(message: ChatMessage, text: string): string {
  const parts = [text]

  const items = todoItems(message)
  if (items?.length) parts.push(formatTodoState(items))

  const ledger = formatChangeLedger(message)
  if (ledger) parts.push(ledger)

  // Item marcado "completed" é asserção do modelo, não medição. Num turno em
  // que nada foi escrito, a checklist vira a "prova" mais convincente do
  // histórico — a anotação impede que ela seja lida como tal.
  if (message.snapshot?.verified === 'unchanged' && items?.some((i) => i.status === 'completed')) {
    parts.push(
      '[SYSTEM: the TODO items above were marked "completed" by you, but no file changed in this turn. Marking an item done is a claim, not evidence — if the work still has to be written to disk, treat those items as pending.]',
    )
  }

  if (message.truncated) {
    parts.push(
      '[SYSTEM: this response was interrupted by hitting the step/tool limit before finishing. If the TODO above has pending or in_progress items, CONTINUE from them — do not recreate the list from scratch.]',
    )
  }

  // Lembrete persistente de TODO não fechada (item em in_progress ao final
  // do turno): reemitido a cada turno seguinte até o modelo resolver o
  // estado — cobra o fechamento mesmo quando o usuário manda "continue".
  if (message.todoReminder) {
    parts.push(
      '[SYSTEM: the previous reply ended with TODO items still marked as "in_progress" — the checklist was never finalized. If those tasks are actually done, send the todo list again marking them as "completed" (the card in the UI still shows a spinner). If they are genuinely still in progress, say so explicitly before continuing.]',
    )
  }

  return parts.filter((p) => p.trim()).join('\n\n')
}
