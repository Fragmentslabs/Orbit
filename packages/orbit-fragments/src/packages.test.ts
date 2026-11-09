import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { FRAGMENT_METHODS, FRAGMENT_SDK_VERSION } from '@orbit/shared/fragment-rules'
import { ORBIT_BRIDGE_METHODS, ORBIT_SDK_VERSION, isCompatibleSdk } from '../../orbit-fragments-api/src/index'
import { scaffoldFragment } from './scaffold'

const cliDir = path.resolve(__dirname, '..')
const apiDir = path.resolve(cliDir, '../orbit-fragments-api')

/** What `npm pack` would put in the tarball. Nothing is written or published. */
function packedFiles(cwd: string): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd, encoding: 'utf8' })
  const [pack] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>
  return pack.files.map((f) => f.path).sort()
}

describe('the typed API tracks the bridge protocol', () => {
  it('declares the same sdk version and methods the app enforces', () => {
    expect(ORBIT_SDK_VERSION).toBe(FRAGMENT_SDK_VERSION)
    expect([...ORBIT_BRIDGE_METHODS].sort()).toEqual([...FRAGMENT_METHODS].sort())
    expect(isCompatibleSdk(FRAGMENT_SDK_VERSION)).toBe(true)
    expect(isCompatibleSdk(FRAGMENT_SDK_VERSION + 1)).toBe(false)
  })

  it('is the version a scaffolded fragment depends on', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-fragments-scaffold-'))
    try {
      await scaffoldFragment({ dir: path.join(dir, 'a') })
      const project = JSON.parse(await fsp.readFile(path.join(dir, 'a/package.json'), 'utf8'))
      const api = JSON.parse(await fsp.readFile(path.join(apiDir, 'package.json'), 'utf8'))
      expect(project.devDependencies['orbit-fragments-api']).toBe(`^${api.version}`)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('npm pack (dry run)', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: apiDir, stdio: 'ignore' })
    execFileSync('npm', ['run', 'build'], { cwd: cliDir, stdio: 'ignore' })
  }, 120_000)

  it('ships the CLI as one bundled file and nothing else', () => {
    expect(packedFiles(cliDir)).toEqual(['README.md', 'dist/orbit-fragments.js', 'package.json'])
  })

  it('ships the declarations and no source or test files', () => {
    expect(packedFiles(apiDir)).toEqual(['README.md', 'dist/index.d.ts', 'dist/index.js', 'package.json'])
  })

  it('has a bundled CLI that runs on its own', async () => {
    const bin = path.join(cliDir, 'dist/orbit-fragments.js')
    expect((await fsp.readFile(bin, 'utf8')).startsWith('#!/usr/bin/env node')).toBe(true)
    expect(execFileSync('node', [bin, '--version'], { encoding: 'utf8' }).trim()).toBe(
      JSON.parse(await fsp.readFile(path.join(cliDir, 'package.json'), 'utf8')).version,
    )
  })
})
