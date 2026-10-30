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
 * The two ends of the citation: main writes the address, the renderer reads it. This
 * file closes the contract by importing BOTH sides for real — the previous
 * version copied the regex into the test, and a copy that diverges passes
 * the test and breaks in the app.
 */

describe('parseSourceHref', () => {
  it('reads the address sourceAnchor generates', () => {
    expect(parseSourceHref(sourceAnchor('src3', 12, 28))).toEqual({
      docId: 'src3',
      page: 12,
      fromLine: 28,
      toLine: undefined,
    })
  })

  it('reads a line range', () => {
    expect(parseSourceHref(sourceAnchor('doc1', 4, 28, 31))).toMatchObject({
      fromLine: 28,
      toLine: 31,
    })
  })

  it('reads a page-only citation', () => {
    expect(parseSourceHref(sourceAnchor('doc2', 7))).toMatchObject({ page: 7, fromLine: undefined })
  })

  it('ignores an ordinary link — a citation cannot hijack a web link', () => {
    expect(parseSourceHref('https://example.com/p1')).toBeNull()
  })

  it('ignora id forjado', () => {
    expect(parseSourceHref('#orbit-source/../../etc/p1')).toBeNull()
    expect(parseSourceHref('#orbit-source/src1/p')).toBeNull()
  })
})

describe('rescueLegacyCitations', () => {
  /**
   * The old format (`orbit-source://`) was erased by the sanitizer and
   * showed up as "[blocked]" in the conversation. The answers already saved keep the
   * text as it was written, so only the rewrite at render time fixes them.
   */
  it('converts the old citation to the current one', () => {
    const legacy = 'Unicast é um para um [1](orbit-source://src1/p3L12).'
    const updated = rescueLegacyCitations(legacy)
    expect(updated).toBe('Unicast é um para um [1](#orbit-source/src1/p3L12).')
    expect(parseSourceHref('#orbit-source/src1/p3L12')).not.toBeNull()
  })

  it('converts every occurrence in the same reply', () => {
    const text = '[1](orbit-source://src1/p1L2) e [2](orbit-source://doc2/p4L9-11)'
    expect(rescueLegacyCitations(text)).toBe('[1](#orbit-source/src1/p1L2) e [2](#orbit-source/doc2/p4L9-11)')
  })

  it('leaves text with no old citation untouched — same reference back', () => {
    const text = 'Veja [1](https://example.com) e [2](#orbit-source/src1/p1L2).'
    expect(rescueLegacyCitations(text)).toBe(text)
  })

  it('does not rewrite the loose word outside a link', () => {
    const text = 'O esquema orbit-source:// foi trocado por fragmento.'
    expect(rescueLegacyCitations(text)).toBe(text)
  })
})

describe('classifyMarkdownLink', () => {
  it('a document citation with an invented id becomes text, not a web card', () => {
    // The real link that took down a conversation: in a code analysis the model
    // wrote the document citation format with an id that does not exist. It went
    // to the web card, which did new URL(href) — and the href is not a URL.
    expect(classifyMarkdownLink('#orbit-source/src?/p1', '1')).toEqual({ kind: 'broken-source' })
  })

  it('a number pointing at a file or an anchor is an ordinary link', () => {
    expect(classifyMarkdownLink('src/app/devolucao.ts', '1')).toEqual({ kind: 'link' })
    expect(classifyMarkdownLink('#arquitetura', '[2]')).toEqual({ kind: 'link' })
  })

  it('only a number pointing at the web becomes a citation card', () => {
    expect(classifyMarkdownLink('https://example.com/artigo', '1')).toEqual({ kind: 'web-citation' })
    expect(classifyMarkdownLink('https://example.com', 'o artigo')).toEqual({ kind: 'link' })
  })

  it('a valid document citation keeps opening the source', () => {
    const link = classifyMarkdownLink('#orbit-source/doc1/p4L10-14', '2')
    expect(link.kind).toBe('source')
  })

  it('everything it cannot classify is a link, and no path throws', () => {
    for (const href of [undefined, '', '#', 'mailto:x@y.com', 'javascript:void(0)', 'caminho com espaço']) {
      expect(() => classifyMarkdownLink(href, '1')).not.toThrow()
    }
  })
})

