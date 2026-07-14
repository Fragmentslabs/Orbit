import path from 'node:path'
import type {
  PermissionClaim,
  PermissionMode,
  PermissionThresholds,
  Verdict,
} from '@shared/chat'

/**
 * Ruleset built-in de permissões (puro, testável). Apenas bash/write/edit
 * geram claims — as demais (read/glob/grep/web/memory/...) são sempre liberas.
 * Quatro níveis de verdict (ordem crescente de risco):
 * - "low"       (sem perigo): executa direto em qualquer modo.
 * - "medium"    (risco médio): pergunta em ask; auto em approve/full.
 * - "high"      (alto risco): pergunta em ask e approve (default high); auto em full.
 * - "forbidden" (piso absoluto): negado sempre — mesmo full não passa. Override
 *                apenas via config programática (~/.config/orbit/...) futura.
 */

export type { Verdict } from '@shared/chat'

export interface Assessment {
  claim: PermissionClaim
  verdict: Verdict
  /** Identificador da regra — chave do cache de "sempre permitir". */
  ruleId: string
}

export interface WorkDirs {
  directory: string
  extraDirectories: string[]
}

const RISK_ORDER: Record<Exclude<Verdict, 'forbidden'>, number> = {
  low: 0,
  medium: 1,
  high: 2,
}

const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'])

function shorten(text: string, max = 80): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max)}…` : single
}

function isCriticalTarget(target: string, dirs: WorkDirs | null): boolean {
  const clean = target.replace(/["']/g, '')
  if (clean === '/' || clean === '~' || clean === '.' || clean === '..' || clean === '*') return true
  if (/^[A-Za-z]:[\\/]?$/.test(clean)) return true
  if (clean.startsWith('~')) return true
  if (!dirs) return path.isAbsolute(clean)
  const resolved = path.resolve(dirs.directory, clean)
  const roots = [dirs.directory, ...dirs.extraDirectories].map((r) => path.resolve(r))
  if (roots.some((root) => resolved === root)) return true
  return !roots.some((root) => {
    const rel = path.relative(root, resolved)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

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
      // Apenas high/forbidden acendem o alerta crítico na UI.
      critical: verdict === 'high' || verdict === 'forbidden' || undefined,
    },
  })

  for (let tokens of segments(command)) {
    if (tokens[0] === 'sudo') {
      found.push(claim('bash:sudo', 'comando com privilégios elevados (sudo)', 'high'))
      tokens = tokens.slice(1)
    }
    const cmd = tokens[0]

    if (cmd === 'rm') {
      const flags = tokens.filter((t) => t.startsWith('-')).join('')
      const recursiveForce = /r/i.test(flags) && flags.includes('f')
      if (recursiveForce) {
        const targets = tokens.slice(1).filter((t) => !t.startsWith('-'))
        if (targets.some((t) => isCriticalTarget(t, dirs))) {
          // rm -rf fora do projeto / na raiz — piso absoluto.
          found.push(claim('bash:rm-rf-critical', 'remoção recursiva fora do projeto ou da raiz', 'forbidden'))
        } else {
          found.push(claim('bash:rm-rf', 'remoção recursiva de arquivos (rm -rf) — alta destrutividade', 'high'))
        }
      }
    }

    if (cmd === 'git') {
      const sub = tokens[1]
      if (sub === 'push') {
        const force = tokens.some((t) => t === '--force' || t === '-f')
        found.push(
          force
            ? claim('bash:git-push-force', 'push forçado reescreve histórico remoto', 'high')
            : claim('bash:git-push', 'publica commits no remoto (git push)', 'medium'),
        )
      }
      if (sub === 'reset' && tokens.includes('--hard')) {
        found.push(claim('bash:git-reset-hard', 'descarta alterações locais (git reset --hard)', 'high'))
      }
    }
  }

  if (found.length === 0) return null
  // Forbidden vence tudo; senão o verdict mais alto (maior risco).
  return (
    found.find((a) => a.verdict === 'forbidden') ??
    found.reduce((acc, a) =>
      a.verdict !== 'forbidden' && RISK_ORDER[a.verdict] > RISK_ORDER[acc.verdict as Exclude<Verdict, 'forbidden'>]
        ? a
        : acc,
    )
  )
}

function assessFileWrite(tool: string, filePath: string): Assessment | null {
  const normalized = filePath.replace(/\\/g, '/')
  const base = path.posix.basename(normalized.toLowerCase())
  const claim = (ruleId: string, detail: string, verdict: Verdict): Assessment => ({
    ruleId,
    verdict,
    claim: {
      tool,
      title: `${tool}: ${shorten(filePath, 60)}`,
      detail,
      critical: verdict === 'high' || verdict === 'forbidden' || undefined,
    },
  })

  if (/(^|\/)\.git(\/|$)/.test(normalized.toLowerCase())) {
    return claim('file:git-dir', 'escrita dentro de .git corrompe o repositório', 'forbidden')
  }
  if (/^\.env(\..+)?$/.test(base)) {
    return claim('file:env', 'arquivo de segredos/ambiente (.env)', 'medium')
  }
  if (LOCKFILES.has(base)) {
    // Editar lockfile manualmente é tranquilamente comum — sem risco real.
    return claim('file:lockfile', 'lockfile de dependências — normalmente gerado', 'low')
  }
  return null
}

export function assess(toolName: string, input: unknown, dirs: WorkDirs | null): Assessment | null {
  const args = (input ?? {}) as Record<string, unknown>
  if (toolName === 'bash' && typeof args.command === 'string') {
    return assessBash(args.command, dirs)
  }
  if ((toolName === 'write' || toolName === 'edit') && typeof args.filePath === 'string') {
    return assessFileWrite(toolName, args.filePath)
  }
  return null
}

export type Decision = 'approved' | 'denied' | 'user'

/** Decisão por modo+threshold:
 * - forbidden → sempre denied (piso absoluto, mesmo full).
 * - verifica verdict <= terminalAuto: aprovado; senão "user" (pergunta UI).
 * - full por padrão tem terminalAuto=high mas NÃO atingir forbidden → libera todos high.
 */
export function decide(mode: PermissionMode, verdict: Verdict, thresholds: PermissionThresholds): Decision {
  if (verdict === 'forbidden') return 'denied'
  if (mode === 'full') return 'approved'
  const autoLevel = RISK_ORDER[thresholds.terminalAuto]
  const verdictLevel = RISK_ORDER[verdict as Exclude<Verdict, 'forbidden'>]
  return verdictLevel <= autoLevel ? 'approved' : 'user'
}
