import { describe, expect, it } from 'vitest'
import { defaultRehypePlugins } from 'streamdown'

import { localImageRehypePlugins } from './local-image-plugins'

/**
 * Este módulo remenda o pipeline do streamdown por dentro, então ele depende
 * do formato que a biblioteca publica. Se uma atualização mudar esse formato,
 * a figura local volta a sumir — e em silêncio, que é o pior jeito.
 *
 * Estes testes existem para que a mudança apareça aqui, e não na tela do
 * usuário meses depois.
 */

type Schema = { protocols?: Record<string, string[]> }

/** O esquema do sanitize, seja dos defaults ou do nosso pipeline. */
function schemaOf(plugin: unknown): Schema {
  expect(Array.isArray(plugin)).toBe(true)
  return (plugin as [unknown, Schema])[1]
}

const SANITIZE_INDEX = Object.keys(defaultRehypePlugins).indexOf('sanitize')

describe('pipeline do preview local', () => {
  it('a entrada do sanitize continua sendo [plugin, esquema]', () => {
    const sanitize = defaultRehypePlugins.sanitize as [unknown, Schema]

    expect(typeof sanitize[0]).toBe('function')
    expect(schemaOf(sanitize).protocols?.src).toBeDefined()
  })

  it('o padrão do streamdown NÃO aceita data: em src — é o que quebrava', () => {
    expect(schemaOf(defaultRehypePlugins.sanitize).protocols?.src).not.toContain('data')
  })

  it('o nosso aceita, sem perder os protocolos que já existiam', () => {
    const original = schemaOf(defaultRehypePlugins.sanitize)
    const patched = schemaOf(localImageRehypePlugins[SANITIZE_INDEX])

    expect(patched.protocols?.src).toContain('data')
    for (const protocol of original.protocols?.src ?? []) {
      expect(patched.protocols?.src).toContain(protocol)
    }
  })

  it('mantém todas as etapas do streamdown, na ordem, antes da nossa', () => {
    const names = Object.keys(defaultRehypePlugins)

    // As deles primeiro; a legenda entra depois, com o texto já na forma final.
    expect(localImageRehypePlugins.length).toBe(names.length + 1)
    // raw e harden passam adiante como vieram — só o sanitize é remendado.
    names.forEach((name, i) => {
      if (name === 'sanitize') return
      expect(localImageRehypePlugins[i]).toBe(defaultRehypePlugins[name])
    })
  })
})