describe('parseMemoryHref', () => {
  it('reads the address the memory citation uses', () => {
    expect(parseMemoryHref('#orbit-memory/mem_msj8qkrh9r542h0y')).toBe('mem_msj8qkrh9r542h0y')
  })

  it('rejects an id outside the format and an ordinary link', () => {
    expect(parseMemoryHref('#orbit-memory/abc123')).toBeNull()
    expect(parseMemoryHref('https://example.com/mem_abc123')).toBeNull()
    expect(parseMemoryHref('#orbit-memory/../../etc/passwd')).toBeNull()
  })

  it('a valid memory citation becomes a chip, and a broken one becomes text', () => {
    expect(classifyMarkdownLink('#orbit-memory/mem_abc123', 'idioma')).toEqual({
      kind: 'memory',
      memoryId: 'mem_abc123',
    })
    expect(classifyMarkdownLink('#orbit-memory/', 'idioma')).toEqual({ kind: 'broken-memory' })
  })
})

describe('linkifyMemoryIds', () => {
  it('converts the loose id into the chip, in the middle of the sentence', () => {
    expect(linkifyMemoryIds('Anotei isso em mem_abc123 e sigo daqui.')).toBe(
      'Anotei isso em [mem_abc123](#orbit-memory/mem_abc123) e sigo daqui.',
    )
  })

  /**
   * Linkify runs over the markdown of EVERY answer. An id cited inside
   * a code block is an example, not a reference — turning it into a chip
   * would ruin the code the person is going to copy.
   */
  it('leaves code blocks and inline code untouched', () => {
    const text = '```ts\nconst id = "mem_abc123"\n```\n\nUse `mem_def456` como exemplo.'
    expect(linkifyMemoryIds(text)).toBe(text)
  })

  it('does not rewrite an existing link or a loose href', () => {
    const pronto = 'Veja [idioma](#orbit-memory/mem_abc123).'
    expect(linkifyMemoryIds(pronto)).toBe(pronto)
    const loose = 'O endereço é #orbit-memory/mem_abc123.'
    expect(linkifyMemoryIds(loose)).toBe(loose)
  })

  it('with no memory id it returns the same string reference', () => {
    const text = 'Nenhuma memória citada aqui.'
    expect(linkifyMemoryIds(text)).toBe(text)
  })

  it('converts more than one id in the same sentence', () => {
    expect(linkifyMemoryIds('mem_abc123 e mem_def456')).toBe(
      '[mem_abc123](#orbit-memory/mem_abc123) e [mem_def456](#orbit-memory/mem_def456)',
    )
  })

  /**
   * The tools list the memories as "#mem_xxx". Without consuming the "#", the chip
   * would appear with a loose hash in front ("#user language").
   */
  it('swallows the "#" from the tools output', () => {
    expect(linkifyMemoryIds('Salvei em #mem_abc123.')).toBe(
      'Salvei em [mem_abc123](#orbit-memory/mem_abc123).',
    )
  })

  it('does not match inside another word', () => {
    const text = 'o campo xmem_abc123 não é uma citação'
    expect(linkifyMemoryIds(text)).toBe(text)
  })
})

describe('splitMemoryIds', () => {
  it('isolates the id from the tool output and keeps the surrounding text', () => {
    expect(splitMemoryIds('Salva #mem_abc123 com 3 vínculos')).toEqual([
      'Salva ',
      { memoryId: 'mem_abc123' },
      ' com 3 vínculos',
    ])
  })

  it('text with no id comes back as a single chunk', () => {
    expect(splitMemoryIds('nada aqui')).toEqual(['nada aqui'])
  })

  it('an id glued to punctuation does not take the punctuation along', () => {
    expect(splitMemoryIds('#mem_abc123:')).toEqual([{ memoryId: 'mem_abc123' }, ':'])
  })
})
