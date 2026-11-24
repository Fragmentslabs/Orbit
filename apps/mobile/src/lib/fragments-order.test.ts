import { describe, expect, it } from 'vitest'
import type { FragmentPhoneEntry } from '@orbit/shared'
import { orderFragments } from './fragments-order'

const e = (id: string, name: string, pinned = false): FragmentPhoneEntry => ({
  id,
  name,
  icon: 'app-window',
  pinned,
  revision: 1,
  updatedAt: 0,
  requests: [],
  grants: [],
  hosts: [],
  mcp: [],
  untrusted: false,
  url: 'http://h/',
})

const list = [e('a', 'Gastos do mês'), e('b', 'Timer de foco'), e('c', 'Painel de deploy', true), e('d', 'Treino', true)]

describe('orderFragments', () => {
  it('puts the pinned ones on top and keeps the order inside each group', () => {
    expect(orderFragments(list, '').map((x) => x.id)).toEqual(['c', 'd', 'a', 'b'])
    expect(orderFragments(list.map((x) => ({ ...x, pinned: false })), '').map((x) => x.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('filters by name, ignoring case and spaces around, and the pinned ones still come first', () => {
    expect(orderFragments(list, '  t ').map((x) => x.id)).toEqual(['d', 'a', 'b'])
    expect(orderFragments(list, 'zzz')).toEqual([])
  })
})
