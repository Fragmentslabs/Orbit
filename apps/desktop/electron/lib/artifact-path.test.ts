import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { resolveArtifactPath } from './artifact-path'

const BASE = path.resolve('/tmp/orbit-artifacts')

describe('resolveArtifactPath', () => {
  it('resolve um nome simples dentro da base', () => {
    expect(resolveArtifactPath(BASE, 'index.json')).toBe(path.join(BASE, 'index.json'))
  })

  it('aceita pastas aninhadas', () => {
    expect(resolveArtifactPath(BASE, 'pages/home.json')).toBe(path.join(BASE, 'pages', 'home.json'))
  })

  it('normaliza separadores do windows', () => {
    expect(resolveArtifactPath(BASE, 'pages\\home.json')).toBe(path.join(BASE, 'pages', 'home.json'))
  })

  it('recusa caminho absoluto unix', () => {
    expect(() => resolveArtifactPath(BASE, '/etc/passwd')).toThrow(/relative/)
  })

  it('recusa caminho absoluto windows', () => {
    expect(() => resolveArtifactPath(BASE, 'C:\\Windows\\system32')).toThrow(/relative/)
  })

  it('recusa escapar da base com ..', () => {
    expect(() => resolveArtifactPath(BASE, '../fora.json')).toThrow(/escapes/)
    expect(() => resolveArtifactPath(BASE, 'pages/../../fora.json')).toThrow(/escapes/)
  })

  it('recusa nome vazio', () => {
    expect(() => resolveArtifactPath(BASE, '')).toThrow(/required/)
  })
})
