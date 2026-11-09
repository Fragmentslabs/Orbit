import { tool } from 'ai'
import { z } from 'zod'
import { MAX_MESSAGE_CHARS, mailboxOf } from '../orchestration/mailbox'

/**
 * The worker's way to leave a short note for another worker of the same plan. Not a conversation:
 * the note is read by the teammate at its next step and nobody waits for a reply. Files in the
 * working folder stay the way to hand over real content. The mailbox enforces who may write to
 * whom and how often (orchestration/mailbox.ts).
 */
export function createTeammateTool(workerId: string) {
  return tool({
    description: [
      'Leaves a SHORT note for another worker of this same plan (a teammate running next to you, or one that has not started yet).',
      'The teammate reads it at its next step; you do not get a reply, so never wait for one.',
      'Use it for a fact the other needs to avoid a clash (a name, a port, a decision), not for results: write results to a file in the working folder.',
      `At most ${MAX_MESSAGE_CHARS} characters, a few messages per worker.`,
    ].join(' '),
    inputSchema: z.object({
      to: z.string().describe('Name of the teammate, exactly as in your plan'),
      message: z.string().describe('The note: one or two sentences'),
    }),
    execute: async ({ to, message }) => {
      const box = mailboxOf(workerId)
      if (!box) return 'There is no plan to send a message in.'
      const r = box.send(workerId, to, message)
      return r.ok ? `Message left for "${r.to}". It will read it at its next step; carry on with your own work.` : `Not sent: ${r.reason}`
    },
  })
}
