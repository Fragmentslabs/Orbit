import { describe, expect, it } from 'vitest'
import { DEFAULT_ORCHESTRATION_SETTINGS, type OrchestrationSettings } from '@shared/chat'
import { settingsForUnattended } from './unattended'

const base = (behavior: OrchestrationSettings['behavior']): OrchestrationSettings => ({ ...DEFAULT_ORCHESTRATION_SETTINGS, behavior })

describe('settingsForUnattended', () => {
  it('leaves a watched run alone', () => {
    expect(settingsForUnattended(base('rigorous'), undefined).behavior).toBe('rigorous')
  })

  it('runs a routine without review whatever the global setting says', () => {
    expect(settingsForUnattended(base('supervise'), {}).behavior).toBe('orchestrate')
    expect(settingsForUnattended(base('rigorous'), { tokenBudget: 1000 }).behavior).toBe('orchestrate')
  })

  it('keeps the global review when the routine opted in', () => {
    expect(settingsForUnattended(base('rigorous'), { review: true }).behavior).toBe('rigorous')
    expect(settingsForUnattended(base('supervise'), { review: true }).behavior).toBe('supervise')
  })

  it('opting in still reviews when the global setting is "orchestrate"', () => {
    expect(settingsForUnattended(base('orchestrate'), { review: true }).behavior).toBe('supervise')
  })

  it('does not change the other settings', () => {
    const out = settingsForUnattended({ ...base('supervise'), adjustmentsPerWorker: 5, worktrees: true }, {})
    expect(out.adjustmentsPerWorker).toBe(5)
    expect(out.worktrees).toBe(true)
  })
})
