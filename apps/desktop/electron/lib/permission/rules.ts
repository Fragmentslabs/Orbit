import path from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { dataDir } from '../storage'
import type { PermissionClaim } from '@shared/chat'

export interface Assessment {
  claim: PermissionClaim
  ruleId: string
}

function shorten(text: string, max = 80): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max)}…` : single
}

/**
 * Tools nativas (first-party) do Orbit. O catch-all de MCP usa "_" como
 * separador de servidor — tools nativas em snake_case (show_image, panel_*,
 * memory_*, browser_*, bash_background/list/kill/output, create_skill) cairiam nele
 * e pediriam permissão em toda chamada. Esta allowlist garante que nativas
 * NUNCA sejam avaliadas como MCP. As que merecem avaliação (bash, write,
 * edit) têm regras próprias no assess() — o resto aprova sem perguntar.
 * Além da allowlist, o usuário pode ampliar o "nunca pedir" via
 * permissions.json (campo neverAsk) — ver loadUserNeverAsk().
 */
const NATIVE_TOOLS = new Set([
  // Browser do painel direito
  'panel_navigate',
  'panel_read',
  'panel_click',
  'panel_type',
  'panel_resize',
  'panel_screenshot',
  'show_image',
  // Automação em lote na engine oculta (mesmo threat model do bash: o agente
  // já executa código arbitrário; o script roda isolado num utilityProcess)
  'run_browser_script',
  'capture_batch',
  // Browser do modo chat (toggle "Browser") — tools nativas do toggle,
  // não MCP; caíam no catch-all "_" e pediam permissão como servidor "browser"
  'browser_open',
  'browser_links',
  // Memória (brain)
  'memory_save',
  'memory_search',
  'memory_open',
  'memory_graph',
  // memory_link existe só no modo chat (cria vínculos entre memórias);
  // também caía no catch-all como servidor "memory"
  'memory_link',
  // Processos em background
  'bash_background',
  'bash_list',
  'bash_kill',
  'bash_output',
  // Esteira (board de tasks)
  'esteira_create',
  'esteira_list',
  'esteira_create_task',
  'esteira_task_status',
  // Modo Visão: descreve imagens anexadas com o modelo de visão configurado
  // (leitura pura, first-party) — caía no catch-all de MCP como servidor
  // "describe" e pedia permissão em toda chamada.
  'describe_image',
  // Skills
  'create_skill',
  // Estado do turno (leitura, first-party): verify_changes confere o que foi
  // escrito no turno; session_context traz metadados dos turnos recentes.
  // Caíam no catch-all de MCP ("verify"/"session") e pediam permissão em
  // toda chamada — o que fazia o modelo pular a verificação.
  'verify_changes',
  'session_context',
])

const USER_RULES_FILE = () => path.join(dataDir(), 'permissions.json')

let cachedNeverAskMtime = -1
let cachedNeverAsk: Set<string> | null = null

/**
 * Lista "nunca pedir permissão" do usuário, lida de permissions.json
 * (mesmo diretório do mcp-config.json). Formato:
 *   { "neverAsk": ["bash", "write", "edit", "websearch"] }
 * Arquivo ausente ou inválido = lista vazia. Cache por mtime para o
 * assess() (chamado a cada tool call) não fazer I/O desnecessário.
 */
function loadUserNeverAsk(): Set<string> {
  try {
    const file = USER_RULES_FILE()
    const mtime = statSync(file).mtimeMs
    if (cachedNeverAsk && mtime === cachedNeverAskMtime) return cachedNeverAsk
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as { neverAsk?: unknown }
    cachedNeverAsk = new Set(
      Array.isArray(parsed.neverAsk) ? parsed.neverAsk.filter((t): t is string => typeof t === 'string') : [],
    )
    cachedNeverAskMtime = mtime
  } catch {
    cachedNeverAsk = new Set()
    cachedNeverAskMtime = -1
  }
  return cachedNeverAsk
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
  // "Nunca pedir": allowlist de nativas + lista configurável do usuário
  // (permissions.json → neverAsk). O check vem antes das regras de risco:
  // quem colocou a tool aqui quer execução sem pergunta — isForbidden
  // (bloqueio duro) continua valendo por cima disso.
  if (NATIVE_TOOLS.has(toolName) || loadUserNeverAsk().has(toolName)) return null
  if (toolName === 'bash' && typeof args.command === 'string') {
    return assessBash(args.command, dir)
  }
  if ((toolName === 'write' || toolName === 'edit') && typeof args.filePath === 'string') {
    return assessFileWrite(toolName, args.filePath)
  }
  // Catch-all "_" exclusivo para servidores MCP (Nodara_*, N8N_-_Vlk_*, ...)
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
