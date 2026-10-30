import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { resolveArtifactPath } from './artifact-path'

const BASE = path.resolve('/tmp/orbit-artifacts')

describe('resolveArtifactPath', () => {
  it('resolves a simple name inside the base', () => {
    expect(resolveArtifactPath(BASE, 'index.json')).toBe(path.join(BASE, 'index.json'))
  })

  it('accepts nested folders', () => {
    expect(resolveArtifactPath(BASE, 'pages/home.json')).toBe(path.join(BASE, 'pages', 'home.json'))
  })

  it('normalizes Windows separators', () => {
    expect(resolveArtifactPath(BASE, 'pages\\home.json')).toBe(path.join(BASE, 'pages', 'home.json'))
  })

  it('refuses a unix absolute path', () => {
    expect(() => resolveArtifactPath(BASE, '/etc/passwd')).toThrow(/relative/)
  })

  it('refuses a windows absolute path', () => {
    expect(() => resolveArtifactPath(BASE, 'C:\\Windows\\system32')).toThrow(/relative/)
  })

  it('refuses to escape the base with ..', () => {
    expect(() => resolveArtifactPath(BASE, '../outside.json')).toThrow(/escapes/)
    expect(() => resolveArtifactPath(BASE, 'pages/../../outside.json')).toThrow(/escapes/)
  })

  it('refuses an empty name', () => {
    expect(() => resolveArtifactPath(BASE, '')).toThrow(/required/)
  })
})
