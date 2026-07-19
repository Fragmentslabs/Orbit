import path from 'node:path'
import type { PermissionClaim } from '@shared/chat'

export interface Assessment {
  claim: PermissionClaim
  ruleId: string
}

function shorten(text: string, max = 80): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max)}…` : single
}

function isCriticalTarget(target: string, dir: string): boolean {
  const clean = target.replace(/["']/g, '')
  if (clean === '/' || clean === '~' || clean === '.' || clean === '..' || clean === '*') return true
  if (/^[A-Za-z]:[\\/]?$/.test(clean)) return true
  if (clean.startsWith('~')) return true
  if (path.isAbsolute(clean)) return true
  const resolved = path.resolve(dir, clean)
  const rel = path.relative(dir, resolved)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function segments(command: string): string[][] {
  return command
    .split(/(?:\|\||&&|;|\|)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(/\s+/))
}

function assessBash(command: string, dir: string | null): Assessment | null {
  const found: Assessment[] = []
  const claim = (ruleId: string, detail: string): Assessment => ({
    ruleId,
    claim: { tool: 'bash', title: `bash: ${shorten(command)}`, detail },
  })

  for (let tokens of segments(command)) {
    if (tokens[0] === 'sudo') {
      found.push(claim('bash:sudo', 'comando com privilégios elevados (sudo)'))
      tokens = tokens.slice(1)
    }
    const cmd = tokens[0]

    if (cmd === 'rm') {
      const flags = tokens.filter((t) => t.startsWith('-')).join('')
      const recursiveForce = /r/i.test(flags) && flags.includes('f')
      if (recursiveForce) {
        const targets = tokens.slice(1).filter((t) => !t.startsWith('-'))
        if (targets.some((t) => isCriticalTarget(t, dir ?? ''))) {
          found.push(claim('bash:rm-rf-critical', 'remoção recursiva fora do projeto ou da raiz'))
        } else {
          found.push(claim('bash:rm-rf', 'remoção recursiva de arquivos (rm -rf)'))
        }
      }
    }

    if (cmd === 'git') {
      const sub = tokens[1]
      if (sub === 'push') {
        const force = tokens.some((t) => t === '--force' || t === '-f')
        found.push(
          force
            ? claim('bash:git-push-force', 'push forçado reescreve histórico remoto')
            : claim('bash:git-push', 'publica commits no remoto (git push)'),
        )
      }
      if (sub === 'reset' && tokens.includes('--hard')) {
        found.push(claim('bash:git-reset-hard', 'descarta alterações locais (git reset --hard)'))
      }
    }

    if (cmd.startsWith('npx') || cmd.startsWith('npm') || cmd.startsWith('pnpm') || cmd.startsWith('yarn') || cmd.startsWith('bun')) {
      const install = tokens.some((t) => t === 'install' || t === 'add' || t === 'remove' || t === 'link')
      if (install) {
        found.push(claim('bash:package-install', 'instalação/remoção de dependências'))
      }
    }
  }

  if (found.length === 0) return null
  return found[found.length - 1]
}

function assessFileWrite(tool: string, filePath: string): Assessment | null {
  const normalized = filePath.replace(/\\/g, '/')
  const base = path.posix.basename(normalized.toLowerCase())

  const claim = (ruleId: string, detail: string): Assessment => ({
    ruleId,
    claim: { tool, title: `${tool}: ${shorten(filePath, 60)}`, detail },
  })

  if (/(^|\/)\.git(\/|$)/.test(normalized.toLowerCase())) {
    return claim('file:git-dir', 'escrita dentro de .git corrompe o repositório')
  }
  if (/^\.env(\..+)?$/.test(base)) {
    return claim('file:env', 'arquivo de segredos/ambiente (.env)')
  }
  const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'])
  if (LOCKFILES.has(base)) {
    return claim('file:lockfile', 'lockfile de dependências')
  }
  return null
}

export function assess(toolName: string, input: unknown, dir: string | null): Assessment | null {
  const args = (input ?? {}) as Record<string, unknown>
  if (toolName === 'bash' && typeof args.command === 'string') {
    return assessBash(args.command, dir)
  }
  if ((toolName === 'write' || toolName === 'edit') && typeof args.filePath === 'string') {
    return assessFileWrite(toolName, args.filePath)
  }
  if (toolName.includes('_')) {
    const serverName = toolName.split('_')[0]
    return {
      ruleId: `mcp:${serverName}`,
      claim: {
        tool: toolName,
        title: toolName,
        detail: `Ferramenta do servidor MCP "${serverName}"`,
      },
    }
  }
  return null
}

export function isForbidden(toolName: string, input: unknown, dir: string | null): boolean {
  const args = (input ?? {}) as Record<string, unknown>

  if (toolName === 'bash' && typeof args.command === 'string') {
    const command = args.command
    for (const tokens of segments(command)) {
      const cmd = tokens[0]
      if (cmd === 'rm') {
        const flags = tokens.filter((t) => t.startsWith('-')).join('')
        const recursiveForce = /r/i.test(flags) && flags.includes('f')
        if (recursiveForce) {
          const targets = tokens.slice(1).filter((t) => !t.startsWith('-'))
          if (targets.some((t) => isCriticalTarget(t, dir ?? ''))) return true
        }
      }
    }
  }

  if ((toolName === 'write' || toolName === 'edit') && typeof args.filePath === 'string') {
    const normalized = args.filePath.replace(/\\/g, '/')
    if (/(^|\/)\.git(\/|$)/.test(normalized.toLowerCase())) return true
  }

  return false
}
