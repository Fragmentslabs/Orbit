import { afterEach, describe, expect, it } from 'vitest'
import { MAX_MESSAGE_CHARS, MAX_SENT_PER_WORKER, MAX_UNREAD_PER_WORKER, MIN_GAP_MS, PlanMailbox, closeMailbox, drainMail, joinMailbox, mailboxOf, openMailbox } from './mailbox'

function box() {
  const b = new PlanMailbox()
  b.join('w1', 'Writer')
  b.join('w2', 'Voice')
  b.join('w3', 'Editor')
  return b
}

describe('PlanMailbox', () => {
  it('delivers a note once, formatted, to the recipient only', () => {
    const b = box()
    expect(b.send('w1', 'voice', ' use port 4000 ', 0)).toEqual({ ok: true, to: 'Voice' })
    expect(b.drain('w3')).toBeNull()
    const mail = b.drain('w2')!
    expect(mail).toContain('From "Writer": use port 4000')
    expect(b.drain('w2')).toBeNull()
  })

  it('only lets workers of the plan write, and only to workers of the plan', () => {
    const b = box()
    expect(b.send('stranger', 'Voice', 'hi', 0)).toMatchObject({ ok: false })
    const r = b.send('w1', 'Ghost', 'hi', 0)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain('Voice, Editor')
    expect(b.send('w1', 'Writer', 'hi', 0)).toMatchObject({ ok: false })
  })

  it('refuses empty and long messages', () => {
    const b = box()
    expect(b.send('w1', 'Voice', '   ', 0)).toMatchObject({ ok: false })
    expect(b.send('w1', 'Voice', 'x'.repeat(MAX_MESSAGE_CHARS + 1), 0)).toMatchObject({ ok: false })
    expect(b.send('w1', 'Voice', 'x'.repeat(MAX_MESSAGE_CHARS), 0)).toMatchObject({ ok: true })
  })

  it('rate limits the sender: a minimum gap and a total allowance', () => {
    const b = new PlanMailbox()
    b.join('a', 'A')
    for (let i = 0; i < 10; i++) b.join(`r${i}`, `R${i}`)
    expect(b.send('a', 'R0', '1', 0)).toMatchObject({ ok: true })
    expect(b.send('a', 'R1', '2', MIN_GAP_MS - 1)).toMatchObject({ ok: false })
    let t = MIN_GAP_MS
    let sent = 1
    for (let i = 1; i < 10; i++, t += MIN_GAP_MS) if (b.send('a', `R${i}`, 'x', t).ok) sent++
    expect(sent).toBe(MAX_SENT_PER_WORKER)
  })

  it('caps what one recipient can have unread, and frees room once it reads', () => {
    const b = new PlanMailbox()
    b.join('r', 'R')
    let t = 0
    for (let i = 0; i < MAX_UNREAD_PER_WORKER; i++) {
      b.join(`s${i}`, `S${i}`)
      expect(b.send(`s${i}`, 'R', 'x', t)).toMatchObject({ ok: true })
    }
    b.join('late', 'Late')
    expect(b.send('late', 'R', 'x', t)).toMatchObject({ ok: false })
    b.drain('r')
    t += MIN_GAP_MS
    expect(b.send('late', 'R', 'x', t)).toMatchObject({ ok: true })
  })

  it('does not write to a worker that finished, but does to one that has not started', () => {
    const b = box()
    expect(b.send('w1', 'Voice', 'hi', 0)).toMatchObject({ ok: true })
    b.start('w2')
    b.finish('w2')
    expect(b.send('w1', 'Voice', 'again', MIN_GAP_MS)).toMatchObject({ ok: false })
    expect(b.teammates('w1')).toEqual(['Editor'])
  })
})

describe('registry', () => {
  afterEach(() => closeMailbox('orch'))

  it('finds the plan mailbox from a worker id and forgets it when the plan ends', () => {
    const b = openMailbox('orch')
    joinMailbox('orch', 'w1', 'Writer')
    joinMailbox('orch', 'w2', 'Voice')
    expect(mailboxOf('w1')).toBe(b)
    expect(mailboxOf('other')).toBeUndefined()
    b.send('w1', 'Voice', 'hello', 0)
    expect(drainMail('w2')).toContain('hello')
    expect(drainMail('unknown')).toBeNull()
    closeMailbox('orch')
    expect(mailboxOf('w1')).toBeUndefined()
  })

  it('workers of different plans cannot reach each other', () => {
    openMailbox('orch')
    joinMailbox('orch', 'w1', 'Writer')
    const other = openMailbox('orch2')
    joinMailbox('orch2', 'x1', 'Writer2')
    expect(mailboxOf('w1')!.send('w1', 'Writer2', 'hi', 0)).toMatchObject({ ok: false })
    expect(mailboxOf('x1')).toBe(other)
    closeMailbox('orch2')
  })
})
