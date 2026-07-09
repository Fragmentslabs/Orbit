import path from 'node:path'
import type { PermissionClaim, PermissionMode } from '../../../shared/chat'

/**
 * Ruleset built-in de permissões (puro, testável). Só bash/write/edit geram
 * claims — as demais ferramentas (read/glob/grep/web/memory/...) são sempre
 * permitidas. Dois níveis:
 * - "ask"  (risco médio): pede confirmação no modo ask; auto-aprovado em approve/full.
 * - "deny" (crítico): pergunta no modo ask; NEGADO com razão em approve; livre em full.
 */

export type Verdict = 'ask' | 'deny'

export interface Assessment {
  claim: PermissionClaim
  verdict: Verdict
  /** Identificador da regra — chave do cache de "sempre permitir" */
  ruleId: string
}

export interface WorkDirs {
  directory: string
  extraDirectories: string[]
}

const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'])

function shorten(text: string, max = 80): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max)}…` : single
}

/** Alvos de rm -rf que apagariam além do projeto (raiz, home, o próprio diretório) */
function isCriticalTarget(target: string, dirs: WorkDirs | null): boolean {
  const clean = target.replace(/["']/g, '')
  if (clean === '/' || clean === '~' || clean === '.' || clean === '..' || clean === '*') return true
  if (/^[A-Za-z]:[\\/]?$/.test(clean)) return true
  if (clean.startsWith('~')) return true
  if (!dirs) return path.isAbsolute(clean)
  // Caminho resolvido fora das pastas de trabalho, ou igual à própria raiz
  const resolved = path.resolve(dirs.directory, clean)
  const roots = [dirs.directory, ...dirs.extraDirectories].map((r) => path.resolve(r))
  if (roots.some((root) => resolved === root)) return true
  return !roots.some((root) => {
    const rel = path.relative(root, resolved)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

/** Divide comandos compostos (a && b; c | d) em listas de tokens */
function segments(command: string): string[][] {
  return command
    .split(/(?:\|\||&&|;|\|)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(/\s+/))
}

function assessBash(command: string, dirs: WorkDirs | null): Assessment | null {
  const found: Assessment[] = []
  const claim = (ruleId: string, detail: string, verdict: Verdict): Assessment => ({
    ruleId,
    verdict,
    claim: {
      tool: 'bash',
      title: `bash: ${shorten(command)}`,
      detail,
      critical: verdict === 'deny' || undefined,
    },
  })

  for (let tokens of segments(command)) {
    if (tokens[0] === 'sudo') {
      found.push(claim('bash:sudo', 'comando com privilégios elevados (sudo)', 'ask'))
      tokens = tokens.slice(1)
    }
    const cmd = tokens[0]

    if (cmd === 'rm') {
      const flags = tokens.filter((t) => t.startsWith('-')).join('')
      const recursiveForce = /r/i.test(flags) && flags.includes('f')
      if (recursiveForce) {
        const targets = tokens.slice(1).filter((t) => !t.startsWith('-'))
        const critical = targets.some((t) => isCriticalTarget(t, dirs))
        found.push(
          critical
            ? claim('bash:rm-rf-critical', 'remoção recursiva fora do projeto ou da raiz', 'deny')
            : claim('bash:rm-rf', 'remoção recursiva de arquivos (rm -rf)', 'ask'),
        )
      }
    }

    if (cmd === 'git') {
      const sub = tokens[1]
      if (sub === 'push') {
        const force = tokens.some((t) => t === '--force' || t === '-f')
        found.push(
          force
            ? claim('bash:git-push-force', 'push forçado reescreve histórico remoto', 'deny')
            : claim('bash:git-push', 'publica commits no remoto (git push)', 'ask'),
        )
      }
      if (sub === 'reset' && tokens.includes('--hard')) {
        found.push(claim('bash:git-reset-hard', 'descarta alterações locais (git reset --hard)', 'deny'))
      }
    }
  }

  if (found.length === 0) return null
  // O veredito mais forte vence (deny > ask)
  return found.find((a) => a.verdict === 'deny') ?? found[0]
}

function assessFileWrite(tool: string, filePath: string, dirs: WorkDirs | null): Assessment | null {
  const normalized = filePath.replace(/\\/g, '/')
  const base = path.posix.basename(normalized.toLowerCase())
  const claim = (ruleId: string, detail: string, verdict: Verdict): Assessment => ({
    ruleId,
    verdict,
    claim: {
      tool,
      title: `${tool}: ${shorten(filePath, 60)}`,
      detail,
      critical: verdict === 'deny' || undefined,
    },
  })

  if (/(^|\/)\.git(\/|$)/.test(normalized.toLowerCase())) {
    return claim('file:git-dir', 'escrita dentro de .git corrompe o repositório', 'deny')
  }
  if (/^\.env(\..+)?$/.test(base)) {
    return claim('file:env', 'arquivo de segredos/ambiente (.env)', 'ask')
  }
  if (LOCKFILES.has(base)) {
    return claim('file:lockfile', 'lockfile de dependências — normalmente gerado, não editado', 'ask')
  }
  void dirs
  return null
}

/** Avalia uma chamada de ferramenta. null = sem risco, executa direto. */
export function assess(toolName: string, input: unknown, dirs: WorkDirs | null): Assessment | null {
  const args = (input ?? {}) as Record<string, unknown>
  if (toolName === 'bash' && typeof args.command === 'string') {
    return assessBash(args.command, dirs)
  }
  if ((toolName === 'write' || toolName === 'edit') && typeof args.filePath === 'string') {
    return assessFileWrite(toolName, args.filePath, dirs)
  }
  return null
}

export type Decision = 'approved' | 'denied' | 'user'

/** Tabela de decisão por modo (ask pergunta sempre; approve nega críticos; full libera tudo). */
export function decide(mode: PermissionMode, verdict: Verdict): Decision {
  if (mode === 'full') return 'approved'
  if (mode === 'approve') return verdict === 'deny' ? 'denied' : 'approved'
  return 'user'
}
