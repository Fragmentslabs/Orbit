import { describe, expect, it, vi } from 'vitest'

vi.mock('../storage', () => ({ readJson: vi.fn(async () => null), writeJson: vi.fn(async () => {}) }))

const { createUserNameTool } = await import('./user-name')
const { getAppSettings, onAppSettingsChange } = await import('../app-settings')

/** O SDK tipa `execute` como opcional; aqui ele existe (a tool declara). */
function run(name: string): Promise<unknown> {
  const execute = createUserNameTool().execute as unknown as (
    input: { name: string },
    options: { toolCallId: string; messages: never[] },
  ) => Promise<unknown>
  return execute({ name }, { toolCallId: 'call-1', messages: [] })
}

describe('set_user_name', () => {
  it('grava o nome no mesmo campo das Preferências, já normalizado', async () => {
    await run('  Ana Clara  ')
    expect(getAppSettings().userName).toBe('Ana Clara')
  })

  it('nome vazio esquece o nome salvo (o campo volta a null)', async () => {
    await run('Rafa')
    expect(getAppSettings().userName).toBe('Rafa')
    await run('   ')
    expect(getAppSettings().userName).toBeNull()
  })

  it('avisa os listeners — é o que leva a mudança ao renderer', async () => {
    const seen: (string | null)[] = []
    const off = onAppSettingsChange((next) => seen.push(next.userName))
    await run('Bia')
    off()
    expect(seen).toContain('Bia')
  })
})
