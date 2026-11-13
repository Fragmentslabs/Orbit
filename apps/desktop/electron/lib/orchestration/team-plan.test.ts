import { describe, expect, it } from 'vitest'
import { handoffFileName, planFromTeam } from './team-plan'

let n = 0
const newId = (prefix: string) => `${prefix}_${++n}`

describe('planFromTeam', () => {
  it('is null for an empty team or members with no task', () => {
    expect(planFromTeam({ members: [] }, newId)).toBeNull()
    expect(planFromTeam({ members: [{ id: 'a', name: 'A', task: '  ' }] }, newId)).toBeNull()
  })

  it('maps members to tasks and remaps the dependencies to the new ids', () => {
    const plan = planFromTeam(
      {
        members: [
          { id: 'a', name: 'Writer', task: 'Write', agent: 'agent:x' },
          { id: 'b', name: 'Voice', task: 'Speak', dependsOn: ['a', 'a', 'b', 'ghost'] },
        ],
      },
      newId,
    )!
    expect(plan.tasks).toHaveLength(2)
    const [writer, voice] = plan.tasks
    expect(writer.agent).toBe('agent:x')
    expect(writer.dependsOn).toBeUndefined()
    expect(voice.dependsOn).toEqual([writer.id, writer.id])
    expect(plan.status).toBe('proposed')
  })

  it('gives each task the model of its member, and leaves the rest on the run default', () => {
    const plan = planFromTeam(
      {
        members: [
          { id: 'a', name: 'Researcher', task: 'Read', model: { providerId: 'anthropic', modelId: 'claude-haiku-4-5' } },
          { id: 'b', name: 'Writer', task: 'Write' },
        ],
      },
      newId,
    )!
    expect(plan.tasks[0].model).toEqual({ providerId: 'anthropic', modelId: 'claude-haiku-4-5' })
    expect(plan.tasks[1].model).toBeUndefined()
  })

  it('hands results over through the folder when the team has one of its own', () => {
    const team = { members: [{ id: 'a', name: 'Weekly Report', task: 'Write' }, { id: 'b', name: 'Voice', task: 'Speak', dependsOn: ['a'] }] }
    const plain = planFromTeam(team, newId)!
    expect(plain.tasks[0].prompt).toBe('Write')
    const withFolder = planFromTeam(team, newId, { handoff: true })!
    expect(withFolder.tasks[0].prompt).toContain('weekly-report.md')
    expect(withFolder.tasks[0].prompt).toContain('Voice (voice.md)')
    expect(withFolder.tasks[1].prompt).toContain('Weekly Report (weekly-report.md)')
    expect(withFolder.tasks[1].prompt).toContain('message_teammate')
  })

  it('names the result file safely', () => {
    expect(handoffFileName('Escritor de Roteiro')).toBe('escritor-de-roteiro.md')
    expect(handoffFileName('Revisão ../x')).toBe('revisao-x.md')
    expect(handoffFileName('???')).toBe('result.md')
  })
})
