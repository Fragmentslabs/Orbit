import { describe, expect, it } from 'vitest'

import { agentWriteFromTool, minimalChange, planMerge } from './agent-merge'

/**
 * Aqui se decide o que acontece com o que a pessoa digitou e ainda não salvou
 * quando o agente escreve no mesmo arquivo. Aplicar quando não devia apaga
 * trabalho em silêncio; recusar quando dava para fundir transforma cada edição
 * do agente num aviso que a pessoa vai aprender a ignorar.
 */

const apply = (plan: ReturnType<typeof planMerge>) =>
  plan.kind === 'apply' ? plan.changes : null

/** Aplica o plano de trás para frente: assim os offsets não se deslocam. */
function run(doc: string, plan: ReturnType<typeof planMerge>): string {
  const changes = apply(plan)
  if (!changes) throw new Error(`plano não aplicável: ${plan.kind}`)
  let out = doc
  for (const c of [...changes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, c.from) + c.insert + out.slice(c.to)
  }
  return out
}

describe('minimalChange', () => {
  it('isola o miolo que mudou', () => {
    const change = minimalChange('const a = 1\nconst b = 2\n', 'const a = 1\nconst b = 3\n')
    expect(change).not.toBeNull()
    // Só o "2" vira "3": o resto do arquivo não é tocado, e por isso o cursor
    // de quem está lendo mais abaixo não se mexe.
    expect(change!.insert).toBe('3')
    expect(change!.to - change!.from).toBe(1)
  })

  it('devolve null quando não mudou nada', () => {
    expect(minimalChange('igual', 'igual')).toBeNull()
  })

  it('cobre inserção no fim sem tocar no começo', () => {
    const change = minimalChange('a\n', 'a\nb\n')!
    expect(change.from).toBe(2)
    expect(change.insert).toBe('b\n')
  })
})

describe('planMerge — write', () => {
  it('aplica o conteúdo novo como alteração pontual', () => {
    const doc = 'linha 1\nlinha 2\nlinha 3\n'
    const plan = planMerge(doc, { kind: 'write', content: 'linha 1\nDOIS\nlinha 3\n' })
    expect(run(doc, plan)).toBe('linha 1\nDOIS\nlinha 3\n')
  })

  it('não faz nada quando o buffer já está como o agente quer', () => {
    expect(planMerge('x', { kind: 'write', content: 'x' })).toEqual({ kind: 'noop' })
  })
})

describe('planMerge — edit', () => {
  const doc = 'function a() {}\nfunction b() {}\n'

  it('funde a substituição quando o trecho é único', () => {
    const plan = planMerge(doc, { kind: 'edit', oldString: 'function b', newString: 'function c' })
    expect(run(doc, plan)).toBe('function a() {}\nfunction c() {}\n')
  })

  it('preserva o rascunho da pessoa em outra parte do arquivo', () => {
    // O ponto do merge: ela escreveu na linha 1, o agente mexeu na 2, e as
    // duas coisas sobrevivem. Recarregar do disco perderia a dela.
    const comRascunho = 'function a() { /* meu rascunho */ }\nfunction b() {}\n'
    const plan = planMerge(comRascunho, {
      kind: 'edit',
      oldString: 'function b',
      newString: 'function c',
    })
    expect(run(comRascunho, plan)).toBe('function a() { /* meu rascunho */ }\nfunction c() {}\n')
  })

  it('acusa conflito quando o trecho sumiu do buffer', () => {
    // Ela reescreveu justamente a região que o agente ia trocar.
    const plan = planMerge('outra coisa\n', {
      kind: 'edit',
      oldString: 'function b',
      newString: 'function c',
    })
    expect(plan).toEqual({ kind: 'conflict', reason: 'not-found' })
  })

  it('acusa conflito quando ficou ambíguo', () => {
    // O agente contava com trecho único; se agora há dois, o buffer divergiu
    // do que ele leu e escolher o primeiro seria chute.
    const duplicado = 'chame()\nchame()\n'
    const plan = planMerge(duplicado, { kind: 'edit', oldString: 'chame()', newString: 'ok()' })
    expect(plan).toEqual({ kind: 'conflict', reason: 'ambiguous' })
  })

  it('replaceAll troca todas as ocorrências', () => {
    const duplicado = 'chame()\nchame()\n'
    const plan = planMerge(duplicado, {
      kind: 'edit',
      oldString: 'chame()',
      newString: 'ok()',
      replaceAll: true,
    })
    expect(run(duplicado, plan)).toBe('ok()\nok()\n')
  })
})

describe('agentWriteFromTool', () => {
  it('reconhece write e edit', () => {
    expect(agentWriteFromTool('write', { filePath: 'a.ts', content: 'x' })).toEqual({
      filePath: 'a.ts',
      write: { kind: 'write', content: 'x' },
    })
    expect(
      agentWriteFromTool('edit', { filePath: 'a.ts', oldString: 'a', newString: 'b' }),
    ).toEqual({
      filePath: 'a.ts',
      write: { kind: 'edit', oldString: 'a', newString: 'b', replaceAll: false },
    })
  })

  it('ignora as demais tools e inputs incompletos', () => {
    // `bash` também escreve arquivo, mas não diz qual nem o quê — é o ponto
    // cego conhecido deste caminho, e adivinhar aqui seria pior.
    expect(agentWriteFromTool('bash', { command: 'sed -i s/a/b/ a.ts' })).toBeNull()
    expect(agentWriteFromTool('write', { filePath: 'a.ts' })).toBeNull()
    expect(agentWriteFromTool('edit', { filePath: 'a.ts', oldString: 'a' })).toBeNull()
  })
})
