import { tool } from 'ai'
import { z } from 'zod'

/**
 * Tool todowrite: TODO viva da tarefa em andamento. O estado mora na própria
 * chamada (o modelo reenvia a lista completa) — o ToolPart persistido já é o
 * registro, e a UI renderiza a última chamada como checklist viva.
 */
export function createTodoTool() {
  return tool({
    description:
      'Maintains the current work\'s task list (TODO). Resend the FULL list on every call — mark in_progress when starting an item and completed when finishing it. Use on tasks with 3+ steps.',
    inputSchema: z.object({
      items: z
        .array(
          z.object({
            content: z.string().describe('Short item description'),
            status: z.enum(['pending', 'in_progress', 'completed']),
            priority: z.enum(['low', 'medium', 'high']).optional(),
          }),
        )
        .min(1),
    }),
    execute: async ({ items }) => {
      const done = items.filter((i) => i.status === 'completed').length
      return `TODO atualizada (${items.length} itens, ${done} concluídos).`
    },
  })
}
