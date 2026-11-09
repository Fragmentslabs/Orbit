import { describe, expect, it } from 'vitest'
import { createPendingStore } from './pending'

describe('pending store', () => {
  it('hands a value back once', () => {
    const store = createPendingStore<string>()
    const token = store.put('a')
    expect(store.take(token)).toBe('a')
    expect(store.take(token)).toBeNull()
  })

  it('expires entries', () => {
    let clock = 0
    const store = createPendingStore<string>({ ttlMs: 100, now: () => clock })
    const token = store.put('a')
    clock = 101
    expect(store.take(token)).toBeNull()
  })

  it('drops the oldest beyond the cap', () => {
    const store = createPendingStore<number>({ max: 2 })
    const a = store.put(1)
    store.put(2)
    store.put(3)
    expect(store.take(a)).toBeNull()
  })

  it('forgets a dropped token', () => {
    const store = createPendingStore<string>()
    const token = store.put('a')
    store.drop(token)
    expect(store.take(token)).toBeNull()
  })
})
