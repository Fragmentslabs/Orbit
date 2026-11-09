import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-secrets-'))
vi.mock('../../storage', () => ({ dataDir: () => dir }))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s.split('').reverse().join('')}`),
    decryptString: (b: Buffer) => b.toString().slice(4).split('').reverse().join(''),
  },
}))

const store = await import('./secrets-store')

describe('secrets store', () => {
  beforeAll(() => fs.mkdirSync(dir, { recursive: true }))
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('lists names only, keeps the value encrypted on disk and reads it back for the main process', async () => {
    expect(await store.setSecret('GITHUB_TOKEN', 'ghp_abcdefgh12345')).toEqual({ ok: true })
    expect(await store.listSecretNames()).toEqual(['GITHUB_TOKEN'])
    expect(fs.readFileSync(path.join(dir, 'routine-secrets.json'), 'utf8')).not.toContain('ghp_abcdefgh12345')
    expect(await store.readSecretValue('GITHUB_TOKEN')).toBe('ghp_abcdefgh12345')
    await store.removeSecret('GITHUB_TOKEN')
    expect(await store.readSecretValue('GITHUB_TOKEN')).toBeNull()
  })

  it('rejects bad names and short values', async () => {
    expect(await store.setSecret('lower', 'ghp_abcdefgh12345')).toMatchObject({ ok: false })
    expect(await store.setSecret('OK_NAME', 'short')).toMatchObject({ ok: false })
  })
})
