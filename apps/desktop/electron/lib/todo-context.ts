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

function formatTodoState(message: ChatMessage): string | null {
  const todo = [...message.parts]
    .reverse()
    .find((p): p is ToolPart => p.type === 'tool' && p.tool === 'todowrite' && p.state === 'done')
  const items = todo?.input?.items as TodoItem[] | undefined
  if (!items?.length) return null

  const mark = { completed: 'x', in_progress: '~', pending: ' ' } as const
  const lines = items.map((i) => `- [${mark[i.status] ?? ' '}] ${i.content}`)
  return `[TODO for this response]\n${lines.join('\n')}`
}

/** Texto de uma mensagem pra enviar ao modelo ou resumir na compactação:
 * narração + (se houver) o estado mais recente da TODO e um aviso quando a
 * resposta foi cortada por atingir o teto de passos. */
export function messageContextText(message: ChatMessage, text: string): string {
  const parts = [text]

  const todo = formatTodoState(message)
  if (todo) parts.push(todo)

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
