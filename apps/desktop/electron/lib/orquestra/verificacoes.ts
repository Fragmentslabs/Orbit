import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { userShellEnv } from '../shell-env'

const execFileAsync = promisify(execFile)

/**
 * Verificações do projeto para a orquestra no modo Rigoroso: o orquestrador só
 * aceita o trabalho de um worker depois de rodar alguma delas.
 *
 * Não roda comando livre: a lista sai do próprio projeto (scripts do
 * package.json, alvos do Makefile) e o orquestrador escolhe por nome. Assim
 * "verificar" nunca vira "rodar qualquer coisa" — o revisor não tem shell.
 */

export interface Verificacao {
  /** Como o orquestrador escolhe: "typecheck", "test", "make lint" */
  nome: string
  comando: string
  args: string[]
  /** Pasta onde roda (a do package.json/Makefile) */
  pasta: string
}

/** Scripts que verificam sem mudar nada nem ficar rodando (watch, dev server). */
const SCRIPT_DE_VERIFICACAO = /^(typecheck|type-check|tsc|lint|test|tests|check|verify)(:[\w-]+)?$/
const NAO_TERMINA = /(watch|dev|serve|start|ui)\b/i
const ALVOS_MAKE = new Set(['test', 'lint', 'check', 'typecheck'])

async function lerJson(arquivo: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(arquivo, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

async function existe(arquivo: string): Promise<boolean> {
  return fs.access(arquivo).then(() => true, () => false)
}

/** Gerenciador de pacotes pelo lockfile, subindo até a raiz informada. */
async function gerenciador(pasta: string, raiz: string): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> {
  let atual = pasta
  for (;;) {
    if (await existe(path.join(atual, 'pnpm-lock.yaml'))) return 'pnpm'
    if (await existe(path.join(atual, 'yarn.lock'))) return 'yarn'
    if (await existe(path.join(atual, 'bun.lockb')) || (await existe(path.join(atual, 'bun.lock')))) return 'bun'
    if (await existe(path.join(atual, 'package-lock.json'))) return 'npm'
    const pai = path.dirname(atual)
    if (atual === raiz || pai === atual || path.relative(raiz, pai).startsWith('..')) return 'npm'
    atual = pai
  }
}

/**
 * Verificações disponíveis para uma pasta de trabalho: as do package.json e do
 * Makefile da própria pasta e, se ela é uma subpasta, as da raiz do
 * repositório (monorepo com scripts na raiz).
 */
export async function descobrirVerificacoes(pasta: string, raizRepositorio?: string): Promise<Verificacao[]> {
  const pastas = [...new Set([pasta, raizRepositorio].filter((p): p is string => !!p))]
  const achadas: Verificacao[] = []
  const nomes = new Set<string>()
  for (const dir of pastas) {
    const pacote = await lerJson(path.join(dir, 'package.json'))
    const scripts = (pacote?.scripts ?? {}) as Record<string, unknown>
    const pm = pacote ? await gerenciador(dir, raizRepositorio ?? dir) : 'npm'
    for (const [nome, corpo] of Object.entries(scripts)) {
      // "watch" pode estar no nome (test:watch → vitest) ou no comando
      if (!SCRIPT_DE_VERIFICACAO.test(nome) || typeof corpo !== 'string' || NAO_TERMINA.test(nome) || NAO_TERMINA.test(corpo)) continue
      const rotulo = dir === pasta ? nome : `${nome} (raiz)`
      if (nomes.has(rotulo)) continue
      nomes.add(rotulo)
      achadas.push({ nome: rotulo, comando: pm, args: ['run', nome], pasta: dir })
    }
    try {
      const makefile = await fs.readFile(path.join(dir, 'Makefile'), 'utf8')
      for (const linha of makefile.split('\n')) {
        const alvo = /^([A-Za-z][\w-]*):(?!=)/.exec(linha)?.[1]
        if (!alvo || !ALVOS_MAKE.has(alvo)) continue
        const rotulo = dir === pasta ? `make ${alvo}` : `make ${alvo} (raiz)`
        if (nomes.has(rotulo)) continue
        nomes.add(rotulo)
        achadas.push({ nome: rotulo, comando: 'make', args: [alvo], pasta: dir })
      }
    } catch {
      // sem Makefile
    }
  }
  return achadas
}

const SAIDA_MAX = 6000

/** Roda uma verificação; a saída volta cortada no fim (onde costumam estar os erros). */
export async function rodarVerificacao(
  v: Verificacao,
  signal?: AbortSignal,
): Promise<{ ok: boolean; saida: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(v.comando, v.args, {
      cwd: v.pasta,
      env: { ...userShellEnv(), CI: '1', FORCE_COLOR: '0' },
      timeout: 10 * 60_000,
      maxBuffer: 20 * 1024 * 1024,
      signal,
    })
    return { ok: true, saida: cortar(`${stdout}\n${stderr}`) }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: number | string }
    const saida = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || String(err)
    return { ok: false, saida: cortar(`(saiu com ${e.code ?? 'erro'})\n${saida}`) }
  }
}

function cortar(texto: string): string {
  const limpo = texto.trim()
  return limpo.length > SAIDA_MAX ? `…\n${limpo.slice(-SAIDA_MAX)}` : limpo
}
