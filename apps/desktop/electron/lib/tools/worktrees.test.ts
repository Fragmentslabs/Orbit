import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListaWorktrees } from '@shared/worktrees'

const estado = vi.hoisted(() => ({
  sessao: { id: 's1', directory: '/repo' } as Record<string, unknown>,
  eventos: [] as unknown[],
  lista: null as ListaWorktrees | null,
}))

vi.mock('../storage', () => ({
  readJson: async () => estado.sessao,
  writeJson: async (_k: string, valor: Record<string, unknown>) => {
    estado.sessao = valor
  },
}))
vi.mock('../broadcast', () => ({ broadcastChatEvent: (e: unknown) => estado.eventos.push(e) }))
const servico = vi.hoisted(() => ({
  listarWorktrees: vi.fn(async () => estado.lista),
  criarWorktreeDoChat: vi.fn(async () => ({
    caminho: '/wt/novo',
    pasta: '/wt/novo/apps/web',
    branch: 'orbit/novo',
    base: 'main',
    dependencias: 'clonadas',
  })),
  removerWorktreeDoChat: vi.fn(async () => {}),
}))
vi.mock('../worktrees/servico', () => servico)

const { createWorktreeTools } = await import('./worktrees')
const { assess } = await import('../permission/rules')

const ctx = { sessionId: 's1', directory: '/repo/apps/web', extraDirectories: [], abort: new AbortController().signal }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const executar = (nome: string, args: unknown) => (createWorktreeTools(ctx)[nome] as any).execute(args, {}) as Promise<string>

const w = (caminho: string, extra: Partial<ListaWorktrees['worktrees'][number]> = {}) => ({
  caminho,
  pasta: `${caminho}/apps/web`,
  nome: caminho.split('/').pop()!,
  branch: 'main',
  head: 'abc1234',
  principal: false,
  origem: 'chat' as const,
  disponivel: true,
  travado: false,
  alteracoes: 0,
  aFrente: 0,
  ...extra,
})

beforeEach(() => {
  estado.sessao = { id: 's1', directory: '/repo/apps/web' }
  estado.eventos = []
  estado.lista = {
    repo: '/repo',
    atual: '/repo',
    worktrees: [w('/repo', { principal: true, origem: 'principal' }), w('/wt/login', { branch: 'orbit/login' })],
  }
  servico.removerWorktreeDoChat.mockClear()
})

describe('ferramentas de worktree', () => {
  it('worktree_create troca a pasta da sessão (mesma subpasta) e avisa a interface', async () => {
    const saida = await executar('worktree_create', { nome: 'novo' })
    expect(estado.sessao.directory).toBe('/wt/novo/apps/web')
    expect(estado.eventos).toHaveLength(1)
    expect(saida).toContain('NEXT message')
  })

  it('worktree_create com trocar=false não mexe na sessão', async () => {
    await executar('worktree_create', { nome: 'novo', trocar: false })
    expect(estado.sessao.directory).toBe('/repo/apps/web')
    expect(estado.eventos).toHaveLength(0)
  })

  it('worktree_switch acha pelo nome do branch sem o prefixo e volta para o principal', async () => {
    await executar('worktree_switch', { destino: 'login' })
    expect(estado.sessao.directory).toBe('/wt/login/apps/web')
    estado.lista!.atual = '/wt/login'
    await executar('worktree_switch', { destino: 'principal' })
    expect(estado.sessao.directory).toBe('/repo/apps/web')
  })

  it('worktree_remove recusa o worktree em que o chat está', async () => {
    estado.lista!.atual = '/wt/login'
    const saida = await executar('worktree_remove', { destino: 'login' })
    expect(saida).toContain('Switch to another one first')
    expect(servico.removerWorktreeDoChat).not.toHaveBeenCalled()
  })

  it('worktree_remove remove outro worktree', async () => {
    await executar('worktree_remove', { destino: 'orbit/login', apagarBranch: true })
    expect(servico.removerWorktreeDoChat).toHaveBeenCalledWith({ pasta: '/repo/apps/web', caminho: '/wt/login', apagarBranch: true })
  })
})

describe('aprovação', () => {
  it('listar, criar e trocar não pedem permissão; remover pede sempre', () => {
    expect(assess('worktree_list', {}, '/repo')).toBeNull()
    expect(assess('worktree_create', { nome: 'x' }, '/repo')).toBeNull()
    expect(assess('worktree_switch', { destino: 'x' }, '/repo')).toBeNull()
    const remover = assess('worktree_remove', { destino: 'login' }, '/repo')
    expect(remover?.sempre).toBe(true)
    expect(remover?.ruleId).toBe('worktree:remove')
  })
})
