import { describe, expect, it } from 'vitest'
import { isHtmlDocument } from './html-source'

describe('isHtmlDocument', () => {
  it('recognises a whole page saved as .md', () => {
    expect(
      isHtmlDocument('<!doctype html>\n<html lang="en">\n<head><title>Orbit</title></head></html>'),
    ).toBe(true)
  })

  it('recognises a page that starts with the root element', () => {
    expect(isHtmlDocument('<html><body><div id="root"></div></body></html>')).toBe(true)
  })

  it('recognises a fragment that carries <head> or <body>', () => {
    expect(isHtmlDocument('\n\n<body class="dark">oi</body>')).toBe(true)
  })

  it('leaves real Markdown alone', () => {
    expect(isHtmlDocument('# Título\n\nUm parágrafo com **negrito** e `código`.')).toBe(false)
  })

  it('does not flag a Markdown that only mentions the tags further down', () => {
    const text = `${'# Documentação\n\n'.padEnd(3000, 'texto ')}<body> aparece no exemplo.`
    expect(isHtmlDocument(text)).toBe(false)
  })

  it('does not flag an inline HTML snippet', () => {
    expect(isHtmlDocument('<div align="center"><img src="logo.png"></div>')).toBe(false)
  })

  it('handles empty text', () => {
    expect(isHtmlDocument('')).toBe(false)
  })
})
