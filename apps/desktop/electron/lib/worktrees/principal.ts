import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { userShellEnv } from '../shell-env'

const execFileAsync = promisify(execFile)

/**
 * Pasta equivalente no repositório PRINCIPAL para uma pasta dentro de um
 * `git worktree` — `<worktree>/apps/web` vira `<principal>/apps/web`.
 *
 * O worktree é outra cópia de trabalho do MESMO projeto, mas mora em outro
 * caminho. Tudo que identifica o projeto pelo caminho (memória de projeto, o
 * mapa do /init) trataria cada worktree como um projeto novo: sem as memórias
 * do principal, e com as novas presas a um caminho que some quando o worktree
 * é removido.
 *
 * Fora de worktree (repositório comum, pasta sem git, repositório bare), a
 * pasta volta como veio. Nunca lança: na dúvida, a pasta original.
 */
export async function pastaNoRepositorioPrincipal(pasta: string): Promise<string> {
  const chave = path.resolve(pasta)
  const pronta = cache.get(chave)
  if (pronta) return pronta
  const resolvida = resolver(chave)
  cache.set(chave, resolvida.then((r) => r.pasta))
  // Roda a cada turno (prompt, memória, relatório de uso): o resultado fica em
  // cache. Quando o git falha (pasta sem repositório, apagada) a resposta vale
  // por um minuto — a pasta pode virar repositório depois, mas um relatório
  // com dezenas de chats em pastas apagadas não deve chamar o git por chat.
  const esquecer = () => setTimeout(() => cache.delete(chave), FALHA_TTL_MS).unref?.()
  resolvida.then((r) => !r.cachear && esquecer()).catch(esquecer)
  return resolvida.then((r) => r.pasta)
}

const cache = new Map<string, Promise<string>>()
const FALHA_TTL_MS = 60_000

async function resolver(pasta: string): Promise<{ pasta: string; cachear: boolean }> {
  const resultado = await resolverNoGit(pasta)
  return resultado === null ? { pasta, cachear: false } : { pasta: resultado, cachear: true }
}

/** null = o git não respondeu (pasta sem repositório, inexistente). */
async function resolverNoGit(pasta: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'],
      { cwd: pasta, env: userShellEnv(), timeout: 10_000 },
    )
    const [gitDir, commonDir, topo] = stdout.trim().split('\n').map((linha) => path.resolve(pasta, linha.trim()))
    if (!gitDir || !commonDir || !topo) return pasta
    // Mesmo .git nos dois: é o repositório principal (ou um comum).
    if (gitDir === commonDir) return pasta
    // O .git compartilhado de um principal com cópia de trabalho termina em
    // ".git"; sem isso é um repositório bare, que não tem pasta para onde ir.
    if (path.basename(commonDir) !== '.git') return pasta
    const principal = path.dirname(commonDir)
    // Caminho real dos dois lados: no macOS o git devolve /private/var/… para
    // o que chegou como /var/…, e o relative daria um caminho cheio de "..".
    const real = await fs.realpath(pasta).catch(() => pasta)
    const relativo = path.relative(topo, real)
    if (relativo.startsWith('..') || path.isAbsolute(relativo)) return pasta
    return relativo ? path.join(principal, relativo) : principal
  } catch {
    return null
  }
}

/** Só para testes: esquece o que já foi resolvido. */
export function limparCachePrincipal(): void {
  cache.clear()
}
