import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { checkWritePath } from './file-write-guard'

/**
 * Esta é a única porta pela qual o renderer grava em disco. Um furo aqui não
 * aparece como bug na tela — aparece como arquivo sobrescrito fora do projeto,
 * ou como repositório corrompido.
 */

const root = path.resolve('/repo')

describe('checkWritePath', () => {
  it('aceita arquivo dentro da raiz', () => {
    const verdict = checkWritePath(path.join(root, 'src', 'app.ts'), [root])
    expect(verdict.ok).toBe(true)
  })

  it('aceita quando o alvo está em uma das várias raízes', () => {
    const outra = path.resolve('/outra')
    expect(checkWritePath(path.join(outra, 'a.ts'), [root, outra]).ok).toBe(true)
  })

  it('recusa fora da raiz', () => {
    const verdict = checkWritePath(path.resolve('/etc', 'hosts'), [root])
    expect(verdict).toEqual({ ok: false, reason: 'outside-workspace' })
  })

  it('recusa escapar por ..', () => {
    const verdict = checkWritePath(path.join(root, '..', 'vizinho', 'a.ts'), [root])
    expect(verdict).toEqual({ ok: false, reason: 'outside-workspace' })
  })

  it('não aceita pasta irmã de prefixo parecido', () => {
    // `/repo-legado` começa com `/repo` como TEXTO, mas não está dentro dele.
    const verdict = checkWritePath(path.resolve('/repo-legado', 'a.ts'), [root])
    expect(verdict).toEqual({ ok: false, reason: 'outside-workspace' })
  })

  it('recusa o diretório do git, mesmo dentro da raiz', () => {
    // Um save aqui corrompe o repositório, e nada que o painel abre para ler
    // precisa ser reescrito dentro de .git.
    const verdict = checkWritePath(path.join(root, '.git', 'config'), [root])
    expect(verdict).toEqual({ ok: false, reason: 'git-internal' })
  })

  it('recusa .git em qualquer profundidade', () => {
    const verdict = checkWritePath(path.join(root, 'sub', '.git', 'HEAD'), [root])
    expect(verdict).toEqual({ ok: false, reason: 'git-internal' })
  })

  it('recusa quando não há raiz nenhuma', () => {
    // Workspace sem pasta aberta não pode virar permissão para escrever em
    // qualquer lugar.
    expect(checkWritePath(path.resolve('/qualquer', 'a.ts'), []).ok).toBe(false)
  })
})
