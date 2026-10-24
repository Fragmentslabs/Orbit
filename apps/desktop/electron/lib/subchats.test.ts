import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, SessionInfo } from '@shared/chat'

const store = new Map<string, unknown>()

vi.mock('./storage', () => ({
  readJson: vi.fn(async (key: string) => store.get(key) ?? null),
  writeJson: vi.fn(async (key: string, value: unknown) => {
    store.set(key, value)
  }),
  listKeys: vi.fn(async (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix))),
}))

const { createSubchatRecord, formatSubchatsBlock, listSubchats } = await import('./subchats')

const T0 = 1_000_000

function sessao(id: string, parentId?: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    title: id,
    mode: 'code',
    pinned: false,
    archived: false,
    folderId: 'pasta-1',
    directory: '/tmp/projeto',
    extraDirectories: ['/tmp/extra'],
    ...(parentId ? { parentId } : {}),
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  }
}

function texto(id: string, role: 'user' | 'assistant', text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role,
    parts: [{ id: `${id}-p`, type: 'text', text, state: 'done' }],
    createdAt: T0,
    ...extra,
  }
}

describe('listSubchats', () => {
  it('lista só as conversas anexadas, com o último resultado de cada uma', async () => {
    store.clear()
    store.set('session/pai', sessao('pai'))
    store.set('session/f1', sessao('f1', 'pai', { title: 'Layout do relatório', updatedAt: T0 + 20 }))
    store.set('session/f2', sessao('f2', 'pai', { title: 'Parser de CSV', updatedAt: T0 + 10 }))
    // Worker de orquestração tem parentId, mas é assunto do workers.ts
    store.set(
      'session/w1',
      sessao('w1', 'pai', {
        orchestration: { role: 'worker', parentSessionId: 'pai', task: 'Backend' },
        updatedAt: T0 + 30,
      }),
    )
    // Arquivado sai da lista
    store.set('session/arq', sessao('arq', 'pai', { archived: true, updatedAt: T0 + 40 }))
    // De outro pai não entra
    store.set('session/outro', sessao('outro', 'x', { updatedAt: T0 + 50 }))

    store.set('messages/f1', [
      texto('m1', 'user', 'ajusta o cabeçalho'),
      texto('m2', 'assistant', 'Cabeçalho agora quebra em duas linhas.'),
    ])
    // Sem resposta ainda: o brief serve de resultado
    store.set('messages/f2', [texto('m3', 'assistant', 'Summary of the conversation so far:\n\nMigrar o split.', { summary: true })])

    const lista = await listSubchats('pai')
    expect(lista.map((r) => r.session.id)).toEqual(['f1', 'f2'])
    expect(lista[0].resultado).toBe('Cabeçalho agora quebra em duas linhas.')
    // O marcador de resumo não vaza para o contexto do pai
    expect(lista[1].resultado).toBe('Migrar o split.')
  })

  it('não devolve nada quando a conversa não tem filhas', async () => {
    store.clear()
    store.set('session/pai', sessao('pai'))
    expect(await listSubchats('pai')).toEqual([])
  })
})

describe('createSubchatRecord', () => {
  it('herda modo e pastas do pai e abre com o brief como resumo do sistema', async () => {
    store.clear()
    store.set('session/pai', sessao('pai', undefined, { mode: 'chat', directory: '/tmp/outro' }))

    const filho = await createSubchatRecord({ parentId: 'pai', title: '  Parser de CSV  ', body: 'Trocar o split.' })
    expect(filho).not.toBeNull()
    expect(filho!.title).toBe('Parser de CSV')
    expect(filho!.parentId).toBe('pai')
    expect(filho!.mode).toBe('chat')
    expect(filho!.directory).toBe('/tmp/outro')
    expect(filho!.extraDirectories).toEqual(['/tmp/extra'])
    expect(filho!.folderId).toBe('pasta-1')

    expect(store.get(`session/${filho!.id}`)).toEqual(filho)
    const mensagens = store.get(`messages/${filho!.id}`) as ChatMessage[]
    expect(mensagens).toHaveLength(1)
    expect(mensagens[0].role).toBe('assistant')
    expect(mensagens[0].summary).toBe(true)
    expect(mensagens[0].continuation).toBe(true)
    const corpo = (mensagens[0].parts[0] as { text: string }).text
    // O marcador existe para o modelo do chat novo ler como contexto…
    expect(corpo.startsWith('Summary of the conversation so far:')).toBe(true)
    expect(corpo).toContain('Trocar o split.')
  })

  it('não cria nada quando o pai não existe', async () => {
    store.clear()
    expect(await createSubchatRecord({ parentId: 'fantasma', title: 'X', body: 'Y' })).toBeNull()
  })
})

describe('formatSubchatsBlock', () => {
  it('é vazio sem subchats', () => {
    expect(formatSubchatsBlock([])).toBe('')
  })

  it('lista título e último resultado, cortando o texto longo', async () => {
    store.clear()
    store.set('session/pai', sessao('pai'))
    store.set('session/f1', sessao('f1', 'pai', { title: 'Layout' }))
    store.set('messages/f1', [texto('m1', 'assistant', 'A'.repeat(1200))])

    const bloco = formatSubchatsBlock(await listSubchats('pai'))
    expect(bloco).toContain('Subchats opened from this conversation')
    expect(bloco).toContain('**Layout**')
    expect(bloco).toContain('Latest: AAAA')
    expect(bloco).toContain('…')
    expect(bloco.length).toBeLessThan(1200)
  })
})
