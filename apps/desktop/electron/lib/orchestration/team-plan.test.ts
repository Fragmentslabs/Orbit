import { describe, expect, it } from 'vitest'
import { planFromTeam } from './team-plan'

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
})
