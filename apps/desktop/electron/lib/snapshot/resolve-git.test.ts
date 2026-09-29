import { describe, expect, it, vi } from 'vitest'

// O módulo resolve o git no load e toca o app do Electron — nada disso
// interessa aqui, só a função pura de resolução.
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const { resolveGitBinary } = await import('./index')

/**
 * No Windows o snapshot quebrava em todo turno do modo código: a resolução foi
 * escrita para macOS e juntava o PATH com ":", procurava "git" sem ".exe" e
 * criava uma segunda chave "PATH" ao lado do "Path" do Windows. O log dizia
 * "spawn git ENOENT" com o git instalado e no PATH.
 */

const existe = (arquivos: string[]) => (file: string) => arquivos.includes(file)

describe('resolveGitBinary', () => {
  it('no Windows, acha o git.exe no Path e não cria uma segunda variável', () => {
    const env = { Path: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }
    const r = resolveGitBinary('win32', env, existe(['C:\\Program Files\\Git\\cmd\\git.exe']))

    expect(r.binary).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
    // Uma chave só, com o nome que ela já tinha — duas chaves que diferem só
    // na caixa deixam o processo filho com a errada.
    expect(Object.keys(r.env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['Path'])
    expect(r.env.Path).toBe('C:\\Windows\\system32;C:\\Program Files\\Git\\cmd')
  })

  it('no Windows, não mistura diretórios do macOS no PATH', () => {
    const r = resolveGitBinary('win32', { Path: 'C:\\Windows' }, existe([]))
    expect(r.env.Path).toBe('C:\\Windows')
    expect(r.env.Path).not.toContain('/usr/bin')
  })

  it('no Windows, fora do PATH, acha o git onde o instalador deixa', () => {
    const r = resolveGitBinary('win32', { Path: 'C:\\Windows' }, existe(['C:\\Program Files\\Git\\cmd\\git.exe']))
    expect(r.binary).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
  })

  it('no Windows, acha a instalação por usuário', () => {
    const local = 'C:\\Users\\x\\AppData\\Local'
    const r = resolveGitBinary(
      'win32',
      { Path: 'C:\\Windows', LOCALAPPDATA: local },
      existe([`${local}\\Programs\\Git\\cmd\\git.exe`]),
    )
    expect(r.binary).toBe(`${local}\\Programs\\Git\\cmd\\git.exe`)
  })

  it('no macOS, o PATH mínimo do Finder ainda acha o git do Homebrew', () => {
    // O caso para o qual a resolução foi escrita, e que tem que continuar valendo.
    const r = resolveGitBinary('darwin', { PATH: '/usr/bin' }, existe(['/opt/homebrew/bin/git']))
    expect(r.binary).toBe('/opt/homebrew/bin/git')
    expect(r.env.PATH?.split(':')).toContain('/opt/homebrew/bin')
    expect(r.env.PATH?.startsWith('/usr/bin')).toBe(true)
  })

  it('sem git em lugar nenhum, entrega "git" e deixa o PATH decidir', () => {
    const r = resolveGitBinary('linux', { PATH: '/usr/bin' }, existe([]))
    expect(r.binary).toBe('git')
  })
})
