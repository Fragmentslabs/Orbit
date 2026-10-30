import { describe, expect, it, vi } from 'vitest'
import type { OrchestrationTask } from '@shared/chat'

vi.mock('../permission', () => ({ createToolApproval: vi.fn() }))
vi.mock('../permission/global-mode', () => ({ globalMode: vi.fn() }))
vi.mock('../prompts', () => ({ buildSystemPrompt: vi.fn() }))
vi.mock('../catalog', () => ({ getProvider: vi.fn() }))
vi.mock('../providers', () => ({ resolveModel: vi.fn() }))
vi.mock('../reasoning', () => ({ buildProviderOptions: vi.fn() }))
vi.mock('../agent-step', () => ({ agentPrepareStep: vi.fn() }))
vi.mock('./index', () => ({ buildToolSet: vi.fn() }))

const { createRemoveTaskTool, createTaskTool } = await import('./orchestration')
const { fileDisputes, normalizePath, outsideOwnership, pathsTouch } = await import('../orchestration/ownership')

const ceiling = { research: false, browser: false, vision: false, subagents: false }

function task(id: string, files?: string[], extra: Partial<OrchestrationTask> = {}): OrchestrationTask {
  return { id, title: id, prompt: '', options: {}, status: 'idle', ...(files ? { files: files } : {}), ...extra }
}

/** Plan being assembled with both tools, the way the orchestrator assembles it. */
function plan() {
  const tasks: OrchestrationTask[] = []
  const create = createTaskTool(
    (task, replaces) => {
      const idx = replaces ? tasks.findIndex((t) => t.id === replaces) : -1
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

describe('file ownership', () => {
  it('normalizes the path', () => {
    expect(normalizePath(' ./src\\app//page.tsx/ ')).toBe('src/app/page.tsx')
  })

  it('a file inside a folder, a glob and the whole project touch; neighbours do not', () => {
    expect(pathsTouch('src/auth/login.ts', 'src/auth')).toBe(true)
    expect(pathsTouch('src/auth/**', 'src/auth/login.ts')).toBe(true)
    expect(pathsTouch('src/*.ts', 'src/index.ts')).toBe(true)
    expect(pathsTouch('**/*.ts', 'docs/a.md')).toBe(true)
    expect(pathsTouch('src/auth', 'src/authz')).toBe(false)
    expect(pathsTouch('src/front/button.tsx', 'src/back/api.ts')).toBe(false)
  })

  it('a dispute only between tasks that run together and write', () => {
    const a = task('a', ['src/shared/types.ts'])
    const b = task('b', ['src/shared'])
    const c = task('c', ['src/shared/types.ts'], { dependsOn: ['a'] })
    const reading = task('d', ['src/shared'], { options: { plan: true } })
    const all = [a, b, c, reading]
    expect(fileDisputes(a, all).map((d) => d.task.id)).toEqual(['b'])
    // c waits for a; b waits for nobody
    expect(fileDisputes(c, all).map((d) => d.task.id)).toEqual(['b'])
    expect(fileDisputes(reading, all)).toEqual([])
  })

  it('outside ownership: points out what left the list and who owns the file', () => {
    const front = task('front', ['src/ui/**'])
    const back = task('back', ['server'])
    const outside = outsideOwnership(front, ['src/ui/button.tsx', './server/api.ts', 'package.json'], [front, back])
    expect(outside.map((f) => [f.file, f.owner?.id])).toEqual([
      ['server/api.ts', 'back'],
      ['package.json', undefined],
    ])
    // With no declared list there is nothing to check
    expect(outsideOwnership(task('x'), ['a.ts'], [])).toEqual([])
  })
})

describe('create_task', () => {
  it('stores the files and warns when two parallel tasks dispute them', async () => {
    const p = plan()
    expect(await p.run({ title: 'Tela', prompt: 'x', files: ['./src/ui/'] })).toBe('Task "Tela" registered in the plan.')
    const notice = await p.run({ title: 'Button', prompt: 'y', files: ['src/ui/button.tsx'] })
    expect(notice).toContain('shares files')
    expect(notice).toContain('"Tela"')
    expect(p.tasks.map((t) => t.files)).toEqual([['src/ui'], ['src/ui/button.tsx']])
  })

  it('repeating the title replaces the task and keeps the id (dependencies still hold)', async () => {
    const p = plan()
    await p.run({ title: 'API', prompt: 'v1', files: ['server/api.ts'] })
    await p.run({ title: 'Testes', prompt: 't', dependsOn: ['API'] })
    const id = p.tasks[0].id
    expect(await p.run({ title: 'api', prompt: 'v2', files: ['server/api.ts'] })).toBe('Task "api" replaced in the plan.')
    expect(p.tasks).toHaveLength(2)
    expect(p.tasks[0]).toMatchObject({ id, prompt: 'v2' })
    expect(p.tasks[1].dependsOn).toEqual([id])
  })

  it('a replacement cannot create a cycle', async () => {
    const p = plan()
    await p.run({ title: 'A', prompt: '' })
    await p.run({ title: 'B', prompt: '', dependsOn: ['A'] })
    expect(await p.run({ title: 'A', prompt: '', dependsOn: ['B'] })).toContain('cycle')
  })

  it('dependsOn resolves a dispute', async () => {
    const p = plan()
    await p.run({ title: 'Tipos', prompt: '', files: ['src/types.ts'] })
    expect(await p.run({ title: 'Uso', prompt: '', files: ['src/types.ts'], dependsOn: ['Tipos'] })).toBe('Task "Uso" registered in the plan.')
  })

  it('remove_task takes the task out and releases whoever depended on it', async () => {
    const p = plan()
    await p.run({ title: 'A', prompt: '' })
    await p.run({ title: 'B', prompt: '', dependsOn: ['A'] })
    expect(await p.drop('a')).toBe('Task "A" removed from the plan.')
    expect(p.tasks.map((t) => t.title)).toEqual(['B'])
    expect(p.tasks[0].dependsOn).toBeUndefined()
  })
})
