import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from './cli'

let tmp: string

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-fragments-cli-'))
})

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true })
})

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const code = await run(args, { out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

async function scaffold(name = 'notes'): Promise<string> {
  const dir = path.join(tmp, name)
  expect((await cli('init', dir)).code).toBe(0)
  return dir
}

async function editManifest(dir: string, edit: (m: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(dir, 'manifest.json')
  const manifest = JSON.parse(await fsp.readFile(file, 'utf8'))
  edit(manifest)
  await fsp.writeFile(file, JSON.stringify(manifest))
}

describe('init', () => {
  it('scaffolds a fragment that validates', async () => {
    const dir = await scaffold('my-notes')
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ name: 'My notes', kind: 'screen', sdk: 1, requests: [] })
    expect(await fsp.readFile(path.join(dir, 'src/app.js'), 'utf8')).toContain('orbit.store')

    const result = await cli('validate', dir)
    expect(result.code).toBe(0)
    expect(result.out).toContain('is valid')
    expect(result.out).not.toContain('warning')
  })

  it('takes a name and a kind', async () => {
    const dir = path.join(tmp, 'w')
    expect((await cli('init', dir, '--name', 'Quick <b>', '--kind=widget')).code).toBe(0)
    expect(JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'))).toMatchObject({ name: 'Quick <b>', kind: 'widget' })
    expect(await fsp.readFile(path.join(dir, 'src/index.html'), 'utf8')).toContain('Quick &lt;b&gt;')
    expect((await cli('validate', dir)).code).toBe(0)
  })

  it('refuses a folder that already has files and a kind that does not exist', async () => {
    const dir = await scaffold()
    const again = await cli('init', dir)
    expect(again.code).toBe(1)
    expect(again.err).toContain('is not empty')
    const kind = await cli('init', path.join(tmp, 'x'), '--kind', 'banner')
    expect(kind.code).toBe(1)
    expect(kind.err).toContain('--kind must be one of: screen, panel, widget')
  })
})

describe('validate', () => {
  it('reports a missing manifest and a missing src', async () => {
    const result = await cli('validate', tmp)
    expect(result.code).toBe(1)
    expect(result.out).toContain('manifest.json: not found')
    expect(result.out).toContain('src/: not found')
  })

  it('reports a manifest that is not JSON', async () => {
    const dir = await scaffold()
    await fsp.writeFile(path.join(dir, 'manifest.json'), '{ nope')
    const result = await cli('validate', dir)
    expect(result.code).toBe(1)
    expect(result.out).toContain('manifest.json: is not valid JSON')
  })

  it('names every broken manifest field', async () => {
    const dir = await scaffold()
    await editManifest(dir, (m) => {
      m.name = ''
      m.id = 'Bad Id'
      m.icon = 'Not An Icon'
      m.kind = 'banner'
      m.sdk = 2
      m.requests = ['ai', 'network']
      m.grants = ['ai']
    })
    const result = await cli('validate', dir)
    expect(result.code).toBe(1)
    for (const expected of [
      'manifest.name: is required',
      'manifest.id: must be lowercase',
      'manifest.icon: must be a lucide icon name',
      'manifest.kind: must be one of: screen, panel, widget',
      'manifest.sdk: is 2 but this tooling supports sdk 1',
      'manifest.requests: unknown capability "network"',
      'manifest.grants: must be empty or absent',
    ]) {
      expect(result.out).toContain(expected)
    }
  })

  it('requires the sdk field', async () => {
    const dir = await scaffold()
    await editManifest(dir, (m) => delete m.sdk)
    expect((await cli('validate', dir)).out).toContain('manifest.sdk: is required')
  })

  it('refuses files the app would not serve', async () => {
    const dir = await scaffold()
    await fsp.writeFile(path.join(dir, 'src/tool.exe'), 'x')
    await fsp.writeFile(path.join(dir, 'src/big.json'), 'x'.repeat(1024 * 1024 + 1))
    await fsp.writeFile(path.join(dir, 'src/.secret.txt'), 'x')
    const result = await cli('validate', dir)
    expect(result.code).toBe(1)
    expect(result.out).toContain('src/tool.exe: file type .exe is not allowed')
    expect(result.out).toContain('src/big.json: too large (limit 1024KB)')
    expect(result.out).toContain('src/.secret.txt: hidden files are ignored')
  })

  it('requires the entry document and enforces the file limit', async () => {
    const dir = await scaffold()
    await fsp.rm(path.join(dir, 'src/index.html'))
    for (let i = 0; i < 60; i++) await fsp.writeFile(path.join(dir, `src/f${i}.txt`), '')
    const result = await cli('validate', dir)
    expect(result.code).toBe(1)
    expect(result.out).toContain('src/index.html: the entry document is missing')
    expect(result.out).toContain('src/: too many files (')
  })

  it('refuses symbolic links', async () => {
    const dir = await scaffold()
    await fsp.symlink(path.join(tmp, 'outside.txt'), path.join(dir, 'src/link.txt'))
    expect((await cli('validate', dir)).out).toContain('src/link.txt: symbolic links are not allowed')
  })

  it('warns, without failing, about remote URLs and unknown fields', async () => {
    const dir = await scaffold()
    await editManifest(dir, (m) => (m.homepage = 'https://example.com'))
    await fsp.appendFile(path.join(dir, 'src/index.html'), '<script src="https://cdn.example.com/lib.js"></script>')
    const result = await cli('validate', dir)
    expect(result.code).toBe(0)
    expect(result.out).toContain('manifest.homepage: unknown field')
    expect(result.out).toContain('src/index.html: loads a remote URL')
    expect(result.out).toContain('2 warnings')
  })

  it('prints a machine-readable report with --json', async () => {
    const dir = await scaffold()
    await editManifest(dir, (m) => (m.sdk = 9))
    const result = await cli('validate', dir, '--json')
    expect(result.code).toBe(1)
    const report = JSON.parse(result.out)
    expect(report.ok).toBe(false)
    expect(report.issues[0]).toMatchObject({ severity: 'error', where: 'manifest.sdk' })
  })
})

describe('arguments', () => {
  it('prints help, version and refuses what it does not know', async () => {
    expect((await cli('--help')).out).toContain('Usage:')
    expect((await cli('--version')).out).toMatch(/^\d+\.\d+\.\d+/)
    expect((await cli()).code).toBe(2)
    expect((await cli('publish')).err).toContain('unknown command "publish"')
    expect((await cli('validate', '--nope')).err).toContain('unknown option --nope')
    expect((await cli('init')).err).toContain('init needs a folder')
  })
})
