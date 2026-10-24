import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  manualSavesUnder,
  recordManualSave,
  resetManualSaves,
  stripFilesFromPatch,
} from './manual-saves'

/**
 * O que está em jogo aqui é a honestidade do registro verificado. Subtrair de
 * menos faz o engine creditar ao agente um arquivo que a pessoa salvou à mão;
 * subtrair de mais esconde uma escrita real do agente, que é pior — é
 * exatamente a alegação falsa que a verificação existe para pegar.
 */

const root = path.resolve('/repo')

beforeEach(resetManualSaves)

describe('manualSavesUnder', () => {
  it('devolve o caminho relativo com separador do git', () => {
    recordManualSave(path.join(root, 'src', 'app.ts'))
    expect(manualSavesUnder(root)).toEqual(new Set(['src/app.ts']))
  })

  it('ignora o que foi salvo fora do diretório do turno', () => {
    // Duas pastas abertas no workspace, um turno só: o save na outra pasta não
    // pode sumir do veredito deste.
    recordManualSave(path.join(root, 'dentro.ts'))
    recordManualSave(path.resolve('/outro', 'fora.ts'))
    expect(manualSavesUnder(root)).toEqual(new Set(['dentro.ts']))
  })

  it('não confunde pasta irmã de prefixo parecido', () => {
    recordManualSave(path.resolve('/repo-legado', 'a.ts'))
    expect(manualSavesUnder(root).size).toBe(0)
  })

  it('conta só os saves desde o começo do turno — e não apaga os de outro turno', () => {
    recordManualSave(path.join(root, 'antes.ts'), 1_000)
    recordManualSave(path.join(root, 'durante.ts'), 2_000)
    // Turno que começou em 1500 vê só o save de 2000; um que começou antes vê os dois.
    expect(manualSavesUnder(root, 1_500)).toEqual(new Set(['durante.ts']))
    expect(manualSavesUnder(root, 500)).toEqual(new Set(['antes.ts', 'durante.ts']))
  })
})

describe('stripFilesFromPatch', () => {
  const patch = [
    'diff --git a/src/agente.ts b/src/agente.ts',
    'index 111..222 100644',
    '--- a/src/agente.ts',
    '+++ b/src/agente.ts',
    '@@ -1 +1 @@',
    '-antigo',
    '+novo',
    'diff --git a/src/usuario.ts b/src/usuario.ts',
    'index 333..444 100644',
    '--- a/src/usuario.ts',
    '+++ b/src/usuario.ts',
    '@@ -1 +1 @@',
    '-meu antigo',
    '+meu novo',
    '',
  ].join('\n')

  it('remove só a seção do arquivo excluído', () => {
    const result = stripFilesFromPatch(patch, new Set(['src/usuario.ts']))
    expect(result).toContain('a/src/agente.ts')
    expect(result).not.toContain('a/src/usuario.ts')
    expect(result).not.toContain('meu novo')
    expect(result).toContain('+novo')
  })

  it('devolve o patch intacto quando não há o que excluir', () => {
    expect(stripFilesFromPatch(patch, new Set())).toBe(patch)
  })

  it('esvazia quando todos os arquivos eram do usuário', () => {
    const excluded = new Set(['src/agente.ts', 'src/usuario.ts'])
    expect(stripFilesFromPatch(patch, excluded)).toBe('')
  })

  it('não corta em linha de conteúdo que parece cabeçalho', () => {
    // Uma linha do CORPO do diff sempre vem prefixada (' ', '+', '-'), então
    // um "diff --git" dentro do código não pode ser lido como fronteira.
    const comArmadilha = [
      'diff --git a/doc.md b/doc.md',
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1 +1,2 @@',
      ' texto',
      '+diff --git a/falso b/falso',
      '',
    ].join('\n')
    expect(stripFilesFromPatch(comArmadilha, new Set(['outro.ts']))).toBe(comArmadilha)
  })
})
