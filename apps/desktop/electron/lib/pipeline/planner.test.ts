import { describe, expect, it, vi } from 'vitest'

vi.mock('../catalog', () => ({ getProvider: vi.fn() }))
vi.mock('../providers', () => ({ resolveModel: vi.fn() }))
vi.mock('../provider-session', () => ({ withProviderSession: vi.fn() }))
vi.mock('../reasoning', () => ({ buildProviderOptions: vi.fn(), interleavedReasoningField: vi.fn(), normalizeMessages: vi.fn() }))
vi.mock('./engine', () => ({ createTask: vi.fn() }))
vi.mock('./repo', () => ({ listPipelines: vi.fn(), listTasks: vi.fn() }))

const { normalizePlan } = await import('./planner')

describe('normalizePlan', () => {
  it('drops tasks without a title or description', () => {
    const plan = normalizePlan([{ title: '', description: 'x' }, { title: 'A', description: 'do a', files: [] }, 7, null])
    expect(plan.map((t) => t.title)).toEqual(['A'])
  })

  it('keeps only backward dependencies, remapped after dropped tasks', () => {
    const plan = normalizePlan([
      { title: 'bad', description: '' },
      { title: 'A', description: 'a', dependsOn: [] },
      { title: 'B', description: 'b', dependsOn: [1, 2, 5, -1, 'x'] },
    ])
    expect(plan[0].dependsOn).toEqual([])
    expect(plan[1].dependsOn).toEqual([0])
  })

  it('chains tasks that touch the same files, so they cannot run together', () => {
    const plan = normalizePlan([
      { title: 'A', description: 'a', files: ['src/app/page.tsx'] },
      { title: 'B', description: 'b', files: ['docs/readme.md'] },
      { title: 'C', description: 'c', files: ['src/app'] },
    ])
    expect(plan[1].dependsOn).toEqual([])
    expect(plan[2].dependsOn).toEqual([0])
  })

  it('never produces a cycle', () => {
    const plan = normalizePlan([
      { title: 'A', description: 'a', dependsOn: [1], files: ['x'] },
      { title: 'B', description: 'b', dependsOn: [0], files: ['x'] },
    ])
    expect(plan[0].dependsOn).toEqual([])
    expect(plan[1].dependsOn).toEqual([0])
  })

  it('accepts a non-array answer as an empty plan', () => {
    expect(normalizePlan({ nope: true })).toEqual([])
  })
})
