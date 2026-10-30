import { describe, expect, it, vi } from 'vitest'
import type { PhaseNote, Pipeline, Task } from '@shared/pipeline'
import { notesForRound, returnForRound, taskRound } from '@shared/pipeline'

// The runner pulls catalog, providers and tools; the prompt uses none of them.
vi.mock('../catalog', () => ({ getProvider: vi.fn(), modelSupportsVision: vi.fn() }))
vi.mock('../providers', () => ({ resolveModel: vi.fn() }))

const { buildMessage } = await import('./runner')

function note(phaseId: string, content: string, round?: number, status: PhaseNote['status'] = 'ok'): PhaseNote {
  return {
    phaseId,
    phaseName: phaseId.toUpperCase(),
    status,
    content,
    controlledCommands: [],
    tokens: 0,
    cost: 0,
    startedAt: '2026-10-07T00:00:00.000Z',
    completedAt: '2026-10-07T00:00:00.000Z',
    ...(round ? { round } : {}),
  }
}

const pipeline = {
  id: 'pipe_1',
  projectId: 'proj_1',
  name: 'P',
  phases: [
    { id: 'dev', name: 'Dev', description: 'd', prompt: '', providerId: 'p', modelId: 'm', thinkingLevel: 0, tools: [], order: 0 },
    {
      id: 'val',
      name: 'Val',
      description: 'v',
      prompt: '',
      providerId: 'p',
      modelId: 'm',
      thinkingLevel: 0,
      tools: [],
      order: 1,
      kind: 'validation',
    },
  ],
  operationMode: 'manual',
  pushAtEnd: false,
  commitAtEnd: true,
  commandPolicy: { blocked: [], controlled: [] },
  createdAt: '2026-10-07T00:00:00.000Z',
} as Pipeline

function task(extra: Partial<Task>): Task {
  return {
    id: 't1',
    pipelineId: 'pipe_1',
    title: 'Frete',
    description: 'Calculate the shipping',
    status: 'in_progress',
    currentPhase: 0,
    dependsOn: [],
    notes: [],
    createdAt: '2026-10-07T00:00:00.000Z',
    workTimeMs: 0,
    tokens: 0,
    cost: 0,
    ...extra,
  }
}

function prompt(t: Task, index = 0): string {
  return buildMessage({
    pipeline,
    task: t,
    phase: pipeline.phases[index],
    phaseIndex: index,
    folders: ['/repo'],
    attempt: 1,
    abort: new AbortController().signal,
  })
}

describe('round helpers', () => {
  it('a task older than rounds counts as round 1, with every note', () => {
    const t = task({ notes: [note('dev', 'a'), note('val', 'b')] })
    expect(taskRound(t)).toBe(1)
    expect(notesForRound(t, 1)).toHaveLength(2)
    expect(returnForRound(t, 1)).toBeUndefined()
  })

  it('splits the notes by round', () => {
    const t = task({
      round: 2,
      notes: [note('dev', 'r1'), note('val', 'r1v'), note('dev', 'r2', 2)],
      returns: [{ round: 2, text: 'corrige', startPhase: 0, createdAt: '' }],
    })
    expect(notesForRound(t, 1).map((a) => a.content)).toEqual(['r1', 'r1v'])
    expect(notesForRound(t, 2).map((a) => a.content)).toEqual(['r2'])
    expect(returnForRound(t, 2)?.text).toBe('corrige')
  })
})

describe('phase prompt with rounds', () => {
  it('round 1 does not mention review', () => {
    const text = prompt(task({ notes: [note('dev', 'done')] }), 1)
    expect(text).not.toContain('Review feedback')
    expect(text).toContain('## Notes from previous phases')
    expect(text).toContain('done')
  })

  it('the review round brings the comment, the previous summary and only this round notes', () => {
    const t = task({
      round: 2,
      currentPhase: 1,
      notes: [
        note('dev', 'nota dev rodada 1'),
        note('val', 'final summary of round 1'),
        note('dev', 'nota dev rodada 2', 2),
      ],
      returns: [{ round: 2, text: 'Got the dimensional weight wrong', startPhase: 0, createdAt: '' }],
    })
    const text = prompt(t, 1)
    expect(text).toContain('## Review feedback (round 2)')
    expect(text).toContain('Got the dimensional weight wrong')
    expect(text).toContain('this is review round 2')
    expect(text).toContain('## Previous round summary (round 1, VAL)')
    expect(text).toContain('final summary of round 1')
    expect(text).toContain('nota dev rodada 2')
    // Phase 1's note from the previous round does not come back in full
    expect(text).not.toContain('nota dev rodada 1')
    // The comment comes before the pipeline: it is the priority instruction
    expect(text.indexOf('Got the dimensional weight wrong')).toBeLessThan(text.indexOf('## Pipeline'))
  })

  it('lists the earlier returns one per line', () => {
    const t = task({
      round: 3,
      returns: [
        { round: 2, text: 'first correction', startPhase: 0, createdAt: '' },
        { round: 3, text: 'second correction', startPhase: 0, createdAt: '' },
      ],
    })
    const text = prompt(t)
    expect(text).toContain('## Review feedback (round 3)')
    expect(text).toContain('- Round 2: first correction')
  })

  it('instruction on resume: priority on its own phase, context on the others of the round', () => {
    const instructions = [
      { text: 'use npm run test:unit', round: 1, phaseId: 'val', phaseName: 'Val', createdAt: '' },
      { text: 'do not touch the schema', round: 1, phaseId: 'dev', phaseName: 'Dev', createdAt: '' },
      { text: 'instruction from another round', round: 2, phaseId: 'val', phaseName: 'Val', createdAt: '' },
    ]
    const text = prompt(task({ currentPhase: 1, instructions }), 1)
    expect(text).toContain('## Instructions from the user for this phase\n')
    expect(text).toContain('- use npm run test:unit')
    expect(text).toContain('## Instructions the user gave to other phases (context)\n- Dev: do not touch the schema')
    expect(text).not.toContain('instruction from another round')
  })
})
