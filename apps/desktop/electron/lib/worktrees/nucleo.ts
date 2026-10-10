import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { WorktreeDaTask } from '@shared/esteira'
import { userShellEnv } from '../shell-env'

const execFileAsync = promisify(execFile)

/**
 * Núcleo dos worktrees: o que a esteira (worktree por task) e os chats
 * (seletor de worktree) compartilham — git, nomes, e levar as dependências do
 * repositório principal para o worktree.
 *
 * Os worktrees do Orbit ficam FORA do projeto, em userData/orbit-data/
 * worktrees: dentro dele, apareceriam nas buscas do agente, disparariam
 * watchers (Vite, dev server) e dependeriam do .gitignore do usuário.
 *
 * O worktree compartilha o .git do repositório; o peso real são os
 * node_modules, que não vêm junto. Eles são clonados copy-on-write quando o
 * sistema de arquivos permite (APFS: quase instantâneo e quase sem espaço) e,
 * senão, vinculados ao repositório principal. Os .env* (ignorados pelo git,
 * mas necessários para rodar o projeto) são copiados.
 */

/** Pastas que não valem a descida na busca por node_modules e .env. */
const IGNORAR = new Set(['.git', 'dist', 'dist-electron', 'build', 'out', '.next', 'target', 'coverage', '.turbo', '.expo'])
/** Profundidade da busca: raiz + workspaces (apps/x, packages/y) com folga. */
const PROFUNDIDADE = 4
const ENV = /^\.env(\..+)?$/

export function pastaDosWorktrees(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'worktrees')
}

export async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: userShellEnv(),
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    signal,
  })
  return stdout.trim()
}

export async function existe(caminho: string): Promise<boolean> {
  try {
    await fs.access(caminho)
    return true
  } catch {
    return false
  }
}

/** "Calcular frete (v2)!" → "calcular-frete-v2" */
export function slug(texto: string): string {
  return (
    texto
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'task'
  )
}

/** Raiz do repositório que contém a pasta (a pasta pode ser uma subpasta). */
export async function raizDoRepositorio(pasta: string): Promise<string> {
  try {
    return await git(pasta, ['rev-parse', '--show-toplevel'])
  } catch {
    throw new Error(`A pasta principal não é um repositório git: ${pasta}`)
  }
}

/** Branch atual do repositório; commit quando está em detached HEAD. */
export async function baseAtual(repo: string): Promise<string> {
  const branch = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return branch === 'HEAD' ? git(repo, ['rev-parse', 'HEAD']) : branch
}

export async function branchExiste(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/**
 * node_modules e .env* do repositório principal, em caminhos relativos. Não
 * desce em node_modules (são tratados inteiros) nem em pastas de build.
 */
export async function acharExtras(raiz: string): Promise<{ modulos: string[]; envs: string[] }> {
  const modulos: string[] = []
  const envs: string[] = []
  const descer = async (relativo: string, profundidade: number) => {
    let entradas
    try {
      entradas = await fs.readdir(path.join(raiz, relativo), { withFileTypes: true })
    } catch {
      return
    }
    for (const entrada of entradas) {
      const caminho = relativo ? path.join(relativo, entrada.name) : entrada.name
      if (entrada.isDirectory()) {
        if (entrada.name === 'node_modules') modulos.push(caminho)
        else if (!IGNORAR.has(entrada.name) && profundidade < PROFUNDIDADE) await descer(caminho, profundidade + 1)
      } else if (entrada.isFile() && ENV.test(entrada.name)) {
        envs.push(caminho)
      }
    }
  }
  await descer('', 1)
  return { modulos, envs }
}

/**
 * Clona uma pasta copy-on-write (APFS no macOS, reflink no Linux). Devolve
 * false quando o sistema de arquivos não permite — aí quem chama vincula.
 */
async function clonar(origem: string, destino: string): Promise<boolean> {
  const args =
    process.platform === 'darwin'
      ? ['-c', '-R', origem, destino]
      : process.platform === 'linux'
        ? ['-R', '--reflink=always', origem, destino]
        : null
  if (!args) return false
  try {
    await execFileAsync('cp', args, { timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 })
    return true
  } catch {
    // Clone parcial (ex.: volumes diferentes) não pode ficar: limpa e vincula.
    await fs.rm(destino, { recursive: true, force: true })
    return false
  }
}

/**
 * Leva node_modules e .env* do repositório principal para o worktree. O que
 * já existe no worktree (arquivos versionados) não é tocado.
 */
export async function prepararDependencias(
  repo: string,
  worktree: string,
): Promise<WorktreeDaTask['dependencias']> {
  const { modulos, envs } = await acharExtras(repo)
  for (const env of envs) {
    const destino = path.join(worktree, env)
    if (await existe(destino)) continue
    await fs.mkdir(path.dirname(destino), { recursive: true })
    await fs.copyFile(path.join(repo, env), destino)
  }
  if (modulos.length === 0) return 'nenhuma'
  let vinculou = false
  for (const modulo of modulos) {
    const origem = path.join(repo, modulo)
    const destino = path.join(worktree, modulo)
    if (await existe(destino)) continue
    await fs.mkdir(path.dirname(destino), { recursive: true })
    if (await clonar(origem, destino)) continue
    await fs.symlink(origem, destino, process.platform === 'win32' ? 'junction' : 'dir')
    vinculou = true
  }
  return vinculou ? 'vinculadas' : 'clonadas'
}
