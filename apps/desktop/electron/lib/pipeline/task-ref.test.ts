import { describe, expect, it } from 'vitest'
import type { Pipeline, Task } from '@shared/pipeline'
import { isEditable, parseTaskNumber, resolveTask, summarizeTask, taskDiff, taskLabel, taskNotes } from './task-ref'

const pipeline = (id: string, name = id): Pipeline =>
  ({ id, name, phases: [{ name: 'Development' }, { name: 'Validation' }] }) as unknown as Pipeline
const task = (id: string, number: number | undefined, extra: Partial<Task> = {}): Task =>
  ({
    id,
    number,
    pipelineId: 'p1',
    title: `Title ${id}`,
    description: 'Do the thing',
    status: 'pending',
    currentPhase: null,
    dependsOn: [],
    notes: [],
    createdAt: '',
    workTimeMs: 0,
    tokens: 10,
    cost: 0.5,
    ...extra,
  }) as Task

describe('parseTaskNumber', () => {
  it.each([
    ['#12', 12],
    ['12', 12],
    [' task 7 ', 7],
    ['Task #3', 3],
  ])('reads %s', (input, expected) => expect(parseTaskNumber(input)).toBe(expected))

  it.each(['task_abc123', '#', '12a', '', '1234567'])('leaves %s to the id lookup', (input) =>
    expect(parseTaskNumber(input)).toBeUndefined(),
  )
})

describe('resolveTask', () => {
  const boards = [
    { pipeline: pipeline('p1', 'Features'), tasks: [task('t1', 1), task('t2', 2)] },
    { pipeline: pipeline('p2', 'Bugs'), tasks: [task('t3', 1), task('t4', 9)] },
  ]

  it('finds by number when it is unique across boards', () => {
    const r = resolveTask('#9', boards)
    expect(r.ok && r.task.id).toBe('t4')
  })

  it('refuses to pick when the number exists on several boards', () => {
    const r = resolveTask('#1', boards)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toContain('more than one pipeline')
    expect(!r.ok && r.message).toContain('p1')
    expect(!r.ok && r.message).toContain('p2')
  })

  it('narrows by pipelineId or by name', () => {
    const byId = resolveTask('#1', boards, { pipelineId: 'p2' })
    expect(byId.ok && byId.task.id).toBe('t3')
    const byName = resolveTask('1', boards, { pipeline: 'feat' })
    expect(byName.ok && byName.task.id).toBe('t1')
  })

  it('finds by task id', () => {
    const r = resolveTask('t4', boards)
    expect(r.ok && r.pipeline.id).toBe('p2')
  })

  it('explains unknown tasks and pipelines', () => {
    expect(resolveTask('#99', boards)).toMatchObject({ ok: false })
    expect(resolveTask('#1', boards, { pipelineId: 'zzz' })).toMatchObject({ ok: false, message: expect.stringContaining('not found') })
    expect(resolveTask('#1', boards, { pipeline: 'zzz' })).toMatchObject({ ok: false, message: expect.stringContaining('No pipeline matches') })
  })
})

describe('summaries', () => {
  it('labels with the number, or the id for unnumbered data', () => {
    expect(taskLabel(task('t1', 5))).toBe('#5')
    expect(taskLabel(task('t1', undefined))).toBe('t1')
  })

  it('summarizes status, dependencies, files and a clipped note', () => {
    const dep = task('d', 2)
    const t = task('t', 3, {
      status: 'in_progress',
      currentPhase: 1,
      dependsOn: ['d'],
      finalCommitHash: 'abc123',
      diff: { start: 's', files: ['a.ts', 'b.ts'], patch: '' },
      notes: [
        { phaseId: 'f1', phaseName: 'Development', status: 'ok', content: 'x'.repeat(1000), controlledCommands: [], tokens: 0, cost: 0, startedAt: '', completedAt: '', round: 1 },
      ],
    })
    const text = summarizeTask(pipeline('p1', 'Features'), t, [dep, t])
    expect(text).toContain('#3 — Title t')
    expect(text).toContain('phase: Validation')
    expect(text).toContain('Depends on: #2 Title d')
    expect(text).toContain('Final commit: abc123')
    expect(text).toContain('Files changed (2): a.ts, b.ts')
    expect(text).toContain('[+')
    expect(text.length).toBeLessThan(2500)
  })

  it('filters notes by phase and clips long ones', () => {
    const t = task('t', 1, {
      notes: [
        { phaseId: 'f1', phaseName: 'Development', status: 'ok', content: 'dev note', controlledCommands: [], tokens: 0, cost: 0, startedAt: '', completedAt: '', round: 1 },
        { phaseId: 'f2', phaseName: 'Validation', status: 'ok', content: 'v'.repeat(20000), controlledCommands: [], tokens: 0, cost: 0, startedAt: '', completedAt: '', round: 1 },
      ],
    })
    expect(taskNotes(t, 'valid')).toContain('### Validation')
    expect(taskNotes(t, 'valid')).not.toContain('dev note')
    expect(taskNotes(t, 'valid').length).toBeLessThan(6200)
    expect(taskNotes(t, 'nothing')).toContain('No note')
  })

  it('reads one file out of the accumulated patch', () => {
    const patch = 'diff --git a/a.ts b/a.ts\n+one\ndiff --git a/dir/b.ts b/dir/b.ts\n+two\n'
    const t = task('t', 1, { diff: { start: 's', files: ['a.ts', 'dir/b.ts'], patch } })
    expect(taskDiff(t)).toContain('a.ts\ndir/b.ts')
    expect(taskDiff(t, 'dir/b.ts')).toContain('+two')
    expect(taskDiff(t, 'dir/b.ts')).not.toContain('+one')
    expect(taskDiff(t, 'zzz')).toContain('No patch')
    expect(taskDiff(task('t', 1))).toContain('no recorded diff')
  })

  it('only pending and paused tasks are editable', () => {
    expect(isEditable({ status: 'pending' })).toBe(true)
    expect(isEditable({ status: 'paused' })).toBe(true)
    expect(isEditable({ status: 'in_progress' })).toBe(false)
    expect(isEditable({ status: 'completed' })).toBe(false)
  })
})
