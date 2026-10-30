import { describe, expect, it, vi } from 'vitest'

vi.mock('../storage', () => ({ readJson: vi.fn(async () => null), writeJson: vi.fn(async () => {}) }))

const { createUserNameTool } = await import('./user-name')
const { getAppSettings, onAppSettingsChange } = await import('../app-settings')

/** The SDK types `execute` as optional; here it exists (the tool declares it). */
function run(name: string): Promise<unknown> {
  const execute = createUserNameTool().execute as unknown as (
    input: { name: string },
    options: { toolCallId: string; messages: never[] },
  ) => Promise<unknown>
  return execute({ name }, { toolCallId: 'call-1', messages: [] })
}

describe('set_user_name', () => {
  it('writes the name into the same field as Preferences, already normalized', async () => {
    await run('  Ana Clara  ')
    expect(getAppSettings().userName).toBe('Ana Clara')
  })

  it('an empty name forgets the saved name (the field goes back to null)', async () => {
    await run('Rafa')
    expect(getAppSettings().userName).toBe('Rafa')
    await run('   ')
    expect(getAppSettings().userName).toBeNull()
  })

  it('notifies the listeners — that is what carries the change to the renderer', async () => {
    const seen: (string | null)[] = []
    const off = onAppSettingsChange((next) => seen.push(next.userName))
    await run('Bia')
    off()
    expect(seen).toContain('Bia')
  })
})
