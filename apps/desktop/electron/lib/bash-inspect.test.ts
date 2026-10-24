import { describe, expect, it } from 'vitest'

import { parseFileView, parseInspection, symbolSearchPattern } from './bash-inspect'

/**
 * Errar para "é inspeção" faria o corte de contexto descartar o registro de um
 * comando que mudou o disco; errar para "não é" só mantém o comportamento de
 * antes. Por isso os casos de dúvida caem sempre no null.
 */

const dir = '/repo'

describe('parseInspection', () => {
  it('aceita leitura e busca, inclusive em pipe e depois de cd', () => {
    expect(parseInspection('grep -rn "foo" src | head -20', dir)).toEqual({
      cwd: '/repo',
      command: 'grep -rn "foo" src | head -20',
    })
    expect(parseInspection('cd apps/desktop && sed -n 1,80p main.ts', dir)?.cwd).toBe('/repo/apps/desktop')
    expect(parseInspection('rg foo 2>/dev/null', dir)?.command).toBe('rg foo')
  })

  it('recusa o que pode escrever ou não dá para saber', () => {
    for (const command of [
      'cat a.ts > b.ts',
      'sed -i s/a/b/ file.ts',
      'find . -name "*.tmp" -delete',
      'find . -exec rm {} ;',
      'grep foo a.ts; rm a.ts',
      'cat $(ls)',
      'npm test',
      'git status',
      'ls && npm run build',
    ]) {
      expect(parseInspection(command, dir), command).toBeNull()
    }
  })

  it('não confunde um > dentro do padrão com redirecionamento', () => {
    expect(parseInspection('grep -n "a > b" src/x.ts', dir)).not.toBeNull()
  })
})

describe('parseFileView', () => {
  const view = (command: string) => {
    const inspection = parseInspection(command, dir)
    return inspection && parseFileView(inspection)
  }

  it('reconhece o trecho que cada comando mostra', () => {
    expect(view('cat src/a.ts')).toEqual({ path: '/repo/src/a.ts', from: 1, to: Infinity })
    expect(view("sed -n '20,80p' src/a.ts")).toEqual({ path: '/repo/src/a.ts', from: 20, to: 80 })
    expect(view('head -n 50 src/a.ts')).toEqual({ path: '/repo/src/a.ts', from: 1, to: 50 })
    expect(view('cd src && head -30 a.ts')).toEqual({ path: '/repo/src/a.ts', from: 1, to: 30 })
  })

  it('fica de fora quando a faixa ou o arquivo não são certos', () => {
    expect(view('tail -n 20 src/a.ts')).toBeNull()
    expect(view('cat a.ts b.ts')).toBeNull()
    expect(view('cat src/*.ts')).toBeNull()
    expect(view('cat a.ts | grep foo')).toBeNull()
  })
})

describe('symbolSearchPattern', () => {
  const pattern = (command: string) => {
    const inspection = parseInspection(command, dir)
    return inspection && symbolSearchPattern(inspection)
  }

  it('reconhece a busca por um nome', () => {
    expect(pattern('grep -rn "trimTurnContext" apps')).toBe('trimTurnContext')
    expect(pattern('rg -n memory.search')).toBe('memory.search')
  })

  it('ignora busca de texto livre', () => {
    expect(pattern('grep -rn "no such file" .')).toBeNull()
    expect(pattern('grep -rn "^export function" src')).toBeNull()
  })
})
