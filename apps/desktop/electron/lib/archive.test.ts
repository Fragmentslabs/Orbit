import { describe, expect, it } from 'vitest'
import { planArchivedCleanup, setArchivedState } from '@shared/archive'
import type { SessionInfo } from '@shared/chat'

const DAY = 24 * 60 * 60 * 1000
const now = 100 * DAY
const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, title: id, mode: 'chat', pinned: false, archived: true, folderId: null, createdAt: 0, updatedAt: 0, ...extra }) as SessionInfo

describe('setArchivedState', () => {
  it('arquivar data o arquivamento; desarquivar limpa a data', () => {
    const archived = setArchivedState(session('a', { archived: false }), true, now)
    expect(archived).toMatchObject({ archived: true, archivedAt: now })
    expect(setArchivedState(archived, false, now + DAY)).toMatchObject({ archived: false, archivedAt: null })
  })

  it('sem mudança de estado, a data original fica', () => {
    const archived = session('a', { archivedAt: now - 5 * DAY })
    expect(setArchivedState(archived, true, now)).toBe(archived)
  })
})

describe('planArchivedCleanup', () => {
  it('conta o prazo desde o arquivamento, não desde a última atividade', () => {
    // Parada há 90 dias, mas arquivada ontem: ainda não sai.
    const recente = session('recente', { updatedAt: now - 90 * DAY, archivedAt: now - DAY })
    const antiga = session('antiga', { archivedAt: now - 31 * DAY })
    const { expired } = planArchivedCleanup([recente, antiga], 30, now, new Set())
    expect(expired.map((s) => s.id)).toEqual(['antiga'])
  })

  it('deixa de fora fixadas, as que estão respondendo, workers e não arquivadas', () => {
    const old = { archivedAt: now - 60 * DAY }
    const sessions = [
      session('sai', old),
      session('fixada', { ...old, pinned: true }),
      session('rodando', old),
      session('worker', { ...old, parentId: 'pai' }),
      session('ativa', { ...old, archived: false }),
    ]
    const { expired } = planArchivedCleanup(sessions, 30, now, new Set(['rodando']))
    expect(expired.map((s) => s.id)).toEqual(['sai'])
  })

  it('arquivadas antes da data existir começam a contar agora, sem sair de uma vez', () => {
    const { expired, undated } = planArchivedCleanup([session('sem-data', { updatedAt: now - 365 * DAY })], 7, now, new Set())
    expect(expired).toEqual([])
    expect(undated.map((s) => s.id)).toEqual(['sem-data'])
  })
})
