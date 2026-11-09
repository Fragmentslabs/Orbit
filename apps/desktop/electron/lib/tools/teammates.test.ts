import { afterEach, describe, expect, it } from 'vitest'
import { closeMailbox, joinMailbox, openMailbox, drainMail } from '../orchestration/mailbox'
import { createTeammateTool } from './teammates'

const run = (workerId: string, args: { to: string; message: string }) =>
  (createTeammateTool(workerId) as unknown as { execute: (a: unknown, o: unknown) => Promise<string> }).execute(args, {})

describe('message_teammate', () => {
  afterEach(() => closeMailbox('orch'))

  it('leaves the note in the teammate mailbox', async () => {
    openMailbox('orch')
    joinMailbox('orch', 'w1', 'Writer')
    joinMailbox('orch', 'w2', 'Voice')
    expect(await run('w1', { to: 'Voice', message: 'chapter 2 is the long one' })).toContain('Message left')
    expect(drainMail('w2')).toContain('chapter 2 is the long one')
  })

  it('explains the refusal instead of throwing', async () => {
    openMailbox('orch')
    joinMailbox('orch', 'w1', 'Writer')
    expect(await run('w1', { to: 'Nobody', message: 'hi' })).toContain('Not sent')
    expect(await run('lone', { to: 'Writer', message: 'hi' })).toContain('no plan')
  })
})
