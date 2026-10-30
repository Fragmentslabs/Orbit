import { tool } from 'ai'
import { z } from 'zod'

/**
 * todowrite tool: the live TODO of the task in progress. The state lives in the
 * call itself (the model resends the whole list) — the persisted ToolPart is already the
 * record, and the UI renders the last call as a live checklist.
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
      return `TODO updated (${items.length} items, ${done} done).`
    },
  })
}
