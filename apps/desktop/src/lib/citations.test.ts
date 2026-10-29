import { describe, expect, it } from 'vitest'

import {
  classifyMarkdownLink,
  linkifyMemoryIds,
  parseMemoryHref,
  parseSourceHref,
  rescueLegacyCitations,
  splitMemoryIds,
} from './citations'
import { sourceAnchor } from '@/electron/lib/document-pages'

/**
 * As duas pontas da citação: o main escreve o endereço, o renderer o lê. Este
 * arquivo fecha o contrato importando os DOIS lados de verdade — a versão
 * anterior copiava a regex para dentro do teste, e uma cópia que diverge passa
 * no teste e quebra no app.
 */

describe('parseSourceHref', () => {
  it('lê o endereço que o sourceAnchor gera', () => {
    expect(parseSourceHref(sourceAnchor('src3', 12, 28))).toEqual({
      docId: 'src3',
      page: 12,
      fromLine: 28,
      toLine: undefined,
    })
  })

  it('lê intervalo de linhas', () => {
    expect(parseSourceHref(sourceAnchor('doc1', 4, 28, 31))).toMatchObject({
      fromLine: 28,
      toLine: 31,
    })
  })

  it('lê citação só de página', () => {
    expect(parseSourceHref(sourceAnchor('doc2', 7))).toMatchObject({ page: 7, fromLine: undefined })
  })

  it('ignora link comum — a citação não pode sequestrar um link da web', () => {
    expect(parseSourceHref('https://exemplo.com/p1')).toBeNull()
  })

  it('ignora id forjado', () => {
    expect(parseSourceHref('#orbit-source/../../etc/p1')).toBeNull()
    expect(parseSourceHref('#orbit-source/src1/p')).toBeNull()
  })
})

describe('rescueLegacyCitations', () => {
  /**
   * O formato antigo (`orbit-source://`) era apagado pelo sanitizador e
   * aparecia como "[blocked]" na conversa. As respostas já gravadas guardam o
   * texto como foi escrito, então só a reescrita na renderização as conserta.
   */
  it('converte a citação antiga para a atual', () => {
    const antigo = 'Unicast é um para um [1](orbit-source://src1/p3L12).'
    const novo = rescueLegacyCitations(antigo)
    expect(novo).toBe('Unicast é um para um [1](#orbit-source/src1/p3L12).')
    expect(parseSourceHref('#orbit-source/src1/p3L12')).not.toBeNull()
  })

  it('converte todas as ocorrências da mesma resposta', () => {
    const texto = '[1](orbit-source://src1/p1L2) e [2](orbit-source://doc2/p4L9-11)'
    expect(rescueLegacyCitations(texto)).toBe('[1](#orbit-source/src1/p1L2) e [2](#orbit-source/doc2/p4L9-11)')
  })

  it('não toca em texto sem citação antiga — mesma referência de volta', () => {
    const texto = 'Veja [1](https://exemplo.com) e [2](#orbit-source/src1/p1L2).'
    expect(rescueLegacyCitations(texto)).toBe(texto)
  })

  it('não reescreve a palavra solta fora de um link', () => {
    const texto = 'O esquema orbit-source:// foi trocado por fragmento.'
    expect(rescueLegacyCitations(texto)).toBe(texto)
  })
})

describe('classifyMarkdownLink', () => {
  it('a citação de documento com id inventado vira texto, e não cartão da web', () => {
    // O link real que derrubou uma conversa: numa análise de código o modelo
    // escreveu o formato de citação de documento com um id que não existe. Ia
    // para o cartão da web, que fazia new URL(href) — e o href não é URL.
    expect(classifyMarkdownLink('#orbit-source/src?/p1', '1')).toEqual({ kind: 'broken-source' })
  })

  it('número apontando para arquivo ou âncora é link comum', () => {
    expect(classifyMarkdownLink('src/app/devolucao.ts', '1')).toEqual({ kind: 'link' })
    expect(classifyMarkdownLink('#arquitetura', '[2]')).toEqual({ kind: 'link' })
  })

  it('só número apontando para a web vira cartão de citação', () => {
    expect(classifyMarkdownLink('https://exemplo.com/artigo', '1')).toEqual({ kind: 'web-citation' })
    expect(classifyMarkdownLink('https://exemplo.com', 'o artigo')).toEqual({ kind: 'link' })
  })

  it('citação de documento válida continua abrindo a fonte', () => {
    const link = classifyMarkdownLink('#orbit-source/doc1/p4L10-14', '2')
    expect(link.kind).toBe('source')
  })

  it('tudo que ele não sabe classificar é link, e nenhum caminho lança', () => {
    for (const href of [undefined, '', '#', 'mailto:x@y.com', 'javascript:void(0)', 'caminho com espaço']) {
      expect(() => classifyMarkdownLink(href, '1')).not.toThrow()
    }
  })
})

