import { describe, expect, it } from 'vitest'
import { DEFAULT_ORCHESTRATION_SETTINGS, normalizeOrchestrationSettings } from '@shared/chat'

/**
 * The settings are persisted (renderer localStorage, companion mirror and plans
 * approved by an older build) with the Portuguese keys and values. The rename
 * to English is migrated on read by `normalizeOrchestrationSettings`, which
 * every consumer goes through.
 */
describe('normalizeOrchestrationSettings — settings renamed to English', () => {
  it.each([
    ['orquestrar', 'orchestrate'],
    ['acompanhar', 'supervise'],
    ['rigoroso', 'rigorous'],
  ])('translates the legacy value %s to %s', (legacy, current) => {
    expect(normalizeOrchestrationSettings({ comportamento: legacy }).behavior).toBe(current)
  })

  it('leaves the current values untouched (idempotent)', () => {
    for (const behavior of ['orchestrate', 'supervise', 'rigorous'] as const) {
      const once = normalizeOrchestrationSettings({ behavior })
      expect(once.behavior).toBe(behavior)
      // Migrating what was already migrated changes nothing.
      expect(normalizeOrchestrationSettings(once)).toEqual(once)
    }
  })

  it('reads the persisted Portuguese keys as the English ones', () => {
    const migrated = normalizeOrchestrationSettings({
      comportamento: 'rigoroso',
      ajustesPorWorker: 4,
      worktrees: true,
      aprovarTarefaUnica: true,
    })
    expect(migrated).toEqual({
      behavior: 'rigorous',
      adjustmentsPerWorker: 4,
      worktrees: true,
      approveSingleTask: true,
    })
    // Idempotent over the migrated object as well.
    expect(normalizeOrchestrationSettings(migrated)).toEqual(migrated)
  })

  it('prefers the English key when both are present', () => {
    const settings = normalizeOrchestrationSettings({
      behavior: 'orchestrate',
      comportamento: 'rigoroso',
      adjustmentsPerWorker: 1,
      ajustesPorWorker: 5,
    })
    expect(settings.behavior).toBe('orchestrate')
    expect(settings.adjustmentsPerWorker).toBe(1)
  })

  it('falls back to the default for an unknown or missing value', () => {
    expect(normalizeOrchestrationSettings({}).behavior).toBe(DEFAULT_ORCHESTRATION_SETTINGS.behavior)
    expect(normalizeOrchestrationSettings({ comportamento: 'outro' }).behavior).toBe(
      DEFAULT_ORCHESTRATION_SETTINGS.behavior,
    )
    expect(normalizeOrchestrationSettings(null).behavior).toBe(DEFAULT_ORCHESTRATION_SETTINGS.behavior)
  })

  it('preserves the other settings, with their defaults, while migrating', () => {
    const migrated = normalizeOrchestrationSettings({ comportamento: 'rigoroso' })
    expect(migrated).toEqual({
      behavior: 'rigorous',
      adjustmentsPerWorker: DEFAULT_ORCHESTRATION_SETTINGS.adjustmentsPerWorker,
      worktrees: DEFAULT_ORCHESTRATION_SETTINGS.worktrees,
      approveSingleTask: DEFAULT_ORCHESTRATION_SETTINGS.approveSingleTask,
    })
  })
})
