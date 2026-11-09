import { describe, expect, it } from 'vitest'
import { scriptFingerprint } from '@shared/routines'

const base = { code: 'return 1', hosts: ['b.com', 'a.com'], readFiles: false }

describe('scriptFingerprint', () => {
  it('is unchanged for scripts without databases, so earlier approvals stay valid', () => {
    expect(scriptFingerprint(base)).toBe('["return 1",["a.com","b.com"],false]')
    expect(scriptFingerprint({ ...base, databases: [] })).toBe(scriptFingerprint(base))
  })

  it('changes when a database is declared or swapped, but not with its order', () => {
    const one = scriptFingerprint({ ...base, databases: ['a.db'] })
    expect(one).not.toBe(scriptFingerprint(base))
    expect(one).not.toBe(scriptFingerprint({ ...base, databases: ['b.db'] }))
    expect(scriptFingerprint({ ...base, databases: ['b.db', 'a.db'] })).toBe(scriptFingerprint({ ...base, databases: ['a.db', 'b.db'] }))
  })
})