describe('parseMemoryHref', () => {
  it('lê o endereço que a citação de memória usa', () => {
    expect(parseMemoryHref('#orbit-memory/mem_msj8qkrh9r542h0y')).toBe('mem_msj8qkrh9r542h0y')
  })

  it('recusa id fora do formato e link comum', () => {
    expect(parseMemoryHref('#orbit-memory/abc123')).toBeNull()
    expect(parseMemoryHref('https://exemplo.com/mem_abc123')).toBeNull()
    expect(parseMemoryHref('#orbit-memory/../../etc/passwd')).toBeNull()
  })

  it('a citação de memória válida vira chip, e a quebrada vira texto', () => {
    expect(classifyMarkdownLink('#orbit-memory/mem_abc123', 'idioma')).toEqual({
      kind: 'memory',
      memoryId: 'mem_abc123',
    })
    expect(classifyMarkdownLink('#orbit-memory/', 'idioma')).toEqual({ kind: 'broken-memory' })
  })
})

describe('linkifyMemoryIds', () => {
  it('converte o id solto no chip, no meio da frase', () => {
    expect(linkifyMemoryIds('Anotei isso em mem_abc123 e sigo daqui.')).toBe(
      'Anotei isso em [mem_abc123](#orbit-memory/mem_abc123) e sigo daqui.',
    )
  })

  /**
   * O linkify roda sobre o markdown de TODA resposta. Um id citado dentro de
   * um bloco de código é exemplo, não referência — transformá-lo em chip
   * estragaria o código que a pessoa vai copiar.
   */
  it('não toca em bloco de código nem em código inline', () => {
    const texto = '```ts\nconst id = "mem_abc123"\n```\n\nUse `mem_def456` como exemplo.'
    expect(linkifyMemoryIds(texto)).toBe(texto)
  })

  it('não reescreve link que já existe nem href solto', () => {
    const pronto = 'Veja [idioma](#orbit-memory/mem_abc123).'
    expect(linkifyMemoryIds(pronto)).toBe(pronto)
    const solto = 'O endereço é #orbit-memory/mem_abc123.'
    expect(linkifyMemoryIds(solto)).toBe(solto)
  })

  it('sem id de memória devolve a mesma referência de string', () => {
    const texto = 'Nenhuma memória citada aqui.'
    expect(linkifyMemoryIds(texto)).toBe(texto)
  })

  it('converte mais de um id na mesma frase', () => {
    expect(linkifyMemoryIds('mem_abc123 e mem_def456')).toBe(
      '[mem_abc123](#orbit-memory/mem_abc123) e [mem_def456](#orbit-memory/mem_def456)',
    )
  })

  /**
   * As tools listam as memórias como "#mem_xxx". Sem consumir o "#", o chip
   * apareceria com um jornal solto na frente ("#idioma do usuário").
   */
  it('engole o "#" da saída das tools', () => {
    expect(linkifyMemoryIds('Salvei em #mem_abc123.')).toBe(
      'Salvei em [mem_abc123](#orbit-memory/mem_abc123).',
    )
  })

  it('não casa dentro de outra palavra', () => {
    const texto = 'o campo xmem_abc123 não é uma citação'
    expect(linkifyMemoryIds(texto)).toBe(texto)
  })
})

describe('splitMemoryIds', () => {
  it('isola o id da saída da tool e mantém o texto em volta', () => {
    expect(splitMemoryIds('Salva #mem_abc123 com 3 vínculos')).toEqual([
      'Salva ',
      { memoryId: 'mem_abc123' },
      ' com 3 vínculos',
    ])
  })

  it('texto sem id volta como um pedaço só', () => {
    expect(splitMemoryIds('nada aqui')).toEqual(['nada aqui'])
  })

  it('id colado em pontuação não leva a pontuação junto', () => {
    expect(splitMemoryIds('#mem_abc123:')).toEqual([{ memoryId: 'mem_abc123' }, ':'])
  })
})
