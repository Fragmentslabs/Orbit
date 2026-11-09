import { tool } from 'ai'
import { z } from 'zod'
import type { SendMessageInput } from '@shared/chat'
import { scriptApproved } from '@shared/routines'
import { describeOutcome } from '../routines/scripts/manage'
import { runScript } from '../routines/scripts/runner'
import { readScriptRecord } from '../routines/scripts/store'

/**
 * Tool run_script: the agent of a routine's execution calls one of the routine's scripts (read
 * the report template from the spreadsheet, fetch a number from an API). Only approved scripts
 * run — and with exactly the abilities they declared. A run here is stateless: it can read what
 * the trigger script remembered, but never changes it.
 */
export function createRunScriptTool(routine: NonNullable<SendMessageInput['routineContext']>) {
  const scripts = routine.scripts
  return tool({
    description:
      'Runs one of this routine\'s scripts and returns what it produced. Scripts available: ' +
      scripts.map((s) => `${s.name} (${s.summary})${scriptApproved(s) ? '' : ' [not approved yet]'}`).join('; ') +
      '. A script that is not approved cannot run: tell the person to approve it on the routine screen.',
    inputSchema: z.object({
      name: z.string().describe('Name of the script.'),
      input: z.unknown().optional().describe('JSON the script reads as `input`.'),
    }),
    execute: async ({ name, input }) => {
      const script = scripts.find((s) => s.name === name)
      if (!script) return `No script named "${name}". Available: ${scripts.map((s) => s.name).join(', ') || 'none'}.`
      if (!scriptApproved(script)) return `The script "${name}" is not approved: it has not run. Ask the person to approve it on the routine screen.`
      const { state } = await readScriptRecord(routine.id)
      return describeOutcome(await runScript({ script, folders: routine.folders, state, input }))
    },
  })
}
