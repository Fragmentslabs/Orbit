import { describe, expect, it, vi } from 'vitest'
import type { OrchestrationTask } from '@shared/chat'

vi.mock('../permission', () => ({ createToolApproval: vi.fn() }))
vi.mock('../permission/modo-global', () => ({ modoGlobal: vi.fn() }))
vi.mock('../prompts', () => ({ buildSystemPrompt: vi.fn() }))
vi.mock('../catalog', () => ({ getProvider: vi.fn() }))
vi.mock('../providers', () => ({ resolveModel: vi.fn() }))
vi.mock('../reasoning', () => ({ buildProviderOptions: vi.fn(), reasoningPrepareStep: vi.fn() }))
vi.mock('./index', () => ({ buildToolSet: vi.fn() }))

const { createRemoveTaskTool, createTaskTool } = await import('./orchestration')
const { caminhosSeTocam, disputasDeArquivo, foraDaPosse, normalizarCaminho } = await import('../orquestra/posse')

const ceiling = { research: false, browser: false, vision: false, subagents: false }

function tarefa(id: string, arquivos?: string[], extra: Partial<OrchestrationTask> = {}): OrchestrationTask {
  return { id, title: id, prompt: '', options: {}, status: 'idle', ...(arquivos ? { arquivos } : {}), ...extra }
}

/** Plano em montagem com as duas tools, como o orquestrador monta. */
function plano() {
  const tasks: OrchestrationTask[] = []
  const create = createTaskTool(
    (task, substitui) => {
      const idx = substitui ? tasks.findIndex((t) => t.id === substitui) : -1
      if (idx >= 0) tasks[idx] = task
      else tasks.push(task)
      return true
    },
    ceiling,
    () => false,
    () => tasks,
  )
  const remove = createRemoveTaskTool(
    () => tasks,
    (id) => tasks.splice(tasks.findIndex((t) => t.id === id), 1),
  )
  const exec = (t: unknown, args: unknown) =>
    (t as { execute: (a: unknown, o: unknown) => Promise<string> }).execute(args, {})
  const run = (args: Record<string, unknown>) => exec(create, args)
  const drop = (title: string) => exec(remove, { title })
  return { tasks, run, drop }
}

describe('posse de arquivos', () => {
  it('normaliza o caminho', () => {
    expect(normalizarCaminho(' ./src\\app//page.tsx/ ')).toBe('src/app/page.tsx')
  })

  it('arquivo dentro de pasta, glob e projeto inteiro se tocam; vizinhos não', () => {
    expect(caminhosSeTocam('src/auth/login.ts', 'src/auth')).toBe(true)
    expect(caminhosSeTocam('src/auth/**', 'src/auth/login.ts')).toBe(true)
    expect(caminhosSeTocam('src/*.ts', 'src/index.ts')).toBe(true)
    expect(caminhosSeTocam('**/*.ts', 'docs/a.md')).toBe(true)
    expect(caminhosSeTocam('src/auth', 'src/authz')).toBe(false)
    expect(caminhosSeTocam('src/front/button.tsx', 'src/back/api.ts')).toBe(false)
  })

  it('disputa só entre tarefas que rodam juntas e que escrevem', () => {
    const a = tarefa('a', ['src/shared/types.ts'])
    const b = tarefa('b', ['src/shared'])
    const c = tarefa('c', ['src/shared/types.ts'], { dependeDe: ['a'] })
    const leitura = tarefa('d', ['src/shared'], { options: { plan: true } })
    const todas = [a, b, c, leitura]
    expect(disputasDeArquivo(a, todas).map((d) => d.task.id)).toEqual(['b'])
    // c espera a; b não espera ninguém
    expect(disputasDeArquivo(c, todas).map((d) => d.task.id)).toEqual(['b'])
    expect(disputasDeArquivo(leitura, todas)).toEqual([])
  })

  it('fora da posse: aponta o que saiu da lista e de quem é o arquivo', () => {
    const front = tarefa('front', ['src/ui/**'])
    const back = tarefa('back', ['server'])
    const fora = foraDaPosse(front, ['src/ui/button.tsx', './server/api.ts', 'package.json'], [front, back])
    expect(fora.map((f) => [f.arquivo, f.dono?.id])).toEqual([
      ['server/api.ts', 'back'],
      ['package.json', undefined],
    ])
    // Sem lista declarada não há o que conferir
    expect(foraDaPosse(tarefa('x'), ['a.ts'], [])).toEqual([])
  })
})

describe('create_task', () => {
  it('guarda os arquivos e avisa quando duas tarefas paralelas os disputam', async () => {
    const p = plano()
    expect(await p.run({ title: 'Tela', prompt: 'x', files: ['./src/ui/'] })).toBe('Task "Tela" registered in the plan.')
    const aviso = await p.run({ title: 'Botão', prompt: 'y', files: ['src/ui/button.tsx'] })
    expect(aviso).toContain('shares files')
    expect(aviso).toContain('"Tela"')
    expect(p.tasks.map((t) => t.arquivos)).toEqual([['src/ui'], ['src/ui/button.tsx']])
  })

  it('repetir o título substitui a tarefa e mantém o id (dependências seguem valendo)', async () => {
    const p = plano()
    await p.run({ title: 'API', prompt: 'v1', files: ['server/api.ts'] })
    await p.run({ title: 'Testes', prompt: 't', dependsOn: ['API'] })
    const id = p.tasks[0].id
    expect(await p.run({ title: 'api', prompt: 'v2', files: ['server/api.ts'] })).toBe('Task "api" replaced in the plan.')
    expect(p.tasks).toHaveLength(2)
    expect(p.tasks[0]).toMatchObject({ id, prompt: 'v2' })
    expect(p.tasks[1].dependeDe).toEqual([id])
  })

  it('substituição não pode criar ciclo', async () => {
    const p = plano()
    await p.run({ title: 'A', prompt: '' })
    await p.run({ title: 'B', prompt: '', dependsOn: ['A'] })
    expect(await p.run({ title: 'A', prompt: '', dependsOn: ['B'] })).toContain('cycle')
  })

  it('dependsOn resolve a disputa', async () => {
    const p = plano()
    await p.run({ title: 'Tipos', prompt: '', files: ['src/types.ts'] })
    expect(await p.run({ title: 'Uso', prompt: '', files: ['src/types.ts'], dependsOn: ['Tipos'] })).toBe('Task "Uso" registered in the plan.')
  })

  it('remove_task tira a tarefa e solta quem dependia dela', async () => {
    const p = plano()
    await p.run({ title: 'A', prompt: '' })
    await p.run({ title: 'B', prompt: '', dependsOn: ['A'] })
    expect(await p.drop('a')).toBe('Task "A" removed from the plan.')
    expect(p.tasks.map((t) => t.title)).toEqual(['B'])
    expect(p.tasks[0].dependeDe).toBeUndefined()
  })
})
