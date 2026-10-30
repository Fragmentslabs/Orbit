import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../shell-env', () => ({ userShellEnv: () => process.env }))

const { discoverChecks, runCheck } = await import('./checks')

let tmp: string

function write(relative: string, content: string) {
  const file = path.join(tmp, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-checks-')))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('discoverChecks', () => {
  it('takes only scripts that verify and terminate, with the lockfile package manager', async () => {
    write('package.json', JSON.stringify({
      scripts: {
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        test: 'vitest run',
        'test:watch': 'vitest',
        'test:e2e': 'playwright test --ui',
        dev: 'vite',
        build: 'vite build',
      },
    }))
    write('pnpm-lock.yaml', '')
    const v = await discoverChecks(tmp)
    expect(v.map((x) => x.name).sort()).toEqual(['lint', 'test', 'typecheck'])
    expect(v.find((x) => x.name === 'test')).toMatchObject({ command: 'pnpm', args: ['run', 'test'] })
  })

  it('in a monorepo, joins the subfolder ones and the root ones', async () => {
    write('package.json', JSON.stringify({ scripts: { lint: 'eslint .' } }))
    write('apps/web/package.json', JSON.stringify({ scripts: { typecheck: 'tsc' } }))
    write('Makefile', 'test:\n\tgo test ./...\nbuild:\n\tgo build\n')
    const v = await discoverChecks(path.join(tmp, 'apps/web'), tmp)
    expect(v.map((x) => x.name).sort()).toEqual(['lint (root)', 'make test (root)', 'typecheck'])
  })

  it('a project with no scripts has no checks', async () => {
    expect(await discoverChecks(tmp)).toEqual([])
  })
})

describe('runCheck', () => {
  it('passes and fails by the exit code, with the output along', async () => {
    // `node -e` instead of `sh -c`: `sh` does not exist on Windows, and what the
    // test verifies is the exit code and the captured output, not the shell.
    const node = process.execPath
    const ok = await runCheck({ name: 'ok', command: node, args: ['-e', 'console.log("all good")'], folder: tmp })
    expect(ok).toEqual({ ok: true, output: 'all good' })
    const failure = await runCheck({
      name: 'x',
      command: node,
      args: ['-e', 'console.error("error in a.ts"); process.exit(2)'],
      folder: tmp,
    })
    expect(failure.ok).toBe(false)
    expect(failure.output).toContain('error in a.ts')
  })
})
