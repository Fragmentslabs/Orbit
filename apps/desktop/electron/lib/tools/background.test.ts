import { describe, expect, it } from 'vitest'

import type { ProcessInfo } from '../process-manager'
import { stoppedWithLabel } from './background'

const proc = (pid: number, label: string, status: ProcessInfo['status']): ProcessInfo => ({
  pid,
  label,
  command: 'npm run dev',
  cwd: '/tmp',
  startTime: 0,
  status,
})

describe('stoppedWithLabel', () => {
  it('replaces the stopped entries of the same label — one card per job', () => {
    // The panel had five "Orbit dev" cards, four of them dead. Restarting the job
    // should take the place of the one that is over.
    expect(stoppedWithLabel([proc(1, 'Orbit dev', 'exited'), proc(2, 'Orbit dev', 'exited')], 'Orbit dev')).toEqual([1, 2])
  })

  it('counts a killed entry as stopped', () => {
    expect(stoppedWithLabel([proc(1, 'dev', 'killed')], 'dev')).toEqual([1])
  })

  it('leaves a running process alone: same label, but it is alive', () => {
    expect(stoppedWithLabel([proc(1, 'dev', 'running')], 'dev')).toEqual([])
  })

  it('does not touch another label', () => {
    expect(stoppedWithLabel([proc(1, 'build', 'exited')], 'dev')).toEqual([])
  })
})
