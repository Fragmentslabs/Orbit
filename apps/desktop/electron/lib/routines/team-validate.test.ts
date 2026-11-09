import { describe, expect, it } from 'vitest'
import { buildTeam } from './team-validate'

let n = 0
const newId = () => `t${++n}`
const agents = new Set(['agent:writer'])

describe('buildTeam', () => {
  it('assigns ids and turns dependency names into ids', () => {
    const out = buildTeam(
      [
        { name: 'Writer', task: 'Write', agent: 'agent:writer' },
        { name: 'Voice', task: 'Speak', dependsOn: ['writer'] },
      ],
      agents,
      newId,
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const [writer, voice] = out.team.members
    expect(writer.agent).toBe('agent:writer')
    expect(voice.dependsOn).toEqual([writer.id])
  })

  it('refuses what cannot run', () => {
    const two = (b: object) => [{ name: 'A', task: 'x' }, { name: 'B', task: 'y', ...b }]
    expect(buildTeam([{ name: 'A', task: 'x' }], agents, newId).ok).toBe(false)
    expect(buildTeam(two({ agent: 'agent:ghost' }), agents, newId).ok).toBe(false)
    expect(buildTeam(two({ dependsOn: ['Nobody'] }), agents, newId).ok).toBe(false)
    expect(buildTeam([{ name: 'A', task: 'x' }, { name: 'a', task: 'y' }], agents, newId).ok).toBe(false)
    expect(buildTeam([{ name: 'A', task: '' }, { name: 'B', task: 'y' }], agents, newId).ok).toBe(false)
  })

  it('refuses a circle of waits and ignores waiting for yourself', () => {
    const circle = buildTeam([{ name: 'A', task: 'x', dependsOn: ['B'] }, { name: 'B', task: 'y', dependsOn: ['A'] }], agents, newId)
    expect(circle.ok).toBe(false)
    const self = buildTeam([{ name: 'A', task: 'x', dependsOn: ['A'] }, { name: 'B', task: 'y' }], agents, newId)
    expect(self.ok && self.team.members[0].dependsOn).toBeUndefined()
  })
})
