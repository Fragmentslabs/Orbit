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
      'Mantém a lista de tarefas (TODO) do trabalho atual. Reenvie a lista COMPLETA a cada chamada — marque in_progress ao iniciar um item e completed ao concluir. Use em tarefas com 3+ etapas.',
    inputSchema: z.object({
      items: z
        .array(
          z.object({
            content: z.string().describe('Descrição curta do item'),
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
