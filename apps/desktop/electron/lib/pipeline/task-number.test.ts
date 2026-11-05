import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const userData = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))

import { allocateTaskNumber, listPipelines, listTasks } from './repo'

/**
 * Task numbers (#12): per pipeline, in order, never reused, and backfilled for
 * data written before they existed. The migration is one-shot per process, so the
 * "old" data is laid out before the first read.
 */
const pipeline = (id: string, extra: object = {}) => ({
  id,
  projectId: 'proj_1',
  name: id,
  phases: [],
  operationMode: 'manual',
  pushAtEnd: false,
  commitAtEnd: true,
  commandPolicy: { blocked: [], controlled: [] },
  createdAt: '2024-01-01T00:00:00.000Z',
  ...extra,
})
const task = (id: string, pipelineId: string, createdAt: string, extra: object = {}) => ({
  id,
  pipelineId,
  title: id,
  description: '',
  status: 'pending',
  currentPhase: null,
  dependsOn: [],
  notes: [],
  createdAt,
  workTimeMs: 0,
  tokens: 0,
  cost: 0,
  ...extra,
})

beforeAll(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pipeline-num-'))
  userData.dir = path.join(tmp, 'userData')
  const dir = path.join(userData.dir, 'orbit-data', 'pipeline')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'pipelines.json'), JSON.stringify([pipeline('p_old'), pipeline('p_new'), pipeline('p_part')]))
  // Old data: no numbers; the creation order (not the file order) decides.
  fs.writeFileSync(
    path.join(dir, 'tasks-p_old.json'),
    JSON.stringify([
      task('b', 'p_old', '2024-02-02T00:00:00.000Z'),
      task('a', 'p_old', '2024-02-01T00:00:00.000Z'),
      task('c', 'p_old', '2024-02-03T00:00:00.000Z'),
    ]),
  )
  // Half numbered (a crash between versions): the numbered ones keep theirs.
  fs.writeFileSync(
    path.join(dir, 'tasks-p_part.json'),
    JSON.stringify([
      task('x', 'p_part', '2024-03-01T00:00:00.000Z', { number: 7 }),
      task('y', 'p_part', '2024-03-02T00:00:00.000Z'),
    ]),
  )
})

describe('task numbers', () => {
  it('backfills old tasks in creation order and moves the counter past them', async () => {
    const tasks = await listTasks('p_old')
    expect(Object.fromEntries(tasks.map((t) => [t.id, t.number]))).toEqual({ a: 1, b: 2, c: 3 })
    const p = (await listPipelines()).find((x) => x.id === 'p_old')
    expect(p?.nextTaskNumber).toBe(4)
  })

  it('keeps existing numbers and numbers only the missing ones after the highest', async () => {
    const tasks = await listTasks('p_part')
    expect(Object.fromEntries(tasks.map((t) => [t.id, t.number]))).toEqual({ x: 7, y: 8 })
  })

  it('hands out consecutive numbers per pipeline, independent of each other', async () => {
    expect(await allocateTaskNumber('p_new')).toBe(1)
    expect(await allocateTaskNumber('p_new')).toBe(2)
    expect(await allocateTaskNumber('p_old')).toBe(4)
  })

  it('never reuses a number, even when the highest task is gone', async () => {
    // p_old has #1..#3 and the counter at 5; "removing" #3 changes nothing.
    const first = await allocateTaskNumber('p_old')
    const second = await allocateTaskNumber('p_old')
    expect(second).toBe(first + 1)
  })

  it('numbers concurrent creations without duplicates', async () => {
    const numbers = await Promise.all(Array.from({ length: 8 }, () => allocateTaskNumber('p_new')))
    expect(new Set(numbers).size).toBe(8)
  })

  it('fails for an unknown pipeline', async () => {
    await expect(allocateTaskNumber('nope')).rejects.toThrow(/not found/)
  })
})
